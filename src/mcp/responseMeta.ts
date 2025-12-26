/**
 * Unified response metadata for all Preflight MCP tools.
 * Provides routing signals for LLM cost-minimization and self-healing.
 */

import crypto from 'node:crypto';

/**
 * Suggested next action for LLM to take.
 */
export interface NextAction {
  /** Tool to call */
  toolName: string;
  /** Parameter template (with example values) */
  paramsTemplate: Record<string, unknown>;
  /** Human-readable reason why this action is suggested */
  why: string;
}

/**
 * Warning that can be machine-read by LLM.
 */
export interface ResponseWarning {
  code: string;
  message: string;
  recoverable: boolean;
}

/**
 * Unified metadata for tool responses.
 * LLM can use these signals for:
 * - Cost minimization (fromCache, durationMs)
 * - Error recovery (warnings, nextActions)
 * - Context management (truncated, truncatedReason)
 */
export interface ResponseMeta {
  /** Unique request ID for tracing */
  requestId: string;
  /** Execution time in milliseconds */
  durationMs: number;
  /** Whether result came from cache */
  fromCache?: boolean;
  /** Machine-readable warnings */
  warnings?: ResponseWarning[];
  /** Whether output was truncated */
  truncated?: boolean;
  /** Reason for truncation */
  truncatedReason?: string;
  /** Suggested follow-up actions */
  nextActions?: NextAction[];
}

/**
 * Generate a unique request ID.
 */
export function generateRequestId(): string {
  return `req_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Create a ResponseMeta builder for tracking execution.
 */
export function createMetaBuilder(): {
  requestId: string;
  startTime: number;
  warnings: ResponseWarning[];
  nextActions: NextAction[];
  truncated: boolean;
  truncatedReason?: string;
  fromCache: boolean;
  addWarning: (code: string, message: string, recoverable?: boolean) => void;
  addNextAction: (action: NextAction) => void;
  setTruncated: (reason: string) => void;
  setFromCache: (cached: boolean) => void;
  build: () => ResponseMeta;
} {
  const requestId = generateRequestId();
  const startTime = Date.now();
  const warnings: ResponseWarning[] = [];
  const nextActions: NextAction[] = [];
  let truncated = false;
  let truncatedReason: string | undefined;
  let fromCache = false;

  return {
    requestId,
    startTime,
    warnings,
    nextActions,
    truncated,
    truncatedReason,
    fromCache,

    addWarning(code: string, message: string, recoverable = true) {
      warnings.push({ code, message, recoverable });
    },

    addNextAction(action: NextAction) {
      nextActions.push(action);
    },

    setTruncated(reason: string) {
      truncated = true;
      truncatedReason = reason;
    },

    setFromCache(cached: boolean) {
      fromCache = cached;
    },

    build(): ResponseMeta {
      const meta: ResponseMeta = {
        requestId,
        durationMs: Date.now() - startTime,
      };

      if (fromCache) {
        meta.fromCache = true;
      }

      if (warnings.length > 0) {
        meta.warnings = warnings;
      }

      if (truncated) {
        meta.truncated = true;
        meta.truncatedReason = truncatedReason;
      }

      if (nextActions.length > 0) {
        meta.nextActions = nextActions;
      }

      return meta;
    },
  };
}

/**
 * Common warning codes for standardized error handling.
 */
export const WarningCodes = {
  /** Source ID format mismatch */
  SOURCE_ID_MISMATCH: 'SOURCE_ID_MISMATCH',
  /** No matching results found */
  NO_MATCHES: 'NO_MATCHES',
  /** Result truncated due to limits */
  RESULT_TRUNCATED: 'RESULT_TRUNCATED',
  /** Index not initialized */
  INDEX_NOT_INITIALIZED: 'INDEX_NOT_INITIALIZED',
  /** Evidence sources missing */
  SOURCES_MISSING: 'SOURCES_MISSING',
  /** Bundle not found */
  BUNDLE_NOT_FOUND: 'BUNDLE_NOT_FOUND',
  /** File not found in bundle */
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  /** Deprecated parameter used */
  DEPRECATED_PARAM: 'DEPRECATED_PARAM',
} as const;

/**
 * Helper to create "did you mean" suggestions for source_id mismatches.
 */
export function createDidYouMeanNextActions(
  bundleId: string,
  sourceType: string,
  candidates: string[],
  originalSourceId: string
): NextAction[] {
  return candidates.slice(0, 5).map((candidate) => ({
    toolName: 'preflight_trace_query',
    paramsTemplate: {
      bundleId,
      source_type: sourceType,
      source_id: candidate,
    },
    why: `Try "${candidate}" instead of "${originalSourceId}"`,
  }));
}
