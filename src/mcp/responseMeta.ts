/**
 * Unified response metadata for all Preflight MCP tools.
 * Provides routing signals for LLM cost-minimization and self-healing.
 * 
 * RFC v2: Extended with schemaVersion, tool, bundleId for unified envelope support.
 */

import crypto from 'node:crypto';
import { SCHEMA_VERSION } from './envelope.js';

/**
 * Suggested next action for LLM to take.
 * @deprecated Use NextAction from envelope.ts for new code
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
 * @deprecated Use ResponseWarning from envelope.ts for new code
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
 * 
 * RFC v2: Added schemaVersion, tool, bundleId, nextCursor
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
  // RFC v2 additions
  /** Schema version for response format */
  schemaVersion?: string;
  /** Tool name that generated this response */
  tool?: string;
  /** Bundle ID if applicable */
  bundleId?: string;
  /** Cursor for pagination (RFC v2) */
  nextCursor?: string;
}

/**
 * Generate a unique request ID.
 */
export function generateRequestId(): string {
  return `req_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Options for creating a meta builder (RFC v2).
 */
export interface MetaBuilderOptions {
  /** Tool name for the response */
  tool?: string;
  /** Bundle ID if applicable */
  bundleId?: string;
  /** Include schema version in output */
  includeSchemaVersion?: boolean;
}

/**
 * Create a ResponseMeta builder for tracking execution.
 * RFC v2: Extended with tool, bundleId, schemaVersion, nextCursor support.
 */
export function createMetaBuilder(options?: MetaBuilderOptions): {
  requestId: string;
  startTime: number;
  warnings: ResponseWarning[];
  nextActions: NextAction[];
  truncated: boolean;
  truncatedReason?: string;
  fromCache: boolean;
  tool?: string;
  bundleId?: string;
  nextCursor?: string;
  addWarning: (code: string, message: string, recoverable?: boolean) => void;
  addNextAction: (action: NextAction) => void;
  setTruncated: (reason: string, nextCursor?: string) => void;
  setFromCache: (cached: boolean) => void;
  setTool: (tool: string) => void;
  setBundleId: (bundleId: string) => void;
  setNextCursor: (cursor: string) => void;
  build: () => ResponseMeta;
} {
  const requestId = generateRequestId();
  const startTime = Date.now();
  const warnings: ResponseWarning[] = [];
  const nextActions: NextAction[] = [];
  let truncated = false;
  let truncatedReason: string | undefined;
  let fromCache = false;
  let tool = options?.tool;
  let bundleId = options?.bundleId;
  let nextCursor: string | undefined;
  const includeSchemaVersion = options?.includeSchemaVersion ?? false;

  return {
    requestId,
    startTime,
    warnings,
    nextActions,
    truncated,
    truncatedReason,
    fromCache,
    tool,
    bundleId,
    nextCursor,

    addWarning(code: string, message: string, recoverable = true) {
      warnings.push({ code, message, recoverable });
    },

    addNextAction(action: NextAction) {
      nextActions.push(action);
    },

    setTruncated(reason: string, cursor?: string) {
      truncated = true;
      truncatedReason = reason;
      if (cursor) nextCursor = cursor;
    },

    setFromCache(cached: boolean) {
      fromCache = cached;
    },

    setTool(t: string) {
      tool = t;
    },

    setBundleId(id: string) {
      bundleId = id;
    },

    setNextCursor(cursor: string) {
      nextCursor = cursor;
    },

    build(): ResponseMeta {
      const meta: ResponseMeta = {
        requestId,
        durationMs: Date.now() - startTime,
      };

      // RFC v2 fields
      if (includeSchemaVersion) {
        meta.schemaVersion = SCHEMA_VERSION;
      }
      if (tool) {
        meta.tool = tool;
      }
      if (bundleId) {
        meta.bundleId = bundleId;
      }

      if (fromCache) {
        meta.fromCache = true;
      }

      if (warnings.length > 0) {
        meta.warnings = warnings;
      }

      if (truncated) {
        meta.truncated = true;
        meta.truncatedReason = truncatedReason;
        if (nextCursor) {
          meta.nextCursor = nextCursor;
        }
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
