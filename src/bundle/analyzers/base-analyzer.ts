/**
 * Base Analyzer Module
 *
 * Provides abstract base class for all analyzers and common error types.
 * All analyzer implementations should extend BaseAnalyzer.
 *
 * @module bundle/analyzers/base-analyzer
 */

import * as path from 'node:path';

import { minimatch } from 'minimatch';

import { PreflightError } from '../../errors.js';
import { createModuleLogger } from '../../logging/logger.js';
import type { ILogger } from '../../logging/types.js';

import {
  type AnalyzerInput,
  type AnalyzerOutput,
  type AnalyzerOptions,
  type AnalyzerErrorInfo,
  type AnalyzerMetadata,
  type AnalyzerHighlight,
  type IngestedFile,
  DEFAULT_ANALYZER_OPTIONS,
} from './types.js';

// ============================================================================
// Analyzer Error Classes
// ============================================================================

/**
 * Base error class for all analyzer errors.
 */
export class AnalyzerError extends PreflightError {
  constructor(
    message: string,
    code: string,
    options?: {
      context?: Record<string, unknown>;
      cause?: Error;
      recoverable?: boolean;
    }
  ) {
    super(message, `ANALYZER_${code}`, options);
    this.name = 'AnalyzerError';
  }

  get recoverable(): boolean {
    return (this.context?.recoverable as boolean) ?? false;
  }
}

/**
 * Error thrown when analyzer execution times out.
 */
export class AnalyzerTimeoutError extends AnalyzerError {
  constructor(analyzerName: string, timeoutMs: number) {
    super(`Analyzer "${analyzerName}" timed out after ${timeoutMs}ms`, 'TIMEOUT', {
      context: { analyzerName, timeoutMs, recoverable: false },
    });
    this.name = 'AnalyzerTimeoutError';
  }
}

/**
 * Error thrown when file analysis fails (recoverable by default).
 */
export class FileAnalysisError extends AnalyzerError {
  constructor(filePath: string, reason: string, cause?: Error) {
    super(`Failed to analyze file "${filePath}": ${reason}`, 'FILE_ANALYSIS_ERROR', {
      context: { filePath, recoverable: true },
      cause,
    });
    this.name = 'FileAnalysisError';
  }
}

/**
 * Error thrown when input validation fails.
 */
export class InputValidationError extends AnalyzerError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'INPUT_VALIDATION_ERROR', {
      context: { ...context, recoverable: false },
    });
    this.name = 'InputValidationError';
  }
}

// ============================================================================
// Base Analyzer Abstract Class
// ============================================================================

/**
 * Abstract base class for all analyzers.
 *
 * Provides common functionality:
 * - Option merging with defaults
 * - File filtering by patterns
 * - Input validation
 * - Execution timing
 * - Error handling framework
 *
 * @typeParam TOutput - The type of analysis result data
 * @typeParam TOptions - The type of analyzer options (extends AnalyzerOptions)
 *
 * @example
 * ```ts
 * class MyAnalyzer extends BaseAnalyzer<MyOutput, MyOptions> {
 *   readonly name = 'my-analyzer';
 *   readonly version = '1.0.0';
 *   readonly description = 'Analyzes something';
 *
 *   protected getDefaultOptions(): Required<MyOptions> {
 *     return { ...DEFAULT_ANALYZER_OPTIONS, customOption: 'value' };
 *   }
 *
 *   async analyze(input: AnalyzerInput): Promise<AnalyzerOutput<MyOutput>> {
 *     // Implementation
 *   }
 * }
 * ```
 */
export abstract class BaseAnalyzer<
  TOutput = unknown,
  TOptions extends AnalyzerOptions = AnalyzerOptions,
> {
  /** Unique analyzer name */
  abstract readonly name: string;

  /** Analyzer version (semver) */
  abstract readonly version: string;

  /** Human-readable description */
  abstract readonly description: string;

  /** Merged options (defaults + user options) */
  readonly options: Required<TOptions>;

  /** Module logger instance */
  protected readonly logger: ILogger;

  /**
   * Creates a new analyzer instance.
   *
   * @param options - Optional partial options to override defaults
   */
  constructor(options?: Partial<TOptions>) {
    this.options = this.mergeOptions(options);
    // Logger will be properly initialized after subclass sets 'name'
    // We use a getter pattern or lazy initialization
    this.logger = null as unknown as ILogger;
  }

  /**
   * Gets or creates the logger instance.
   * Uses lazy initialization to ensure 'name' is available.
   */
  protected getLogger(): ILogger {
    if (!this.logger) {
      (this as unknown as { logger: ILogger }).logger = createModuleLogger(`analyzer:${this.name}`);
    }
    return this.logger;
  }

  /**
   * Execute analysis on the input.
   *
   * @param input - Analyzer input configuration
   * @returns Analysis output with results and metadata
   */
  abstract analyze(input: AnalyzerInput): Promise<AnalyzerOutput<TOutput>>;

  /**
   * Returns default options for this analyzer.
   * Subclasses should override to provide analyzer-specific defaults.
   */
  protected getDefaultOptions(): Required<TOptions> {
    return DEFAULT_ANALYZER_OPTIONS as Required<TOptions>;
  }

  /**
   * Merges user options with default options.
   *
   * @param userOptions - Partial options provided by user
   * @returns Fully populated options object
   */
  protected mergeOptions(userOptions?: Partial<TOptions>): Required<TOptions> {
    const defaults = this.getDefaultOptions();
    return {
      ...defaults,
      ...userOptions,
    } as Required<TOptions>;
  }

  /**
   * Validates analyzer input.
   * Can be overridden by subclasses for additional validation.
   *
   * @param input - Analyzer input to validate
   * @returns Array of validation errors (empty if valid)
   */
  protected validateInput(input: AnalyzerInput): AnalyzerErrorInfo[] {
    const errors: AnalyzerErrorInfo[] = [];

    if (!input.bundleRoot) {
      errors.push({
        code: 'MISSING_BUNDLE_ROOT',
        message: 'bundleRoot is required',
        recoverable: false,
      });
    }

    if (!input.files) {
      errors.push({
        code: 'MISSING_FILES',
        message: 'files array is required',
        recoverable: false,
      });
    }

    if (!input.manifest) {
      errors.push({
        code: 'MISSING_MANIFEST',
        message: 'manifest is required',
        recoverable: false,
      });
    }

    return errors;
  }

  /**
   * Filters files based on include/exclude patterns.
   *
   * @param files - Files to filter
   * @returns Filtered files matching patterns
   */
  protected filterFiles(files: IngestedFile[]): IngestedFile[] {
    const { includePatterns, excludePatterns, maxFiles } = this.options;

    let filtered = files;

    // Apply include patterns (if specified, file must match at least one)
    if (includePatterns && includePatterns.length > 0) {
      filtered = filtered.filter((file) =>
        includePatterns.some((pattern) => minimatch(file.repoRelativePath, pattern))
      );
    }

    // Apply exclude patterns (file must not match any)
    if (excludePatterns && excludePatterns.length > 0) {
      filtered = filtered.filter(
        (file) => !excludePatterns.some((pattern) => minimatch(file.repoRelativePath, pattern))
      );
    }

    // Apply maxFiles limit
    if (maxFiles && maxFiles > 0) {
      filtered = filtered.slice(0, maxFiles);
    }

    return filtered;
  }

  /**
   * Creates analyzer metadata for output.
   *
   * @param startTime - Analysis start timestamp
   * @param filesAnalyzed - Number of files analyzed
   * @returns Analyzer metadata object
   */
  protected createMetadata(startTime: number, filesAnalyzed: number): AnalyzerMetadata {
    return {
      analyzerName: this.name,
      version: this.version,
      durationMs: Date.now() - startTime,
      filesAnalyzed,
    };
  }

  /**
   * Creates a successful output result.
   *
   * @param data - Analysis result data
   * @param metadata - Analyzer metadata
   * @param summary - Brief 1-2 sentence summary
   * @param highlights - Top findings (max 5)
   * @param errors - Optional non-fatal errors encountered
   * @returns Success output object
   */
  protected createSuccessOutput(
    data: TOutput,
    metadata: AnalyzerMetadata,
    summary: string,
    highlights: AnalyzerHighlight[],
    errors?: AnalyzerErrorInfo[]
  ): AnalyzerOutput<TOutput> {
    return {
      success: true,
      summary,
      highlights: highlights.slice(0, 5), // Limit to top 5
      data,
      errors: errors && errors.length > 0 ? errors : undefined,
      metadata,
    };
  }

  /**
   * Creates a failure output result.
   *
   * @param errors - Errors that caused the failure
   * @param metadata - Analyzer metadata
   * @returns Failure output object
   */
  protected createFailureOutput(
    errors: AnalyzerErrorInfo[],
    metadata: AnalyzerMetadata
  ): AnalyzerOutput<TOutput> {
    return {
      success: false,
      summary: 'Analysis failed due to errors.',
      highlights: [],
      errors,
      metadata,
    };
  }

  /**
   * Converts an Error to AnalyzerErrorInfo.
   *
   * @param error - Error to convert
   * @param file - Optional associated file path
   * @returns Analyzer error info object
   */
  protected errorToInfo(error: unknown, file?: string): AnalyzerErrorInfo {
    if (error instanceof AnalyzerError) {
      return {
        code: error.code,
        message: error.message,
        file,
        recoverable: error.recoverable,
      };
    }

    if (error instanceof Error) {
      return {
        code: 'UNKNOWN_ERROR',
        message: error.message,
        file,
        recoverable: true,
      };
    }

    return {
      code: 'UNKNOWN_ERROR',
      message: String(error),
      file,
      recoverable: true,
    };
  }

  /**
   * Wraps analysis execution with timeout protection.
   *
   * @param fn - Async function to execute
   * @returns Result of the function
   * @throws AnalyzerTimeoutError if execution exceeds timeout
   */
  protected async withTimeout<T>(fn: () => Promise<T>): Promise<T> {
    const { timeout } = this.options;

    if (!timeout || timeout <= 0) {
      return fn();
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new AnalyzerTimeoutError(this.name, timeout));
      }, timeout);

      fn()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Gets file extension from path.
 *
 * @param filePath - File path
 * @returns File extension (lowercase, without dot) or empty string
 */
export function getFileExtension(filePath: string): string {
  const ext = path.extname(filePath);
  return ext ? ext.slice(1).toLowerCase() : '';
}

/**
 * Determines if a file is likely source code based on extension.
 *
 * @param filePath - File path to check
 * @returns True if file appears to be source code
 */
export function isSourceCodeFile(filePath: string): boolean {
  const codeExtensions = new Set([
    // JavaScript/TypeScript
    'js',
    'jsx',
    'ts',
    'tsx',
    'mjs',
    'cjs',
    // Python
    'py',
    'pyw',
    // Java/Kotlin
    'java',
    'kt',
    'kts',
    // C/C++
    'c',
    'cpp',
    'cc',
    'cxx',
    'h',
    'hpp',
    'hh',
    'hxx',
    // C#
    'cs',
    // Go
    'go',
    // Rust
    'rs',
    // Ruby
    'rb',
    // PHP
    'php',
    // Swift
    'swift',
    // Scala
    'scala',
    // Perl
    'pl',
    'pm',
    // Shell
    'sh',
    'bash',
    'zsh',
    // PowerShell
    'ps1',
    'psm1',
  ]);

  const ext = getFileExtension(filePath);
  return codeExtensions.has(ext);
}
