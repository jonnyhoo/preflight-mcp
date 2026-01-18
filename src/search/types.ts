/**
 * Shared types for search module.
 * Extracted to avoid circular dependencies between sqliteFts.ts and cache.ts.
 *
 * @module search/types
 */

export type IndexBuildOptions = {
  includeDocs: boolean;
  includeCode: boolean;
};

export type IncrementalIndexResult = {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  totalIndexed: number;
};

export type SearchScope = 'docs' | 'code' | 'all';

export type SearchHit = {
  path: string; // bundle-relative posix path
  repo: string; // owner/repo
  kind: 'doc' | 'code';
  lineNo: number;
  snippet: string;
  /** BM25 relevance score (lower is more relevant, FTS5 convention) */
  score?: number;
  context?: {
    functionName?: string;
    className?: string;
    startLine: number;
    endLine: number;
    surroundingLines: string[];
  };
};

/**
 * Grouped search hit - aggregates multiple hits from the same file.
 * Used when groupByFile=true to reduce token consumption.
 */
export type GroupedSearchHit = {
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
};

/**
 * Extended search options for EDDA token efficiency.
 */
export type SearchOptions = {
  /** Search scope */
  scope: SearchScope;
  /** Max results */
  limit: number;
  /** Bundle root path (for context extraction) */
  bundleRoot?: string;
  /** Include BM25 score in results */
  includeScore?: boolean;
  /** Filter by file extensions (e.g., [".py", ".ts"]) */
  fileTypeFilters?: string[];
  /** Group results by file */
  groupByFile?: boolean;
};

/**
 * Search cache entry structure.
 */
export interface SearchCacheEntry {
  hits: SearchHit[];
  grouped?: GroupedSearchHit[];
  meta: { tokenBudgetHint?: string };
}
