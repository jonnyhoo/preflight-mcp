/**
 * RFC v2: Response Builder for Preflight MCP tools.
 * 
 * Provides utilities for building unified response envelopes
 * with consistent structure, evidence tracking, and format support.
 */

import crypto from 'node:crypto';
import {
  type UnifiedResponse,
  type ResponseMeta,
  type StructuredError,
  type ResponseWarning,
  type NextAction,
  type TruncationInfo,
  type EvidencePointer,
  type ResponseFormat,
  SCHEMA_VERSION,
} from './envelope.js';

/**
 * Generate a unique request ID.
 */
export function generateRequestId(): string {
  return `req_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Options for building a success response.
 */
export interface SuccessResponseOptions {
  warnings?: ResponseWarning[];
  nextActions?: NextAction[];
  truncation?: TruncationInfo;
  evidence?: EvidencePointer[];
  fromCache?: boolean;
}

/**
 * Options for building an error response.
 */
export interface ErrorResponseOptions {
  warnings?: ResponseWarning[];
  nextActions?: NextAction[];
  details?: Record<string, unknown>;
}

/**
 * Context for building responses within a tool handler.
 */
export interface ResponseContext {
  tool: string;
  requestId: string;
  startTime: number;
  bundleId?: string;
  warnings: ResponseWarning[];
  nextActions: NextAction[];
  evidence: EvidencePointer[];
  truncation?: TruncationInfo;
  fromCache: boolean;
}

/**
 * Create a new response context for a tool handler.
 */
export function createResponseContext(tool: string, bundleId?: string): ResponseContext {
  return {
    tool,
    requestId: generateRequestId(),
    startTime: Date.now(),
    bundleId,
    warnings: [],
    nextActions: [],
    evidence: [],
    fromCache: false,
  };
}

/**
 * Build response metadata from context.
 */
function buildMeta(ctx: ResponseContext): ResponseMeta {
  return {
    tool: ctx.tool,
    schemaVersion: SCHEMA_VERSION,
    requestId: ctx.requestId,
    timeMs: Date.now() - ctx.startTime,
    bundleId: ctx.bundleId,
    fromCache: ctx.fromCache || undefined,
  };
}

/**
 * Create a successful unified response.
 */
export function createSuccessResponse<T>(
  ctx: ResponseContext,
  data: T,
  options?: SuccessResponseOptions
): UnifiedResponse<T> {
  const response: UnifiedResponse<T> = {
    ok: true,
    meta: buildMeta(ctx),
    data,
  };

  // Merge warnings from context and options
  const allWarnings = [...ctx.warnings, ...(options?.warnings ?? [])];
  if (allWarnings.length > 0) {
    response.warnings = allWarnings;
  }

  // Merge nextActions from context and options
  const allNextActions = [...ctx.nextActions, ...(options?.nextActions ?? [])];
  if (allNextActions.length > 0) {
    response.nextActions = allNextActions;
  }

  // Add truncation info
  if (options?.truncation || ctx.truncation) {
    response.truncation = options?.truncation ?? ctx.truncation;
  }

  // Merge evidence from context and options
  const allEvidence = [...ctx.evidence, ...(options?.evidence ?? [])];
  if (allEvidence.length > 0) {
    response.evidence = allEvidence;
  }

  return response;
}

/**
 * Create an error unified response.
 */
export function createErrorResponse(
  ctx: ResponseContext,
  code: string,
  message: string,
  hint?: string,
  options?: ErrorResponseOptions
): UnifiedResponse<never> {
  const error: StructuredError = {
    code,
    message,
  };
  if (hint) error.hint = hint;
  if (options?.details) error.details = options.details;

  const response: UnifiedResponse<never> = {
    ok: false,
    meta: buildMeta(ctx),
    error,
  };

  // Merge warnings from context and options
  const allWarnings = [...ctx.warnings, ...(options?.warnings ?? [])];
  if (allWarnings.length > 0) {
    response.warnings = allWarnings;
  }

  // Merge nextActions from context and options
  const allNextActions = [...ctx.nextActions, ...(options?.nextActions ?? [])];
  if (allNextActions.length > 0) {
    response.nextActions = allNextActions;
  }

  return response;
}

/**
 * Add a warning to the response context.
 */
export function addWarning(
  ctx: ResponseContext,
  code: string,
  message: string,
  recoverable = true
): void {
  ctx.warnings.push({ code, message, recoverable });
}

/**
 * Add a next action suggestion to the response context.
 */
export function addNextAction(
  ctx: ResponseContext,
  tool: string,
  args: Record<string, unknown>,
  reason: string
): void {
  ctx.nextActions.push({ tool, args, reason });
}

/**
 * Add an evidence pointer to the response context.
 */
export function addEvidence(
  ctx: ResponseContext,
  evidence: EvidencePointer
): void {
  ctx.evidence.push(evidence);
}

/**
 * Set truncation info on the response context.
 */
export function setTruncation(
  ctx: ResponseContext,
  truncated: boolean,
  options?: {
    nextCursor?: string;
    reason?: string;
    totalCount?: number;
    returnedCount?: number;
  }
): void {
  ctx.truncation = {
    truncated,
    nextCursor: options?.nextCursor,
    reason: options?.reason,
    totalCount: options?.totalCount,
    returnedCount: options?.returnedCount,
  };
}

/**
 * Format a unified response as human-readable text (backward compatibility).
 * Used when format='text' is requested.
 */
export function formatAsText<T>(response: UnifiedResponse<T>): string {
  const lines: string[] = [];

  if (response.ok && response.data !== undefined) {
    // Success case
    if (typeof response.data === 'string') {
      lines.push(response.data);
    } else if (Array.isArray(response.data)) {
      lines.push(JSON.stringify(response.data, null, 2));
    } else if (typeof response.data === 'object' && response.data !== null) {
      // Try to extract common text fields
      const data = response.data as Record<string, unknown>;
      if (typeof data.content === 'string') {
        lines.push(data.content);
      } else if (typeof data.text === 'string') {
        lines.push(data.text);
      } else if (typeof data.message === 'string') {
        lines.push(data.message);
      } else {
        lines.push(JSON.stringify(response.data, null, 2));
      }
    } else {
      lines.push(String(response.data));
    }
  } else if (response.error) {
    // Error case
    lines.push(`[${response.error.code}] ${response.error.message}`);
    if (response.error.hint) {
      lines.push('');
      lines.push(response.error.hint);
    }
  }

  // Add warnings
  if (response.warnings && response.warnings.length > 0) {
    lines.push('');
    lines.push('⚠️ Warnings:');
    for (const w of response.warnings) {
      lines.push(`  - [${w.code}] ${w.message}`);
    }
  }

  // Add next actions
  if (response.nextActions && response.nextActions.length > 0) {
    lines.push('');
    lines.push('💡 Suggested actions:');
    for (const action of response.nextActions) {
      lines.push(`  - ${action.tool}: ${action.reason}`);
    }
  }

  // Add truncation notice
  if (response.truncation?.truncated) {
    lines.push('');
    lines.push(`📄 Results truncated${response.truncation.reason ? `: ${response.truncation.reason}` : ''}`);
    if (response.truncation.nextCursor) {
      lines.push(`   Use cursor "${response.truncation.nextCursor}" to fetch more`);
    }
  }

  return lines.join('\n');
}

/**
 * Format response based on requested format.
 * Returns { text, structuredContent } suitable for MCP tool response.
 */
export function formatResponse<T>(
  response: UnifiedResponse<T>,
  format: ResponseFormat
): { text: string; structuredContent: UnifiedResponse<T> } {
  if (format === 'text') {
    return {
      text: formatAsText(response),
      structuredContent: response,
    };
  }
  // JSON format - return structured content as primary
  return {
    text: JSON.stringify(response, null, 2),
    structuredContent: response,
  };
}

/**
 * Common error codes for Preflight MCP.
 */
export const ErrorCodes = {
  // Bundle errors
  BUNDLE_NOT_FOUND: 'BUNDLE_NOT_FOUND',
  BUNDLE_INCOMPLETE: 'BUNDLE_INCOMPLETE',
  BUNDLE_IN_PROGRESS: 'BUNDLE_IN_PROGRESS',
  BUNDLE_EXISTS: 'BUNDLE_EXISTS',
  
  // File errors
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  INVALID_PATH: 'INVALID_PATH',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  
  // Index errors
  INDEX_MISSING: 'INDEX_MISSING',
  INDEX_CORRUPT: 'INDEX_CORRUPT',
  
  // Input errors
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_RANGE: 'INVALID_RANGE',
  INVALID_CURSOR: 'INVALID_CURSOR',
  
  // Resource errors
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  TIMEOUT: 'TIMEOUT',
  
  // Operation errors
  OPERATION_FAILED: 'OPERATION_FAILED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  
  // Deprecated
  DEPRECATED_PARAM: 'DEPRECATED_PARAM',
  
  // Unknown
  UNKNOWN: 'UNKNOWN',
} as const;

/**
 * Common warning codes for Preflight MCP.
 */
export const WarningCodes = {
  /** Result was truncated due to limits */
  RESULT_TRUNCATED: 'RESULT_TRUNCATED',
  /** Deprecated parameter was used */
  DEPRECATED_PARAM: 'DEPRECATED_PARAM',
  /** Some items were skipped */
  ITEMS_SKIPPED: 'ITEMS_SKIPPED',
  /** Evidence not found for some claims */
  EVIDENCE_MISSING: 'EVIDENCE_MISSING',
  /** Cache was stale */
  CACHE_STALE: 'CACHE_STALE',
  /** Partial results due to errors */
  PARTIAL_RESULTS: 'PARTIAL_RESULTS',
} as const;

/**
 * Recovery hints for common errors.
 */
export const RecoveryHints: Record<string, string> = {
  [ErrorCodes.BUNDLE_NOT_FOUND]: 
    'Run preflight_list_bundles to find available bundles, or create a new one with preflight_create_bundle.',
  [ErrorCodes.FILE_NOT_FOUND]: 
    'Run preflight_repo_tree to see available files in the bundle. Check the path format: repos/{owner}/{repo}/norm/{path}.',
  [ErrorCodes.INVALID_PATH]: 
    'Use bundle-relative paths only (no ".." or absolute paths). Format: repos/{owner}/{repo}/norm/{path}.',
  [ErrorCodes.INDEX_MISSING]: 
    'The search index is missing. Try deleting and recreating the bundle with preflight_delete_bundle and preflight_create_bundle.',
  [ErrorCodes.INDEX_CORRUPT]: 
    'The search index is corrupt. Try deleting and recreating the bundle with preflight_delete_bundle and preflight_create_bundle.',
  [ErrorCodes.INVALID_CURSOR]: 
    'The cursor is invalid or expired. Start a new search without a cursor.',
  [ErrorCodes.INVALID_RANGE]: 
    'Check range format: "startLine-endLine" (e.g., "20-80"). Lines are 1-indexed.',
  [ErrorCodes.QUOTA_EXCEEDED]: 
    'Reduce limit parameter or use more specific filters to reduce result size.',
  [ErrorCodes.TIMEOUT]: 
    'Try a more specific query or reduce the scope of the operation.',
};

/**
 * Get recovery hint for an error code.
 */
export function getRecoveryHint(code: string): string | undefined {
  return RecoveryHints[code];
}
