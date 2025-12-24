/**
 * Custom error types for preflight-mcp.
 * Provides structured error handling with error codes and context.
 */

/**
 * Base error class for all preflight-mcp errors.
 */
export class PreflightError extends Error {
  public readonly code: string;
  public readonly context?: Record<string, unknown>;
  public readonly cause?: Error;

  constructor(
    message: string,
    code: string,
    options?: {
      context?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(message);
    this.name = 'PreflightError';
    this.code = code;
    this.context = options?.context;
    this.cause = options?.cause;

    // Maintains proper stack trace for where our error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      cause: this.cause?.message,
      stack: this.stack,
    };
  }
}

/**
 * Check if a string looks like a valid UUID v4.
 */
function isUuidFormat(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * Error thrown when a bundle is not found.
 */
export class BundleNotFoundError extends PreflightError {
  constructor(bundleId: string) {
    const hint = isUuidFormat(bundleId)
      ? '\nUse preflight_list_bundles to see available bundles.'
      : `\nHint: bundleId must be a UUID (e.g., 025c6dcb-1234-5678-9abc-def012345678).\n` +
        `      "${bundleId}" looks like a displayName, not a bundleId.\n` +
        `      Use preflight_list_bundles to find the correct bundleId.\n` +
        `      DO NOT automatically create a new bundle - ASK the user first!`;
    
    super(`Bundle not found: ${bundleId}${hint}`, 'BUNDLE_NOT_FOUND', {
      context: { bundleId },
    });
    this.name = 'BundleNotFoundError';
  }
}

/**
 * Error thrown when storage operations fail.
 */
export class StorageError extends PreflightError {
  constructor(message: string, options?: { context?: Record<string, unknown>; cause?: Error }) {
    super(message, 'STORAGE_ERROR', options);
    this.name = 'StorageError';
  }
}

/**
 * Error thrown when no storage directory is available.
 */
export class StorageUnavailableError extends StorageError {
  constructor(attemptedPaths: string[]) {
    super('No storage directory available. All mount points are inaccessible.', {
      context: { attemptedPaths },
    });
    this.name = 'StorageUnavailableError';
  }
}

/**
 * Error thrown when bundle creation fails.
 */
export class BundleCreationError extends PreflightError {
  constructor(
    message: string,
    bundleId: string,
    options?: { context?: Record<string, unknown>; cause?: Error }
  ) {
    super(`Failed to create bundle: ${message}`, 'BUNDLE_CREATION_ERROR', {
      ...options,
      context: { ...options?.context, bundleId },
    });
    this.name = 'BundleCreationError';
  }
}

/**
 * Error thrown when bundle validation fails.
 */
export class BundleValidationError extends PreflightError {
  constructor(bundleId: string, missingComponents: string[]) {
    super(`Bundle creation incomplete. Missing: ${missingComponents.join(', ')}`, 'BUNDLE_VALIDATION_ERROR', {
      context: { bundleId, missingComponents },
    });
    this.name = 'BundleValidationError';
  }
}

/**
 * Error thrown when GitHub operations fail.
 */
export class GitHubError extends PreflightError {
  constructor(message: string, options?: { context?: Record<string, unknown>; cause?: Error }) {
    super(message, 'GITHUB_ERROR', options);
    this.name = 'GitHubError';
  }
}

/**
 * Error thrown when Context7 operations fail.
 */
export class Context7Error extends PreflightError {
  constructor(message: string, options?: { context?: Record<string, unknown>; cause?: Error }) {
    super(message, 'CONTEXT7_ERROR', options);
    this.name = 'Context7Error';
  }
}

/**
 * Error thrown when search operations fail.
 */
export class SearchError extends PreflightError {
  constructor(message: string, options?: { context?: Record<string, unknown>; cause?: Error }) {
    super(message, 'SEARCH_ERROR', options);
    this.name = 'SearchError';
  }
}

/**
 * Error thrown when file ingestion fails.
 */
export class IngestError extends PreflightError {
  constructor(message: string, options?: { context?: Record<string, unknown>; cause?: Error }) {
    super(message, 'INGEST_ERROR', options);
    this.name = 'IngestError';
  }
}

/**
 * Error thrown for configuration-related issues.
 */
export class ConfigError extends PreflightError {
  constructor(message: string, options?: { context?: Record<string, unknown>; cause?: Error }) {
    super(message, 'CONFIG_ERROR', options);
    this.name = 'ConfigError';
  }
}

/**
 * Helper to wrap unknown errors as PreflightError.
 */
export function wrapError(err: unknown, code = 'UNKNOWN_ERROR'): PreflightError {
  if (err instanceof PreflightError) {
    return err;
  }

  if (err instanceof Error) {
    return new PreflightError(err.message, code, { cause: err });
  }

  return new PreflightError(String(err), code);
}

/**
 * Type guard to check if an error is a PreflightError.
 */
export function isPreflightError(err: unknown): err is PreflightError {
  return err instanceof PreflightError;
}
