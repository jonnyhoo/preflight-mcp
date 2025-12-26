import fs from 'node:fs/promises';
import path from 'node:path';

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
import { generateRepoTree, formatTreeResult } from './bundle/tree.js';

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
  dryRun: z.boolean().optional().default(true).describe(
    'If true (default), only preview what would be deleted without actually deleting. ' +
    'Set to false AND provide confirm to actually delete.'
  ),
  confirm: z.string().optional().describe(
    'Required when dryRun=false. Must match bundleId exactly to confirm deletion. ' +
    'This prevents accidental deletions.'
  ),
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
version: '0.2.5',
      description: 'Create evidence-based preflight bundles for repositories (docs + code) with SQLite FTS search.',
    },
    {
      capabilities: {
        resources: {
          // We can emit list changed notifications when new bundles appear.
          listChanged: true,
        },
        prompts: {
          // We provide interactive guidance prompts.
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
        '(1) Omit "file" param → returns ALL key files in one call. ' +
        '(2) Provide "file" param → returns that specific file. ' +
        'Use when: "查看bundle", "show bundle", "read overview", "bundle概览", "项目信息", "读取依赖图".\n\n' +
        '⭐ **Evidence Citation Support:**\n' +
        '- Use `withLineNumbers: true` to get output in `N|line` format for precise citations\n' +
        '- Use `ranges: ["20-80", "100-120"]` to read only specific line ranges\n' +
        '- Combine both for efficient evidence gathering: `{ file: "src/main.ts", withLineNumbers: true, ranges: ["50-100"] }`\n' +
        '- Citation format: `repos/owner/repo/norm/src/main.ts:50-100`\n\n' +
        '⭐ **Recommended Reading Order (AI-optimized summaries are better than raw README):**\n' +
        '1. `OVERVIEW.md` - Project structure & architecture summary (START HERE)\n' +
        '2. `START_HERE.md` - Key entry points & critical paths\n' +
        '3. `AGENTS.md` - AI agent usage guide\n' +
        '4. `analysis/FACTS.json` - Static analysis data (dependencies, exports, etc.)\n' +
        '5. `deps/dependency-graph.json` - Import relationships (if generated)\n' +
        '6. `repos/{owner}/{repo}/norm/README.md` - Original README (only if you need raw docs)\n\n' +
        '📁 **Bundle Structure:**\n' +
        '```\n' +
        'bundle-{id}/\n' +
        '├── OVERVIEW.md            # ⭐ Start here - AI-generated project summary\n' +
        '├── START_HERE.md          # ⭐ Entry points & key files\n' +
        '├── AGENTS.md              # ⭐ AI agent instructions\n' +
        '├── manifest.json          # Bundle metadata\n' +
        '├── analysis/FACTS.json    # Static analysis facts\n' +
        '├── deps/dependency-graph.json  # Import graph (generated on demand)\n' +
        '├── trace/trace.json       # Trace links export (auto-generated after trace_upsert)\n' +
        '├── indexes/search.sqlite3 # FTS5 index (use preflight_search_bundle)\n' +
        '└── repos/{owner}/{repo}/norm/  # Source code & original README\n' +
        '```\n\n' +
        '**File Access:**\n' +
        '- Omit `file` param → returns OVERVIEW + START_HERE + AGENTS + manifest (recommended)\n' +
        '- Original README: `file: "repos/{owner}/{repo}/norm/README.md"`\n' +
        '- Source code: `file: "repos/{owner}/{repo}/norm/{path}"`\n' +
        '- Search code: use preflight_search_bundle instead',
      inputSchema: {
        bundleId: z.string().describe('Bundle ID to read.'),
        file: z.string().optional().describe('Specific file to read (e.g., "deps/dependency-graph.json"). If omitted, uses mode-based batch reading.'),
        mode: z.enum(['light', 'full']).optional().default('light').describe(
          'Batch reading mode (used when file param is omitted). ' +
          'light: OVERVIEW + START_HERE + AGENTS + manifest only (recommended, saves tokens). ' +
          'full: includes README and deps graph too.'
        ),
        includeReadme: z.boolean().optional().default(false).describe('Include repo README files in batch mode (can be large).'),
        includeDepsGraph: z.boolean().optional().default(false).describe('Include deps/dependency-graph.json in batch mode.'),
        withLineNumbers: z.boolean().optional().default(false).describe('If true, prefix each line with line number in "N|" format for evidence citation.'),
        ranges: z.array(z.string()).optional().describe('Line ranges to read, e.g. ["20-80", "100-120"]. Each range is "start-end" (1-indexed, inclusive). If omitted, reads entire file.'),
      },
      outputSchema: {
        bundleId: z.string(),
        mode: z.enum(['light', 'full']).optional().describe('Mode used for batch reading.'),
        file: z.string().optional(),
        content: z.string().optional(),
        files: z.record(z.string(), z.string().nullable()).optional(),
        sections: z.array(z.string()).optional().describe('List of sections/files included in the response.'),
        lineInfo: z.object({
          totalLines: z.number(),
          ranges: z.array(z.object({
            start: z.number(),
            end: z.number(),
          })),
        }).optional(),
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

        // Helper: parse range string "start-end" into { start, end }
        const parseRange = (rangeStr: string): { start: number; end: number } | null => {
          const match = rangeStr.match(/^(\d+)-(\d+)$/);
          if (!match) return null;
          const start = parseInt(match[1]!, 10);
          const end = parseInt(match[2]!, 10);
          if (start < 1 || end < start) return null;
          return { start, end };
        };

        // Helper: format content with optional line numbers and ranges
        const formatContent = (
          rawContent: string,
          withLineNumbers: boolean,
          ranges?: Array<{ start: number; end: number }>
        ): { content: string; lineInfo: { totalLines: number; ranges: Array<{ start: number; end: number }> } } => {
          const lines = rawContent.replace(/\r\n/g, '\n').split('\n');
          const totalLines = lines.length;

          let selectedLines: Array<{ lineNo: number; text: string }> = [];

          if (ranges && ranges.length > 0) {
            // Extract specified ranges
            for (const range of ranges) {
              const start = Math.max(1, range.start);
              const end = Math.min(totalLines, range.end);
              for (let i = start; i <= end; i++) {
                selectedLines.push({ lineNo: i, text: lines[i - 1] ?? '' });
              }
            }
          } else {
            // All lines
            selectedLines = lines.map((text, idx) => ({ lineNo: idx + 1, text }));
          }

          // Format output
          const formatted = withLineNumbers
            ? selectedLines.map((l) => `${l.lineNo}|${l.text}`).join('\n')
            : selectedLines.map((l) => l.text).join('\n');

          const actualRanges = ranges && ranges.length > 0
            ? ranges.map((r) => ({ start: Math.max(1, r.start), end: Math.min(totalLines, r.end) }))
            : [{ start: 1, end: totalLines }];

          return { content: formatted, lineInfo: { totalLines, ranges: actualRanges } };
        };

        // Single file mode
        if (args.file) {
          const absPath = safeJoin(bundleRoot, args.file);
          const rawContent = await fs.readFile(absPath, 'utf8');

          // Parse ranges if provided
          let parsedRanges: Array<{ start: number; end: number }> | undefined;
          if (args.ranges && args.ranges.length > 0) {
            parsedRanges = [];
            for (const rangeStr of args.ranges) {
              const parsed = parseRange(rangeStr);
              if (!parsed) {
                throw new Error(`Invalid range format: "${rangeStr}". Expected "start-end" (e.g., "20-80").`);
              }
              parsedRanges.push(parsed);
            }
            // Sort and merge overlapping ranges
            parsedRanges.sort((a, b) => a.start - b.start);
          }

          const { content, lineInfo } = formatContent(rawContent, args.withLineNumbers ?? false, parsedRanges);

          const out = {
            bundleId: args.bundleId,
            file: args.file,
            content,
            lineInfo,
          };

          // Build text with citation hint
          let textOutput = content;
          if (parsedRanges && parsedRanges.length > 0) {
            const rangeStr = parsedRanges.map((r) => `${r.start}-${r.end}`).join(', ');
            textOutput = `[${args.file}:${rangeStr}] (${lineInfo.totalLines} total lines)\n\n${content}`;
          }

          return {
            content: [{ type: 'text', text: textOutput }],
            structuredContent: out,
          };
        }

        // Batch mode: read key files based on mode
        const mode = args.mode ?? 'light';
        const includeReadme = args.includeReadme ?? (mode === 'full');
        const includeDepsGraph = args.includeDepsGraph ?? (mode === 'full');
        
        // Core files (always included in both modes)
        const coreFiles = ['OVERVIEW.md', 'START_HERE.md', 'AGENTS.md', 'manifest.json'];
        const keyFiles = [...coreFiles];
        
        // Add deps graph if requested or in full mode
        if (includeDepsGraph) {
          keyFiles.push('deps/dependency-graph.json');
        }
        
        const files: Record<string, string | null> = {};
        const sections: string[] = [];

        for (const file of keyFiles) {
          try {
            const absPath = safeJoin(bundleRoot, file);
            files[file] = await fs.readFile(absPath, 'utf8');
            sections.push(file);
          } catch {
            files[file] = null;
          }
        }

        // Try to find and read repo README files (only if requested or in full mode)
        if (includeReadme) {
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
                  sections.push(readmePath);
                  break;
                } catch {
                  // Try next
                }
              }
            }
          } catch {
            // Ignore manifest read errors
          }
        }

        // Build combined text output
        const textParts: string[] = [];
        textParts.push(`[Mode: ${mode}] Sections: ${sections.join(', ')}`);
        textParts.push('');
        
        for (const [filePath, content] of Object.entries(files)) {
          if (content) {
            textParts.push(`=== ${filePath} ===\n${content}`);
          }
        }
        
        // Add hint for getting more content
        if (mode === 'light') {
          textParts.push('');
          textParts.push('---');
          textParts.push('💡 To include README: set includeReadme=true');
          textParts.push('💡 To include dependency graph: set includeDepsGraph=true');
          textParts.push('💡 For all content: set mode="full"');
        }

        const out = { bundleId: args.bundleId, mode, files, sections };
        return {
          content: [{ type: 'text', text: textParts.join('\n') || '(no files found)' }],
          structuredContent: out,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );

  server.registerTool(
    'preflight_repo_tree',
    {
      title: 'Repository tree & statistics',
      description:
        'Get repository structure overview with directory tree, file statistics, and entry point candidates. ' +
        'Use this BEFORE deep analysis to understand project layout without wasting tokens on search. ' +
        'Use when: "show project structure", "what files are in this repo", "项目结构", "文件分布", "show tree".\n\n' +
        '**Output includes:**\n' +
        '- ASCII directory tree (depth-limited)\n' +
        '- File count by extension (.ts, .py, etc.)\n' +
        '- File count by top-level directory\n' +
        '- Entry point candidates (README, main, index, cli, server, etc.)\n\n' +
        '**Recommended workflow:**\n' +
        '1. Call preflight_repo_tree to understand structure\n' +
        '2. Read OVERVIEW.md for AI-generated summary\n' +
        '3. Use preflight_search_bundle to find specific code\n' +
        '4. Use preflight_read_file with ranges for evidence gathering',
      inputSchema: {
        bundleId: z.string().describe('Bundle ID to analyze.'),
        depth: z.number().int().min(1).max(10).default(4).describe('Maximum directory depth to traverse. Default 4.'),
        include: z.array(z.string()).optional().describe('Glob patterns to include (e.g., ["*.ts", "*.py"]). If omitted, includes all files.'),
        exclude: z.array(z.string()).optional().describe('Patterns to exclude (e.g., ["node_modules", "*.pyc"]). Defaults include common excludes.'),
      },
      outputSchema: {
        bundleId: z.string(),
        tree: z.string().describe('ASCII directory tree representation.'),
        stats: z.object({
          totalFiles: z.number(),
          totalDirs: z.number(),
          byExtension: z.record(z.string(), z.number()),
          byTopDir: z.record(z.string(), z.number()),
        }),
        entryPointCandidates: z.array(
          z.object({
            path: z.string(),
            type: z.enum(['readme', 'main', 'index', 'cli', 'server', 'app', 'test', 'config']),
            priority: z.number(),
          })
        ),
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
        const result = await generateRepoTree(paths.rootDir, args.bundleId, {
          depth: args.depth,
          include: args.include,
          exclude: args.exclude,
        });

        const textOutput = formatTreeResult(result);

        return {
          content: [{ type: 'text', text: textOutput }],
          structuredContent: result,
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
      description:
        'Delete/remove a bundle permanently. ' +
        '⚠️ SAFETY: By default runs in dryRun mode (preview only). ' +
        'To actually delete: set dryRun=false AND confirm=bundleId. ' +
        'Use when: "delete bundle", "remove bundle", "清除bundle", "删除索引", "移除仓库".',
      inputSchema: DeleteBundleInputSchema,
      outputSchema: {
        dryRun: z.boolean().describe('Whether this was a dry run (preview only).'),
        deleted: z.boolean().describe('Whether the bundle was actually deleted.'),
        bundleId: z.string(),
        displayName: z.string().optional().describe('Bundle display name (from manifest).'),
        repos: z.array(z.string()).optional().describe('Repos in this bundle.'),
        message: z.string().optional().describe('Human-readable status message.'),
        nextAction: z.object({
          toolName: z.string(),
          paramsTemplate: z.record(z.string(), z.unknown()),
          why: z.string(),
        }).optional().describe('Suggested next action to confirm deletion.'),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async (args) => {
      try {
        const dryRun = args.dryRun ?? true;
        
        // First, verify bundle exists and get info for preview
        const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
        if (!storageDir) {
          throw new BundleNotFoundError(args.bundleId);
        }
        
        // Get bundle info for preview/confirmation
        const paths = getBundlePathsForId(storageDir, args.bundleId);
        let displayName: string | undefined;
        let repos: string[] = [];
        try {
          const manifest = await readManifest(paths.manifestPath);
          displayName = manifest.displayName;
          repos = (manifest.repos ?? []).map((r) => r.id).filter(Boolean);
        } catch {
          // Manifest might be missing/corrupt
        }
        
        // Dry run mode: preview only
        if (dryRun) {
          const out = {
            dryRun: true,
            deleted: false,
            bundleId: args.bundleId,
            displayName,
            repos,
            message: `DRY RUN: Would delete bundle "${displayName || args.bundleId}" containing ${repos.length} repo(s).`,
            nextAction: {
              toolName: 'preflight_delete_bundle',
              paramsTemplate: {
                bundleId: args.bundleId,
                dryRun: false,
                confirm: args.bundleId,
              },
              why: 'Set dryRun=false and confirm=bundleId to actually delete.',
            },
          };
          
          return {
            content: [{ type: 'text', text: `⚠️ ${out.message}\n\nTo confirm deletion:\n- Set dryRun: false\n- Set confirm: "${args.bundleId}"` }],
            structuredContent: out,
          };
        }
        
        // Non-dry-run: require confirm
        if (!args.confirm || args.confirm !== args.bundleId) {
          const out = {
            dryRun: false,
            deleted: false,
            bundleId: args.bundleId,
            displayName,
            repos,
            message: `BLOCKED: confirm must match bundleId exactly. Got "${args.confirm || '(missing)'}", expected "${args.bundleId}".`,
            nextAction: {
              toolName: 'preflight_delete_bundle',
              paramsTemplate: {
                bundleId: args.bundleId,
                dryRun: false,
                confirm: args.bundleId,
              },
              why: 'Provide confirm=bundleId to proceed with deletion.',
            },
          };
          
          return {
            content: [{ type: 'text', text: `❌ ${out.message}` }],
            structuredContent: out,
          };
        }
        
        // Actually delete
        const deleted = await clearBundleMulti(cfg.storageDirs, args.bundleId);
        if (!deleted) {
          throw new BundleNotFoundError(args.bundleId);
        }

        server.sendResourceListChanged();

        const out = {
          dryRun: false,
          deleted: true,
          bundleId: args.bundleId,
          displayName,
          repos,
          message: `Deleted bundle "${displayName || args.bundleId}" (${repos.length} repo(s)).`,
        };
        return {
          content: [{ type: 'text', text: `✅ ${out.message}` }],
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
      description: 'Create a new bundle from GitHub repos or local directories. IMPORTANT: Only call this tool when the user EXPLICITLY asks to create/index a repo. Do NOT automatically create bundles when search fails or bundle is not found - ASK the user first! Use when user says: "index this repo", "create bundle for", "创建bundle", "添加GitHub项目". If ifExists=updateExisting, updates an existing bundle.',
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
        textResponse += `Repos: ${summary.repos.map(r => `${r.id} (${r.source})`).join(', ')}\n\n`;
        // Prompt user for advanced analysis
        textResponse += `📊 **Recommended next steps:**\n`;
        textResponse += `Would you like me to generate a **global dependency graph** for deeper code analysis? ` +
          `This will analyze import relationships across all files.\n`;
        textResponse += `(Call \`preflight_evidence_dependency_graph\` with this bundleId to generate)`;

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
      title: 'Evidence: dependency graph',
      description:
        '**Proactive use recommended**: Generate dependency graphs to understand code structure. ' +
        'Generate an evidence-based dependency graph. IMPORTANT: Before running, ASK the user which bundle and which file/mode they want! ' +
        'Two modes: (1) TARGET MODE: analyze a specific file (provide target.file). (2) GLOBAL MODE: project-wide graph (omit target). ' +
        'Do NOT automatically choose bundle or mode - confirm with user first! ' +
        'File path must be bundle-relative: repos/{owner}/{repo}/norm/{path}.\n\n' +
        '📊 **Coverage Report (Global Mode):**\n' +
        'The response includes a `coverageReport` explaining what was analyzed:\n' +
        '- `scannedFilesCount` / `parsedFilesCount`: Files discovered vs successfully parsed\n' +
        '- `perLanguage`: Statistics per programming language (TypeScript, Python, etc.)\n' +
        '- `perDir`: File counts per top-level directory\n' +
        '- `skippedFiles`: Files that were skipped with reasons (too large, read error, etc.)\n' +
        '- `truncated` / `truncatedReason`: Whether limits were hit\n\n' +
        'Use this to understand graph completeness and identify gaps.\n\n' +
        '📂 **Large File Handling (LLM Guidance):**\n' +
        '- Default: files >1MB are skipped to avoid timeouts\n' +
        '- If coverageReport.skippedFiles shows important files were skipped:\n' +
        '  1. Try `largeFileStrategy: "truncate"` to read first 500 lines\n' +
        '  2. Or increase `maxFileSizeBytes` (e.g., 5000000 for 5MB)\n' +
        '- Options: `{ maxFileSizeBytes: 5000000, largeFileStrategy: "truncate", truncateLines: 1000 }`\n' +
        '- User can override these settings if needed',
      inputSchema: DependencyGraphInputSchema,
      outputSchema: {
        meta: z.any(),
        facts: z.any(),
        signals: z.any(),
        coverageReport: z.object({
          scannedFilesCount: z.number(),
          parsedFilesCount: z.number(),
          perLanguage: z.record(z.string(), z.object({
            scanned: z.number(),
            parsed: z.number(),
            edges: z.number(),
          })),
          perDir: z.record(z.string(), z.number()),
          skippedFiles: z.array(z.object({
            path: z.string(),
            size: z.number().optional(),
            reason: z.string(),
          })),
          truncated: z.boolean(),
          truncatedReason: z.string().optional(),
          limits: z.object({
            maxFiles: z.number(),
            maxNodes: z.number(),
            maxEdges: z.number(),
            timeBudgetMs: z.number(),
          }),
        }).optional().describe('Coverage report explaining what was analyzed and what was skipped (global mode only).'),
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

  // Simplified dependency graph tool for single-point tasks
  server.registerTool(
    'preflight_get_dependency_graph',
    {
      title: 'Get dependency graph (simplified)',
      description:
        'Get dependency graph with minimal parameters. ' +
        'Use when user asks: "show dependencies", "看依赖图", "import graph", "what does X depend on". ' +
        'This is a simplified wrapper around preflight_evidence_dependency_graph.\n\n' +
        '**Modes:**\n' +
        '- `scope: "global"` (default): Project-wide dependency graph\n' +
        '- `scope: "target"` with `targetFile`: Dependencies for a specific file\n\n' +
        '**Format:**\n' +
        '- `format: "summary"` (default): Top nodes, aggregated by directory, key edges only\n' +
        '- `format: "full"`: Complete graph data',
      inputSchema: {
        bundleId: z.string().describe('Bundle ID. Use preflight_list_bundles to find available bundles.'),
        scope: z.enum(['global', 'target']).optional().default('global').describe('global=project-wide, target=single file.'),
        targetFile: z.string().optional().describe('Target file path (required when scope="target"). Use bundle-relative path: repos/{owner}/{repo}/norm/{path}.'),
        format: z.enum(['summary', 'full']).optional().default('summary').describe('summary=aggregated view (recommended), full=raw graph data.'),
        fresh: z.boolean().optional().default(false).describe('If true, regenerate graph even if cached version exists.'),
      },
      outputSchema: {
        bundleId: z.string(),
        scope: z.enum(['global', 'target']),
        format: z.enum(['summary', 'full']),
        // Summary format output
        summary: z.object({
          totalNodes: z.number(),
          totalEdges: z.number(),
          topImporters: z.array(z.object({
            file: z.string(),
            importCount: z.number(),
          })),
          topImported: z.array(z.object({
            file: z.string(),
            importedByCount: z.number(),
          })),
          byDirectory: z.record(z.string(), z.number()),
        }).optional(),
        // Full format passes through to evidence_dependency_graph
        facts: z.any().optional(),
        coverageReport: z.any().optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      try {
        await assertBundleComplete(cfg, args.bundleId);
        
        // Build params for the underlying dependency graph generator
        const depGraphArgs: any = {
          bundleId: args.bundleId,
          options: {
            timeBudgetMs: 30000,
            maxFiles: 500,
            maxNodes: 1000,
            maxEdges: 5000,
          },
        };
        
        if (args.scope === 'target' && args.targetFile) {
          depGraphArgs.target = { file: args.targetFile };
        }
        
        if (args.fresh) {
          depGraphArgs.options.force = true;
        }
        
        const rawResult = await generateDependencyGraph(cfg, depGraphArgs);
        
        // For summary format, aggregate the results
        if (args.format === 'summary') {
          const edges = rawResult.facts?.edges ?? [];
          const nodes = rawResult.facts?.nodes ?? [];
          
          // Count imports per file
          const importCounts: Record<string, number> = {};
          const importedByCounts: Record<string, number> = {};
          const dirCounts: Record<string, number> = {};
          
          for (const edge of edges) {
            if (edge.type === 'imports' || edge.type === 'imports_resolved') {
              const from = typeof edge.from === 'string' ? edge.from.replace(/^file:/, '') : '';
              const to = typeof edge.to === 'string' ? edge.to.replace(/^(file:|module:)/, '') : '';
              
              if (from) {
                importCounts[from] = (importCounts[from] ?? 0) + 1;
                const dir = from.split('/').slice(0, -1).join('/') || '(root)';
                dirCounts[dir] = (dirCounts[dir] ?? 0) + 1;
              }
              if (to && !to.startsWith('.')) {
                importedByCounts[to] = (importedByCounts[to] ?? 0) + 1;
              }
            }
          }
          
          const topImporters = Object.entries(importCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([file, count]) => ({ file, importCount: count }));
          
          const topImported = Object.entries(importedByCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([file, count]) => ({ file, importedByCount: count }));
          
          const out = {
            bundleId: args.bundleId,
            scope: args.scope ?? 'global',
            format: 'summary' as const,
            summary: {
              totalNodes: nodes.length,
              totalEdges: edges.length,
              topImporters,
              topImported,
              byDirectory: dirCounts,
            },
          };
          
          // Build human-readable output
          let text = `## Dependency Graph Summary (${args.scope ?? 'global'})\n\n`;
          text += `- Total nodes: ${nodes.length}\n`;
          text += `- Total edges: ${edges.length}\n\n`;
          text += `### Top Importers (files with most imports)\n`;
          for (const item of topImporters.slice(0, 5)) {
            text += `- ${item.file}: ${item.importCount} imports\n`;
          }
          text += `\n### Most Imported (files imported by others)\n`;
          for (const item of topImported.slice(0, 5)) {
            text += `- ${item.file}: imported by ${item.importedByCount} files\n`;
          }
          text += `\n💡 For full graph data, use format="full"`;
          
          return {
            content: [{ type: 'text', text }],
            structuredContent: out,
          };
        }
        
        // Full format: pass through raw result
        const out = {
          bundleId: args.bundleId,
          scope: args.scope ?? 'global',
          format: 'full' as const,
          facts: rawResult.facts,
          coverageReport: rawResult.coverageReport,
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
    'preflight_trace_upsert',
    {
      title: 'Trace: upsert links',
      description:
        'Create or update traceability links (code↔test, code↔doc, file↔requirement). ' +
        '**Proactive use recommended**: When you discover relationships during code analysis ' +
        '(e.g., "this file has a corresponding test", "this module implements feature X"), ' +
        'automatically create trace links to record these findings for future queries.\n\n' +
        '⚠️ **SAFETY: Use dryRun=true to preview changes before writing.**\n\n' +
        '📌 **When to Write Trace Links (LLM Rules):**\n' +
        'Write trace links ONLY for these 3 high-value relationship types:\n' +
        '1. **Entry ↔ Core module** (entrypoint_of): Main entry points and their critical paths\n' +
        '2. **Implementation ↔ Test** (tested_by): Code files and their corresponding tests\n' +
        '3. **Code ↔ Documentation** (documents/implements): Code implementing specs or documented in files\n\n' +
        '⚠️ **Required Evidence (for tested_by/documents/implements):**\n' +
        '- sources: Array of evidence with file path + line range or note (REQUIRED)\n' +
        '- method: "exact" (parser-verified) or "heuristic" (name-based)\n' +
        '- confidence: 0.0-1.0 (use 0.9 for exact matches, 0.6-0.8 for heuristics)\n' +
        '- Edges without sources will be BLOCKED with actionable guidance\n\n' +
        '❌ **Do NOT write:**\n' +
        '- Pure import relationships (use dependency_graph instead)\n' +
        '- Low-value or obvious relationships\n\n' +
        '**Standard edge_types:** tested_by, documents, implements, relates_to, entrypoint_of, depends_on\n\n' +
        '📤 **Auto-export:** trace.json is automatically exported to trace/trace.json after each upsert for LLM direct reading.',
      inputSchema: TraceUpsertInputSchema,
      outputSchema: {
        bundleId: z.string(),
        dryRun: z.boolean().describe('Whether this was a dry run (preview only).'),
        upserted: z.number().int().describe('Number of edges actually written (0 if dryRun=true).'),
        ids: z.array(z.string()).describe('IDs of upserted edges.'),
        warnings: z.array(z.object({
          edgeIndex: z.number(),
          code: z.string(),
          message: z.string(),
        })).optional().describe('Non-blocking validation warnings.'),
        blocked: z.array(z.object({
          edgeIndex: z.number(),
          code: z.string(),
          message: z.string(),
          nextAction: z.object({
            toolName: z.string(),
            why: z.string(),
          }),
        })).optional().describe('Edges blocked due to validation errors (e.g., missing sources).'),
        preview: z.array(z.object({
          id: z.string(),
          source: z.object({ type: z.string(), id: z.string() }),
          target: z.object({ type: z.string(), id: z.string() }),
          type: z.string(),
          confidence: z.number(),
          method: z.enum(['exact', 'heuristic']),
          sourcesCount: z.number(),
        })).optional().describe('Preview of edges (only in dryRun mode).'),
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
        'Query traceability links (code↔test, code↔doc, commit↔ticket). ' +
        '**Proactive use recommended**: When analyzing a specific file or discussing code structure, ' +
        'automatically query trace links to find related tests, documentation, or requirements. ' +
        'This helps answer questions like "does this code have tests?" or "what requirements does this implement?". ' +
        'Provide bundleId for fast queries; if omitted, scans across bundles (capped). This tool is read-only.',
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
        reason: z.enum(['no_edges', 'no_matching_edges', 'not_initialized', 'no_matching_bundle']).optional()
          .describe('Reason for empty results. no_edges=no trace links exist across bundles, no_matching_edges=links exist but none match query, not_initialized=trace DB empty for this bundle, no_matching_bundle=no bundles found.'),
        nextSteps: z.array(z.string()).optional()
          .describe('Actionable guidance when edges is empty.'),
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
        
        // Build human-readable text output
        let textOutput: string;
        if (out.edges.length === 0 && out.reason) {
          textOutput = `No trace links found.\nReason: ${out.reason}\n\nNext steps:\n${(out.nextSteps ?? []).map(s => `- ${s}`).join('\n')}`;
        } else {
          textOutput = JSON.stringify(out, null, 2);
        }
        
        return {
          content: [{ type: 'text', text: textOutput }],
          structuredContent: out,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );

  server.registerTool(
    'preflight_trace_export',
    {
      title: 'Trace: export to JSON',
      description:
        'Export trace links to trace/trace.json for direct LLM reading. ' +
        'Note: trace.json is auto-exported after each trace_upsert, so this tool is only needed to manually refresh or verify the export. ' +
        'Use when: "export trace", "refresh trace.json", "导出trace", "刷新trace.json".',
      inputSchema: {
        bundleId: z.string().describe('Bundle ID to export trace links from.'),
      },
      outputSchema: {
        bundleId: z.string(),
        exported: z.number().int().describe('Number of edges exported.'),
        jsonPath: z.string().describe('Bundle-relative path to the exported JSON file.'),
      },
      annotations: {
        readOnlyHint: false,
      },
    },
    async (args) => {
      try {
        await assertBundleComplete(cfg, args.bundleId);

        const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
        if (!storageDir) {
          throw new BundleNotFoundError(args.bundleId);
        }

        const paths = getBundlePathsForId(storageDir, args.bundleId);
        const traceDbPath = path.join(paths.rootDir, 'trace', 'trace.sqlite3');
        
        // Import and call exportTraceToJson
        const { exportTraceToJson } = await import('./trace/store.js');
        const result = await exportTraceToJson(traceDbPath);
        
        // Convert absolute path to bundle-relative path
        const jsonRelPath = 'trace/trace.json';
        
        const out = {
          bundleId: args.bundleId,
          exported: result.exported,
          jsonPath: jsonRelPath,
        };

        return {
          content: [{ type: 'text', text: `Exported ${result.exported} trace edge(s) to ${jsonRelPath}` }],
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

  // ============================================================
  // PROMPTS - Interactive guidance for users
  // ============================================================

  // Main menu prompt - shows all available features
  server.registerPrompt(
    'preflight_menu',
    {
      title: 'Preflight 功能菜单',
      description: '显示 Preflight 所有可用功能的交互式菜单。Use when: "preflight有什么功能", "有什么工具", "what can preflight do", "show menu".',
    },
    async () => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `🛠️ **Preflight 功能菜单**

请选择您需要的功能：

**1. 📂 深入分析项目**
创建 bundle 并生成全局依赖图，理解代码架构

**2. 🔍 搜索代码/文档**
在已索引的项目中全文搜索代码和文档

**3. 📋 管理 bundles**
列出、更新、修复、删除已有的 bundle

**4. 🔗 追溯链接**
查询/创建代码-测试-文档之间的关联关系

---
请输入功能编号 (1-4) 或直接描述您的需求。`,
            },
          },
        ],
      };
    }
  );

  // Deep analysis guide prompt
  server.registerPrompt(
    'preflight_analyze_guide',
    {
      title: '深入分析项目指南',
      description: '提供深入分析项目的操作指南和示例 prompt。Use when user selected "深入分析" or wants to analyze a project.',
      argsSchema: {
        projectPath: z.string().optional().describe('项目路径或 GitHub 仓库地址（可选）'),
      },
    },
    async (args) => {
      const pathExample = args.projectPath || 'E:\\coding\\my-project 或 owner/repo';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `📊 **深入分析项目指南**

**第一步：提供项目路径**
- 本地路径：\`E:\\coding\\my-project\`
- GitHub：\`owner/repo\` 或完整 URL

**第二步：复制以下完美 prompt（送给工作 LLM）**

\`\`\`
请执行以下分析流程：

1. 使用 preflight_create_bundle 创建 ${pathExample} 的 bundle
2. 使用 preflight_evidence_dependency_graph 生成全局依赖图
3. 使用 preflight_read_file 读取 bundle 内容，分析：
   - OVERVIEW.md 了解项目概览
   - deps/dependency-graph.json 查看依赖关系
   - START_HERE.md 了解入口点

然后总结：
1. 项目核心功能是什么
2. 主要模块及其关系（基于依赖图）
3. 代码架构特点
\`\`\`

**Bundle 文件结构说明：**
| 文件 | 内容 |
|------|------|
| \`OVERVIEW.md\` | 项目概览和结构总结 |
| \`START_HERE.md\` | 入口文件和关键路径 |
| \`AGENTS.md\` | AI Agent 使用指南 |
| \`deps/dependency-graph.json\` | 依赖关系图（节点+边） |
| \`manifest.json\` | bundle 元数据 |
| \`repos/{owner}/{repo}/norm/\` | 规范化源代码 |

---
💡 提示：搜索功能只能查找代码文件内容，不能搜索依赖图。要查看依赖图，请用 preflight_read_file 读取 deps/dependency-graph.json。`,
            },
          },
        ],
      };
    }
  );

  // Search guide prompt
  server.registerPrompt(
    'preflight_search_guide',
    {
      title: '搜索代码/文档指南',
      description: '提供搜索功能的操作指南和示例 prompt。Use when user selected "搜索" or wants to search in bundles.',
      argsSchema: {
        bundleId: z.string().optional().describe('要搜索的 bundle ID（可选）'),
      },
    },
    async (args) => {
      const bundleHint = args.bundleId ? `bundle \`${args.bundleId}\`` : '指定的 bundle';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `🔍 **搜索代码/文档指南**

**搜索模式：**

**1. 单 bundle 搜索**（需要先知道 bundleId）
\`\`\`
在 ${bundleHint} 中搜索 "config parser"
\`\`\`

**2. 跨 bundle 搜索**（按 tags 过滤）
\`\`\`
在所有 MCP 相关项目中搜索 "tool registration"
在标签为 agent 的项目中搜索 "LLM"
\`\`\`

**3. 列出所有 bundle**（不确定有哪些时）
\`\`\`
列出所有 bundle
或: preflight list bundles
\`\`\`

---
💡 搜索支持 FTS5 全文语法，如：\`config AND parser\`、\`"exact phrase"\``,
            },
          },
        ],
      };
    }
  );

  // Manage bundles guide prompt
  server.registerPrompt(
    'preflight_manage_guide',
    {
      title: '管理 bundles 指南',
      description: '提供 bundle 管理操作的指南。Use when user selected "管理" or wants to manage bundles.',
    },
    async () => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `📋 **管理 Bundles 指南**

**常用操作：**

**列出所有 bundle**
\`\`\`
列出所有 bundle
或: 查看有哪些项目已索引
\`\`\`

**查看 bundle 详情**
\`\`\`
查看 bundle {bundleId} 的概览
或: 读取 bundle {bundleId}
\`\`\`

**更新 bundle**（同步最新代码）
\`\`\`
更新 bundle {bundleId}
或: 检查 {bundleId} 是否有更新
\`\`\`

**修复 bundle**（重建索引）
\`\`\`
修复 bundle {bundleId}
或: 重建 {bundleId} 的搜索索引
\`\`\`

**删除 bundle**
\`\`\`
删除 bundle {bundleId}
\`\`\`

---
💡 先运行「列出所有 bundle」获取 bundleId 列表`,
            },
          },
        ],
      };
    }
  );

  // Trace guide prompt
  server.registerPrompt(
    'preflight_trace_guide',
    {
      title: '追溯链接指南',
      description: '提供代码追溯功能的操作指南。Use when user selected "追溯" or wants to trace code relationships.',
      argsSchema: {
        bundleId: z.string().optional().describe('bundle ID（可选）'),
      },
    },
    async (args) => {
      const bundleHint = args.bundleId || '{bundleId}';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `🔗 **追溯链接指南**

追溯功能用于建立和查询代码之间的关联关系：
- 代码 ↔ 测试
- 代码 ↔ 文档
- 模块 ↔ 需求

**查询已有的追溯链接**
\`\`\`
查询 bundle ${bundleHint} 中 src/main.ts 的相关测试
查询所有 implements 类型的追溯链接
\`\`\`

**创建追溯链接**
\`\`\`
在 bundle ${bundleHint} 中创建追溯：
src/parser.ts 被 tests/parser.test.ts 测试
\`\`\`

**常用链接类型：**
- \`tested_by\` - 被...测试
- \`implements\` - 实现了...
- \`documents\` - 文档描述了...
- \`depends_on\` - 依赖于...
- \`relates_to\` - 相关联

---
💡 追溯链接会持久化存储，便于未来快速查询代码关系`,
            },
          },
        ],
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
