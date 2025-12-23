import fs from 'node:fs/promises';

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';

import { getConfig } from './config.js';
import {
  bundleExists,
  checkForUpdates,
  clearBundleMulti,
  createBundle,
  findBundleStorageDir,
  getBundlePathsForId,
  getEffectiveStorageDir,
  listBundles,
  repairBundle,
  updateBundle,
} from './bundle/service.js';
import { readManifest } from './bundle/manifest.js';
import { safeJoin, toBundleFileUri } from './mcp/uris.js';
import { wrapPreflightError } from './mcp/errorKinds.js';
import { searchIndex, type SearchScope } from './search/sqliteFts.js';
import { logger } from './logging/logger.js';
import { runSearchByTags } from './tools/searchByTags.js';
import { cleanupOnStartup, cleanupOrphanBundles } from './bundle/cleanup.js';
import { startHttpServer } from './http/server.js';
import { DependencyGraphInputSchema, generateDependencyGraph } from './evidence/dependencyGraph.js';
import { TraceQueryInputSchema, TraceUpsertInputSchema, traceQuery, traceUpsert } from './trace/service.js';

const CreateRepoInputSchema = z.union([
  z.object({
    kind: z.literal('github'),
    repo: z.string().describe('GitHub repo in owner/repo form (or github.com/owner/repo URL).'),
    ref: z.string().optional().describe('Optional git ref (branch/tag).'),
  }),
  z.object({
    kind: z.literal('local'),
    repo: z
      .string()
      .describe('Logical repo id in owner/repo form (used for storage layout and de-dup).'),
    path: z.string().describe('Local directory path containing the repository files.'),
    ref: z.string().optional().describe('Optional label/ref for the local snapshot.'),
  }),
]);

const CreateBundleInputSchema = {
  repos: z.array(CreateRepoInputSchema).min(1).describe('Repositories to ingest into the bundle.'),
  libraries: z.array(z.string()).optional().describe('Optional library names for Context7 docs ingestion.'),
  topics: z.array(z.string()).optional().describe('Optional Context7 topic filters (limits fetched docs).'),
  ifExists: z
    .enum(['error', 'returnExisting', 'updateExisting', 'createNew'])
    .default('error')
    .describe(
      'What to do if a bundle with the same normalized inputs already exists. error=reject (default), returnExisting=return existing without fetching, updateExisting=update existing bundle then return it, createNew=bypass de-duplication.'
    ),
};

const UpdateBundleInputSchema = {
  bundleId: z.string().describe('Bundle ID returned by preflight_create_bundle.'),
  checkOnly: z.boolean().optional().describe('If true, only check if updates are available without applying them.'),
  force: z.boolean().optional().describe('If true, force rebuild index even if no changes detected.'),
};

const SearchBundleInputSchema = {
  bundleId: z.string().describe('Bundle ID to search.'),
  query: z.string().describe('Search query. Prefix with fts: to use raw FTS syntax.'),
  scope: z.enum(['docs', 'code', 'all']).default('all').describe('Search scope.'),
  limit: z.number().int().min(1).max(200).default(30).describe('Max number of hits.'),
  // Deprecated (kept for backward compatibility): this tool is strictly read-only.
  ensureFresh: z
    .boolean()
    .optional()
    .describe('DEPRECATED. This tool is strictly read-only and will not auto-update. Use preflight_update_bundle, then call search again.'),
  maxAgeHours: z
    .number()
    .optional()
    .describe('DEPRECATED. Only used with ensureFresh (which is deprecated).'),
  autoRepairIndex: z
    .boolean()
    .optional()
    .describe('DEPRECATED. This tool is strictly read-only and will not auto-repair. Use preflight_repair_bundle, then call search again.'),
};

const SearchByTagsInputSchema = {
  query: z.string().describe('Search query across bundles.'),
  tags: z.array(z.string()).optional().describe('Filter by tags (e.g., ["mcp", "agents"]). Searches only matching bundles.'),
  scope: z.enum(['docs', 'code', 'all']).default('all').describe('Search scope.'),
  limit: z.number().int().min(1).max(200).default(50).describe('Max total hits across all bundles.'),
};

const ListBundlesInputSchema = {
  // keep open for future filters
};

const DeleteBundleInputSchema = {
  bundleId: z.string().describe('Bundle ID to delete.'),
};

const RepairBundleInputSchema = {
  bundleId: z.string().describe('Bundle ID to repair.'),
  mode: z.enum(['validate', 'repair']).default('repair').describe('validate=report missing components only; repair=fix missing derived artifacts.'),
  rebuildIndex: z.boolean().optional().describe('If true, rebuild search index when missing/empty.'),
  rebuildGuides: z.boolean().optional().describe('If true, rebuild START_HERE.md and AGENTS.md when missing/empty.'),
  rebuildOverview: z.boolean().optional().describe('If true, rebuild OVERVIEW.md when missing/empty.'),
};

const ReadFileInputSchema = {
  bundleId: z.string().describe('Bundle ID.'),
  file: z.string().default('OVERVIEW.md').describe('File path relative to bundle root. Common files: OVERVIEW.md, START_HERE.md, AGENTS.md, manifest.json, or any repo file like repos/owner/repo/norm/README.md'),
};


export async function startServer(): Promise<void> {
  const cfg = getConfig();

  // Run orphan bundle cleanup on startup (non-blocking, best-effort)
  cleanupOnStartup(cfg).catch((err) => {
    logger.debug('Startup cleanup failed (non-critical)', err instanceof Error ? err : undefined);
  });

  // Start built-in REST API (best-effort). This must not interfere with MCP stdio transport.
  startHttpServer(cfg);

  const server = new McpServer(
    {
      name: 'preflight-mcp',
      version: '0.1.3',
      description: 'Create evidence-based preflight bundles for repositories (docs + code) with SQLite FTS search.',
    },
    {
      capabilities: {
        resources: {
          // We can emit list changed notifications when new bundles appear.
          listChanged: true,
        },
      },
    }
  );

  // Resource template to read any file inside a bundle.
  // URI format: preflight://bundle/{bundleId}/file/{encodedPath}
  server.registerResource(
    'bundle-file',
    new ResourceTemplate('preflight://bundle/{bundleId}/file/{encodedPath}', {
      list: undefined,
      complete: {
        bundleId: async (value) => {
          const effectiveDir = await getEffectiveStorageDir(cfg);
          const ids = await listBundles(effectiveDir);
          return ids.filter((id) => id.startsWith(value)).slice(0, 50);
        },
      },
    }),
    {
      title: 'Preflight bundle file',
      description: 'Reads a specific file from a preflight bundle by bundleId and encoded path.',
      mimeType: 'text/plain',
    },
    async (uri, vars) => {
      const bundleId = String(vars['bundleId'] ?? '');
      const encodedPath = String(vars['encodedPath'] ?? '');
      const rel = decodeURIComponent(encodedPath);

      const effectiveDir = await getEffectiveStorageDir(cfg);
      const bundleRoot = getBundlePathsForId(effectiveDir, bundleId).rootDir;
      const absPath = safeJoin(bundleRoot, rel);

      const text = await fs.readFile(absPath, 'utf8');
      const mimeType = absPath.endsWith('.md') ? 'text/markdown' : 'text/plain';

      return {
        contents: [
          {
            uri: uri.href,
            mimeType,
            text,
          },
        ],
      };
    }
  );

  // A small static resource that lists bundles.
  server.registerResource(
    'bundles-index',
    'preflight://bundles',
    {
      title: 'Preflight bundles index',
      description: 'Lists available bundle IDs and their main entry files.',
      mimeType: 'application/json',
    },
    async () => {
      const effectiveDir = await getEffectiveStorageDir(cfg);
      const ids = await listBundles(effectiveDir);
      const items = ids.map((id) => ({
        bundleId: id,
        startHere: toBundleFileUri({ bundleId: id, relativePath: 'START_HERE.md' }),
        agents: toBundleFileUri({ bundleId: id, relativePath: 'AGENTS.md' }),
        overview: toBundleFileUri({ bundleId: id, relativePath: 'OVERVIEW.md' }),
        manifest: toBundleFileUri({ bundleId: id, relativePath: 'manifest.json' }),
      }));
      return {
        contents: [
          {
            uri: 'preflight://bundles',
            mimeType: 'application/json',
            text: JSON.stringify({ bundles: items }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    'preflight_list_bundles',
    {
      title: 'List bundles',
      description:
        'List available preflight bundles in a stable, minimal format. Use when: "show bundles", "what bundles exist", "list repos", "show my knowledge bases", "what have I indexed", "查看bundle", "有哪些bundle", "列出仓库".',
      inputSchema: {
        filterByTag: z
          .string()
          .optional()
          .describe('Filter by tag (e.g., "mcp", "agents", "web-scraping").'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe('Max number of bundles to return.'),
        maxItemsPerList: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe('Max repos/tags to include per bundle to keep output compact.'),
      },
      outputSchema: {
        bundles: z.array(
          z.object({
            bundleId: z.string(),
            displayName: z.string(),
            repos: z.array(z.string()),
            tags: z.array(z.string()),
          })
        ),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      const effectiveDir = await getEffectiveStorageDir(cfg);
      const ids = (await listBundles(effectiveDir)).slice(0, args.limit);

      const capList = (items: string[], max: number): string[] => {
        if (items.length <= max) return items;
        const keep = items.slice(0, max);
        keep.push(`...(+${items.length - max})`);
        return keep;
      };

      const bundlesInternal: Array<{
        bundleId: string;
        displayName: string;
        repos: string[];
        tags: string[];
        tagsFull: string[];
      }> = [];

      for (const id of ids) {
        try {
          const paths = getBundlePathsForId(effectiveDir, id);
          const manifest = await readManifest(paths.manifestPath);

          const reposRaw = (manifest.repos ?? []).map((r) => r.id).filter(Boolean);
          const tagsFull = (manifest.tags ?? []).map(String);

          const displayName =
            (manifest.displayName && manifest.displayName.trim()) ||
            (reposRaw[0] && reposRaw[0].trim()) ||
            '(unnamed)';

          bundlesInternal.push({
            bundleId: id,
            displayName,
            repos: capList(reposRaw, args.maxItemsPerList),
            tags: capList(tagsFull, args.maxItemsPerList),
            tagsFull,
          });
        } catch {
          // Keep the bundleId visible even if the manifest is missing/corrupt.
          bundlesInternal.push({
            bundleId: id,
            displayName: '(unreadable manifest)',
            repos: [],
            tags: [],
            tagsFull: [],
          });
        }
      }

      const filteredInternal = args.filterByTag
        ? bundlesInternal.filter((b) => b.tagsFull.includes(args.filterByTag!))
        : bundlesInternal;

      const filtered = filteredInternal.map(({ tagsFull: _tagsFull, ...b }) => b);

      const out = { bundles: filtered };

      // Stable human-readable format for UI logs.
      const lines = filtered.map((b) => {
        const repos = b.repos.length ? b.repos.join(', ') : '(none)';
        const tags = b.tags.length ? b.tags.join(', ') : '(none)';
        return `${b.bundleId} | ${b.displayName} | repos: ${repos} | tags: ${tags}`;
      });

      return {
        content: [{ type: 'text', text: lines.join('\n') || '(no bundles)' }],
        structuredContent: out,
      };
    }
  );

  server.registerTool(
    'preflight_read_file',
    {
      title: 'Read bundle file',
      description: 'Read a file from bundle. Use when: "show overview", "read file", "查看概览", "项目概览", "看README", "查看文档", "bundle详情", "bundle状态", "仓库信息". Common files: OVERVIEW.md, START_HERE.md, AGENTS.md, manifest.json (for bundle metadata/status).',
      inputSchema: ReadFileInputSchema,
      outputSchema: {
        bundleId: z.string(),
        file: z.string(),
        content: z.string(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      try {
        const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
        if (!storageDir) {
          throw new Error(`Bundle not found: ${args.bundleId}`);
        }

        const bundleRoot = getBundlePathsForId(storageDir, args.bundleId).rootDir;
        const absPath = safeJoin(bundleRoot, args.file);

        const content = await fs.readFile(absPath, 'utf8');

        const out = {
          bundleId: args.bundleId,
          file: args.file,
          content,
        };

        return {
          content: [{ type: 'text', text: content }],
          structuredContent: out,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );

  server.registerTool(
    'preflight_delete_bundle',
    {
      title: 'Delete bundle',
      description: 'Delete/remove a bundle permanently. Use when: "delete bundle", "remove bundle", "清除bundle", "删除索引", "移除仓库".',
      inputSchema: DeleteBundleInputSchema,
      outputSchema: {
        deleted: z.boolean(),
        bundleId: z.string(),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async (args) => {
      try {
        const deleted = await clearBundleMulti(cfg.storageDirs, args.bundleId);
        if (!deleted) {
          throw new Error(`Bundle not found: ${args.bundleId}`);
        }

        server.sendResourceListChanged();

        const out = { deleted: true, bundleId: args.bundleId };
        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );

  server.registerTool(
    'preflight_create_bundle',
    {
      title: 'Create bundle',
      description: 'Create a new bundle from GitHub repos or local directories (or update an existing one if ifExists=updateExisting). Use when: "index this repo", "create bundle for", "add repo to preflight", "索引这个仓库", "创建bundle", "添加GitHub项目", "学习这个项目". NOTE: If the bundle contains code files, consider asking user if they want to generate dependency graph (preflight_evidence_dependency_graph) or establish trace links (preflight_trace_upsert).',
      inputSchema: CreateBundleInputSchema,
      outputSchema: {
        bundleId: z.string(),
        createdAt: z.string(),
        updatedAt: z.string(),
        resources: z.object({
          startHere: z.string(),
          agents: z.string(),
          overview: z.string(),
          manifest: z.string(),
        }),
        repos: z.array(
          z.object({
            kind: z.enum(['github', 'local']),
            id: z.string(),
            source: z.enum(['git', 'archive', 'local']).optional(),
            headSha: z.string().optional(),
            notes: z.array(z.string()).optional(),
          })
        ),
        libraries: z
          .array(
            z.object({
              kind: z.literal('context7'),
              input: z.string(),
              id: z.string().optional(),
              fetchedAt: z.string(),
              notes: z.array(z.string()).optional(),
              files: z.array(z.string()).optional(),
            })
          )
          .optional(),
      },
      annotations: {
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const summary = await createBundle(
          cfg,
          {
            repos: args.repos,
            libraries: args.libraries,
            topics: args.topics,
          },
          { ifExists: args.ifExists }
        );

        const resources = {
          startHere: toBundleFileUri({ bundleId: summary.bundleId, relativePath: 'START_HERE.md' }),
          agents: toBundleFileUri({ bundleId: summary.bundleId, relativePath: 'AGENTS.md' }),
          overview: toBundleFileUri({ bundleId: summary.bundleId, relativePath: 'OVERVIEW.md' }),
          manifest: toBundleFileUri({ bundleId: summary.bundleId, relativePath: 'manifest.json' }),
        };

        // Let clients know resources list may have changed.
        server.sendResourceListChanged();

        const out = {
          ...summary,
          resources,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );

  server.registerTool(
    'preflight_repair_bundle',
    {
      title: 'Repair bundle (offline)',
      description:
        'Validate and repair missing/empty derived bundle artifacts (offline, no fetching): search index, START_HERE.md, AGENTS.md, OVERVIEW.md. Use when: "bundle is broken", "search fails", "index missing", "修复bundle", "重建索引", "修复概览".',
      inputSchema: RepairBundleInputSchema,
      outputSchema: {
        bundleId: z.string(),
        mode: z.enum(['validate', 'repair']),
        repaired: z.boolean(),
        actionsTaken: z.array(z.string()),
        before: z.object({
          isValid: z.boolean(),
          missingComponents: z.array(z.string()),
        }),
        after: z.object({
          isValid: z.boolean(),
          missingComponents: z.array(z.string()),
        }),
        updatedAt: z.string().optional(),
      },
      annotations: {
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const out = await repairBundle(cfg, args.bundleId, {
          mode: args.mode,
          rebuildIndex: args.rebuildIndex,
          rebuildGuides: args.rebuildGuides,
          rebuildOverview: args.rebuildOverview,
        });

        const summaryLine =
          out.mode === 'validate'
            ? `VALIDATE ${out.bundleId}: ${out.before.isValid ? 'OK' : 'MISSING'} (${out.before.missingComponents.length} issue(s))`
            : out.repaired
              ? `REPAIRED ${out.bundleId}: ${out.actionsTaken.length} action(s), now ${out.after.isValid ? 'OK' : 'STILL_MISSING'} (${out.after.missingComponents.length} issue(s))`
              : `NOOP ${out.bundleId}: nothing to repair (already OK)`;

        return {
          content: [{ type: 'text', text: summaryLine }],
          structuredContent: out,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );

  server.registerTool(
    'preflight_update_bundle',
    {
      title: 'Update bundle',
      description: 'Refresh/sync a bundle with latest repo changes. Use when: "update bundle", "refresh bundle", "sync bundle", "check for updates", "更新bundle", "同步仓库", "刷新索引". Set checkOnly=true to only check without applying.',
      inputSchema: UpdateBundleInputSchema,
      outputSchema: {
        changed: z.boolean(),
        checkOnly: z.boolean().optional(),
        updateDetails: z.array(
          z.object({
            repoId: z.string(),
            currentSha: z.string().optional(),
            remoteSha: z.string().optional(),
            changed: z.boolean(),
          })
        ).optional(),
        bundleId: z.string(),
        createdAt: z.string().optional(),
        updatedAt: z.string().optional(),
        resources: z.object({
          startHere: z.string(),
          agents: z.string(),
          overview: z.string(),
          manifest: z.string(),
        }).optional(),
        repos: z.array(
          z.object({
            kind: z.enum(['github', 'local', 'deepwiki']),
            id: z.string(),
            source: z.enum(['git', 'archive', 'local', 'deepwiki']).optional(),
            headSha: z.string().optional(),
            notes: z.array(z.string()).optional(),
          })
        ).optional(),
        libraries: z
          .array(
            z.object({
              kind: z.literal('context7'),
              input: z.string(),
              id: z.string().optional(),
              fetchedAt: z.string(),
              notes: z.array(z.string()).optional(),
              files: z.array(z.string()).optional(),
            })
          )
          .optional(),
      },
      annotations: {
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
        if (!storageDir) {
          throw new Error(`Bundle not found: ${args.bundleId}`);
        }

        // checkOnly mode: just check for updates without applying
        if (args.checkOnly) {
          const { hasUpdates, details } = await checkForUpdates(cfg, args.bundleId);
          const out = {
            bundleId: args.bundleId,
            changed: hasUpdates,
            checkOnly: true,
            updateDetails: details,
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
            structuredContent: out,
          };
        }

        const { summary, changed } = await updateBundle(cfg, args.bundleId, { force: args.force });

        const resources = {
          startHere: toBundleFileUri({ bundleId: summary.bundleId, relativePath: 'START_HERE.md' }),
          agents: toBundleFileUri({ bundleId: summary.bundleId, relativePath: 'AGENTS.md' }),
          overview: toBundleFileUri({ bundleId: summary.bundleId, relativePath: 'OVERVIEW.md' }),
          manifest: toBundleFileUri({ bundleId: summary.bundleId, relativePath: 'manifest.json' }),
        };

        const out = {
          changed: args.force ? true : changed,
          ...summary,
          resources,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );

  server.registerTool(
    'preflight_search_by_tags',
    {
      title: 'Search by tags',
      description: 'Search across multiple bundles filtered by tags. Use when: "search in MCP bundles", "find in all agent repos", "search web-scraping tools", "在MCP项目中搜索", "搜索所有agent".',
      inputSchema: SearchByTagsInputSchema,
      outputSchema: {
        query: z.string(),
        tags: z.array(z.string()).optional(),
        scope: z.enum(['docs', 'code', 'all']),
        totalBundlesSearched: z.number(),
        hits: z.array(
          z.object({
            bundleId: z.string(),
            bundleName: z.string().optional(),
            kind: z.enum(['doc', 'code']),
            repo: z.string(),
            path: z.string(),
            lineNo: z.number(),
            snippet: z.string(),
            uri: z.string(),
          })
        ),
        warnings: z
          .array(
            z.object({
              bundleId: z.string(),
              kind: z.string(),
              message: z.string(),
            })
          )
          .optional()
          .describe('Non-fatal per-bundle errors. Use kind to decide whether to repair/update.'),
        warningsTruncated: z.boolean().optional().describe('True if warnings were capped.'),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      const effectiveDir = await getEffectiveStorageDir(cfg);
      const allBundleIds = await listBundles(effectiveDir);

      const result = await runSearchByTags({
        bundleIds: allBundleIds,
        query: args.query,
        tags: args.tags,
        scope: args.scope as SearchScope,
        limit: args.limit,
        readManifestForBundleId: async (bundleId) => {
          const paths = getBundlePathsForId(effectiveDir, bundleId);
          const manifest = await readManifest(paths.manifestPath);
          return { displayName: manifest.displayName, tags: manifest.tags };
        },
        searchIndexForBundleId: (bundleId, query, scope, limit) => {
          const paths = getBundlePathsForId(effectiveDir, bundleId);
          return searchIndex(paths.searchDbPath, query, scope, limit, paths.rootDir);
        },
        toUri: (bundleId, p) => toBundleFileUri({ bundleId, relativePath: p }),
      });

      const out = {
        query: args.query,
        tags: args.tags,
        scope: args.scope,
        totalBundlesSearched: result.totalBundlesSearched,
        hits: result.hits,
        warnings: result.warnings,
        warningsTruncated: result.warningsTruncated,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    }
  );

  server.registerTool(
    'preflight_search_bundle',
    {
      title: 'Search bundle',
      description: 'Full-text search in bundle docs and code (strictly read-only). If you need to update or repair, call preflight_update_bundle or preflight_repair_bundle explicitly, then search again. Use when: "search in bundle", "find in repo", "look for X in bundle", "搜索bundle", "在仓库中查找", "搜代码", "搜文档".',
      inputSchema: SearchBundleInputSchema,
      outputSchema: {
        bundleId: z.string(),
        query: z.string(),
        scope: z.enum(['docs', 'code', 'all']),
        hits: z.array(
          z.object({
            kind: z.enum(['doc', 'code']),
            repo: z.string(),
            path: z.string(),
            lineNo: z.number(),
            snippet: z.string(),
            uri: z.string(),
          })
        ),
        autoUpdated: z
          .boolean()
          .optional()
          .describe('DEPRECATED. This tool is strictly read-only and will not auto-update.'),
        autoRepaired: z
          .boolean()
          .optional()
          .describe('DEPRECATED. This tool is strictly read-only and will not auto-repair.'),
        repairActions: z
          .array(z.string())
          .optional()
          .describe('DEPRECATED. This tool is strictly read-only and will not auto-repair.'),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      try {
        // Resolve bundle location across storageDirs (more robust than a single effectiveDir).
        const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
        if (!storageDir) {
          throw new Error(`Bundle not found: ${args.bundleId}`);
        }

        if (args.ensureFresh) {
          throw new Error(
            'ensureFresh is deprecated and not supported in this tool. This tool is strictly read-only. ' +
              'Call preflight_update_bundle explicitly, then call preflight_search_bundle again.'
          );
        }

        if (args.autoRepairIndex) {
          throw new Error(
            'autoRepairIndex is deprecated and not supported in this tool. This tool is strictly read-only. ' +
              'Call preflight_repair_bundle explicitly, then call preflight_search_bundle again.'
          );
        }

        const paths = getBundlePathsForId(storageDir, args.bundleId);

        const rawHits = searchIndex(paths.searchDbPath, args.query, args.scope as SearchScope, args.limit, paths.rootDir);

        const hits = rawHits.map((h) => ({
          ...h,
          uri: toBundleFileUri({ bundleId: args.bundleId, relativePath: h.path }),
        }));

        const out = {
          bundleId: args.bundleId,
          query: args.query,
          scope: args.scope,
          hits,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );

  server.registerTool(
    'preflight_evidence_dependency_graph',
    {
      title: 'Evidence: dependency graph (callers + imports)',
      description:
        'Generate an evidence-based dependency graph for a target file/symbol inside a bundle. Output is deterministic (FTS + regex) and every edge includes traceable sources (file + range). This tool is read-only.',
      inputSchema: DependencyGraphInputSchema,
      outputSchema: {
        meta: z.any(),
        facts: z.any(),
        signals: z.any(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      try {
        const out = await generateDependencyGraph(cfg, args);
        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );

  server.registerTool(
    'preflight_trace_upsert',
    {
      title: 'Trace: upsert links',
      description:
        'Upsert traceability links (commit↔ticket, symbol↔test, code↔doc, etc.) for a bundle. Stores trace edges in a per-bundle SQLite database.',
      inputSchema: TraceUpsertInputSchema,
      outputSchema: {
        bundleId: z.string(),
        upserted: z.number().int(),
        ids: z.array(z.string()),
      },
      annotations: {
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const out = await traceUpsert(cfg, args);
        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );

  server.registerTool(
    'preflight_trace_query',
    {
      title: 'Trace: query links',
      description:
        'Query traceability links. Provide bundleId for fast queries; if omitted, scans across bundles (capped). This tool is read-only.',
      inputSchema: TraceQueryInputSchema,
      outputSchema: {
        bundleId: z.string().optional(),
        scannedBundles: z.number().int().optional(),
        truncated: z.boolean().optional(),
        edges: z.array(
          z.object({
            id: z.string(),
            source: z.object({ type: z.string(), id: z.string() }),
            target: z.object({ type: z.string(), id: z.string() }),
            type: z.string(),
            confidence: z.number(),
            method: z.enum(['exact', 'heuristic']),
            sources: z.array(z.any()),
            createdAt: z.string(),
            updatedAt: z.string(),
            bundleId: z.string().optional(),
          })
        ),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      try {
        const out = await traceQuery(cfg, args);
        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );

  server.registerTool(
    'preflight_cleanup_orphans',
    {
      title: 'Cleanup orphan bundles',
      description: 'Remove incomplete or corrupted bundles (bundles without valid manifest.json). Safe to run anytime. Use when: "clean up broken bundles", "remove orphans", "清理孤儿bundle", "清除损坏的bundle".',
      inputSchema: {
        dryRun: z.boolean().default(true).describe('If true, only report orphans without deleting. Set to false to actually delete.'),
        minAgeHours: z.number().default(1).describe('Only clean bundles older than N hours (safety margin to avoid race conditions).'),
      },
      outputSchema: {
        totalFound: z.number(),
        totalCleaned: z.number(),
        details: z.array(
          z.object({
            storageDir: z.string(),
            found: z.array(z.string()),
            cleaned: z.array(z.string()),
            skipped: z.array(z.object({ bundleId: z.string(), reason: z.string() })),
          })
        ),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async (args) => {
      try {
        const result = await cleanupOrphanBundles(cfg, {
          minAgeHours: args.minAgeHours,
          dryRun: args.dryRun,
        });

        const summary = args.dryRun
          ? `Found ${result.totalFound} orphan bundle(s) (DRY RUN - not deleted)`
          : `Cleaned ${result.totalCleaned} of ${result.totalFound} orphan bundle(s)`;

        return {
          content: [{ type: 'text', text: summary }],
          structuredContent: result,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );

  // Provide backward-compatible parsing of the same URI via resources/read for clients that bypass templates.
  // This is a safety net: if a client gives us a fully-specified URI, we can still serve it.
  server.registerResource(
    'bundle-file-compat',
    'preflight://bundle-file',
    {
      title: 'Bundle file (compat)',
      description: 'Compatibility resource. Prefer preflight://bundle/{bundleId}/file/{encodedPath}.',
      mimeType: 'text/plain',
    },
    async () => {
      return {
        contents: [
          {
            uri: 'preflight://bundle-file',
            mimeType: 'text/plain',
            text: 'Use preflight://bundle/{bundleId}/file/{encodedPath} to read bundle files.',
          },
        ],
      };
    }
  );

  // Connect via stdio.
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
