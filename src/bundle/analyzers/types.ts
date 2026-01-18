/**
 * Analyzer Module - Type Definitions
 *
 * Defines unified interfaces for all analyzers in the bundle/analyzers module.
 * All analyzer implementations must conform to these type contracts.
 *
 * @module bundle/analyzers/types
 */

import type { IngestedFile } from '../ingest.js';
import type { BundleManifestV1 } from '../manifest.js';
import type { BundleFacts } from '../facts.js';

// ============================================================================
// Re-exports for convenience
// ============================================================================

/** Bundle manifest type alias for analyzer usage */
export type BundleManifest = BundleManifestV1;

// Re-export commonly used types
export type { IngestedFile, BundleFacts };

// ============================================================================
// Analyzer Input Types
// ============================================================================

/**
 * Analyzer input configuration.
 * Provides all necessary context for an analyzer to perform its analysis.
 */
export type AnalyzerInput = {
  /** Bundle root directory absolute path */
  bundleRoot: string;
  /** List of ingested files to analyze */
  files: IngestedFile[];
  /** Bundle manifest containing metadata */
  manifest: BundleManifest;
  /** Optional pre-extracted bundle facts */
  facts?: BundleFacts;
};

// ============================================================================
// Analyzer Output Types
// ============================================================================

/**
 * A single highlight item representing a key finding from analysis.
 */
export type AnalyzerHighlight = {
  /** Type of finding (pattern name, config key, etc.) */
  type: string;
  /** Human-readable description of the finding */
  description: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** File path where found (optional) */
  file?: string;
  /** Line number (optional) */
  line?: number;
  /** Additional context (optional) */
  context?: Record<string, unknown>;
};

/**
 * Analyzer output result.
 * Generic type parameter T represents the specific data type returned by each analyzer.
 */
export type AnalyzerOutput<T = unknown> = {
  /** Whether the analysis completed successfully */
  success: boolean;
  /** Brief 1-2 sentence summary of analysis results */
  summary: string;
  /** Top 5 most valuable findings (high confidence/quality only) */
  highlights: AnalyzerHighlight[];
  /** Analysis result data (present when success is true) */
  data?: T;
  /** List of errors encountered during analysis (non-fatal errors allow continuation) */
  errors?: AnalyzerErrorInfo[];
  /** Metadata about the analysis execution */
  metadata: AnalyzerMetadata;
};

/**
 * Metadata about analyzer execution.
 */
export type AnalyzerMetadata = {
  /** Unique analyzer name */
  analyzerName: string;
  /** Analyzer version (semver) */
  version: string;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Number of files analyzed */
  filesAnalyzed: number;
};

// ============================================================================
// Analyzer Error Types
// ============================================================================

/**
 * Analyzer error information.
 * Represents errors encountered during analysis.
 */
export type AnalyzerErrorInfo = {
  /** Error code (e.g., 'PARSE_ERROR', 'FILE_NOT_FOUND') */
  code: string;
  /** Human-readable error description */
  message: string;
  /** Associated file path (if applicable) */
  file?: string;
  /** Associated line number (if applicable) */
  line?: number;
  /** Whether analysis can continue after this error */
  recoverable: boolean;
};

// ============================================================================
// Analyzer Configuration Types
// ============================================================================

/**
 * Base analyzer configuration options.
 * All analyzers support these common options.
 */
export type AnalyzerOptions = {
  /** Whether the analyzer is enabled (default: true) */
  enabled?: boolean;
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Maximum number of files to analyze (0 = unlimited) */
  maxFiles?: number;
  /** File inclusion patterns (glob) */
  includePatterns?: string[];
  /** File exclusion patterns (glob) */
  excludePatterns?: string[];
};

/**
 * Default analyzer options.
 */
export const DEFAULT_ANALYZER_OPTIONS: Required<AnalyzerOptions> = {
  enabled: true,
  timeout: 30000,
  maxFiles: 0,
  includePatterns: [],
  excludePatterns: [],
};

// ============================================================================
// Analyzer Interface
// ============================================================================

/**
 * Analyzer interface.
 * All analyzers must implement this interface.
 */
export type Analyzer<TOutput = unknown, TOptions extends AnalyzerOptions = AnalyzerOptions> = {
  /** Unique analyzer name */
  readonly name: string;
  /** Analyzer version (semver) */
  readonly version: string;
  /** Human-readable description */
  readonly description: string;
  /** Current options */
  readonly options: Required<TOptions>;
  /** Execute analysis */
  analyze(input: AnalyzerInput): Promise<AnalyzerOutput<TOutput>>;
};

/**
 * Analyzer factory function type.
 * Each analyzer module should export a factory function following this signature.
 */
export type AnalyzerFactory<
  TOutput = unknown,
  TOptions extends AnalyzerOptions = AnalyzerOptions,
> = (options?: Partial<TOptions>) => Analyzer<TOutput, TOptions>;
