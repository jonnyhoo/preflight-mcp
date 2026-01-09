/**
 * RFC v2: Unified Response Envelope for all Preflight MCP tools.
 * 
 * This module defines the standardized response structure that enables:
 * - LLM-friendly JSON output with stable field names
 * - Evidence-first design with traceable citations
 * - Pagination/truncation support with cursor-based continuation
 * - Structured error handling with recovery hints
 */

/**
 * Schema version for response envelope.
 * Increment when making breaking changes to envelope structure.
 */
export const SCHEMA_VERSION = '2.0';

/**
 * Response format type.
 * - 'json': Structured JSON output (default, LLM-optimized)
 * - 'text': Human-readable text output (backward compatibility)
 */
export type ResponseFormat = 'json' | 'text';

/**
 * Source range within a file.
 * All positions are 1-indexed (line 1 = first line).
 */
export interface SourceRange {
  startLine: number;
  endLine: number;
  startCol?: number;
  endCol?: number;
}

/**
 * Evidence pointer - the atomic unit of citation.
 * Every fact in LLM output should be traceable to one or more evidence pointers.
 */
export interface EvidencePointer {
  /** Bundle-relative posix path (e.g., "repos/owner/repo/norm/src/index.ts") */
  path: string;
  /** Source range within the file */
  range: SourceRange;
  /** Optional URI for direct access (e.g., "preflight://bundle/xxx/file/...") */
  uri?: string;
  /** Optional short snippet (<= 500 chars) for quote-ready citations */
  snippet?: string;
  /** SHA256 of snippet for integrity verification */
  snippetSha256?: string;
}

/**
 * Truncation information for paginated responses.
 */
export interface TruncationInfo {
  /** Whether the response was truncated */
  truncated: boolean;
  /** Opaque cursor for fetching the next page */
  nextCursor?: string;
  /** Human-readable reason for truncation */
  reason?: string;
  /** Total count of items (if known) */
  totalCount?: number;
  /** Number of items returned in this response */
  returnedCount?: number;
}

/**
 * Structured error for machine-readable error handling.
 */
export interface StructuredError {
  /** Stable error code (e.g., "BUNDLE_NOT_FOUND", "FILE_NOT_FOUND") */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Recovery hint for LLM/user */
  hint?: string;
  /** Additional error context */
  details?: Record<string, unknown>;
}

/**
 * Warning that can be machine-read by LLM.
 */
export interface ResponseWarning {
  /** Warning code for programmatic handling */
  code: string;
  /** Human-readable warning message */
  message: string;
  /** Whether recovery is possible without user intervention */
  recoverable: boolean;
}

/**
 * Suggested next action for LLM to take.
 * Enables self-healing agent behavior.
 */
export interface NextAction {
  /** Tool to call */
  tool: string;
  /** Parameter template (with example values) */
  args: Record<string, unknown>;
  /** Human-readable reason why this action is suggested */
  reason: string;
}

/**
 * Response metadata for tracing and debugging.
 */
export interface ResponseMeta {
  /** Tool name that generated this response */
  tool: string;
  /** Schema version for this response format */
  schemaVersion: string;
  /** Unique request ID for tracing */
  requestId: string;
  /** Execution time in milliseconds */
  timeMs: number;
  /** Bundle ID if applicable */
  bundleId?: string;
  /** Whether result came from cache */
  fromCache?: boolean;
}

/**
 * Unified response envelope for all Preflight MCP tools.
 * 
 * @template T - The type of the data payload
 * 
 * Usage:
 * - Success: ok=true, data contains result, error is undefined
 * - Failure: ok=false, error contains structured error, data is undefined
 * 
 * Note: Index signature added for MCP SDK compatibility.
 */
export interface UnifiedResponse<T> {
  /** Index signature for MCP SDK compatibility */
  [key: string]: unknown;
  /** Whether the operation succeeded */
  ok: boolean;
  /** Response metadata */
  meta: ResponseMeta;
  /** Success payload (undefined on error) */
  data?: T;
  /** Structured error (undefined on success) */
  error?: StructuredError;
  /** Non-fatal warnings */
  warnings?: ResponseWarning[];
  /** Suggested follow-up actions */
  nextActions?: NextAction[];
  /** Truncation/pagination info */
  truncation?: TruncationInfo;
  /** Evidence pointers for citations (applicable responses only) */
  evidence?: EvidencePointer[];
}

/**
 * Type guard to check if response is successful.
 */
export function isSuccessResponse<T>(
  response: UnifiedResponse<T>
): response is UnifiedResponse<T> & { ok: true; data: T } {
  return response.ok === true && response.data !== undefined;
}

/**
 * Type guard to check if response is an error.
 */
export function isErrorResponse<T>(
  response: UnifiedResponse<T>
): response is UnifiedResponse<T> & { ok: false; error: StructuredError } {
  return response.ok === false && response.error !== undefined;
}

/**
 * Helper to create a source range from line numbers.
 */
export function createRange(
  startLine: number,
  endLine: number,
  startCol?: number,
  endCol?: number
): SourceRange {
  const range: SourceRange = { startLine, endLine };
  if (startCol !== undefined) range.startCol = startCol;
  if (endCol !== undefined) range.endCol = endCol;
  return range;
}

/**
 * Helper to create an evidence pointer.
 */
export function createEvidencePointer(
  path: string,
  range: SourceRange,
  options?: {
    uri?: string;
    snippet?: string;
    snippetSha256?: string;
  }
): EvidencePointer {
  const pointer: EvidencePointer = { path, range };
  if (options?.uri) pointer.uri = options.uri;
  if (options?.snippet) pointer.snippet = options.snippet;
  if (options?.snippetSha256) pointer.snippetSha256 = options.snippetSha256;
  return pointer;
}

/**
 * Format evidence pointer as citation string.
 * Format: "path:startLine-endLine" or "path:line" for single line
 */
export function formatEvidenceCitation(pointer: EvidencePointer): string {
  const { path, range } = pointer;
  if (range.startLine === range.endLine) {
    return `${path}:${range.startLine}`;
  }
  return `${path}:${range.startLine}-${range.endLine}`;
}
