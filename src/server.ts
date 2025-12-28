import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { searchIndex, searchIndexAdvanced, type SearchScope, type GroupedSearchHit } from './search/sqliteFts.js';
import { logger } from './logging/logger.js';
import { runSearchByTags } from './tools/searchByTags.js';
import { cleanupOnStartup, cleanupOrphanBundles } from './bundle/cleanup.js';
import { startHttpServer } from './http/server.js';
import { DependencyGraphInputSchema, generateDependencyGraph } from './evidence/dependencyGraph.js';
import { TraceQueryInputSchema, TraceUpsertInputSchema, traceQuery, traceUpsert } from './trace/service.js';
import { suggestTestedByTraces, type SuggestTracesResult } from './trace/suggest.js';
import { generateRepoTree, formatTreeResult } from './bundle/tree.js';
import { buildDeepAnalysis, detectTestInfo, type TreeSummary, type SearchSummary, type DepsSummary, type TraceSummary, type OverviewContent, type TestInfo, type NextCommand } from './analysis/deep.js';
import { validateReport } from './analysis/validate.js';
import { type Claim, type EvidenceRef, type SourceRange } from './types/evidence.js';
import { extractOutlineWasm, type SymbolOutline } from './ast/treeSitter.js';
// RFC v2: New aggregation tools
import { ReadFilesInputSchema, createReadFilesHandler, readFilesToolDescription } from './tools/readFiles.js';
import { SearchAndReadInputSchema, createSearchAndReadHandler, searchAndReadToolDescription } from './tools/searchAndRead.js';

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
  // New filtering options (v0.3.1)
  excludePatterns: z
    .array(z.string())
    .optional()
    .describe('Exclude paths matching these patterns (e.g., ["**/tests/**", "**/__pycache__/**"]). Reduces noise from test/config files.'),
  maxSnippetLength: z
    .number()
    .int()
    .min(50)
    .max(500)
    .optional()
    .describe('Max length of snippet in each result (default: no limit). Use to reduce token consumption.'),
  // EDDA enhancements (v0.4.0)
  groupByFile: z
    .boolean()
    .optional()
    .describe('If true, group hits by file. Returns {path, hitCount, lines[], topSnippet} instead of individual hits. Reduces tokens significantly.'),
  fileTypeFilters: z
    .array(z.string())
    .optional()
    .describe('Filter by file extensions (e.g., [".py", ".ts"]). Only returns hits from matching files.'),
  includeScore: z
    .boolean()
    .optional()
    .describe('If true, include BM25 relevance score in results. Lower score = more relevant.'),
  // RFC v2: cursor pagination
  cursor: z
    .string()
    .optional()
    .describe('Pagination cursor from previous call. Use to fetch next page of results.'),
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
  // RFC v2: cursor pagination
  cursor: z
    .string()
    .optional()
    .describe('Pagination cursor from previous call. Use to fetch next page of results.'),
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


// Read version from package.json at startup
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
let PACKAGE_VERSION = '0.0.0';
try {
  const pkgJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  PACKAGE_VERSION = pkgJson.version ?? '0.0.0';
} catch {
  // Fallback if package.json cannot be read
}

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
      version: PACKAGE_VERSION,
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
        // RFC v2: cursor pagination
        cursor: z
          .string()
          .optional()
          .describe('Pagination cursor from previous call. Use to fetch next page.'),
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
        // RFC v2: truncation info
        truncation: z.object({
          truncated: z.boolean(),
          nextCursor: z.string().optional(),
          totalCount: z.number().optional(),
          returnedCount: z.number().optional(),
        }).optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      const effectiveDir = await getEffectiveStorageDir(cfg);
      const allIds = await listBundles(effectiveDir);
      
      // RFC v2: Parse cursor for pagination
      const { parseCursorOrDefault, createNextCursor, shouldPaginate } = await import('./mcp/cursor.js');
      const TOOL_NAME = 'preflight_list_bundles';
      const { offset, error: cursorError } = parseCursorOrDefault(args.cursor, TOOL_NAME);
      
      // Sort for stable pagination
      allIds.sort();
      
      // Apply pagination
      const ids = allIds.slice(offset, offset + args.limit);

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

      // RFC v2: Calculate truncation info
      const hasMore = shouldPaginate(ids.length, args.limit, allIds.length, offset);
      const truncation = hasMore
        ? {
            truncated: true,
            nextCursor: createNextCursor(TOOL_NAME, offset, ids.length),
            totalCount: allIds.length,
            returnedCount: filtered.length,
          }
        : { truncated: false, returnedCount: filtered.length, totalCount: allIds.length };

      const out: Record<string, unknown> = { bundles: filtered, truncation };

      // LLM-friendly Markdown format (easier to parse than pipe-separated)
      const lines: string[] = [];
      lines.push(`## Bundles (${filtered.length}${hasMore ? '+' : ''})`);
      lines.push('');
      
      for (const b of filtered) {
        lines.push(`### ${b.displayName}`);
        lines.push(`- **ID**: \`${b.bundleId}\``);
        if (b.repos.length > 0) {
          lines.push(`- **Repos**: ${b.repos.join(', ')}`);
        }
        if (b.tags.length > 0) {
          lines.push(`- **Tags**: ${b.tags.join(', ')}`);
        }
        lines.push('');
      }
      
      // Add pagination hint
      if (hasMore) {
        lines.push('---');
        lines.push(`📄 More bundles available (total: ${allIds.length}). Use cursor to fetch next page.`);
      }
      
      const textOutput = filtered.length > 0 ? lines.join('\n') : '(no bundles found)';

      return {
        content: [{ type: 'text', text: textOutput }],
        structuredContent: out,
      };
    }
  );

  // ==================== NEW: preflight_get_overview ====================
  // Simplified tool for getting project overview - the FIRST step when exploring a bundle
  server.registerTool(
    'preflight_get_overview',
    {
      title: 'Get bundle overview',
      description:
        '⭐ **START HERE** - Get project overview in one call. Returns OVERVIEW.md + START_HERE.md + AGENTS.md. ' +
        'This is the recommended FIRST tool to call when exploring any bundle. ' +
        'Use when: "了解项目", "项目概览", "what is this project", "show overview", "get started".\n\n' +
        '**Returns:**\n' +
        '- OVERVIEW.md: AI-generated project summary & architecture\n' +
        '- START_HERE.md: Key entry points & critical paths\n' +
        '- AGENTS.md: AI agent usage guide\n\n' +
        '**Next steps after overview:**\n' +
        '1. `preflight_repo_tree` - See file structure\n' +
        '2. `preflight_search` - Find specific code\n' +
        '3. `preflight_read_file` - Read specific files',
      inputSchema: {
        bundleId: z.string().describe('Bundle ID to get overview for.'),
      },
      outputSchema: {
        bundleId: z.string(),
        overview: z.string().nullable().describe('OVERVIEW.md content'),
        startHere: z.string().nullable().describe('START_HERE.md content'),
        agents: z.string().nullable().describe('AGENTS.md content'),
        sections: z.array(z.string()).describe('List of available sections'),
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

        const readFile = async (name: string): Promise<string | null> => {
          try {
            return await fs.readFile(safeJoin(bundleRoot, name), 'utf8');
          } catch {
            return null;
          }
        };

        const overview = await readFile('OVERVIEW.md');
        const startHere = await readFile('START_HERE.md');
        const agents = await readFile('AGENTS.md');

        const sections: string[] = [];
        if (overview) sections.push('OVERVIEW.md');
        if (startHere) sections.push('START_HERE.md');
        if (agents) sections.push('AGENTS.md');

        // Build human-readable text output
        const textParts: string[] = [];
        textParts.push(`[Bundle: ${args.bundleId}] Overview (${sections.length} sections)`);
        textParts.push('');
        
        if (overview) {
          textParts.push('=== OVERVIEW.md ===');
          textParts.push(overview);
          textParts.push('');
        }
        if (startHere) {
          textParts.push('=== START_HERE.md ===');
          textParts.push(startHere);
          textParts.push('');
        }
        if (agents) {
          textParts.push('=== AGENTS.md ===');
          textParts.push(agents);
        }

        if (sections.length === 0) {
          textParts.push('⚠️ No overview files found. Try preflight_repo_tree to explore structure.');
        }

        const out = { bundleId: args.bundleId, overview, startHere, agents, sections };
        return {
          content: [{ type: 'text', text: textParts.join('\n') }],
          structuredContent: out,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
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
        mode: z.enum(['light', 'full', 'core']).optional().default('light').describe(
          'Batch reading mode (used when file param is omitted). ' +
          'light: OVERVIEW + START_HERE + AGENTS + manifest only (recommended, saves tokens). ' +
          'full: includes README and deps graph too. ' +
          'core: ⭐ NEW - reads core source files (top imported + entry points) with outline and content.'
        ),
        coreOptions: z.object({
          maxFiles: z.number().int().min(1).max(10).default(5).describe('Max core files to read.'),
          includeOutline: z.boolean().default(true).describe('Include symbol outline for each file.'),
          includeContent: z.boolean().default(true).describe('Include full file content.'),
          tokenBudget: z.number().int().optional().describe('Approximate token budget (chars/4). Files exceeding budget return outline only.'),
        }).optional().describe('Options for mode="core". Controls which files and how much content to return.'),
        includeReadme: z.boolean().optional().default(false).describe('Include repo README files in batch mode (can be large).'),
        includeDepsGraph: z.boolean().optional().default(false).describe('Include deps/dependency-graph.json in batch mode.'),
        withLineNumbers: z.boolean().optional().default(false).describe('If true, prefix each line with line number in "N|" format for evidence citation.'),
        ranges: z.array(z.string()).optional().describe('Line ranges to read, e.g. ["20-80", "100-120"]. Each range is "start-end" (1-indexed, inclusive). If omitted, reads entire file.'),
        // NEW: outline mode for code structure extraction
        outline: z.boolean().optional().default(false).describe(
          'If true, return symbol outline instead of file content. ' +
          'Returns function/class/method/interface/type/enum with line ranges. ' +
          'Saves tokens by showing code structure without full content. ' +
          'Supports: .ts, .tsx, .js, .jsx, .py, .go, .rs files.'
        ),
        // NEW: symbol-based reading
        symbol: z.string().optional().describe(
          'Read a specific symbol (function/class/method) by name. ' +
          'Format: "functionName" or "ClassName" or "ClassName.methodName". ' +
          'Automatically locates and returns the symbol\'s code with context. ' +
          'Requires outline-supported file types (.ts, .tsx, .js, .jsx, .py).'
        ),
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
        // NEW: outline output
        outline: z.array(z.object({
          kind: z.enum(['function', 'class', 'method', 'interface', 'type', 'enum', 'variable']),
          name: z.string(),
          signature: z.string().optional(),
          range: z.object({ startLine: z.number(), endLine: z.number() }),
          exported: z.boolean(),
          children: z.array(z.any()).optional(),
        })).optional().describe('Symbol outline (when outline=true).'),
        language: z.string().optional().describe('Detected language (when outline=true).'),
        // NEW: core mode output
        coreFiles: z.array(z.object({
          path: z.string(),
          reason: z.string().describe('Why this file is considered core (e.g., "Most imported (5 dependents)")'),
          outline: z.array(z.any()).optional().describe('Symbol outline'),
          content: z.string().optional().describe('Full content (if within token budget)'),
          language: z.string().optional(),
          charCount: z.number().describe('Character count of file'),
        })).optional().describe('Core files with outline and content (when mode="core").'),
        coreStats: z.object({
          totalFiles: z.number(),
          totalChars: z.number(),
          truncatedFiles: z.number().describe('Files where content was omitted due to token budget'),
        }).optional().describe('Statistics for core mode.'),
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
          const normalizedContent = rawContent.replace(/\r\n/g, '\n');

          // NEW: Outline mode - extract symbol structure
          if (args.outline) {
            const outlineResult = await extractOutlineWasm(args.file, normalizedContent);
            
            if (!outlineResult) {
              // Unsupported file type
              return {
                content: [{ type: 'text', text: `[${args.file}] Outline not supported for this file type. Supported: .ts, .tsx, .js, .jsx` }],
                structuredContent: {
                  bundleId: args.bundleId,
                  file: args.file,
                  outline: null,
                  language: null,
                },
              };
            }
            
            // Format outline as readable text
            const formatOutlineText = (symbols: SymbolOutline[], indent = ''): string[] => {
              const lines: string[] = [];
              for (let i = 0; i < symbols.length; i++) {
                const sym = symbols[i]!;
                const isLast = i === symbols.length - 1;
                const prefix = indent + (isLast ? '└── ' : '├── ');
                const exportMark = sym.exported ? '⚡' : '';
                const sig = sym.signature ? sym.signature : '';
                lines.push(`${prefix}${exportMark}${sym.kind} ${sym.name}${sig} :${sym.range.startLine}-${sym.range.endLine}`);
                
                if (sym.children && sym.children.length > 0) {
                  const childIndent = indent + (isLast ? '    ' : '│   ');
                  lines.push(...formatOutlineText(sym.children, childIndent));
                }
              }
              return lines;
            };
            
            const outlineText = formatOutlineText(outlineResult.outline);
            const totalSymbols = outlineResult.outline.length;
            const header = `[${args.file}] Outline (${totalSymbols} top-level symbols, ${outlineResult.language}):\n`;
            
            return {
              content: [{ type: 'text', text: header + outlineText.join('\n') }],
              structuredContent: {
                bundleId: args.bundleId,
                file: args.file,
                outline: outlineResult.outline,
                language: outlineResult.language,
              },
            };
          }

          // NEW: Symbol-based reading - locate and read a specific symbol
          if (args.symbol) {
            const outlineResult = await extractOutlineWasm(args.file, normalizedContent);
            
            if (!outlineResult) {
              return {
                content: [{ type: 'text', text: `[${args.file}] Symbol lookup not supported for this file type. Supported: .ts, .tsx, .js, .jsx, .py` }],
                structuredContent: { bundleId: args.bundleId, file: args.file, error: 'unsupported_file_type' },
              };
            }
            
            // Parse symbol query: "funcName" or "ClassName.methodName"
            const parts = args.symbol.split('.');
            const targetName = parts[0]!;
            const methodName = parts[1];
            
            // Find the symbol in outline
            let foundSymbol: SymbolOutline | undefined;
            let foundIn: 'top' | 'child' = 'top';
            
            for (const sym of outlineResult.outline) {
              if (sym.name === targetName) {
                if (methodName && sym.children) {
                  // Looking for a method inside this class
                  const method = sym.children.find(c => c.name === methodName);
                  if (method) {
                    foundSymbol = method;
                    foundIn = 'child';
                    break;
                  }
                } else {
                  foundSymbol = sym;
                  break;
                }
              }
            }
            
            if (!foundSymbol) {
              // Symbol not found - provide helpful error with available symbols
              const available = outlineResult.outline.map(s => {
                if (s.children && s.children.length > 0) {
                  return `${s.name} (${s.kind}, methods: ${s.children.map(c => c.name).join(', ')})`;
                }
                return `${s.name} (${s.kind})`;
              }).join(', ');
              
              return {
                content: [{ type: 'text', text: `[${args.file}] Symbol "${args.symbol}" not found.\n\nAvailable symbols: ${available}` }],
                structuredContent: { bundleId: args.bundleId, file: args.file, error: 'symbol_not_found', available: outlineResult.outline.map(s => s.name) },
              };
            }
            
            // Read the symbol's code (with 2 lines of context before)
            const contextLines = 2;
            const startLine = Math.max(1, foundSymbol.range.startLine - contextLines);
            const endLine = foundSymbol.range.endLine;
            
            const { content, lineInfo } = formatContent(rawContent, true, [{ start: startLine, end: endLine }]);
            
            const header = `[${args.file}:${startLine}-${endLine}] ${foundSymbol.kind} ${foundSymbol.name}${foundSymbol.signature || ''}\n\n`;
            
            return {
              content: [{ type: 'text', text: header + content }],
              structuredContent: {
                bundleId: args.bundleId,
                file: args.file,
                symbol: foundSymbol,
                content,
                lineInfo,
              },
            };
          }

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
        
        // ==================== MODE: CORE ====================
        // Read core source files (top imported + entry points) with outline and content
        if (mode === 'core') {
          const coreOpts = (args.coreOptions ?? {}) as {
            maxFiles?: number;
            includeOutline?: boolean;
            includeContent?: boolean;
            tokenBudget?: number;
          };
          const maxFiles = coreOpts.maxFiles ?? 5;
          const includeOutline = coreOpts.includeOutline ?? true;
          const includeContent = coreOpts.includeContent ?? true;
          const tokenBudget = coreOpts.tokenBudget; // chars / 4 ≈ tokens
          const charBudget = tokenBudget ? tokenBudget * 4 : undefined;
          
          // Step 1: Generate dependency graph to find core files
          let depResult;
          try {
            depResult = await generateDependencyGraph(cfg, {
              bundleId: args.bundleId,
              options: { timeBudgetMs: 10000, maxNodes: 200, maxEdges: 1000 },
            });
          } catch {
            depResult = null;
          }
          
          // Step 2: Identify core files (most imported + entry points)
          const coreFileCandidates: Array<{ path: string; reason: string; score: number }> = [];
          
          if (depResult?.facts?.edges) {
            // Count how many times each file is imported
            const importedByCounts: Record<string, number> = {};
            for (const edge of depResult.facts.edges) {
              if (edge.type === 'imports' || edge.type === 'imports_resolved') {
                const to = typeof edge.to === 'string' ? edge.to.replace(/^(file:|module:)/, '') : '';
                if (to && !to.startsWith('node_modules') && !to.includes('node:')) {
                  importedByCounts[to] = (importedByCounts[to] ?? 0) + 1;
                }
              }
            }
            
            // Sort by import count and add top files
            const sortedByImports = Object.entries(importedByCounts)
              .sort((a, b) => b[1] - a[1])
              .slice(0, maxFiles * 2); // Get more candidates for filtering
            
            for (const [filePath, count] of sortedByImports) {
              coreFileCandidates.push({
                path: filePath,
                reason: `Most imported (${count} dependents)`,
                score: count * 10,
              });
            }
          }
          
          // Add entry points (index.ts, main.ts, etc.)
          const entryPointPatterns = [
            { pattern: /\/(index|main)\.(ts|js|tsx|jsx)$/i, reason: 'Entry point', score: 50 },
            { pattern: /\/app\.(ts|js|tsx|jsx)$/i, reason: 'App entry', score: 40 },
            { pattern: /\/server\.(ts|js)$/i, reason: 'Server entry', score: 40 },
            { pattern: /\/types\.(ts|d\.ts)$/i, reason: 'Type definitions', score: 30 },
          ];
          
          // Scan for entry points in repos directory
          const scanEntryPoints = async (dir: string, relPath: string): Promise<void> => {
            try {
              const entries = await fs.readdir(dir, { withFileTypes: true });
              for (const entry of entries) {
                if (entry.name.startsWith('.') || ['node_modules', '__pycache__', 'dist', 'build'].includes(entry.name)) continue;
                const fullPath = path.join(dir, entry.name);
                const entryRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;
                
                if (entry.isFile()) {
                  for (const ep of entryPointPatterns) {
                    if (ep.pattern.test('/' + entryRelPath)) {
                      // Check if already in candidates
                      const existing = coreFileCandidates.find(c => c.path.endsWith(entry.name) || c.path === entryRelPath);
                      if (!existing) {
                        coreFileCandidates.push({ path: entryRelPath, reason: ep.reason, score: ep.score });
                      }
                    }
                  }
                } else if (entry.isDirectory() && relPath.split('/').length < 6) {
                  await scanEntryPoints(fullPath, entryRelPath);
                }
              }
            } catch { /* ignore */ }
          };
          
          await scanEntryPoints(paths.reposDir, 'repos');
          
          // Sort by score and dedupe
          coreFileCandidates.sort((a, b) => b.score - a.score);
          const seenPaths = new Set<string>();
          const uniqueCandidates = coreFileCandidates.filter(c => {
            const key = c.path.split('/').pop() ?? c.path;
            if (seenPaths.has(key)) return false;
            seenPaths.add(key);
            return true;
          }).slice(0, maxFiles);
          
          // Step 3: Read each core file with outline and content
          const coreFilesResult: Array<{
            path: string;
            reason: string;
            outline?: SymbolOutline[];
            content?: string;
            language?: string;
            charCount: number;
          }> = [];
          
          let totalChars = 0;
          let truncatedFiles = 0;
          
          for (const candidate of uniqueCandidates) {
            // Resolve actual file path
            let actualPath = candidate.path;
            let absPath: string;
            
            // Try different path resolutions
            const pathsToTry = [
              candidate.path,
              `repos/${candidate.path}`,
              candidate.path.startsWith('repos/') ? candidate.path : null,
            ].filter(Boolean) as string[];
            
            let fileContent: string | null = null;
            for (const tryPath of pathsToTry) {
              try {
                absPath = safeJoin(bundleRoot, tryPath);
                fileContent = await fs.readFile(absPath, 'utf8');
                actualPath = tryPath;
                break;
              } catch { /* try next */ }
            }
            
            if (!fileContent) continue;
            
            const charCount = fileContent.length;
            const withinBudget = !charBudget || (totalChars + charCount <= charBudget);
            
            const result: typeof coreFilesResult[number] = {
              path: actualPath,
              reason: candidate.reason,
              charCount,
            };
            
            // Extract outline if requested
            if (includeOutline) {
              const outlineResult = await extractOutlineWasm(actualPath, fileContent);
              if (outlineResult) {
                result.outline = outlineResult.outline;
                result.language = outlineResult.language;
              }
            }
            
            // Include content if requested and within budget
            if (includeContent && withinBudget) {
              result.content = fileContent;
              totalChars += charCount;
            } else if (includeContent && !withinBudget) {
              truncatedFiles++;
            }
            
            coreFilesResult.push(result);
          }
          
          // Build text output
          const textParts: string[] = [];
          textParts.push(`[Mode: core] ${coreFilesResult.length} core files identified`);
          textParts.push(`Total: ${totalChars} chars (~${Math.round(totalChars / 4)} tokens)`);
          if (truncatedFiles > 0) {
            textParts.push(`⚠️ ${truncatedFiles} file(s) exceeded token budget - showing outline only`);
          }
          textParts.push('');
          
          for (const cf of coreFilesResult) {
            textParts.push(`=== ${cf.path} (${cf.reason}) ===`);
            
            // Show outline
            if (cf.outline && cf.outline.length > 0) {
              textParts.push(`[Outline - ${cf.outline.length} symbols]`);
              for (const sym of cf.outline.slice(0, 10)) {
                const exp = sym.exported ? '⚡' : '';
                textParts.push(`  ${exp}${sym.kind} ${sym.name}${sym.signature || ''} :${sym.range.startLine}-${sym.range.endLine}`);
              }
              if (cf.outline.length > 10) {
                textParts.push(`  ... and ${cf.outline.length - 10} more symbols`);
              }
            }
            
            // Show content
            if (cf.content) {
              textParts.push(`[Content - ${cf.charCount} chars]`);
              textParts.push('```' + (cf.language || ''));
              textParts.push(cf.content);
              textParts.push('```');
            }
            textParts.push('');
          }
          
          const out = {
            bundleId: args.bundleId,
            mode: 'core' as const,
            coreFiles: coreFilesResult,
            coreStats: {
              totalFiles: coreFilesResult.length,
              totalChars,
              truncatedFiles,
            },
          };
          
          return {
            content: [{ type: 'text', text: textParts.join('\n') }],
            structuredContent: out,
          };
        }
        
        // ==================== MODE: LIGHT / FULL ====================
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
          textParts.push('💡 ⭐ For core source code: set mode="core"');
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
        // EDDA enhancements
        focusDir: z.string().optional().describe('Focus directory path - expand deeper within this path (e.g., "owner/repo/norm/src"). Gets +3 extra depth levels.'),
        focusDepthBonus: z.number().int().min(1).max(6).optional().describe('Extra depth levels for focusDir. Default 3.'),
        showFileCountPerDir: z.boolean().optional().describe('If true, include file count per directory in stats.byDir.'),
        showSkippedFiles: z.boolean().optional().describe('If true, include list of files that were skipped during indexing (too large, binary, etc.). Helps understand what content is NOT searchable.'),
      },
      outputSchema: {
        bundleId: z.string(),
        tree: z.string().describe('ASCII directory tree representation.'),
        stats: z.object({
          totalFiles: z.number(),
          totalDirs: z.number(),
          byExtension: z.record(z.string(), z.number()),
          byTopDir: z.record(z.string(), z.number()),
          byDir: z.record(z.string(), z.number()).optional().describe('File count per directory (when showFileCountPerDir=true).'),
        }),
        entryPointCandidates: z.array(
          z.object({
            path: z.string(),
            type: z.enum(['readme', 'main', 'index', 'cli', 'server', 'app', 'test', 'config']),
            priority: z.number(),
          })
        ),
        skippedFiles: z.array(
          z.object({
            path: z.string(),
            reason: z.string(),
            size: z.number().optional(),
          })
        ).optional().describe('Files skipped during indexing (only when showSkippedFiles=true). These files are NOT searchable.'),
        autoFocused: z.object({
          enabled: z.boolean(),
          path: z.string().optional(),
        }).optional().describe('Auto-focus info for single-repo bundles. When enabled, tree starts from repos/{source}/{repo}/norm instead of repos/.'),
        // RFC v2: Evidence pointers
        evidence: z.array(
          z.object({
            path: z.string(),
            range: z.object({
              startLine: z.number(),
              endLine: z.number(),
            }).optional(),
            uri: z.string().optional(),
            snippet: z.string().optional(),
          })
        ).optional().describe('Evidence pointers to key entry point files.'),
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
          focusDir: args.focusDir,
          focusDepthBonus: args.focusDepthBonus,
          showFileCountPerDir: args.showFileCountPerDir,
        });

        // Add skipped files if requested
        let skippedFiles: Array<{ path: string; reason: string; size?: number }> | undefined;
        if (args.showSkippedFiles) {
          try {
            const manifest = await readManifest(paths.manifestPath);
            if (manifest.skippedFiles && manifest.skippedFiles.length > 0) {
              const reasonLabels: Record<string, string> = {
                too_large: 'too large',
                binary: 'binary file',
                non_utf8: 'non-UTF8 encoding',
                max_total_reached: 'bundle size limit reached',
              };
              skippedFiles = manifest.skippedFiles.map(s => ({
                path: s.path,
                reason: reasonLabels[s.reason] ?? s.reason,
                size: s.size,
              }));
            }
          } catch {
            // Ignore manifest read errors
          }
        }

        // RFC v2: Build evidence array from entry point candidates
        const evidence = result.entryPointCandidates
          .slice(0, 5) // Top 5 entry points as evidence
          .map((ep) => ({
            path: ep.path,
            uri: toBundleFileUri({ bundleId: args.bundleId, relativePath: ep.path }),
          }));

        const textOutput = formatTreeResult(result);
        let fullTextOutput = textOutput;
        if (skippedFiles && skippedFiles.length > 0) {
          fullTextOutput += `\n\n## Skipped Files (${skippedFiles.length} files not searchable)\n`;
          for (const sf of skippedFiles.slice(0, 20)) {
            const sizeStr = sf.size ? ` (${(sf.size / 1024).toFixed(0)}KB)` : '';
            fullTextOutput += `- ${sf.path}: ${sf.reason}${sizeStr}\n`;
          }
          if (skippedFiles.length > 20) {
            fullTextOutput += `... and ${skippedFiles.length - 20} more\n`;
          }
        }

        const structuredResult = { ...result, skippedFiles, evidence };
        return {
          content: [{ type: 'text', text: fullTextOutput }],
          structuredContent: structuredResult,
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
      description: 'Create a new bundle from GitHub repos or local directories. ' +
        '**Safe to call proactively** - use `ifExists: "returnExisting"` to avoid duplicates. ' +
        'Bundle creation is a **read-only collection** operation (clones repo, builds index, generates guides). ' +
        'When user asks to analyze/understand a project, create the bundle first if it does not exist. ' +
        'Use when: "analyze this repo", "understand this codebase", "index project", "分析项目", "理解代码".',
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
        // RFC v2: truncation info
        truncation: z.object({
          truncated: z.boolean(),
          nextCursor: z.string().optional(),
          reason: z.string().optional(),
          returnedCount: z.number().optional(),
        }).optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      // RFC v2: Parse cursor for pagination
      const { parseCursorOrDefault, createNextCursor } = await import('./mcp/cursor.js');
      const TOOL_NAME = 'preflight_search_by_tags';
      const { offset, error: cursorError } = parseCursorOrDefault(args.cursor, TOOL_NAME);
      const pageSize = args.limit;

      const effectiveDir = await getEffectiveStorageDir(cfg);
      const allBundleIds = await listBundles(effectiveDir);

      // Fetch extra items to detect if there are more results
      const fetchLimit = offset + pageSize + 1;
      const result = await runSearchByTags({
        bundleIds: allBundleIds,
        query: args.query,
        tags: args.tags,
        scope: args.scope as SearchScope,
        limit: fetchLimit,
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

      // Apply cursor pagination
      const hasMore = result.hits.length > offset + pageSize;
      const paginatedHits = result.hits.slice(offset, offset + pageSize);

      const out: Record<string, unknown> = {
        query: args.query,
        tags: args.tags,
        scope: args.scope,
        totalBundlesSearched: result.totalBundlesSearched,
        hits: paginatedHits,
        warnings: result.warnings,
        warningsTruncated: result.warningsTruncated,
      };

      // RFC v2: Add truncation info
      if (hasMore || offset > 0 || cursorError) {
        out.truncation = {
          truncated: hasMore,
          returnedCount: paginatedHits.length,
          ...(hasMore && { nextCursor: createNextCursor(TOOL_NAME, offset, pageSize) }),
          ...(cursorError && { reason: cursorError }),
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    }
  );

  // ==========================================================================
  // RFC v2: New aggregation tools for LLM optimization
  // ==========================================================================

  // preflight_read_files - Batch file reading
  const readFilesHandler = createReadFilesHandler({
    findBundleStorageDir: (storageDirs, bundleId) => findBundleStorageDir(storageDirs, bundleId),
    getBundlePathsForId: (storageDir, bundleId) => getBundlePathsForId(storageDir, bundleId),
    storageDirs: cfg.storageDirs,
  });

  server.registerTool(
    'preflight_read_files',
    {
      title: readFilesToolDescription.title,
      description: readFilesToolDescription.description,
      inputSchema: ReadFilesInputSchema,
      outputSchema: {
        ok: z.boolean(),
        meta: z.object({
          tool: z.string(),
          schemaVersion: z.string(),
          requestId: z.string(),
          timeMs: z.number(),
          bundleId: z.string().optional(),
        }),
        data: z.object({
          bundleId: z.string(),
          files: z.array(z.object({
            path: z.string(),
            content: z.string(),
            lineInfo: z.object({
              totalLines: z.number(),
              ranges: z.array(z.object({ start: z.number(), end: z.number() })),
            }),
            error: z.string().optional(),
          })),
        }).optional(),
        error: z.object({
          code: z.string(),
          message: z.string(),
          hint: z.string().optional(),
        }).optional(),
        warnings: z.array(z.object({
          code: z.string(),
          message: z.string(),
          recoverable: z.boolean(),
        })).optional(),
        evidence: z.array(z.object({
          path: z.string(),
          range: z.object({
            startLine: z.number(),
            endLine: z.number(),
          }),
          uri: z.string().optional(),
          snippet: z.string().optional(),
        })).optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      const result = await readFilesHandler(args);
      return {
        content: [{ type: 'text', text: result.text }],
        structuredContent: result.structuredContent,
      };
    }
  );

  // preflight_search_and_read - Search with excerpts
  const searchAndReadHandler = createSearchAndReadHandler({
    findBundleStorageDir: (storageDirs, bundleId) => findBundleStorageDir(storageDirs, bundleId),
    getBundlePathsForId: (storageDir, bundleId) => getBundlePathsForId(storageDir, bundleId),
    assertBundleComplete: (bundleId) => assertBundleComplete(cfg, bundleId),
    storageDirs: cfg.storageDirs,
  });

  server.registerTool(
    'preflight_search_and_read',
    {
      title: searchAndReadToolDescription.title,
      description: searchAndReadToolDescription.description,
      inputSchema: SearchAndReadInputSchema,
      outputSchema: {
        ok: z.boolean(),
        meta: z.object({
          tool: z.string(),
          schemaVersion: z.string(),
          requestId: z.string(),
          timeMs: z.number(),
          bundleId: z.string().optional(),
        }),
        data: z.object({
          bundleId: z.string(),
          query: z.string(),
          scope: z.enum(['docs', 'code', 'all']),
          hits: z.array(z.object({
            path: z.string(),
            repo: z.string(),
            kind: z.enum(['doc', 'code']),
            matchRange: z.object({ startLine: z.number(), endLine: z.number() }),
            excerptRange: z.object({ startLine: z.number(), endLine: z.number() }),
            excerpt: z.string(),
            score: z.number().optional(),
          })),
        }).optional(),
        error: z.object({
          code: z.string(),
          message: z.string(),
          hint: z.string().optional(),
        }).optional(),
        warnings: z.array(z.object({
          code: z.string(),
          message: z.string(),
          recoverable: z.boolean(),
        })).optional(),
        nextActions: z.array(z.object({
          tool: z.string(),
          args: z.record(z.string(), z.unknown()),
          reason: z.string(),
        })).optional(),
        truncation: z.object({
          truncated: z.boolean(),
          nextCursor: z.string().optional(),
          reason: z.string().optional(),
          returnedCount: z.number().optional(),
        }).optional(),
        evidence: z.array(z.object({
          path: z.string(),
          range: z.object({
            startLine: z.number(),
            endLine: z.number(),
          }),
          uri: z.string().optional(),
          snippet: z.string().optional(),
        })).optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      const result = await searchAndReadHandler(args);
      return {
        content: [{ type: 'text', text: result.text }],
        structuredContent: result.structuredContent,
      };
    }
  );

  // ==========================================================================
  // End RFC v2 tools
  // ==========================================================================

  server.registerTool(
    'preflight_search_bundle',
    {
      title: 'Search bundle (DEPRECATED)',
      description: '⚠️ **DEPRECATED**: Use `preflight_search_and_read` instead. ' +
        'For index-only search without reading content, use `preflight_search_and_read` with `readContent: false`.\n\n' +
        'Full-text search in bundle docs and code (strictly read-only). If you need to update or repair, call preflight_update_bundle or preflight_repair_bundle explicitly, then search again.',
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
            score: z.number().optional().describe('BM25 relevance score (lower is more relevant).'),
            uri: z.string(),
            context: z.object({
              functionName: z.string().optional(),
              className: z.string().optional(),
              startLine: z.number(),
              endLine: z.number(),
              surroundingLines: z.array(z.string()),
            }).optional(),
          })
        ).describe('Individual hits (empty when groupByFile=true).'),
        // EDDA grouped results
        grouped: z.array(
          z.object({
            path: z.string(),
            repo: z.string(),
            kind: z.enum(['doc', 'code']),
            hitCount: z.number().describe('Number of matching lines in this file.'),
            lines: z.array(z.number()).describe('Line numbers of all matches.'),
            topSnippet: z.string().describe('Best matching snippet.'),
            topScore: z.number().optional().describe('Best score (most relevant).'),
          })
        ).optional().describe('Grouped results by file (only when groupByFile=true).'),
        meta: z.object({
          tokenBudgetHint: z.string().optional().describe('Hint about token savings from groupByFile.'),
        }).optional().describe('Search metadata for EDDA optimization.'),
        // Skipped files hint for transparency
        skippedFilesHint: z.object({
          message: z.string().describe('Human-readable hint explaining why some content might be missing.'),
          skippedCount: z.number().describe('Total number of files skipped during indexing.'),
          examples: z.array(z.object({
            path: z.string(),
            reason: z.string(),
            size: z.number().optional(),
          })).describe('Example skipped files (limited to 5).'),
        }).optional().describe('Present when search returns 0 results and files were skipped during indexing. Helps explain why expected content might be missing.'),
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
        // RFC v2: truncation info
        truncation: z.object({
          truncated: z.boolean(),
          nextCursor: z.string().optional(),
          reason: z.string().optional(),
          returnedCount: z.number().optional(),
        }).optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      try {
        // Check bundle completeness before any operation
        await assertBundleComplete(cfg, args.bundleId);
        
        // RFC v2: Parse cursor for pagination
        const { parseCursorOrDefault, createNextCursor, shouldPaginate } = await import('./mcp/cursor.js');
        const TOOL_NAME = 'preflight_search_bundle';
        const { offset, error: cursorError } = parseCursorOrDefault(args.cursor, TOOL_NAME);
        const pageSize = args.limit; // Use limit as page size

        // Resolve bundle location across storageDirs (more robust than a single effectiveDir).
        const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
        if (!storageDir) {
          throw new BundleNotFoundError(args.bundleId);
        }

        // P1: Collect warnings for deprecated parameters instead of throwing
        const warnings: Array<{ code: string; message: string }> = [];
        
        if (args.ensureFresh !== undefined) {
          warnings.push({
            code: 'DEPRECATED_PARAM',
            message: 'ensureFresh is deprecated and ignored. This tool is strictly read-only. Use preflight_update_bundle separately, then search again.',
          });
        }

        if (args.autoRepairIndex !== undefined) {
          warnings.push({
            code: 'DEPRECATED_PARAM',
            message: 'autoRepairIndex is deprecated and ignored. This tool is strictly read-only. Use preflight_repair_bundle separately, then search again.',
          });
        }
        
        if (args.maxAgeHours !== undefined) {
          warnings.push({
            code: 'DEPRECATED_PARAM',
            message: 'maxAgeHours is deprecated and ignored (was only used with ensureFresh).',
          });
        }

        const paths = getBundlePathsForId(storageDir, args.bundleId);

        // Helper to build skippedFilesHint when search returns 0 results
        const buildSkippedFilesHint = async (): Promise<{
          message: string;
          skippedCount: number;
          examples: Array<{ path: string; reason: string; size?: number }>;
        } | undefined> => {
          try {
            const manifest = await readManifest(paths.manifestPath);
            if (!manifest.skippedFiles || manifest.skippedFiles.length === 0) {
              return undefined;
            }
            const skipped = manifest.skippedFiles;
            const reasonLabels: Record<string, string> = {
              too_large: 'too large',
              binary: 'binary file',
              non_utf8: 'non-UTF8 encoding',
              max_total_reached: 'bundle size limit reached',
            };
            return {
              message: `Search returned 0 results. Note: ${skipped.length} file(s) were skipped during indexing and are not searchable. Check if your target content might be in a skipped file.`,
              skippedCount: skipped.length,
              examples: skipped.slice(0, 5).map(s => ({
                path: s.path,
                reason: reasonLabels[s.reason] ?? s.reason,
                size: s.size,
              })),
            };
          } catch {
            return undefined;
          }
        };

        // Use advanced search if EDDA features are requested
        const useAdvanced = args.groupByFile || args.fileTypeFilters?.length || args.includeScore;
        
        if (useAdvanced) {
          // EDDA-enhanced search path
          // Fetch extra items to detect if there are more results
          const fetchLimit = offset + pageSize + 1;
          const result = searchIndexAdvanced(paths.searchDbPath, args.query, {
            scope: args.scope as SearchScope,
            limit: fetchLimit,
            bundleRoot: paths.rootDir,
            includeScore: args.includeScore,
            fileTypeFilters: args.fileTypeFilters,
            groupByFile: args.groupByFile,
          });

          // Apply excludePatterns to grouped results
          let grouped = result.grouped;
          if (grouped && args.excludePatterns?.length) {
            const patterns = args.excludePatterns.map(p => {
              const regexStr = p
                .replace(/\./g, '\\.')
                .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
                .replace(/\*/g, '[^/]*')
                .replace(/<<<DOUBLESTAR>>>/g, '.*');
              return new RegExp(regexStr, 'i');
            });
            grouped = grouped.filter(g => !patterns.some(re => re.test(g.path)));
          }

          // Apply cursor pagination to grouped results
          const totalGrouped = grouped?.length ?? 0;
          const hasMoreGrouped = totalGrouped > offset + pageSize;
          if (grouped) {
            grouped = grouped.slice(offset, offset + pageSize);
          }
          
          // Also paginate hits
          const totalHits = result.hits.length;
          const hasMoreHits = totalHits > offset + pageSize;
          const paginatedHits = result.hits.slice(offset, offset + pageSize);

          // Apply maxSnippetLength to grouped topSnippet
          if (grouped && args.maxSnippetLength) {
            grouped = grouped.map(g => ({
              ...g,
              topSnippet: g.topSnippet.length > args.maxSnippetLength!
                ? g.topSnippet.slice(0, args.maxSnippetLength!) + '…'
                : g.topSnippet,
            }));
          }

          // Auto-compress: extract common repo to top-level if all results from same repo
          let commonRepo: string | undefined;
          if (grouped && grouped.length > 0) {
            const repos = new Set(grouped.map(g => g.repo));
            if (repos.size === 1 && grouped[0]) {
              commonRepo = grouped[0].repo;
            }
          }

          // Build compressed grouped results (omit repo when extracted to top-level)
          const compressedGrouped = grouped?.map(g => {
            const { repo, ...rest } = g;
            return commonRepo ? rest : g;
          });

          const out: Record<string, unknown> = {
            bundleId: args.bundleId,
            query: args.query,
            scope: args.scope,
            // Auto-compress: omit uri (can be derived from bundleId + path)
            hits: paginatedHits.map(h => {
              const { context, ...rest } = h;
              // Auto-compress: trim surroundingLines to save tokens
              const compressedContext = context ? {
                ...context,
                surroundingLines: context.surroundingLines?.slice(0, 5),
              } : undefined;
              return compressedContext ? { ...rest, context: compressedContext } : rest;
            }),
            grouped: compressedGrouped,
            ...(commonRepo && { repo: commonRepo }), // Extracted common repo
            meta: result.meta,
          };
          
          if (warnings.length > 0) {
            out.warnings = warnings;
          }

          // Add skippedFilesHint when 0 results
          const hasNoResults = paginatedHits.length === 0 && (!grouped || grouped.length === 0);
          if (hasNoResults) {
            const hint = await buildSkippedFilesHint();
            if (hint) {
              out.skippedFilesHint = hint;
            }
          }

          // RFC v2: Add truncation info with cursor pagination
          const hasMore = hasMoreGrouped || hasMoreHits;
          if (hasMore || offset > 0 || cursorError) {
            const returnedCount = (grouped?.length ?? 0) + paginatedHits.length;
            out.truncation = {
              truncated: hasMore,
              returnedCount,
              ...(hasMore && { nextCursor: createNextCursor(TOOL_NAME, offset, pageSize) }),
              ...(cursorError && { reason: cursorError }),
            };
          }

          return {
            content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
            structuredContent: out,
          };
        }

        // Legacy search path with cursor pagination
        // Fetch extra items to detect if there are more results after pagination
        const baseFetchLimit = args.excludePatterns?.length ? Math.min(pageSize * 2, 200) : pageSize;
        const fetchLimit = offset + baseFetchLimit + 1;
        let rawHits = searchIndex(paths.searchDbPath, args.query, args.scope as SearchScope, fetchLimit, paths.rootDir);

        // Apply excludePatterns filter
        if (args.excludePatterns && args.excludePatterns.length > 0) {
          const patterns = args.excludePatterns.map(p => {
            const regexStr = p
              .replace(/\./g, '\\.')
              .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
              .replace(/\*/g, '[^/]*')
              .replace(/<<<DOUBLESTAR>>>/g, '.*');
            return new RegExp(regexStr, 'i');
          });
          rawHits = rawHits.filter(h => !patterns.some(re => re.test(h.path)));
        }

        // Check if there are more results after current page
        const hasMore = rawHits.length > offset + pageSize;
        // Apply cursor pagination
        rawHits = rawHits.slice(offset, offset + pageSize);

        // Auto-compress: extract common repo if all hits from same repo
        let commonRepo: string | undefined;
        if (rawHits.length > 0 && rawHits[0]) {
          const repos = new Set(rawHits.map(h => h.repo).filter(Boolean));
          if (repos.size === 1) {
            commonRepo = rawHits[0].repo;
          }
        }

        const hits = rawHits.map((h) => {
          // Auto-compress: omit uri (derivable from bundleId + path), omit repo when extracted
          const { uri: _uri, repo, context, ...rest } = h as Record<string, unknown>;
          const hit: Record<string, unknown> = commonRepo && repo === commonRepo
            ? rest  // Omit repo when extracted to top-level
            : { ...rest, ...(repo ? { repo } : {}) };
          
          // Apply maxSnippetLength truncation
          if (args.maxSnippetLength && h.snippet && h.snippet.length > args.maxSnippetLength) {
            hit.snippet = h.snippet.slice(0, args.maxSnippetLength) + '…';
          }
          
          // Auto-compress: limit surroundingLines to save tokens (default 5, or based on maxSnippetLength)
          if ((context as { surroundingLines?: string[] } | undefined)?.surroundingLines) {
            const ctx = context as { surroundingLines: string[]; [k: string]: unknown };
            const maxLines = args.maxSnippetLength
              ? Math.max(3, Math.floor(args.maxSnippetLength / 50))
              : 5; // Default auto-compress to 5 lines
            hit.context = {
              ...ctx,
              surroundingLines: ctx.surroundingLines.slice(0, maxLines),
            };
          }
          
          return hit;
        });

        const out: Record<string, unknown> = {
          bundleId: args.bundleId,
          query: args.query,
          scope: args.scope,
          hits,
          ...(commonRepo && { repo: commonRepo }), // Auto-compress: extracted common repo
        };
        
        if (warnings.length > 0) {
          out.warnings = warnings;
        }

        // Add skippedFilesHint when 0 results
        if (hits.length === 0) {
          const hint = await buildSkippedFilesHint();
          if (hint) {
            out.skippedFilesHint = hint;
          }
        }

        // RFC v2: Add truncation info with cursor pagination
        if (hasMore || offset > 0 || cursorError) {
          out.truncation = {
            truncated: hasMore,
            returnedCount: hits.length,
            ...(hasMore && { nextCursor: createNextCursor(TOOL_NAME, offset, pageSize) }),
            ...(cursorError && { reason: cursorError }),
          };
        }

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
      title: 'Evidence: dependency graph (DEPRECATED)',
      description:
        '⚠️ **DEPRECATED**: Use `preflight_dependency_graph` instead. ' +
        'This tool provides the same functionality with a simpler interface.\n\n' +
        'Generate an evidence-based dependency graph. ' +
        'Two modes: (1) TARGET MODE: analyze a specific file (provide target.file). (2) GLOBAL MODE: project-wide graph (omit target). ' +
        'File path must be bundle-relative: repos/{owner}/{repo}/norm/{path}.',
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
        // RFC v2: Evidence pointers
        evidence: z.array(
          z.object({
            path: z.string(),
            range: z.object({
              startLine: z.number(),
              endLine: z.number(),
            }).optional(),
            uri: z.string().optional(),
            snippet: z.string().optional(),
          })
        ).optional().describe('Evidence pointers to key files in the dependency graph.'),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      try {
        // Check bundle completeness before generating dependency graph
        await assertBundleComplete(cfg, args.bundleId);

        const rawOut = await generateDependencyGraph(cfg, args);
        
        // RFC v2: Build evidence from top nodes in the graph
        const evidence: Array<{ path: string; uri?: string }> = [];
        const nodes = (rawOut.facts?.nodes ?? []) as Array<{ id: string }>;
        // Pick top 5 file nodes as evidence
        for (const node of nodes.slice(0, 5)) {
          if (node.id?.startsWith('file:')) {
            const filePath = node.id.replace(/^file:/, '');
            evidence.push({
              path: filePath,
              uri: toBundleFileUri({ bundleId: args.bundleId, relativePath: filePath }),
            });
          }
        }
        
        const out = { ...rawOut, evidence };
        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );

  // ==================== MAIN: preflight_dependency_graph ====================
  // Unified tool for dependency graphs (replaces both evidence_dependency_graph and get_dependency_graph)
  server.registerTool(
    'preflight_dependency_graph',
    {
      title: 'Dependency graph',
      description:
        'Get or generate dependency graph for a bundle. ' +
        'Auto-generates if not cached, returns cached version if available. ' +
        'Use when: "show dependencies", "看依赖图", "import graph", "what does X depend on".\n\n' +
        '**Modes:**\n' +
        '- `scope: "global"` (default): Project-wide dependency graph\n' +
        '- `scope: "target"` with `targetFile`: Dependencies for a specific file\n\n' +
        '**Format:**\n' +
        '- `format: "summary"` (default): Top nodes, aggregated by directory, key edges only\n' +
        '- `format: "full"`: Complete graph data with coverage report',
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
        // RFC v2: truncation info with cursor pagination
        truncation: z.object({
          truncated: z.boolean(),
          nextCursor: z.string().optional(),
          reason: z.string().optional(),
          returnedCount: z.number().optional(),
        }).optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      try {
        // RFC v2: Parse cursor for pagination
        const { parseCursorOrDefault, createNextCursor } = await import('./mcp/cursor.js');
        const TOOL_NAME = 'preflight_trace_query';
        const { offset, error: cursorError } = parseCursorOrDefault(args.cursor, TOOL_NAME);
        const pageSize = args.limit;

        // Check bundle completeness if bundleId is provided
        if (args.bundleId) {
          await assertBundleComplete(cfg, args.bundleId);
        }

        // Fetch extra items to detect if there are more results
        const fetchLimit = offset + pageSize + 1;
        const rawOut = await traceQuery(cfg, { ...args, limit: fetchLimit });
        
        // Apply cursor pagination to edges
        const hasMore = rawOut.edges.length > offset + pageSize;
        const paginatedEdges = rawOut.edges.slice(offset, offset + pageSize);
        
        // Build output with paginated edges
        const out: Record<string, unknown> = {
          ...rawOut,
          edges: paginatedEdges,
        };
        
        // RFC v2: Add truncation info with cursor pagination
        if (hasMore || offset > 0 || cursorError) {
          out.truncation = {
            truncated: hasMore,
            returnedCount: paginatedEdges.length,
            ...(hasMore && { nextCursor: createNextCursor(TOOL_NAME, offset, pageSize) }),
            ...(cursorError && { reason: cursorError }),
          };
        }
        
        // Build human-readable text output
        let textOutput: string;
        if (paginatedEdges.length === 0 && rawOut.reason) {
          textOutput = `No trace links found.\nReason: ${rawOut.reason}\n\nNext steps:\n${(rawOut.nextSteps ?? []).map(s => `- ${s}`).join('\n')}`;
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
      title: 'Trace: export to JSON (DEPRECATED)',
      description:
        '⚠️ **DEPRECATED**: trace.json is auto-exported after each trace_upsert, so this tool is rarely needed. ' +
        'Use `preflight_read_file` with `file: "trace/trace.json"` to read exported traces directly.\n\n' +
        'Export trace links to trace/trace.json. Only needed to manually refresh or verify the export.',
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
    'preflight_deep_analyze_bundle',
    {
      title: 'Deep analyze bundle (EDDA macro)',
      description:
        'One-call deep analysis that aggregates tree, search, dependencies, and traces. ' +
        'Returns a unified evidence pack with LLM-friendly summary.\n\n' +
        '**Use when:** Starting analysis of unfamiliar codebase, need quick overview, or want comprehensive context.\n\n' +
        '**Components (all optional, enabled by default):**\n' +
        '- tree: File structure summary\n' +
        '- search: Query results (if focus.query provided)\n' +
        '- deps: Dependency graph summary\n' +
        '- traces: Test coverage links',
      inputSchema: {
        bundleId: z.string().describe('Bundle ID to analyze.'),
        focus: z.object({
          path: z.string().optional().describe('Focus on specific directory or file path.'),
          query: z.string().optional().describe('Search query to include in analysis.'),
          depth: z.number().int().min(1).max(10).optional().describe('Tree depth for focused path (default: 3).'),
        }).optional().describe('Optional focus parameters to narrow analysis.'),
        options: z.object({
          includeTree: z.boolean().optional().default(true).describe('Include file tree summary.'),
          includeSearch: z.boolean().optional().default(true).describe('Include search results (requires focus.query).'),
          includeDeps: z.boolean().optional().default(true).describe('Include dependency analysis.'),
          includeTraces: z.boolean().optional().default(true).describe('Include trace link summary.'),
          includeOverview: z.boolean().optional().default(true).describe('Include OVERVIEW.md, START_HERE.md, AGENTS.md content.'),
          includeReadme: z.boolean().optional().default(true).describe('Include README.md content from repos.'),
          includeTests: z.boolean().optional().default(true).describe('Detect test directories and frameworks.'),
          tokenBudget: z.number().int().optional().describe('Soft limit on output tokens (reduces detail if exceeded).'),
          maxFiles: z.number().int().min(10).max(1000).optional().default(500).describe('Max files to scan for tree/deps.'),
        }).optional().describe('Analysis options.'),
      },
      outputSchema: {
        bundleId: z.string(),
        focus: z.object({ path: z.string().optional(), query: z.string().optional() }).optional(),
        tree: z.object({
          totalFiles: z.number(),
          totalDirs: z.number(),
          byExtension: z.record(z.string(), z.number()),
          topDirs: z.array(z.object({ path: z.string(), fileCount: z.number() })),
          focusedTree: z.string().optional(),
        }).optional(),
        search: z.object({
          query: z.string(),
          totalHits: z.number(),
          topFiles: z.array(z.object({ path: z.string(), hitCount: z.number(), snippet: z.string().optional() })),
          byDirectory: z.record(z.string(), z.number()),
        }).optional(),
        deps: z.object({
          totalNodes: z.number(),
          totalEdges: z.number(),
          topImporters: z.array(z.object({ file: z.string(), count: z.number() })),
          topImported: z.array(z.object({ file: z.string(), count: z.number() })),
          cycles: z.array(z.string()).optional(),
        }).optional(),
        traces: z.object({
          totalLinks: z.number(),
          byType: z.record(z.string(), z.number()),
          coverageEstimate: z.number(),
        }).optional(),
        overviewContent: z.object({
          overview: z.string().optional(),
          startHere: z.string().optional(),
          agents: z.string().optional(),
          readme: z.string().optional(),
        }).optional().describe('Overview content from bundle files (OVERVIEW.md, START_HERE.md, AGENTS.md, README.md).'),
        testInfo: z.object({
          detected: z.boolean(),
          framework: z.enum(['jest', 'vitest', 'pytest', 'go', 'mocha', 'unknown']).nullable(),
          testDirs: z.array(z.string()),
          testFiles: z.array(z.string()).describe('Test files detected by naming pattern (*.test.ts, *.spec.ts, etc.)'),
          testFileCount: z.number(),
          configFiles: z.array(z.string()),
          hint: z.string(),
        }).optional().describe('Test detection result.'),
        claims: z.array(z.object({
          id: z.string(),
          text: z.string(),
          confidence: z.number(),
          kind: z.string(),
          status: z.enum(['supported', 'inferred', 'unknown']),
          evidence: z.array(z.any()),
          whyInferred: z.string().optional(),
        })).describe('Auto-generated claims with evidence.'),
        checklistStatus: z.object({
          read_overview: z.boolean(),
          repo_tree: z.boolean(),
          search_focus: z.boolean(),
          dependency_graph_global: z.boolean(),
          entrypoints_identified: z.boolean(),
          core_modules_identified: z.boolean(),
          one_deep_dive_done: z.boolean(),
          tests_or_trace_checked: z.boolean(),
        }).describe('Checklist of completed analysis steps.'),
        openQuestions: z.array(z.object({
          question: z.string(),
          whyUnknown: z.string(),
          nextEvidenceToFetch: z.array(z.string()),
        })).describe('Questions that could not be answered.'),
        coverageReport: z.any(),
        summary: z.string().describe('LLM-formatted analysis summary with checklist and claims.'),
        nextSteps: z.array(z.string()).describe('Human-readable next step suggestions.'),
        nextCommands: z.array(z.object({
          tool: z.string(),
          description: z.string(),
          args: z.record(z.string(), z.unknown()),
        })).describe('Copyable next commands for LLM/automation - can be directly used as tool call arguments.'),
        // RFC v2: Top-level evidence aggregation
        evidence: z.array(
          z.object({
            path: z.string(),
            range: z.object({
              startLine: z.number(),
              endLine: z.number(),
            }).optional(),
            uri: z.string().optional(),
            snippet: z.string().optional(),
          })
        ).optional().describe('Aggregated evidence pointers from all claims.'),
      },
      annotations: {
        readOnlyHint: true,
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
        const opts = args.options ?? {} as {
          includeTree?: boolean;
          includeSearch?: boolean;
          includeDeps?: boolean;
          includeTraces?: boolean;
          includeOverview?: boolean;
          includeReadme?: boolean;
          includeTests?: boolean;
          tokenBudget?: number;
          maxFiles?: number;
        };
        const focus = args.focus ?? {};
        const errors: string[] = [];

        let tree: TreeSummary | undefined;
        let search: SearchSummary | undefined;
        let deps: DepsSummary | undefined;
        let traces: TraceSummary | undefined;
        let overviewContent: OverviewContent | undefined;
        let testInfo: TestInfo | undefined;

        // 1. Tree
        if (opts.includeTree ?? true) {
          try {
            const treeResult = await generateRepoTree(paths.rootDir, args.bundleId, {
              depth: focus.depth ?? 4,
              focusDir: focus.path,
              showFileCountPerDir: true,
            });
            tree = {
              totalFiles: treeResult.stats.totalFiles,
              totalDirs: treeResult.stats.totalDirs,
              byExtension: treeResult.stats.byExtension,
              topDirs: Object.entries(treeResult.stats.byDir ?? {})
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([p, count]) => ({ path: p, fileCount: count })),
              focusedTree: focus.path ? formatTreeResult(treeResult) : undefined,
            };
          } catch (e) {
            errors.push(`Tree: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // 2. Search (only if query provided)
        if ((opts.includeSearch ?? true) && focus.query) {
          try {
            const searchResult = await searchIndexAdvanced(paths.searchDbPath, focus.query, {
              scope: 'all',
              limit: 50,
              groupByFile: true,
              includeScore: true,
            });
            const byDir: Record<string, number> = {};
            for (const hit of searchResult.hits) {
              const dir = hit.path.split('/').slice(0, -1).join('/') || '(root)';
              byDir[dir] = (byDir[dir] ?? 0) + 1;
            }
            search = {
              query: focus.query,
              totalHits: searchResult.hits.length,
              topFiles: searchResult.grouped?.slice(0, 10).map(g => ({
                path: g.path,
                hitCount: g.hitCount,
                snippet: g.topSnippet,
              })) ?? searchResult.hits.slice(0, 10).map(h => ({
                path: h.path,
                hitCount: 1,
                snippet: h.snippet,
              })),
              byDirectory: byDir,
            };
          } catch (e) {
            errors.push(`Search: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // 3. Dependencies
        if (opts.includeDeps ?? true) {
          try {
            const depResult = await generateDependencyGraph(cfg, {
              bundleId: args.bundleId,
              options: {
                timeBudgetMs: 15000,
                maxNodes: (opts as any).maxFiles ?? 500,
                maxEdges: 2000,
              },
            });
            const edges = depResult.facts?.edges ?? [];
            const nodes = depResult.facts?.nodes ?? [];
            const importCounts: Record<string, number> = {};
            const importedByCounts: Record<string, number> = {};
            for (const edge of edges) {
              if (edge.type === 'imports' || edge.type === 'imports_resolved') {
                const from = typeof edge.from === 'string' ? edge.from.replace(/^file:/, '') : '';
                const to = typeof edge.to === 'string' ? edge.to.replace(/^(file:|module:)/, '') : '';
                if (from) importCounts[from] = (importCounts[from] ?? 0) + 1;
                if (to) importedByCounts[to] = (importedByCounts[to] ?? 0) + 1;
              }
            }
            deps = {
              totalNodes: nodes.length,
              totalEdges: edges.length,
              topImporters: Object.entries(importCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([file, count]) => ({ file, count })),
              topImported: Object.entries(importedByCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([file, count]) => ({ file, count })),
            };
          } catch (e) {
            errors.push(`Deps: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // 4. Traces
        if (opts.includeTraces ?? true) {
          try {
            const traceResult = await traceQuery(cfg, {
              bundleId: args.bundleId,
              limit: 500,
            });
            const byType: Record<string, number> = {};
            for (const edge of traceResult.edges) {
              byType[edge.type] = (byType[edge.type] ?? 0) + 1;
            }
            const testedFiles = new Set(traceResult.edges.filter(e => e.type === 'tested_by').map(e => e.source.id));
            const totalSourceFiles = tree?.totalFiles ?? 100;
            traces = {
              totalLinks: traceResult.edges.length,
              byType,
              coverageEstimate: testedFiles.size / Math.max(totalSourceFiles, 1),
            };
          } catch {
            traces = { totalLinks: 0, byType: {}, coverageEstimate: 0 };
          }
        }

        // 5. Overview content (OVERVIEW.md, START_HERE.md, AGENTS.md)
        if (opts.includeOverview ?? true) {
          overviewContent = {};
          const readFile = async (filename: string): Promise<string | undefined> => {
            try {
              const absPath = safeJoin(paths.rootDir, filename);
              return await fs.readFile(absPath, 'utf8');
            } catch {
              return undefined;
            }
          };
          overviewContent.overview = await readFile('OVERVIEW.md');
          overviewContent.startHere = await readFile('START_HERE.md');
          overviewContent.agents = await readFile('AGENTS.md');
        }

        // 6. README content (from repos)
        if (opts.includeReadme ?? true) {
          if (!overviewContent) overviewContent = {};
          try {
            const manifest = await readManifest(paths.manifestPath);
            for (const repo of manifest.repos ?? []) {
              if (!repo.id) continue;
              const [owner, repoName] = repo.id.split('/');
              if (!owner || !repoName) continue;
              
              const readmeNames = ['README.md', 'readme.md', 'Readme.md'];
              for (const readmeName of readmeNames) {
                const readmePath = `repos/${owner}/${repoName}/norm/${readmeName}`;
                try {
                  const absPath = safeJoin(paths.rootDir, readmePath);
                  overviewContent.readme = await fs.readFile(absPath, 'utf8');
                  break; // Found README, stop searching
                } catch {
                  // Try next README name
                }
              }
              if (overviewContent.readme) break; // Only read first repo's README
            }
          } catch {
            // Ignore manifest read errors
          }
        }

        // 7. Test detection
        if ((opts.includeTests ?? true) && tree) {
          // Collect files for test detection (config files + source files)
          const filesFound: Array<{ path: string; name: string }> = [];
          
          // Helper to recursively scan for files
          const scanDir = async (dir: string, relPath: string, maxDepth: number): Promise<void> => {
            if (maxDepth <= 0) return;
            try {
              const entries = await fs.readdir(dir, { withFileTypes: true });
              for (const entry of entries) {
                if (entry.name.startsWith('.') || ['node_modules', '__pycache__', 'venv', '.venv', 'dist', 'build'].includes(entry.name)) continue;
                const fullPath = safeJoin(dir, entry.name);
                const entryRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;
                
                if (entry.isFile()) {
                  filesFound.push({ path: entryRelPath, name: entry.name });
                } else if (entry.isDirectory()) {
                  await scanDir(fullPath, entryRelPath, maxDepth - 1);
                }
              }
            } catch {
              // Ignore directory access errors
            }
          };
          
          try {
            // Scan for config files at bundle root
            const configPatterns = [
              'jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.json',
              'vitest.config.js', 'vitest.config.ts',
              'pytest.ini', 'pyproject.toml', 'setup.cfg',
              '.mocharc.js', '.mocharc.json', '.mocharc.yml',
            ];
            for (const cfg of configPatterns) {
              try {
                const cfgPath = safeJoin(paths.rootDir, cfg);
                await fs.access(cfgPath);
                filesFound.push({ path: cfg, name: cfg });
              } catch {
                // Config file doesn't exist
              }
            }
            
            // **CRITICAL**: Scan repos/ directory to find test files (*.test.ts, *.spec.ts, etc.)
            // This is essential for detecting tests that live alongside source files
            await scanDir(paths.reposDir, 'repos', 8); // Scan up to 8 levels deep
          } catch {
            // Ignore errors during scanning
          }
          
          testInfo = detectTestInfo(
            { byExtension: tree.byExtension, byTopDir: tree.topDirs.reduce((acc, d) => ({ ...acc, [d.path]: d.fileCount }), {} as Record<string, number>) },
            filesFound.length > 0 ? filesFound : undefined
          );
        }

        const result = buildDeepAnalysis(args.bundleId, {
          tree,
          search,
          deps,
          traces,
          overviewContent,
          testInfo,
          focusPath: focus.path,
          focusQuery: focus.query,
          errors,
        });

        // RFC v2: Aggregate evidence from all claims into top-level array
        const evidence: Array<{ path: string; range?: { startLine: number; endLine: number }; uri?: string; snippet?: string }> = [];
        const seenPaths = new Set<string>();
        for (const claim of result.claims ?? []) {
          for (const ev of claim.evidence ?? []) {
            const evRef = ev as EvidenceRef;
            if (evRef.file && !seenPaths.has(evRef.file)) {
              seenPaths.add(evRef.file);
              evidence.push({
                path: evRef.file,
                range: evRef.range ? { startLine: evRef.range.startLine, endLine: evRef.range.endLine } : undefined,
                uri: toBundleFileUri({ bundleId: args.bundleId, relativePath: evRef.file }),
                snippet: evRef.snippet,
              });
            }
          }
        }

        return {
          content: [{ type: 'text', text: result.summary }],
          structuredContent: { ...result, evidence },
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );

  server.registerTool(
    'preflight_validate_report',
    {
      title: 'Validate claims and evidence',
      description:
        'Validate a report containing claims with evidence chains. ' +
        'Checks for: missing evidence, invalid file references, broken snippet hashes, etc.\n\n' +
        '**Use when:** Before finalizing analysis output, after generating claims, for audit compliance.',
      inputSchema: {
        bundleId: z.string().describe('Bundle ID for file verification.'),
        claims: z.array(z.object({
          id: z.string().describe('Unique claim identifier.'),
          text: z.string().describe('The claim text.'),
          confidence: z.number().min(0).max(1).describe('Confidence score (0-1).'),
          kind: z.enum(['feature', 'entrypoint', 'module', 'dependency', 'test_coverage', 'behavior', 'architecture', 'unknown']),
          status: z.enum(['supported', 'inferred', 'unknown']),
          evidence: z.array(z.object({
            file: z.string(),
            range: z.object({
              startLine: z.number().int().min(1),
              startCol: z.number().int().min(1),
              endLine: z.number().int().min(1),
              endCol: z.number().int().min(1),
            }),
            uri: z.string().optional(),
            snippet: z.string().optional(),
            snippetSha256: z.string().optional(),
            note: z.string().optional(),
          })),
          whyInferred: z.string().optional(),
        })).describe('Claims to validate.'),
        options: z.object({
          verifySnippets: z.boolean().optional().default(true).describe('Verify snippet SHA256 hashes.'),
          verifyFileExists: z.boolean().optional().default(true).describe('Verify evidence files exist in bundle.'),
          strictMode: z.boolean().optional().default(false).describe('Treat warnings as errors.'),
        }).optional(),
      },
      outputSchema: {
        bundleId: z.string(),
        totalClaims: z.number(),
        validClaims: z.number(),
        invalidClaims: z.number(),
        issues: z.array(z.object({
          severity: z.enum(['error', 'warning', 'info']),
          code: z.string(),
          message: z.string(),
          claimId: z.string().optional(),
          evidenceIndex: z.number().optional(),
          file: z.string().optional(),
        })),
        summary: z.string(),
        passed: z.boolean(),
      },
      annotations: {
        readOnlyHint: true,
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

        const result = await validateReport(paths.rootDir, {
          bundleId: args.bundleId,
          claims: args.claims as Claim[],
          options: args.options,
        });

        return {
          content: [{ type: 'text', text: result.summary }],
          structuredContent: {
            bundleId: result.bundleId,
            totalClaims: result.totalClaims,
            validClaims: result.validClaims,
            invalidClaims: result.invalidClaims,
            issues: result.issues,
            summary: result.summary,
            passed: result.passed,
          },
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );

  server.registerTool(
    'preflight_suggest_traces',
    {
      title: 'Trace: suggest links (DEPRECATED)',
      description:
        '⚠️ **DEPRECATED**: This tool has limited value. Use `preflight_deep_analyze_bundle` for test detection, ' +
        'then manually create trace links with `preflight_trace_upsert` if needed.\n\n' +
        'Automatically suggest trace links based on file naming patterns. ' +
        'MVP: Only supports tested_by edge type (code↔test relationships).',
      inputSchema: {
        bundleId: z.string().describe('Bundle ID to scan for trace suggestions.'),
        edge_type: z.enum(['tested_by']).default('tested_by').describe('Type of edge to suggest. MVP only supports tested_by.'),
        scope: z.enum(['repo', 'dir', 'file']).default('repo').describe('Scope of scan: repo=entire bundle, dir=specific directory, file=single file.'),
        scopePath: z.string().optional().describe('Path within bundle when scope is dir or file.'),
        min_confidence: z.number().min(0).max(1).default(0.85).describe('Minimum confidence threshold (0-1). Default 0.85.'),
        limit: z.number().int().min(1).max(200).default(50).describe('Maximum number of suggestions to return.'),
        skipExisting: z.boolean().default(true).describe('If true, skip pairs that already have trace links.'),
      },
      outputSchema: {
        bundleId: z.string(),
        edgeType: z.string(),
        suggestions: z.array(z.object({
          type: z.string(),
          source: z.object({ type: z.string(), id: z.string() }),
          target: z.object({ type: z.string(), id: z.string() }),
          confidence: z.number(),
          method: z.enum(['exact', 'heuristic']),
          why: z.string(),
          upsertPayload: z.any().describe('Ready-to-use payload for trace_upsert'),
        })),
        stats: z.object({
          scannedFiles: z.number(),
          matchedPairs: z.number(),
          suggestionsReturned: z.number(),
        }),
        nextSteps: z.array(z.string()),
      },
      annotations: {
        readOnlyHint: true,
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
        
        // Get existing edges if skipExisting is true
        let existingEdges: Set<string> | undefined;
        if (args.skipExisting) {
          try {
            const existingResult = await traceQuery(cfg, {
              bundleId: args.bundleId,
              edgeType: 'tested_by',
              limit: 1000,
            });
            existingEdges = new Set(
              existingResult.edges.map(e => `${e.source.id}|${e.target.id}`)
            );
          } catch {
            existingEdges = new Set();
          }
        }

        const result = await suggestTestedByTraces(paths.rootDir, {
          bundleId: args.bundleId,
          edgeType: args.edge_type,
          scope: args.scope,
          scopePath: args.scopePath,
          minConfidence: args.min_confidence,
          limit: args.limit,
          skipExisting: args.skipExisting,
          existingEdges,
        });

        const out = {
          bundleId: args.bundleId,
          edgeType: args.edge_type,
          suggestions: result.suggestions,
          stats: {
            scannedFiles: result.scannedFiles,
            matchedPairs: result.matchedPairs,
            suggestionsReturned: result.suggestions.length,
          },
          nextSteps: result.suggestions.length > 0
            ? [
                'Review suggestions for accuracy',
                'Call trace_upsert with upsertPayload (set dryRun=false) to persist approved links',
              ]
            : [
                'No test patterns found. Try manual trace_upsert for non-standard patterns.',
              ],
        };

        // Human-readable summary
        let text = `## Trace Suggestions (${args.edge_type})\n\n`;
        text += `Scanned ${result.scannedFiles} files, found ${result.matchedPairs} potential pairs.\n`;
        text += `Returning ${result.suggestions.length} suggestions (min confidence: ${args.min_confidence}).\n\n`;
        
        if (result.suggestions.length > 0) {
          text += `### Top Suggestions\n`;
          for (const s of result.suggestions.slice(0, 5)) {
            text += `- ${s.source.id} ← tested_by ← ${s.target.id} (${(s.confidence * 100).toFixed(0)}%)\n`;
          }
          if (result.suggestions.length > 5) {
            text += `\n... and ${result.suggestions.length - 5} more (see structuredContent)\n`;
          }
          text += `\n💡 Use trace_upsert with the upsertPayload from each suggestion to persist.`;
        }

        return {
          content: [{ type: 'text', text }],
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
