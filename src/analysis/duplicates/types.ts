/**
 * Code Duplication Check Module - Type Definitions
 *
 * Defines types for detecting copy-paste code patterns.
 * Uses jscpd for multi-language duplication detection.
 *
 * @module analysis/duplicates/types
 */

// ============================================================================
// Clone Types
// ============================================================================

/**
 * Source location information for a code clone.
 */
export interface CloneSourceLocation {
  /** File path */
  file: string;
  /** Start line (1-indexed) */
  startLine: number;
  /** End line (1-indexed) */
  endLine: number;
  /** Start column */
  startColumn?: number;
  /** End column */
  endColumn?: number;
}

/**
 * A duplicated code fragment (clone instance).
 */
export interface CloneFragment {
  /** Source location */
  location: CloneSourceLocation;
  /** Number of lines */
  lines: number;
  /** Number of tokens */
  tokens: number;
  /** Code content preview (first few lines) */
  preview?: string;
}

/**
 * A code clone pair - two fragments that are duplicates.
 */
export interface Clone {
  /** First occurrence */
  fragmentA: CloneFragment;
  /** Second (duplicate) occurrence */
  fragmentB: CloneFragment;
  /** Detected format/language */
  format: string;
  /** Number of duplicated lines */
  linesCount: number;
  /** Number of duplicated tokens */
  tokensCount: number;
}

// ============================================================================
// Issue Types
// ============================================================================

/**
 * Issue severity levels.
 */
export type DuplicateSeverity = 'error' | 'warning' | 'info';

/**
 * A single duplication issue.
 */
export interface DuplicateIssue {
  /** Issue severity */
  severity: DuplicateSeverity;
  /** Primary file path */
  file: string;
  /** Line range (e.g., "10-25") */
  lineRange: string;
  /** Human-readable message */
  message: string;
  /** The clone pair information */
  clone: Clone;
}

// ============================================================================
// Result Types
// ============================================================================

/**
 * Per-file duplication statistics.
 */
export interface FileDuplicateStats {
  /** File path */
  file: string;
  /** Detected format/language */
  format: string;
  /** Total lines in file */
  totalLines: number;
  /** Number of duplicated lines */
  duplicatedLines: number;
  /** Duplication percentage */
  duplicationPercent: number;
  /** Number of clones involving this file */
  cloneCount: number;
}

/**
 * Overall duplication check summary.
 */
export interface DuplicateSummary {
  /** Total files analyzed */
  totalFiles: number;
  /** Total lines analyzed */
  totalLines: number;
  /** Total duplicated lines */
  duplicatedLines: number;
  /** Overall duplication percentage */
  duplicationPercent: number;
  /** Number of clone pairs found */
  totalClones: number;
  /** Issues by severity */
  issuesBySeverity: Record<DuplicateSeverity, number>;
  /** Clones by format/language */
  clonesByFormat: Record<string, number>;
}

/**
 * Overall duplication check result.
 */
export interface DuplicateCheckResult {
  /** All issues found */
  issues: DuplicateIssue[];
  /** All clones detected */
  clones: Clone[];
  /** Per-file statistics */
  files: FileDuplicateStats[];
  /** Summary statistics */
  summary: DuplicateSummary;
}

// ============================================================================
// Options Types
// ============================================================================

/**
 * Detection mode affecting strictness.
 * - strict: All symbols as tokens, only explicit ignores skipped
 * - mild: Skip ignored blocks, newlines, empty symbols
 * - weak: Skip ignored blocks, newlines, empty symbols, and comments
 */
export type DetectionMode = 'strict' | 'mild' | 'weak';

/**
 * Duplication check options.
 */
export interface DuplicateCheckOptions {
  /** Minimum tokens for a block to be considered (default: 50) */
  minTokens?: number;
  /** Minimum lines for a block to be considered (default: 5) */
  minLines?: number;
  /** Maximum file size in lines to analyze (default: 1000) */
  maxLines?: number;
  /** Maximum file size in bytes (default: 100KB) */
  maxSize?: string;
  /** Detection mode (default: 'mild') */
  mode?: DetectionMode;
  /** Duplication threshold percentage - fail if exceeded (default: 10) */
  threshold?: number;
  /** File patterns to include (glob) */
  includePatterns?: string[];
  /** File patterns to exclude (glob) */
  excludePatterns?: string[];
  /** Specific formats/languages to check (empty = all supported) */
  formats?: string[];
  /** Whether to ignore case when comparing (default: false) */
  ignoreCase?: boolean;
  /** Whether to skip detection in same folder only (default: false) */
  skipLocal?: boolean;
}

/**
 * Default duplication check options.
 */
export const DEFAULT_DUPLICATE_OPTIONS: Required<DuplicateCheckOptions> = {
  minTokens: 50,
  minLines: 5,
  maxLines: 1000,
  maxSize: '100kb',
  mode: 'mild',
  threshold: 10,
  includePatterns: [],
  excludePatterns: [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/__pycache__/**',
    '**/.venv/**',
    '**/venv/**',
    '**/*.min.js',
    '**/*.min.css',
    '**/*.map',
    '**/vendor/**',
  ],
  formats: [],
  ignoreCase: false,
  skipLocal: false,
};

// ============================================================================
// Severity Mapping
// ============================================================================

/**
 * Get severity based on duplication size.
 */
export function getSeverityForClone(clone: Clone): DuplicateSeverity {
  // Large duplications (50+ lines) are errors
  if (clone.linesCount >= 50) {
    return 'error';
  }
  // Medium duplications (20+ lines) are warnings
  if (clone.linesCount >= 20) {
    return 'warning';
  }
  // Small duplications are info
  return 'info';
}
