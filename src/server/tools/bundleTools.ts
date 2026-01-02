/**
 * Bundle management tools - create, update, delete, repair, list, etc.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';

import type { ToolDependencies } from './types.js';
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
} from '../../bundle/service.js';
import { getProgressTracker, type TaskProgress } from '../../jobs/progressTracker.js';
import { readManifest } from '../../bundle/manifest.js';
import { safeJoin, toBundleFileUri } from '../../mcp/uris.js';
import { wrapPreflightError } from '../../mcp/errorKinds.js';
import { BundleNotFoundError } from '../../errors.js';
import { cleanupOrphanBundles } from '../../bundle/cleanup.js';
import { generateRepoTree, formatTreeResult } from '../../bundle/tree.js';
import { generateDependencyGraph } from '../../evidence/dependencyGraph.js';
import { extractOutlineWasm, type SymbolOutline } from '../../ast/treeSitter.js';

// ==========================================================================
// Input Schemas
// ==========================================================================

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

const ListBundlesInputSchema = {
  filterByTag: z.string().optional().describe('Filter by tag (e.g., "mcp", "agents", "web-scraping").'),
  limit: z.number().int().min(1).max(200).default(50).describe('Max number of bundles to return.'),
  maxItemsPerList: z.number().int().min(1).max(50).default(10).describe('Max repos/tags to include per bundle to keep output compact.'),
  cursor: z.string().optional().describe('Pagination cursor from previous call. Use to fetch next page.'),
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

/**
 * Register all bundle management tools.
 */
export function registerBundleTools({ server, cfg }: ToolDependencies): void {
  // ==========================================================================
  // preflight_list_bundles
  // ==========================================================================
  server.registerTool(
    'preflight_list_bundles',
    {
      title: 'List bundles',
      description:
        'List available preflight bundles in a stable, minimal format. Use when: "show bundles", "what bundles exist", "list repos", "show my knowledge bases", "what have I indexed", "查看bundle", "有哪些bundle", "列出仓库".',
      inputSchema: ListBundlesInputSchema,
      outputSchema: {
        bundles: z.array(
          z.object({
            bundleId: z.string(),
            displayName: z.string(),
            repos: z.array(z.string()),
            tags: z.array(z.string()),
          })
        ),
        truncation: z.object({
          truncated: z.boolean(),
          nextCursor: z.string().optional(),
          totalCount: z.number().optional(),
          returnedCount: z.number().optional(),
        }).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const effectiveDir = await getEffectiveStorageDir(cfg);
      const allIds = await listBundles(effectiveDir);
      
      const { parseCursorOrDefault, createNextCursor, shouldPaginate } = await import('../../mcp/cursor.js');
      const TOOL_NAME = 'preflight_list_bundles';
      const { offset } = parseCursorOrDefault(args.cursor, TOOL_NAME);
      
      allIds.sort();
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

  // ==========================================================================
  // preflight_get_overview
  // ==========================================================================
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
      annotations: { readOnlyHint: true },
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

  // ==========================================================================
  // preflight_read_file
  // ==========================================================================
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
        '6. `repos/{owner}/{repo}/norm/README.md` - Original README (only if you need raw docs)',
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
        outline: z.boolean().optional().default(false).describe(
          'If true, return symbol outline instead of file content. ' +
          'Returns function/class/method/interface/type/enum with line ranges. ' +
          'Saves tokens by showing code structure without full content. ' +
          'Supports: .ts, .tsx, .js, .jsx, .py, .go, .rs files.'
        ),
        symbol: z.string().optional().describe(
          'Read a specific symbol (function/class/method) by name. ' +
          'Format: "functionName" or "ClassName" or "ClassName.methodName". ' +
          'Automatically locates and returns the symbol\'s code with context. ' +
          'Requires outline-supported file types (.ts, .tsx, .js, .jsx, .py).'
        ),
      },
      outputSchema: {
        bundleId: z.string(),
        mode: z.enum(['light', 'full']).optional(),
        file: z.string().optional(),
        content: z.string().optional(),
        files: z.record(z.string(), z.string().nullable()).optional(),
        sections: z.array(z.string()).optional(),
        lineInfo: z.object({
          totalLines: z.number(),
          ranges: z.array(z.object({ start: z.number(), end: z.number() })),
        }).optional(),
        outline: z.array(z.object({
          kind: z.enum(['function', 'class', 'method', 'interface', 'type', 'enum', 'variable']),
          name: z.string(),
          signature: z.string().optional(),
          range: z.object({ startLine: z.number(), endLine: z.number() }),
          exported: z.boolean(),
          children: z.array(z.any()).optional(),
        })).optional(),
        language: z.string().optional(),
        coreFiles: z.array(z.object({
          path: z.string(),
          reason: z.string(),
          outline: z.array(z.any()).optional(),
          content: z.string().optional(),
          language: z.string().optional(),
          charCount: z.number(),
        })).optional(),
        coreStats: z.object({
          totalFiles: z.number(),
          totalChars: z.number(),
          truncatedFiles: z.number(),
        }).optional(),
      },
      annotations: { readOnlyHint: true },
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
            for (const range of ranges) {
              const start = Math.max(1, range.start);
              const end = Math.min(totalLines, range.end);
              for (let i = start; i <= end; i++) {
                selectedLines.push({ lineNo: i, text: lines[i - 1] ?? '' });
              }
            }
          } else {
            selectedLines = lines.map((text, idx) => ({ lineNo: idx + 1, text }));
          }

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

          // Outline mode
          if (args.outline) {
            const outlineResult = await extractOutlineWasm(args.file, normalizedContent);
            
            if (!outlineResult) {
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

          // Symbol-based reading
          if (args.symbol) {
            const outlineResult = await extractOutlineWasm(args.file, normalizedContent);
            
            if (!outlineResult) {
              return {
                content: [{ type: 'text', text: `[${args.file}] Symbol lookup not supported for this file type. Supported: .ts, .tsx, .js, .jsx, .py` }],
                structuredContent: { bundleId: args.bundleId, file: args.file, error: 'unsupported_file_type' },
              };
            }
            
            const parts = args.symbol.split('.');
            const targetName = parts[0]!;
            const methodName = parts[1];
            
            let foundSymbol: SymbolOutline | undefined;
            
            for (const sym of outlineResult.outline) {
              if (sym.name === targetName) {
                if (methodName && sym.children) {
                  const method = sym.children.find(c => c.name === methodName);
                  if (method) {
                    foundSymbol = method;
                    break;
                  }
                } else {
                  foundSymbol = sym;
                  break;
                }
              }
            }
            
            if (!foundSymbol) {
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
            parsedRanges.sort((a, b) => a.start - b.start);
          }

          const { content, lineInfo } = formatContent(rawContent, args.withLineNumbers ?? false, parsedRanges);

          const out = {
            bundleId: args.bundleId,
            file: args.file,
            content,
            lineInfo,
          };

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
        
        // MODE: CORE
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
          const tokenBudget = coreOpts.tokenBudget;
          const charBudget = tokenBudget ? tokenBudget * 4 : undefined;
          
          let depResult;
          try {
            depResult = await generateDependencyGraph(cfg, {
              bundleId: args.bundleId,
              options: { timeBudgetMs: 10000, maxNodes: 200, maxEdges: 1000 },
            });
          } catch {
            depResult = null;
          }
          
          const coreFileCandidates: Array<{ path: string; reason: string; score: number }> = [];
          
          if (depResult?.facts?.edges) {
            const importedByCounts: Record<string, number> = {};
            for (const edge of depResult.facts.edges) {
              if (edge.type === 'imports' || edge.type === 'imports_resolved') {
                const to = typeof edge.to === 'string' ? edge.to.replace(/^(file:|module:)/, '') : '';
                if (to && !to.startsWith('node_modules') && !to.includes('node:')) {
                  importedByCounts[to] = (importedByCounts[to] ?? 0) + 1;
                }
              }
            }
            
            const sortedByImports = Object.entries(importedByCounts)
              .sort((a, b) => b[1] - a[1])
              .slice(0, maxFiles * 2);
            
            for (const [filePath, count] of sortedByImports) {
              coreFileCandidates.push({
                path: filePath,
                reason: `Most imported (${count} dependents)`,
                score: count * 10,
              });
            }
          }
          
          const entryPointPatterns = [
            { pattern: /\/(index|main)\.(ts|js|tsx|jsx)$/i, reason: 'Entry point', score: 50 },
            { pattern: /\/app\.(ts|js|tsx|jsx)$/i, reason: 'App entry', score: 40 },
            { pattern: /\/server\.(ts|js)$/i, reason: 'Server entry', score: 40 },
            { pattern: /\/types\.(ts|d\.ts)$/i, reason: 'Type definitions', score: 30 },
          ];
          
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
          
          coreFileCandidates.sort((a, b) => b.score - a.score);
          const seenPaths = new Set<string>();
          const uniqueCandidates = coreFileCandidates.filter(c => {
            const key = c.path.split('/').pop() ?? c.path;
            if (seenPaths.has(key)) return false;
            seenPaths.add(key);
            return true;
          }).slice(0, maxFiles);
          
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
            let actualPath = candidate.path;
            let absPath: string;
            
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
            
            if (includeOutline) {
              const outlineResult = await extractOutlineWasm(actualPath, fileContent);
              if (outlineResult) {
                result.outline = outlineResult.outline;
                result.language = outlineResult.language;
              }
            }
            
            if (includeContent && withinBudget) {
              result.content = fileContent;
              totalChars += charCount;
            } else if (includeContent && !withinBudget) {
              truncatedFiles++;
            }
            
            coreFilesResult.push(result);
          }
          
          const textParts: string[] = [];
          textParts.push(`[Mode: core] ${coreFilesResult.length} core files identified`);
          textParts.push(`Total: ${totalChars} chars (~${Math.round(totalChars / 4)} tokens)`);
          if (truncatedFiles > 0) {
            textParts.push(`⚠️ ${truncatedFiles} file(s) exceeded token budget - showing outline only`);
          }
          textParts.push('');
          
          for (const cf of coreFilesResult) {
            textParts.push(`=== ${cf.path} (${cf.reason}) ===`);
            
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
        
        // MODE: LIGHT / FULL
        const includeReadme = args.includeReadme ?? (mode === 'full');
        const includeDepsGraph = args.includeDepsGraph ?? (mode === 'full');
        
        const coreFiles = ['OVERVIEW.md', 'START_HERE.md', 'AGENTS.md', 'manifest.json'];
        const keyFiles = [...coreFiles];
        
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

        const textParts: string[] = [];
        textParts.push(`[Mode: ${mode}] Sections: ${sections.join(', ')}`);
        textParts.push('');
        
        for (const [filePath, content] of Object.entries(files)) {
          if (content) {
            textParts.push(`=== ${filePath} ===\n${content}`);
          }
        }
        
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

  // ==========================================================================
  // preflight_repo_tree
  // ==========================================================================
  server.registerTool(
    'preflight_repo_tree',
    {
      title: 'Repository tree & statistics',
      description:
        'Get repository structure overview with directory tree, file statistics, and entry point candidates. ' +
        'Use this BEFORE deep analysis to understand project layout without wasting tokens on search. ' +
        'Use when: "show project structure", "what files are in this repo", "项目结构", "文件分布", "show tree".',
      inputSchema: {
        bundleId: z.string().describe('Bundle ID to analyze.'),
        depth: z.number().int().min(1).max(10).default(4).describe('Maximum directory depth to traverse. Default 4.'),
        include: z.array(z.string()).optional().describe('Glob patterns to include (e.g., ["*.ts", "*.py"]). If omitted, includes all files.'),
        exclude: z.array(z.string()).optional().describe('Patterns to exclude (e.g., ["node_modules", "*.pyc"]). Defaults include common excludes.'),
        focusDir: z.string().optional().describe('Focus directory path - expand deeper within this path (e.g., "owner/repo/norm/src"). Gets +3 extra depth levels.'),
        focusDepthBonus: z.number().int().min(1).max(6).optional().describe('Extra depth levels for focusDir. Default 3.'),
        showFileCountPerDir: z.boolean().optional().describe('If true, include file count per directory in stats.byDir.'),
        showSkippedFiles: z.boolean().optional().describe('If true, include list of files that were skipped during indexing (too large, binary, etc.). Helps understand what content is NOT searchable.'),
      },
      outputSchema: {
        bundleId: z.string(),
        tree: z.string(),
        stats: z.object({
          totalFiles: z.number(),
          totalDirs: z.number(),
          byExtension: z.record(z.string(), z.number()),
          byTopDir: z.record(z.string(), z.number()),
          byDir: z.record(z.string(), z.number()).optional(),
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
        ).optional(),
        autoFocused: z.object({
          enabled: z.boolean(),
          path: z.string().optional(),
        }).optional(),
        evidence: z.array(
          z.object({
            path: z.string(),
            range: z.object({ startLine: z.number(), endLine: z.number() }).optional(),
            uri: z.string().optional(),
            snippet: z.string().optional(),
          })
        ).optional(),
      },
      annotations: { readOnlyHint: true },
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

        const evidence = result.entryPointCandidates
          .slice(0, 5)
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

  // ==========================================================================
  // preflight_delete_bundle
  // ==========================================================================
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
        dryRun: z.boolean(),
        deleted: z.boolean(),
        bundleId: z.string(),
        displayName: z.string().optional(),
        repos: z.array(z.string()).optional(),
        message: z.string().optional(),
        nextAction: z.object({
          toolName: z.string(),
          paramsTemplate: z.record(z.string(), z.unknown()),
          why: z.string(),
        }).optional(),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      try {
        const dryRun = args.dryRun ?? true;
        
        const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
        if (!storageDir) {
          throw new BundleNotFoundError(args.bundleId);
        }
        
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

  // ==========================================================================
  // preflight_create_bundle
  // ==========================================================================
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
        libraries: z.array(
          z.object({
            kind: z.literal('context7'),
            input: z.string(),
            id: z.string().optional(),
            fetchedAt: z.string(),
            notes: z.array(z.string()).optional(),
            files: z.array(z.string()).optional(),
          })
        ).optional(),
        warnings: z.array(z.string()).optional(),
        status: z.enum(['in-progress', 'complete']).optional(),
        message: z.string().optional(),
        taskId: z.string().optional(),
        fingerprint: z.string().optional(),
        requestedRepos: z.array(z.string()).optional(),
        startedAt: z.string().optional(),
        elapsedSeconds: z.number().optional(),
        currentPhase: z.string().optional(),
        currentProgress: z.number().optional(),
        currentMessage: z.string().optional(),
      },
      annotations: { openWorldHint: true },
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

        server.sendResourceListChanged();

        const out = {
          ...summary,
          resources,
        };

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
        textResponse += `📊 **Recommended next steps:**\n`;
        textResponse += `Would you like me to generate a **global dependency graph** for deeper code analysis? ` +
          `This will analyze import relationships across all files.\n`;
        textResponse += `(Call \`preflight_evidence_dependency_graph\` with this bundleId to generate)`;

        return {
          content: [{ type: 'text', text: textResponse }],
          structuredContent: out,
        };
      } catch (err: any) {
        if (err?.code === 'BUNDLE_IN_PROGRESS') {
          const elapsedSec = err.startedAt
            ? Math.round((Date.now() - new Date(err.startedAt).getTime()) / 1000)
            : 0;
          
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

  // ==========================================================================
  // preflight_repair_bundle
  // ==========================================================================
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
      annotations: { openWorldHint: true },
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

  // ==========================================================================
  // preflight_update_bundle
  // ==========================================================================
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
        libraries: z.array(
          z.object({
            kind: z.literal('context7'),
            input: z.string(),
            id: z.string().optional(),
            fetchedAt: z.string(),
            notes: z.array(z.string()).optional(),
            files: z.array(z.string()).optional(),
          })
        ).optional(),
      },
      annotations: { openWorldHint: true },
    },
    async (args) => {
      try {
        const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
        if (!storageDir) {
          throw new BundleNotFoundError(args.bundleId);
        }

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

  // ==========================================================================
  // preflight_cleanup_orphans
  // ==========================================================================
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
      annotations: { destructiveHint: true },
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

  // ==========================================================================
  // preflight_get_task_status
  // ==========================================================================
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
      annotations: { readOnlyHint: true },
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

        let fingerprint = args.fingerprint;
        if (!fingerprint && args.repos?.length) {
          fingerprint = computeCreateInputFingerprint({
            repos: args.repos,
            libraries: args.libraries,
            topics: args.topics,
          });
        }

        if (args.taskId) {
          const task = tracker.getTask(args.taskId);
          if (task) {
            result = { found: true, task };
          }
        }
        else if (fingerprint) {
          const task = tracker.getTaskByFingerprint(fingerprint);
          if (task) {
            result = { found: true, task };
          }
          
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
}
