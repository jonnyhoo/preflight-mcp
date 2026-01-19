/**
 * Unified Code Check Module - Type Definitions
 *
 * Provides unified types for all code quality checks:
 * - duplicates: Copy-paste code detection
 * - doccheck: Documentation-code consistency
 * - deadcode: Unused code detection
 * - circular: Circular dependency detection
 * - complexity: Code complexity hotspots
 *
 * @module analysis/check/types
 */

// ============================================================================
// Check Types
// ============================================================================

/**
 * Available check types.
 */
export type CheckType = 'duplicates' | 'doccheck' | 'deadcode' | 'circular' | 'complexity';

/**
 * All available check types.
 */
export const ALL_CHECK_TYPES: CheckType[] = ['duplicates', 'doccheck', 'deadcode', 'circular', 'complexity'];

/**
 * Issue severity levels.
 */
export type CheckSeverity = 'error' | 'warning' | 'info';

// ============================================================================
// Unified Issue Types
// ============================================================================

/**
 * Base issue interface for all check types.
 */
export interface BaseCheckIssue {
  /** Issue severity */
  severity: CheckSeverity;
  /** File path */
  file: string;
  /** Line number or range (e.g., "10" or "10-25") */
  line: string;
  /** Human-readable message */
  message: string;
  /** Rule ID (optional, being phased in) */
  ruleId?: string;
  /** Whether this issue is suppressed */
  suppressed?: boolean;
}

/**
 * Deadcode-specific issue.
 */
export interface DeadCodeIssue extends BaseCheckIssue {
  type: 'orphaned' | 'unused-export' | 'unreachable';
  /** For unused-export: the export name */
  exportName?: string;
}

/**
 * Circular dependency issue.
 */
export interface CircularIssue extends BaseCheckIssue {
  type: 'circular';
  /** The cycle path: [a.ts, b.ts, c.ts, a.ts] */
  cycle: string[];
}

/**
 * Complexity issue.
 */
export interface ComplexityIssue extends BaseCheckIssue {
  type: 'high-complexity' | 'cognitive-complexity' | 'deep-nesting' | 'long-function' | 'many-params';
  /** Function or method name */
  functionName?: string;
  /** Measured value (complexity score, nesting depth, lines, param count) */
  value: number;
  /** Threshold that was exceeded */
  threshold: number;
}

// ============================================================================
// Check Result Types
// ============================================================================

/**
 * Summary for a single check type.
 */
export interface CheckSummary {
  /** Total files analyzed */
  totalFiles: number;
  /** Total issues found */
  totalIssues: number;
  /** Issues by severity */
  issuesBySeverity: Record<CheckSeverity, number>;
}

/**
 * Result for a single check type.
 */
export interface SingleCheckResult<T extends BaseCheckIssue = BaseCheckIssue> {
  /** Check type */
  type: CheckType;
  /** Whether the check succeeded */
  success: boolean;
  /** Issues found */
  issues: T[];
  /** Summary statistics */
  summary: CheckSummary;
  /** Error message if check failed */
  error?: string;
}

/**
 * Unified check result containing all check results.
 */
export interface UnifiedCheckResult {
  /** Overall success */
  success: boolean;
  /** Results by check type */
  checks: Partial<Record<CheckType, SingleCheckResult>>;
  /** Skipped checks with reasons */
  skipped: Partial<Record<CheckType, string[]>>;
  /** Total issues across all checks */
  totalIssues: number;
  /** Combined summary */
  summary: {
    /** Total files analyzed */
    totalFiles: number;
    /** Issues by check type */
    issuesByCheck: Partial<Record<CheckType, number>>;
    /** Issues by severity */
    issuesBySeverity: Record<CheckSeverity, number>;
  };
}

// ============================================================================
// Check Options
// ============================================================================

/**
 * Options for deadcode detection.
 */
export interface DeadCodeOptions {
  /** Include test files in analysis (default: false) */
  includeTests?: boolean;
  /** Consider entry point patterns (default: ['index.*', 'main.*', 'app.*', 'server.*']) */
  entryPatterns?: string[];
}

/**
 * Options for circular dependency detection.
 */
export interface CircularOptions {
  /** Maximum cycle length to report (default: 10) */
  maxCycleLength?: number;
  /** Maximum cycles to report (default: 20) */
  maxCycles?: number;
}

/**
 * Options for complexity detection.
 */
export interface ComplexityOptions {
  /** Cyclomatic complexity threshold (default: 15) */
  complexityThreshold?: number;
  /** Cognitive complexity threshold (default: 15) */
  cognitiveThreshold?: number;
  /** Function line count threshold (default: 100) */
  lineLengthThreshold?: number;
  /** Nesting depth threshold (default: 5) */
  nestingThreshold?: number;
  /** Parameter count threshold (default: 6) */
  paramCountThreshold?: number;
}

// ============================================================================
// Rule Metadata
// ============================================================================

/**
 * Rule category for grouping rules.
 */
export type RuleCategory =
  | 'bestpractices'
  | 'codestyle'
  | 'design'
  | 'documentation'
  | 'errorprone'
  | 'multithreading'
  | 'performance'
  | 'security';

/**
 * Confidence level for rule detection.
 */
export type RuleConfidence = 'high' | 'medium' | 'low';

/**
 * Rule metadata for rule registration and gating.
 */
export interface RuleMetadata {
  /** Unique rule identifier */
  ruleId: string;
  /** Rule category */
  category: RuleCategory;
  /** Languages this rule applies to */
  languages: string[];
  /** Detection confidence */
  confidence: RuleConfidence;
  /** Whether rule is enabled by default */
  defaultEnabled: boolean;
  /** Whether rule requires semantic analysis */
  requiresSemantics: boolean;
  /** Default severity */
  severity: CheckSeverity;
  /** Human-readable description */
  description?: string;
}

/**
 * Rules configuration for enabling/disabling rules.
 */
export interface RulesConfig {
  /** Rules to enable (by ID) */
  enable?: string[];
  /** Rules to disable (by ID) */
  disable?: string[];
}

/**
 * Categories configuration for enabling/disabling categories.
 */
export interface CategoriesConfig {
  /** Categories to enable */
  enable?: RuleCategory[];
  /** Categories to disable */
  disable?: RuleCategory[];
}

/**
 * Suppressions configuration.
 */
export interface SuppressionsConfig {
  /** Global suppressions by rule ID */
  global?: string[];
  /** Per-file suppressions */
  files?: Record<string, string[]>;
}

/**
 * Semantics configuration.
 */
export interface SemanticsConfig {
  /** Enable semantic analysis (default: false) */
  enabled?: boolean;
}

/**
 * Unified check options.
 */
export interface CheckOptions {
  /** Checks to run (default: all) */
  checks?: CheckType[];

  /** File patterns to exclude (glob) */
  excludePatterns?: string[];

  /** Deadcode-specific options */
  deadcode?: DeadCodeOptions;

  /** Circular-specific options */
  circular?: CircularOptions;

  /** Complexity-specific options */
  complexity?: ComplexityOptions;

  /** Doccheck-specific options (from existing doccheck module) */
  doccheck?: {
    onlyExported?: boolean;
    requireDocs?: boolean;
    checkParamTypes?: boolean;
    pythonStyle?: 'google' | 'numpy' | 'sphinx';
  };

  /** Duplicates-specific options (from existing duplicates module) */
  duplicates?: {
    minLines?: number;
    minTokens?: number;
    threshold?: number;
    mode?: 'strict' | 'mild' | 'weak';
    formats?: string[];
  };

  /** Rules configuration (Phase 0: types only, filtering not implemented) */
  rules?: RulesConfig;

  /** Categories configuration (Phase 0: types only) */
  categories?: CategoriesConfig;

  /** Suppressions configuration (Phase 0: types only) */
  suppressions?: SuppressionsConfig;

  /** Semantics configuration (Phase 0: types only) */
  semantics?: SemanticsConfig;
}

/**
 * Default check options.
 */
export const DEFAULT_CHECK_OPTIONS: Required<CheckOptions> = {
  checks: ALL_CHECK_TYPES,
  excludePatterns: [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/__pycache__/**',
    '**/.venv/**',
    '**/venv/**',
    '**/vendor/**',
    '**/target/**',
  ],
  deadcode: {
    includeTests: false,
    entryPatterns: ['index.*', 'main.*', 'app.*', 'server.*', 'cli.*', 'lib.*'],
  },
  circular: {
    maxCycleLength: 10,
    maxCycles: 20,
  },
  complexity: {
    complexityThreshold: 15,
    cognitiveThreshold: 15,
    lineLengthThreshold: 100,
    nestingThreshold: 5,
    paramCountThreshold: 6,
  },
  doccheck: {
    onlyExported: true,
    requireDocs: false,
    checkParamTypes: false,
    pythonStyle: 'google',
  },
  duplicates: {
    minLines: 5,
    minTokens: 50,
    threshold: 10,
    mode: 'mild',
    formats: [],
  },
  // Phase 0: default values for new options (filtering not implemented)
  rules: {},
  categories: {},
  suppressions: {},
  semantics: { enabled: false },
};

// ============================================================================
// Language Support
// ============================================================================

/**
 * Supported languages by check type.
 */
export const LANGUAGE_SUPPORT: Record<CheckType, string[]> = {
  duplicates: ['*'], // 150+ languages via jscpd
  doccheck: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py'],
  deadcode: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.java', '.rs'],
  circular: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.java', '.rs'],
  complexity: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.java', '.rs'],
};

/**
 * Check if a file extension is supported by a check type.
 */
export function isExtensionSupported(checkType: CheckType, ext: string): boolean {
  const supported = LANGUAGE_SUPPORT[checkType];
  if (supported.includes('*')) return true;
  return supported.includes(ext.toLowerCase());
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create an empty check summary.
 */
export function createEmptySummary(): CheckSummary {
  return {
    totalFiles: 0,
    totalIssues: 0,
    issuesBySeverity: { error: 0, warning: 0, info: 0 },
  };
}

/**
 * Compute summary from issues.
 */
export function computeSummaryFromIssues(issues: BaseCheckIssue[], totalFiles: number): CheckSummary {
  const issuesBySeverity: Record<CheckSeverity, number> = { error: 0, warning: 0, info: 0 };

  for (const issue of issues) {
    issuesBySeverity[issue.severity]++;
  }

  return {
    totalFiles,
    totalIssues: issues.length,
    issuesBySeverity,
  };
}
