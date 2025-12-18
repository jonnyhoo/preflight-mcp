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
  getBundlePathsForId,
  getEffectiveStorageDir,
  listBundles,
  updateBundle,
} from './bundle/service.js';
import { readManifest } from './bundle/manifest.js';
import { safeJoin, toBundleFileUri } from './mcp/uris.js';
import { searchIndex, verifyClaimInIndex, type SearchScope, type EvidenceType } from './search/sqliteFts.js';
import { logger } from './logging/logger.js';

const CreateRepoInputSchema = z.union([
  z.object({
    kind: z.literal('github'),
    repo: z.string().describe('GitHub repo in owner/repo form (or github.com/owner/repo URL).'),
    ref: z.string().optional().describe('Optional git ref (branch/tag).'),
  }),
  z.object({
    kind: z.literal('deepwiki'),
    url: z.string().url().describe('DeepWiki URL (https://deepwiki.com/owner/repo).'),
  }),
]);

const CreateBundleInputSchema = {
  repos: z.array(CreateRepoInputSchema).min(1).describe('Repositories to ingest into the bundle.'),
  libraries: z.array(z.string()).optional().describe('Optional library names for Context7 docs ingestion.'),
  topics: z.array(z.string()).optional().describe('Optional Context7 topic filters (limits fetched docs).'),
};

const UpdateBundleInputSchema = {
  bundleId: z.string().describe('Bundle ID returned by preflight_create_bundle.'),
  checkOnly: z.boolean().optional().describe('If true, only check if updates are available without applying them.'),
  force: z.boolean().optional().describe('If true, force rebuild index even if no changes detected.'),
};

const UpdateAllBundlesInputSchema = {
  bundleIds: z
    .array(z.string())
    .optional()
    .describe('Optional bundle IDs to update. If omitted, updates all bundles in storage.'),
};

const SearchBundleInputSchema = {
  bundleId: z.string().describe('Bundle ID to search.'),
  query: z.string().describe('Search query. Prefix with fts: to use raw FTS syntax.'),
  scope: z.enum(['docs', 'code', 'all']).default('all').describe('Search scope.'),
  limit: z.number().int().min(1).max(200).default(30).describe('Max number of hits.'),
  ensureFresh: z.boolean().optional().describe('If true, check if bundle needs update before searching.'),
  maxAgeHours: z.number().optional().describe('Max age in hours before triggering auto-update (requires ensureFresh).'),
};

const SearchByTagsInputSchema = {
  query: z.string().describe('Search query across bundles.'),
  tags: z.array(z.string()).optional().describe('Filter by tags (e.g., ["mcp", "agents"]). Searches only matching bundles.'),
  scope: z.enum(['docs', 'code', 'all']).default('all').describe('Search scope.'),
  limit: z.number().int().min(1).max(200).default(50).describe('Max total hits across all bundles.'),
};

const VerifyClaimInputSchema = {
  bundleId: z.string().describe('Bundle ID to verify against.'),
  claim: z.string().describe('A claim to look for evidence for (best-effort).'),
  scope: z.enum(['docs', 'code', 'all']).default('all').describe('Search scope.'),
  limit: z.number().int().min(1).max(50).default(8).describe('Max number of evidence hits.'),
  ensureFresh: z.boolean().optional().describe('If true, check if bundle needs update before verifying.'),
  maxAgeHours: z.number().optional().describe('Max age in hours before triggering auto-update (requires ensureFresh).'),
};

const ListBundlesInputSchema = {
  // keep open for future filters
};

const DeleteBundleInputSchema = {
  bundleId: z.string().describe('Bundle ID to delete.'),
};

const BundleInfoInputSchema = {
  bundleId: z.string().describe('Bundle ID to get info for.'),
};

const ReadFileInputSchema = {
  bundleId: z.string().describe('Bundle ID.'),
  file: z.string().default('OVERVIEW.md').describe('File path relative to bundle root. Common files: OVERVIEW.md, START_HERE.md, AGENTS.md, manifest.json, or any repo file like repos/owner/repo/norm/README.md'),
};


export async function startServer(): Promise<void> {
  const cfg = getConfig();

  const server = new McpServer(
    {
      name: 'preflight-mcp',
      version: '0.1.0',
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
      description: 'List all preflight bundles with metadata. Use when: "show bundles", "what bundles exist", "list repos", "show my knowledge bases", "what have I indexed", "查看bundle", "有哪些bundle", "列出仓库".',
      inputSchema: {
        filterByTag: z.string().optional().describe('Filter by tag (e.g., "mcp", "agents", "web-scraping")'),
        groupByCategory: z.boolean().default(false).describe('Group bundles by auto-detected categories'),
      },
      outputSchema: {
        bundles: z.array(
          z.object({
            bundleId: z.string(),
            displayName: z.string().optional(),
            description: z.string().optional(),
            tags: z.array(z.string()).optional(),
            primaryLanguage: z.string().optional(),
            category: z.string().optional(),
            repoCount: z.number(),
          })
        ),
        grouped: z.record(z.string(), z.array(z.string())).optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      const effectiveDir = await getEffectiveStorageDir(cfg);
      const ids = await listBundles(effectiveDir);
      
      // Read manifests for each bundle
      const bundlesWithMeta: Array<{
        bundleId: string;
        displayName?: string;
        description?: string;
        tags?: string[];
        primaryLanguage?: string;
        category?: string;
        repoCount: number;
      }> = [];

      for (const id of ids) {
        try {
          const paths = getBundlePathsForId(effectiveDir, id);
          const manifest = await readManifest(paths.manifestPath);
          
          // Import getCategoryFromTags dynamically
          const { getCategoryFromTags } = await import('./bundle/tagging.js');
          const category = manifest.tags ? getCategoryFromTags(manifest.tags) : 'uncategorized';
          
          bundlesWithMeta.push({
            bundleId: id,
            displayName: manifest.displayName,
            description: manifest.description,
            tags: manifest.tags,
            primaryLanguage: manifest.primaryLanguage,
            category,
            repoCount: manifest.repos.length,
          });
        } catch {
          // Skip bundles with missing/corrupt manifests
        }
      }

      // Filter by tag if specified
      let filtered = bundlesWithMeta;
      if (args.filterByTag) {
        filtered = bundlesWithMeta.filter(
          (b) => b.tags && b.tags.includes(args.filterByTag!)
        );
      }

      // Group by category if requested
      let grouped: Record<string, string[]> | undefined;
      if (args.groupByCategory) {
        grouped = {};
        for (const bundle of filtered) {
          const cat = bundle.category || 'uncategorized';
          if (!grouped[cat]) grouped[cat] = [];
          grouped[cat]!.push(bundle.bundleId);
        }
      }

      const out = {
        bundles: filtered,
        grouped,
      };
      
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    }
  );

  server.registerTool(
    'preflight_read_file',
    {
      title: 'Read bundle file',
      description: 'Read a file from bundle. Use when: "show overview", "read file", "查看概览", "项目概览", "看README", "查看文档". Common files: OVERVIEW.md, START_HERE.md, AGENTS.md.',
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
      const effectiveDir = await getEffectiveStorageDir(cfg);
      const exists = await bundleExists(effectiveDir, args.bundleId);
      if (!exists) {
        throw new Error(`Bundle not found: ${args.bundleId}`);
      }

      const bundleRoot = getBundlePathsForId(effectiveDir, args.bundleId).rootDir;
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
    }
  );

  server.registerTool(
    'preflight_bundle_info',
    {
      title: 'Bundle info',
      description: 'Get bundle details: repos, update time, stats. Use when: "bundle info", "show bundle details", "what\'s in this bundle", "bundle状态", "查看bundle详情", "仓库信息".',
      inputSchema: BundleInfoInputSchema,
      outputSchema: {
        bundleId: z.string(),
        createdAt: z.string(),
        updatedAt: z.string(),
        repos: z.array(
          z.object({
            kind: z.enum(['github', 'deepwiki']),
            id: z.string(),
            headSha: z.string().optional(),
            fetchedAt: z.string().optional(),
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
        index: z.object({
          backend: z.string(),
          includeDocs: z.boolean(),
          includeCode: z.boolean(),
        }),
        resources: z.object({
          startHere: z.string(),
          agents: z.string(),
          overview: z.string(),
          manifest: z.string(),
        }),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      const effectiveDir = await getEffectiveStorageDir(cfg);
      const exists = await bundleExists(effectiveDir, args.bundleId);
      if (!exists) {
        throw new Error(`Bundle not found: ${args.bundleId}`);
      }

      const paths = getBundlePathsForId(effectiveDir, args.bundleId);
      const manifest = await readManifest(paths.manifestPath);

      const resources = {
        startHere: toBundleFileUri({ bundleId: args.bundleId, relativePath: 'START_HERE.md' }),
        agents: toBundleFileUri({ bundleId: args.bundleId, relativePath: 'AGENTS.md' }),
        overview: toBundleFileUri({ bundleId: args.bundleId, relativePath: 'OVERVIEW.md' }),
        manifest: toBundleFileUri({ bundleId: args.bundleId, relativePath: 'manifest.json' }),
      };

      const out = {
        bundleId: manifest.bundleId,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        repos: manifest.repos,
        libraries: manifest.libraries,
        index: manifest.index,
        resources,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    }
  );

  server.registerTool(
    'preflight_create_bundle',
    {
      title: 'Create bundle',
      description: 'Create a new bundle from GitHub repos or DeepWiki. Use when: "index this repo", "create bundle for", "add repo to preflight", "索引这个仓库", "创建bundle", "添加GitHub项目", "学习这个项目".',
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
            kind: z.enum(['github', 'deepwiki']),
            id: z.string(),
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
      const summary = await createBundle(cfg, {
        repos: args.repos,
        libraries: args.libraries,
        topics: args.topics,
      });

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
            kind: z.enum(['github', 'deepwiki']),
            id: z.string(),
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
      const effectiveDir = await getEffectiveStorageDir(cfg);
      const exists = await bundleExists(effectiveDir, args.bundleId);
      if (!exists) {
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
    }
  );

  server.registerTool(
    'preflight_update_all_bundles',
    {
      title: 'Update all bundles',
      description: 'Batch update all bundles at once. Use when: "update all bundles", "refresh everything", "sync all", "批量更新", "全部刷新", "更新所有bundle".',
      inputSchema: UpdateAllBundlesInputSchema,
      outputSchema: {
        total: z.number().int(),
        ok: z.number().int(),
        results: z.array(
          z.object({
            bundleId: z.string(),
            changed: z.boolean().optional(),
            updatedAt: z.string().optional(),
            error: z.string().optional(),
          })
        ),
      },
      annotations: {
        openWorldHint: true,
      },
    },
    async (args) => {
      const effectiveDir = await getEffectiveStorageDir(cfg);
      const ids =
        args.bundleIds && args.bundleIds.length > 0
          ? args.bundleIds
          : await listBundles(effectiveDir);

      const results: Array<{
        bundleId: string;
        changed?: boolean;
        updatedAt?: string;
        error?: string;
      }> = [];

      for (const bundleId of ids) {
        try {
          const exists = await bundleExists(effectiveDir, bundleId);
          if (!exists) {
            throw new Error(`Bundle not found: ${bundleId}`);
          }

          const { summary, changed } = await updateBundle(cfg, bundleId);
          results.push({ bundleId, changed, updatedAt: summary.updatedAt });
        } catch (err) {
          results.push({ bundleId, error: err instanceof Error ? err.message : String(err) });
        }
      }

      const out = {
        total: ids.length,
        ok: results.filter((r) => !r.error).length,
        results,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
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
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      const effectiveDir = await getEffectiveStorageDir(cfg);
      const allBundleIds = await listBundles(effectiveDir);
      
      // Filter bundles by tags if specified
      let targetBundleIds: string[] = allBundleIds;
      if (args.tags && args.tags.length > 0) {
        targetBundleIds = [];
        for (const id of allBundleIds) {
          try {
            const paths = getBundlePathsForId(effectiveDir, id);
            const manifest = await readManifest(paths.manifestPath);
            if (manifest.tags && args.tags.some((t) => manifest.tags!.includes(t))) {
              targetBundleIds.push(id);
            }
          } catch {
            // Skip bundles with errors
          }
        }
      }

      // Search each bundle and collect results
      const allHits: Array<{
        bundleId: string;
        bundleName?: string;
        kind: 'doc' | 'code';
        repo: string;
        path: string;
        lineNo: number;
        snippet: string;
        uri: string;
      }> = [];

      for (const bundleId of targetBundleIds) {
        try {
          const paths = getBundlePathsForId(effectiveDir, bundleId);
          const manifest = await readManifest(paths.manifestPath);
          
          const bundleHits = searchIndex(
            paths.searchDbPath,
            args.query,
            args.scope as SearchScope,
            args.limit
          );

          for (const hit of bundleHits) {
            allHits.push({
              bundleId,
              bundleName: manifest.displayName,
              kind: hit.kind,
              repo: hit.repo,
              path: hit.path,
              lineNo: hit.lineNo,
              snippet: hit.snippet,
              uri: toBundleFileUri({ bundleId, relativePath: hit.path }),
            });

            if (allHits.length >= args.limit) break;
          }

          if (allHits.length >= args.limit) break;
        } catch {
          // Skip bundles with search errors
        }
      }

      const out = {
        query: args.query,
        tags: args.tags,
        scope: args.scope,
        totalBundlesSearched: targetBundleIds.length,
        hits: allHits.slice(0, args.limit),
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
      description: 'Full-text search in bundle docs and code. Use when: "search in bundle", "find in repo", "look for X in bundle", "搜索bundle", "在仓库中查找", "搜代码", "搜文档".',
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
        autoUpdated: z.boolean().optional().describe('True if bundle was auto-updated due to ensureFresh.'),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      const effectiveDir = await getEffectiveStorageDir(cfg);
      const exists = await bundleExists(effectiveDir, args.bundleId);
      if (!exists) {
        throw new Error(`Bundle not found: ${args.bundleId}`);
      }

      let autoUpdated: boolean | undefined;
      const paths = getBundlePathsForId(effectiveDir, args.bundleId);

      // Lazy update: check if bundle is stale when ensureFresh is true.
      if (args.ensureFresh) {
        const manifest = await readManifest(paths.manifestPath);
        const updatedAt = new Date(manifest.updatedAt).getTime();
        const ageMs = Date.now() - updatedAt;
        const maxAgeMs = (args.maxAgeHours ?? 24) * 60 * 60 * 1000;
        if (ageMs > maxAgeMs) {
          await updateBundle(cfg, args.bundleId);
          autoUpdated = true;
        } else {
          autoUpdated = false;
        }
      }

      const hits = searchIndex(paths.searchDbPath, args.query, args.scope as SearchScope, args.limit).map((h) => ({
        ...h,
        uri: toBundleFileUri({ bundleId: args.bundleId, relativePath: h.path }),
      }));

      const out = {
        bundleId: args.bundleId,
        query: args.query,
        scope: args.scope,
        hits,
        autoUpdated,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    }
  );

  server.registerTool(
    'preflight_verify_claim',
    {
      title: 'Verify claim',
      description: 'Verify a claim with evidence classification and confidence scoring. Returns supporting/contradicting/related evidence. Use when: "verify this claim", "is this true", "find evidence for", "check if", "验证说法", "找证据", "这个对吗", "有没有依据".',
      inputSchema: VerifyClaimInputSchema,
      outputSchema: {
        bundleId: z.string(),
        claim: z.string(),
        scope: z.enum(['docs', 'code', 'all']),
        found: z.boolean(),
        confidence: z.number().describe('Confidence score 0-1'),
        confidenceLabel: z.enum(['high', 'medium', 'low', 'none']),
        summary: z.string().describe('Human-readable summary of verification'),
        supporting: z.array(
          z.object({
            kind: z.enum(['doc', 'code']),
            repo: z.string(),
            path: z.string(),
            lineNo: z.number(),
            snippet: z.string(),
            uri: z.string(),
            evidenceType: z.enum(['supporting', 'contradicting', 'related']),
            relevanceScore: z.number(),
          })
        ).describe('Evidence supporting the claim'),
        contradicting: z.array(
          z.object({
            kind: z.enum(['doc', 'code']),
            repo: z.string(),
            path: z.string(),
            lineNo: z.number(),
            snippet: z.string(),
            uri: z.string(),
            evidenceType: z.enum(['supporting', 'contradicting', 'related']),
            relevanceScore: z.number(),
          })
        ).describe('Evidence contradicting the claim'),
        related: z.array(
          z.object({
            kind: z.enum(['doc', 'code']),
            repo: z.string(),
            path: z.string(),
            lineNo: z.number(),
            snippet: z.string(),
            uri: z.string(),
            evidenceType: z.enum(['supporting', 'contradicting', 'related']),
            relevanceScore: z.number(),
          })
        ).describe('Related but inconclusive evidence'),
        autoUpdated: z.boolean().optional().describe('True if bundle was auto-updated due to ensureFresh.'),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      const effectiveDir = await getEffectiveStorageDir(cfg);
      const exists = await bundleExists(effectiveDir, args.bundleId);
      if (!exists) {
        throw new Error(`Bundle not found: ${args.bundleId}`);
      }

      let autoUpdated: boolean | undefined;
      const paths = getBundlePathsForId(effectiveDir, args.bundleId);

      // Lazy update: check if bundle is stale when ensureFresh is true.
      if (args.ensureFresh) {
        const manifest = await readManifest(paths.manifestPath);
        const updatedAt = new Date(manifest.updatedAt).getTime();
        const ageMs = Date.now() - updatedAt;
        const maxAgeMs = (args.maxAgeHours ?? 24) * 60 * 60 * 1000;
        if (ageMs > maxAgeMs) {
          await updateBundle(cfg, args.bundleId);
          autoUpdated = true;
        } else {
          autoUpdated = false;
        }
      }

      // Use differentiated verification with confidence scoring
      const verification = verifyClaimInIndex(
        paths.searchDbPath,
        args.claim,
        args.scope as SearchScope,
        args.limit
      );

      // Add URIs to evidence hits
      const addUri = (hit: typeof verification.supporting[0]) => ({
        ...hit,
        uri: toBundleFileUri({ bundleId: args.bundleId, relativePath: hit.path }),
      });

      const out = {
        bundleId: args.bundleId,
        claim: args.claim,
        scope: args.scope,
        found: verification.found,
        confidence: verification.confidence,
        confidenceLabel: verification.confidenceLabel,
        summary: verification.summary,
        supporting: verification.supporting.map(addUri),
        contradicting: verification.contradicting.map(addUri),
        related: verification.related.map(addUri),
        autoUpdated,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
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
