/**
 * RFC v2: preflight_search_and_read - Search and read excerpts in one call.
 * 
 * The most important LLM optimization tool: combines search + context extraction
 * to provide citation-ready evidence in a single round-trip.
 */

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import * as z from 'zod';

import { type EvidencePointer, createRange } from '../mcp/envelope.js';
import {
  type ResponseContext,
  createResponseContext,
  createSuccessResponse,
  createErrorResponse,
  addWarning,
  addEvidence,
  addNextAction,
  setTruncation,
  formatResponse,
  ErrorCodes,
  WarningCodes,
} from '../mcp/responseBuilder.js';
import { createNextCursor, parseCursorOrDefault } from '../mcp/cursor.js';
import { safeJoin, toBundleFileUri } from '../mcp/uris.js';
import { searchIndex, searchIndexAdvanced, type SearchHit, type SearchScope, type GroupedSearchHit } from '../search/sqliteFts.js';

/**
 * Input schema for preflight_search_and_read.
 */
export const SearchAndReadInputSchema = {
  bundleId: z.string().describe('Bundle ID to search.'),
  query: z.string().describe('Search query. Prefix with fts: to use raw FTS5 syntax.'),
  scope: z
    .enum(['docs', 'code', 'all'])
    .default('code')
    .describe('Search scope. Default: code (most common for LLM tasks).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Max number of hits (default: 10, max: 50).'),
  contextLines: z
    .number()
    .int()
    .min(5)
    .max(100)
    .default(30)
    .describe('Lines of context around each match (default: 30).'),
  withLineNumbers: z
    .boolean()
    .default(true)
    .describe('Prefix excerpt lines with "N|" for citation (default: true).'),
  fileTypeFilters: z
    .array(z.string())
    .optional()
    .describe('Filter by extensions (e.g., [".ts", ".py"]).'),
  excludePatterns: z
    .array(z.string())
    .optional()
    .describe('Exclude paths matching patterns (e.g., ["**/tests/**"]).'),
  maxBytesPerHit: z
    .number()
    .int()
    .min(500)
    .max(10000)
    .default(2000)
    .describe('Max bytes per excerpt (default: 2000).'),
  tokenBudget: z
    .number()
    .int()
    .optional()
    .describe('Advisory total token budget. Tool will try to stay within.'),
  cursor: z.string().optional().describe('Pagination cursor from previous call.'),
  format: z
    .enum(['json', 'text'])
    .default('json')
    .describe('Response format. json=unified envelope (default).'),
  // NEW: readContent parameter for search-only mode (replaces search_bundle)
  readContent: z
    .boolean()
    .default(true)
    .describe(
      'If true (default), read file excerpts for each hit. ' +
      'If false, return search metadata only (path, lineNo, score) without reading file content. ' +
      'Use false for quick index-only searches (like groupByFile in search_bundle).'
    ),
  // NEW: groupByFile parameter for token-efficient grouped results
  groupByFile: z
    .boolean()
    .default(false)
    .describe(
      'If true, group results by file instead of returning individual hits. ' +
      'Returns {path, hitCount, lines[], topSnippet} per file. ' +
      'Significantly reduces tokens when same file has multiple matches. ' +
      'When groupByFile=true, readContent is ignored (no excerpts returned).'
    ),
};

/**
 * Single search hit with excerpt.
 */
export interface SearchAndReadHit {
  path: string;
  repo: string;
  kind: 'doc' | 'code';
  /** Range where the match was found */
  matchRange: { startLine: number; endLine: number };
  /** Range of the excerpt (includes context) */
  excerptRange: { startLine: number; endLine: number };
  /** Excerpt content with optional line numbers */
  excerpt: string;
  /** BM25 relevance score (lower = more relevant) */
  score?: number;
}

/**
 * Grouped search hit for token-efficient output.
 */
export interface GroupedSearchAndReadHit {
  path: string;
  repo: string;
  kind: 'doc' | 'code';
  /** Number of matching lines in this file */
  hitCount: number;
  /** Line numbers of all matches */
  lines: number[];
  /** Best matching snippet (highest relevance) */
  topSnippet: string;
  /** Best score (most relevant) */
  topScore?: number;
}

/**
 * Output data for preflight_search_and_read.
 */
export interface SearchAndReadData {
  bundleId: string;
  query: string;
  scope: SearchScope;
  hits: SearchAndReadHit[];
  /** Grouped results (when groupByFile=true) */
  grouped?: GroupedSearchAndReadHit[];
  /** Token savings hint (when groupByFile=true) */
  tokenSavingsHint?: string;
}

/**
 * Compute SHA256 hash of content.
 */
function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Read excerpt around a match with context lines.
 */
async function readExcerpt(
  bundleRoot: string,
  hit: SearchHit,
  contextLines: number,
  withLineNumbers: boolean,
  maxBytes: number
): Promise<{
  excerpt: string;
  excerptRange: { startLine: number; endLine: number };
} | null> {
  try {
    const absPath = safeJoin(bundleRoot, hit.path);
    const content = await fs.readFile(absPath, 'utf8');
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const totalLines = lines.length;

    // Calculate excerpt range
    const matchLine = hit.lineNo;
    const halfContext = Math.floor(contextLines / 2);
    let startLine = Math.max(1, matchLine - halfContext);
    let endLine = Math.min(totalLines, matchLine + halfContext);

    // Adjust to maintain contextLines count if possible
    if (endLine - startLine + 1 < contextLines) {
      if (startLine === 1) {
        endLine = Math.min(totalLines, startLine + contextLines - 1);
      } else if (endLine === totalLines) {
        startLine = Math.max(1, endLine - contextLines + 1);
      }
    }

    // Extract lines
    const excerptLines: string[] = [];
    let byteCount = 0;
    for (let i = startLine; i <= endLine; i++) {
      const line = lines[i - 1] ?? '';
      const formatted = withLineNumbers ? `${i}|${line}` : line;
      
      // Check byte limit
      const lineBytes = Buffer.byteLength(formatted, 'utf8') + 1; // +1 for newline
      if (byteCount + lineBytes > maxBytes && excerptLines.length > 0) {
        // Truncate here
        endLine = i - 1;
        break;
      }
      
      excerptLines.push(formatted);
      byteCount += lineBytes;
    }

    return {
      excerpt: excerptLines.join('\n'),
      excerptRange: { startLine, endLine },
    };
  } catch {
    return null;
  }
}

/**
 * Match patterns against a path.
 */
function matchesPattern(path: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<DOUBLESTAR>>>/g, '.*');
  const regex = new RegExp(regexStr, 'i');
  return regex.test(path);
}

/**
 * Input type for tool handler.
 */
export type SearchAndReadInput = {
  bundleId: string;
  query: string;
  scope?: 'docs' | 'code' | 'all';
  limit?: number;
  contextLines?: number;
  withLineNumbers?: boolean;
  fileTypeFilters?: string[];
  excludePatterns?: string[];
  maxBytesPerHit?: number;
  tokenBudget?: number;
  cursor?: string;
  format?: 'json' | 'text';
  readContent?: boolean;
  groupByFile?: boolean;
};

/**
 * Create the tool handler for preflight_search_and_read.
 */
export function createSearchAndReadHandler(deps: {
  findBundleStorageDir: (storageDirs: string[], bundleId: string) => Promise<string | null>;
  getBundlePathsForId: (storageDir: string, bundleId: string) => {
    rootDir: string;
    searchDbPath: string;
  };
  assertBundleComplete: (bundleId: string) => Promise<void>;
  storageDirs: string[];
}) {
  const TOOL_NAME = 'preflight_search_and_read';

  return async (args: SearchAndReadInput) => {
    const ctx = createResponseContext(TOOL_NAME, args.bundleId);
    const format = args.format ?? 'json';

    try {
      // Parse cursor
      const { offset, error: cursorError } = parseCursorOrDefault(args.cursor, TOOL_NAME);
      if (cursorError) {
        addWarning(ctx, WarningCodes.DEPRECATED_PARAM, `Invalid cursor: ${cursorError}`, true);
      }

      // Find bundle
      const storageDir = await deps.findBundleStorageDir(deps.storageDirs, args.bundleId);
      if (!storageDir) {
        const response = createErrorResponse(
          ctx,
          ErrorCodes.BUNDLE_NOT_FOUND,
          `Bundle not found: ${args.bundleId}`,
          'Run preflight_list_bundles to find available bundles.'
        );
        addNextAction(ctx, 'preflight_list_bundles', {}, 'Find available bundles');
        return formatResponse(response, format);
      }

      const paths = deps.getBundlePathsForId(storageDir, args.bundleId);
      
      // Perform search
      const scope = (args.scope ?? 'code') as SearchScope;
      const limit = args.limit ?? 10;
      const contextLines = args.contextLines ?? 30;
      const withLineNumbers = args.withLineNumbers ?? true;
      const maxBytesPerHit = args.maxBytesPerHit ?? 2000;
      const tokenBudget = args.tokenBudget;
      const groupByFile = args.groupByFile ?? false;

      // Fast path: groupByFile mode uses searchIndexAdvanced
      if (groupByFile) {
        const advancedResult = searchIndexAdvanced(paths.searchDbPath, args.query, {
          scope,
          limit: limit * 3, // Fetch more to ensure enough grouped results
          groupByFile: true,
          includeScore: true,
          fileTypeFilters: args.fileTypeFilters,
          bundleRoot: paths.rootDir,
        });

        // Convert to grouped output format
        const grouped: GroupedSearchAndReadHit[] = (advancedResult.grouped ?? []).slice(0, limit).map(g => ({
          path: g.path,
          repo: g.repo,
          kind: g.kind,
          hitCount: g.hitCount,
          lines: g.lines,
          topSnippet: g.topSnippet,
          topScore: g.topScore,
        }));

        const data: SearchAndReadData = {
          bundleId: args.bundleId,
          query: args.query,
          scope,
          hits: [], // Empty when groupByFile=true
          grouped,
          tokenSavingsHint: advancedResult.meta.tokenBudgetHint,
        };

        if (grouped.length === 0) {
          addWarning(ctx, 'NO_RESULTS', 'No matching results found', true);
          addNextAction(
            ctx,
            'preflight_repo_tree',
            { bundleId: args.bundleId },
            'View repository structure to find relevant files'
          );
        }

        const response = createSuccessResponse(ctx, data);
        return formatResponse(response, format);
      }

      // Fetch more results to allow for filtering
      const fetchLimit = Math.min(limit * 3, 100);
      let rawHits = searchIndex(paths.searchDbPath, args.query, scope, fetchLimit, paths.rootDir);

      // Apply file type filters
      if (args.fileTypeFilters && args.fileTypeFilters.length > 0) {
        const exts = args.fileTypeFilters.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase());
        rawHits = rawHits.filter((h) => {
          const ext = h.path.slice(h.path.lastIndexOf('.')).toLowerCase();
          return exts.includes(ext);
        });
      }

      // Apply exclude patterns
      if (args.excludePatterns && args.excludePatterns.length > 0) {
        rawHits = rawHits.filter((h) => !args.excludePatterns!.some((p) => matchesPattern(h.path, p)));
      }

      // Sort deterministically: score ASC, path ASC, lineNo ASC
      rawHits.sort((a, b) => {
        const scoreA = a.score ?? 0;
        const scoreB = b.score ?? 0;
        if (scoreA !== scoreB) return scoreA - scoreB;
        if (a.path !== b.path) return a.path.localeCompare(b.path);
        return a.lineNo - b.lineNo;
      });

      // Apply pagination offset
      rawHits = rawHits.slice(offset);

      // Build result hits with excerpts (or metadata-only if readContent=false)
      const hits: SearchAndReadHit[] = [];
      let totalBytes = 0;
      const estimatedTokensPerByte = 0.25; // Rough estimate
      const shouldReadContent = args.readContent ?? true;

      for (const rawHit of rawHits) {
        if (hits.length >= limit) break;

        // Check token budget (only relevant when reading content)
        if (shouldReadContent && tokenBudget && totalBytes * estimatedTokensPerByte > tokenBudget) {
          addWarning(ctx, WarningCodes.RESULT_TRUNCATED, 'Token budget exceeded', true);
          setTruncation(ctx, true, {
            reason: 'Token budget exceeded',
            returnedCount: hits.length,
          });
          break;
        }

        // readContent=false: return metadata only (index-only search)
        if (!shouldReadContent) {
          const hit: SearchAndReadHit = {
            path: rawHit.path,
            repo: rawHit.repo,
            kind: rawHit.kind,
            matchRange: { startLine: rawHit.lineNo, endLine: rawHit.lineNo },
            excerptRange: { startLine: rawHit.lineNo, endLine: rawHit.lineNo },
            excerpt: rawHit.snippet || '', // Use indexed snippet if available
            score: rawHit.score,
          };
          hits.push(hit);
          continue;
        }

        // readContent=true: read full excerpt with context
        const excerptResult = await readExcerpt(
          paths.rootDir,
          rawHit,
          contextLines,
          withLineNumbers,
          maxBytesPerHit
        );

        if (!excerptResult) continue;

        const hit: SearchAndReadHit = {
          path: rawHit.path,
          repo: rawHit.repo,
          kind: rawHit.kind,
          matchRange: { startLine: rawHit.lineNo, endLine: rawHit.lineNo },
          excerptRange: excerptResult.excerptRange,
          excerpt: excerptResult.excerpt,
          score: rawHit.score,
        };

        hits.push(hit);
        totalBytes += Buffer.byteLength(excerptResult.excerpt, 'utf8');

        // Create evidence pointer
        const snippet = excerptResult.excerpt.length <= 500
          ? excerptResult.excerpt
          : excerptResult.excerpt.slice(0, 500) + '…';
        const evidence: EvidencePointer = {
          path: rawHit.path,
          range: createRange(excerptResult.excerptRange.startLine, excerptResult.excerptRange.endLine),
          uri: toBundleFileUri({ bundleId: args.bundleId, relativePath: rawHit.path }),
          snippet,
          snippetSha256: computeSha256(snippet),
        };
        addEvidence(ctx, evidence);
      }

      // Check if more results available
      const hasMore = rawHits.length > hits.length;
      if (hasMore) {
        const nextCursor = createNextCursor(TOOL_NAME, offset, hits.length);
        setTruncation(ctx, true, {
          nextCursor,
          reason: 'More results available',
          returnedCount: hits.length,
        });
      }

      // No results - suggest actions
      if (hits.length === 0) {
        addWarning(ctx, 'NO_RESULTS', 'No matching results found', true);
        addNextAction(
          ctx,
          'preflight_repo_tree',
          { bundleId: args.bundleId },
          'View repository structure to find relevant files'
        );
        addNextAction(
          ctx,
          'preflight_search_and_read',
          { bundleId: args.bundleId, query: args.query, groupByFile: true },
          'Try broader search with file grouping'
        );
      }

      const data: SearchAndReadData = {
        bundleId: args.bundleId,
        query: args.query,
        scope,
        hits,
      };

      const response = createSuccessResponse(ctx, data);
      return formatResponse(response, format);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      
      // Check for index issues
      if (errorMessage.toLowerCase().includes('sqlite') || errorMessage.toLowerCase().includes('database')) {
        const response = createErrorResponse(
          ctx,
          ErrorCodes.INDEX_CORRUPT,
          'Search index is missing or corrupt',
          'Run preflight_repair_bundle with rebuildIndex=true to rebuild the index.'
        );
        addNextAction(ctx, 'preflight_repair_bundle', {
          bundleId: args.bundleId,
          rebuildIndex: true,
        }, 'Rebuild the search index');
        return formatResponse(response, format);
      }

      const response = createErrorResponse(ctx, ErrorCodes.OPERATION_FAILED, errorMessage);
      return formatResponse(response, format);
    }
  };
}

/**
 * Tool description for MCP registration.
 */
export const searchAndReadToolDescription = {
  title: 'Search and read excerpts',
  description:
    'Search bundle and return excerpts with context in one call. ' +
    'The most important tool for LLM evidence gathering - combines search + read.\n\n' +
    '**LLM Usage Guide:**\n' +
    '- Use when you need to find AND read code/docs in one step\n' +
    '- Default contextLines=30 provides good surrounding context\n' +
    '- Results include citation-ready evidence[] with path + range\n' +
    '- Deterministic ordering: score → path → line (stable pagination)\n\n' +
    '**Token Optimization (NEW):**\n' +
    '- groupByFile=true: Returns {path, hitCount, lines[], topSnippet} per file\n' +
    '- Saves 30-50% tokens when same file has multiple matches\n' +
    '- Use for initial exploration, then readContent=true for specific files\n\n' +
    '**When to use vs other tools:**\n' +
    '- search_and_read: You need evidence excerpts NOW (most common)\n' +
    '- search_and_read + groupByFile: Quick overview without reading content\n' +
    '- groupByFile=true + readContent=false: Quick index-only search (replaces legacy search_bundle)\n' +
    '- read_files: You already know exact files and ranges\n\n' +
    '**Evidence Citation:**\n' +
    '- Each hit includes matchRange (exact match) and excerptRange (with context)\n' +
    '- Use excerptRange for citations: "path:startLine-endLine"\n\n' +
    'Triggers: "search and show", "find with context", "搜索并显示", "查找代码"',
};
