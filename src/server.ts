import fs from 'node:fs/promises';

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';

import { getConfig } from './config.js';
import {
  assertBundleComplete,
  bundleExists,
  checkForUpdates,
  checkInProgressLock,
  clearBundleMulti,
  computeCreateInputFingerprint,
  createBundle,
  findBundleStorageDir,
  getBundlePathsForId,
  getEffectiveStorageDir,
  listBundles,
  repairBundle,
  updateBundle,
} from './bundle/service.js';
import { getProgressTracker, type TaskProgress } from './jobs/progressTracker.js';
import { readManifest } from './bundle/manifest.js';
import { safeJoin, toBundleFileUri } from './mcp/uris.js';
import { wrapPreflightError } from './mcp/errorKinds.js';
import { BundleNotFoundError } from './errors.js';
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

const GetTaskStatusInputSchema = {
  taskId: z.string().optional().describe('Task ID to query (from BUNDLE_IN_PROGRESS error).'),
  fingerprint: z.string().optional().describe('Fingerprint to query (computed from repos/libraries/topics).'),
  repos: z.array(CreateRepoInputSchema).optional().describe('Repos to compute fingerprint from (alternative to fingerprint).'),
  libraries: z.array(z.string()).optional().describe('Libraries for fingerprint computation.'),
  topics: z.array(z.string()).optional().describe('Topics for fingerprint computation.'),
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
version: '0.1.7',
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
      title: 'Read bundle file(s)',
      description:
        'Read file(s) from bundle. Two modes: ' +
        '(1) Omit "file" param → returns ALL key files (OVERVIEW.md, START_HERE.md, AGENTS.md, manifest.json, repo READMEs) in one call. ' +
        '(2) Provide "file" param → returns that specific file. ' +
        'Use when: "查看bundle", "show bundle", "read overview", "bundle概览", "项目信息".',
      inputSchema: {
        bundleId: z.string().describe('Bundle ID to read.'),
        file: z.string().optional().describe('Specific file to read. If omitted, returns all key files (OVERVIEW.md, START_HERE.md, AGENTS.md, manifest.json, repo READMEs).'),
      },
      outputSchema: {
        bundleId: z.string(),
        file: z.string().optional(),
        content: z.string().optional(),
        files: z.record(z.string(), z.string().nullable()).optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      try {
        const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
        if (!storageDir) {
          throw new BundleNotFoundError(args.bundleId);
        }

        const paths = getBundlePathsForId(storageDir, args.bundleId);
        const bundleRoot = paths.rootDir;

        // Single file mode
        if (args.file) {
          const absPath = safeJoin(bundleRoot, args.file);
          const content = await fs.readFile(absPath, 'utf8');
          const out = { bundleId: args.bundleId, file: args.file, content };
          return {
            content: [{ type: 'text', text: content }],
            structuredContent: out,
          };
        }

        // Batch mode: read all key files
        const keyFiles = ['OVERVIEW.md', 'START_HERE.md', 'AGENTS.md', 'manifest.json'];
        const files: Record<string, string | null> = {};

        for (const file of keyFiles) {
          try {
            const absPath = safeJoin(bundleRoot, file);
            files[file] = await fs.readFile(absPath, 'utf8');
          } catch {
            files[file] = null;
          }
        }

        // Try to find and read repo README files
        try {
          const manifest = await readManifest(paths.manifestPath);
          for (const repo of manifest.repos ?? []) {
            if (!repo.id) continue;
            const [owner, repoName] = repo.id.split('/');
            if (!owner || !repoName) continue;

            const readmeNames = ['README.md', 'readme.md', 'Readme.md', 'README.MD'];
            for (const readmeName of readmeNames) {
              const readmePath = `repos/${owner}/${repoName}/norm/${readmeName}`;
              try {
                const absPath = safeJoin(bundleRoot, readmePath);
                files[readmePath] = await fs.readFile(absPath, 'utf8');
                break;
              } catch {
                // Try next
              }
            }
          }
        } catch {
          // Ignore manifest read errors
        }

        // Build combined text output
        const textParts: string[] = [];
        for (const [filePath, content] of Object.entries(files)) {
          if (content) {
            textParts.push(`=== ${filePath} ===\n${content}`);
          }
        }

        const out = { bundleId: args.bundleId, files };
        return {
          content: [{ type: 'text', text: textParts.join('\n\n') || '(no files found)' }],
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
          throw new BundleNotFoundError(args.bundleId);
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
        // Normal completion fields
        bundleId: z.string().optional(),
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
            kind: z.enum(['github', 'local']),
            id: z.string(),
            source: z.enum(['git', 'archive', 'local']).optional(),
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
        // User-facing warnings (e.g., git clone failed, used zip fallback)
        warnings: z.array(z.string()).optional(),
        // In-progress status fields
        status: z.enum(['in-progress', 'complete']).optional(),
        message: z.string().optional(),
        taskId: z.string().optional(),
        fingerprint: z.string().optional(),
        /** Repo IDs requested (for in-progress status only, different from repos array) */
        requestedRepos: z.array(z.string()).optional(),
        startedAt: z.string().optional(),
        elapsedSeconds: z.number().optional(),
        currentPhase: z.string().optional(),
        currentProgress: z.number().optional(),
        currentMessage: z.string().optional(),
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

        // Build text response - prominently show warnings if any
        let textResponse = '';
        if (summary.warnings && summary.warnings.length > 0) {
          textResponse += '📢 **Network Issues Encountered:**\n';
          for (const warn of summary.warnings) {
            textResponse += `${warn}\n`;
          }
          textResponse += '\n';
        }
        textResponse += `✅ Bundle created: ${summary.bundleId}\n`;
        textResponse += `Repos: ${summary.repos.map(r => `${r.id} (${r.source})`).join(', ')}`;

        return {
          content: [{ type: 'text', text: textResponse }],
          structuredContent: out,
        };
      } catch (err: any) {
        // Handle BUNDLE_IN_PROGRESS error specially - provide useful info instead of just error
        if (err?.code === 'BUNDLE_IN_PROGRESS') {
          const elapsedSec = err.startedAt
            ? Math.round((Date.now() - new Date(err.startedAt).getTime()) / 1000)
            : 0;
          
          // Check current progress from tracker
          const tracker = getProgressTracker();
          const task = err.taskId ? tracker.getTask(err.taskId) : undefined;
          
          const out = {
            status: 'in-progress' as const,
            message: `Bundle creation already in progress. Use preflight_get_task_status to check progress.`,
            taskId: err.taskId,
            fingerprint: err.fingerprint,
            requestedRepos: err.repos,
            startedAt: err.startedAt,
            elapsedSeconds: elapsedSec,
            currentPhase: task?.phase,
            currentProgress: task?.progress,
            currentMessage: task?.message,
          };
          
          return {
            content: [{ type: 'text', text: `⚠️ Bundle creation in progress (${elapsedSec}s elapsed). ${task ? `Current: ${task.phase} (${task.progress}%) - ${task.message}` : 'Use preflight_get_task_status to check progress.'}` }],
            structuredContent: out,
          };
        }
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
        /** Issues that cannot be fixed by repair (require re-download) */
        unfixableIssues: z.array(z.string()).optional(),
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

        let summaryLine: string;
        if (out.mode === 'validate') {
          summaryLine = `VALIDATE ${out.bundleId}: ${out.before.isValid ? 'OK' : 'INVALID'} (${out.before.missingComponents.length} issue(s))`;
        } else if (out.unfixableIssues && out.unfixableIssues.length > 0) {
          // Has unfixable issues - clearly communicate this
          summaryLine = `⚠️ UNFIXABLE ${out.bundleId}: ${out.unfixableIssues.length} issue(s) cannot be repaired offline.\n` +
            out.unfixableIssues.map(i => `  - ${i}`).join('\n');
        } else if (out.repaired) {
          summaryLine = `REPAIRED ${out.bundleId}: ${out.actionsTaken.length} action(s), now ${out.after.isValid ? 'OK' : 'STILL_INVALID'} (${out.after.missingComponents.length} issue(s))`;
        } else {
          summaryLine = `NOOP ${out.bundleId}: nothing to repair (already OK)`;
        }

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
          throw new BundleNotFoundError(args.bundleId);
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

        // Create task for progress tracking
        const tracker = getProgressTracker();
        const fingerprint = `update-${args.bundleId}`;
        const taskId = tracker.startTask(fingerprint, [args.bundleId]);

        try {
          const { summary, changed } = await updateBundle(cfg, args.bundleId, {
            force: args.force,
            onProgress: (phase, progress, message, total) => {
              tracker.updateProgress(taskId, phase, progress, message, total);
            },
          });

          tracker.completeTask(taskId, args.bundleId);

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
        } catch (updateErr) {
          tracker.failTask(taskId, updateErr instanceof Error ? updateErr.message : String(updateErr));
          throw updateErr;
        }
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
            context: z.object({
              functionName: z.string().optional(),
              className: z.string().optional(),
              startLine: z.number(),
              endLine: z.number(),
              surroundingLines: z.array(z.string()),
            }).optional(),
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
        // Check bundle completeness before any operation
        await assertBundleComplete(cfg, args.bundleId);

        // Resolve bundle location across storageDirs (more robust than a single effectiveDir).
        const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
        if (!storageDir) {
          throw new BundleNotFoundError(args.bundleId);
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
        'Generate an evidence-based dependency graph. Two modes: ' +
        '(1) TARGET MODE: provide target.file to analyze a specific file\'s imports and callers. ' +
        '(2) GLOBAL MODE: omit target to generate a project-wide import graph of all code files. ' +
        'For target mode, file path must be bundle-relative: repos/{owner}/{repo}/norm/{path}. ' +
        'Use preflight_search_bundle to find file paths, or check OVERVIEW.md.',
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
        // Check bundle completeness before generating dependency graph
        await assertBundleComplete(cfg, args.bundleId);

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
        // Check bundle completeness before trace upsert
        await assertBundleComplete(cfg, args.bundleId);

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
        // Check bundle completeness if bundleId is provided
        if (args.bundleId) {
          await assertBundleComplete(cfg, args.bundleId);
        }

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

  // Get task status - for checking progress of in-progress bundle creations
  server.registerTool(
    'preflight_get_task_status',
    {
      title: 'Get task status',
      description: 'Check status of bundle creation tasks (especially in-progress ones). Use when: "check bundle creation progress", "what is the status", "查看任务状态", "下载进度". Can query by taskId (from error), fingerprint, or repos.',
      inputSchema: GetTaskStatusInputSchema,
      outputSchema: {
        found: z.boolean(),
        task: z.object({
          taskId: z.string(),
          fingerprint: z.string(),
          phase: z.string(),
          progress: z.number(),
          total: z.number().optional(),
          message: z.string(),
          startedAt: z.string(),
          updatedAt: z.string(),
          repos: z.array(z.string()),
          bundleId: z.string().optional(),
          error: z.string().optional(),
        }).optional(),
        inProgressLock: z.object({
          bundleId: z.string(),
          status: z.string(),
          startedAt: z.string().optional(),
          taskId: z.string().optional(),
          repos: z.array(z.string()).optional(),
          elapsedSeconds: z.number().optional(),
        }).optional(),
        activeTasks: z.array(z.object({
          taskId: z.string(),
          fingerprint: z.string(),
          phase: z.string(),
          progress: z.number(),
          message: z.string(),
          repos: z.array(z.string()),
          startedAt: z.string(),
        })).optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      try {
        const tracker = getProgressTracker();
        let result: {
          found: boolean;
          task?: TaskProgress;
          inProgressLock?: {
            bundleId: string;
            status: string;
            startedAt?: string;
            taskId?: string;
            repos?: string[];
            elapsedSeconds?: number;
          };
          activeTasks?: TaskProgress[];
        } = { found: false };

        // Compute fingerprint if repos provided
        let fingerprint = args.fingerprint;
        if (!fingerprint && args.repos?.length) {
          fingerprint = computeCreateInputFingerprint({
            repos: args.repos,
            libraries: args.libraries,
            topics: args.topics,
          });
        }

        // Query by taskId
        if (args.taskId) {
          const task = tracker.getTask(args.taskId);
          if (task) {
            result = { found: true, task };
          }
        }
        // Query by fingerprint
        else if (fingerprint) {
          const task = tracker.getTaskByFingerprint(fingerprint);
          if (task) {
            result = { found: true, task };
          }
          
          // Also check persistent in-progress lock
          const lock = await checkInProgressLock(cfg, fingerprint);
          if (lock) {
            const elapsedSeconds = lock.startedAt
              ? Math.round((Date.now() - new Date(lock.startedAt).getTime()) / 1000)
              : undefined;
            result.inProgressLock = {
              bundleId: lock.bundleId,
              status: lock.status ?? 'unknown',
              startedAt: lock.startedAt,
              taskId: lock.taskId,
              repos: lock.repos,
              elapsedSeconds,
            };
            result.found = true;
          }
        }
        // If no specific query, return all active tasks
        else {
          const activeTasks = tracker.listActiveTasks();
          if (activeTasks.length > 0) {
            result = { found: true, activeTasks };
          }
        }

        const summary = result.found
          ? result.task
            ? `Task ${result.task.taskId}: ${result.task.phase} (${result.task.progress}%) - ${result.task.message}`
            : result.activeTasks
              ? `${result.activeTasks.length} active task(s)`
              : result.inProgressLock
                ? `In-progress lock found (started ${result.inProgressLock.elapsedSeconds}s ago)`
                : 'Status found'
          : 'No matching task found';

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
