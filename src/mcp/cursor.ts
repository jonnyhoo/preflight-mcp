/**
 * RFC v2: Cursor encoding/decoding for stable pagination.
 * 
 * Cursors are opaque, base64-encoded JSON objects that contain:
 * - offset: The position in the result set
 * - sortKey: The last seen sort key for stable ordering
 * - tool: The tool that generated the cursor (for validation)
 * - timestamp: When the cursor was created (for expiration)
 * 
 * This enables LLMs to reliably paginate through large result sets.
 */

/**
 * Internal cursor state structure.
 */
export interface CursorState {
  /** Offset in the result set */
  offset: number;
  /** Last seen sort key (for keyset pagination) */
  sortKey?: string;
  /** Tool that generated this cursor */
  tool: string;
  /** Creation timestamp (Unix ms) */
  timestamp: number;
  /** Additional tool-specific data */
  extra?: Record<string, unknown>;
}

/**
 * Cursor validation result.
 */
export interface CursorValidation {
  valid: boolean;
  state?: CursorState;
  error?: string;
}

/**
 * Maximum cursor age in milliseconds (24 hours).
 * Cursors older than this are considered expired.
 */
const MAX_CURSOR_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Encode cursor state to an opaque string.
 */
export function encodeCursor(state: CursorState): string {
  const json = JSON.stringify(state);
  // Use base64url encoding (URL-safe, no padding)
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decode cursor string to cursor state.
 * Returns null if the cursor is invalid.
 */
export function decodeCursor(cursor: string): CursorState | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const state = JSON.parse(json) as unknown;
    
    // Validate structure
    if (
      typeof state !== 'object' ||
      state === null ||
      typeof (state as CursorState).offset !== 'number' ||
      typeof (state as CursorState).tool !== 'string' ||
      typeof (state as CursorState).timestamp !== 'number'
    ) {
      return null;
    }
    
    return state as CursorState;
  } catch {
    return null;
  }
}

/**
 * Validate a cursor for a specific tool.
 * Checks structure, tool match, and expiration.
 */
export function validateCursor(
  cursor: string,
  expectedTool: string,
  options?: {
    /** Maximum age in milliseconds (default: 24 hours) */
    maxAgeMs?: number;
    /** Allow tool mismatch (default: false) */
    allowToolMismatch?: boolean;
  }
): CursorValidation {
  const state = decodeCursor(cursor);
  
  if (!state) {
    return {
      valid: false,
      error: 'Invalid cursor format',
    };
  }
  
  // Check tool match
  if (!options?.allowToolMismatch && state.tool !== expectedTool) {
    return {
      valid: false,
      state,
      error: `Cursor was created by ${state.tool}, not ${expectedTool}`,
    };
  }
  
  // Check expiration
  const maxAge = options?.maxAgeMs ?? MAX_CURSOR_AGE_MS;
  const age = Date.now() - state.timestamp;
  if (age > maxAge) {
    return {
      valid: false,
      state,
      error: `Cursor expired (age: ${Math.round(age / 1000)}s, max: ${Math.round(maxAge / 1000)}s)`,
    };
  }
  
  return {
    valid: true,
    state,
  };
}

/**
 * Create a cursor for the next page of results.
 * 
 * @param tool - The tool creating the cursor
 * @param offset - Current offset (will be incremented by pageSize)
 * @param pageSize - Number of items per page
 * @param sortKey - Optional sort key for keyset pagination
 * @param extra - Optional additional data
 */
export function createNextCursor(
  tool: string,
  offset: number,
  pageSize: number,
  sortKey?: string,
  extra?: Record<string, unknown>
): string {
  const state: CursorState = {
    offset: offset + pageSize,
    tool,
    timestamp: Date.now(),
  };
  if (sortKey !== undefined) state.sortKey = sortKey;
  if (extra !== undefined) state.extra = extra;
  
  return encodeCursor(state);
}

/**
 * Parse cursor or return default offset.
 * Convenience function for tool handlers.
 * 
 * @param cursor - Optional cursor string
 * @param tool - Expected tool name
 * @param defaultOffset - Default offset if no cursor (default: 0)
 * @returns Offset to use and any error message
 */
export function parseCursorOrDefault(
  cursor: string | undefined,
  tool: string,
  defaultOffset = 0
): { offset: number; sortKey?: string; extra?: Record<string, unknown>; error?: string } {
  if (!cursor) {
    return { offset: defaultOffset };
  }
  
  const validation = validateCursor(cursor, tool);
  if (!validation.valid) {
    return { offset: defaultOffset, error: validation.error };
  }
  
  return {
    offset: validation.state!.offset,
    sortKey: validation.state!.sortKey,
    extra: validation.state!.extra,
  };
}

/**
 * Helper to determine if pagination should continue.
 * 
 * @param returnedCount - Number of items returned in this page
 * @param limit - Requested limit
 * @param totalCount - Optional total count (if known)
 * @param currentOffset - Current offset in result set
 */
export function shouldPaginate(
  returnedCount: number,
  limit: number,
  totalCount?: number,
  currentOffset = 0
): boolean {
  // If we got fewer items than requested, we're at the end
  if (returnedCount < limit) {
    return false;
  }
  
  // If we know the total and have fetched everything, no more pages
  if (totalCount !== undefined && currentOffset + returnedCount >= totalCount) {
    return false;
  }
  
  // Otherwise, assume there might be more
  return true;
}
