/**
 * Conflict Detection Module - Type Definitions
 *
 * Defines types for detecting conflicts between documentation and code.
 * Supports detection of missing APIs, signature mismatches, and description conflicts.
 *
 * @module bundle/analyzers/conflicts/types
 */

import type { AnalyzerOptions } from '../types.js';

// ============================================================================
// Conflict Types
// ============================================================================

/**
 * Types of conflicts that can be detected.
 */
export type ConflictType =
  | 'missing_in_docs'     // API exists in code but not documented
  | 'missing_in_code'     // API documented but doesn't exist in code
  | 'signature_mismatch'; // Different parameters/types between docs and code

/**
 * Conflict severity levels.
 */
export type ConflictSeverity = 'low' | 'medium' | 'high';

/**
 * API parameter information.
 */
export type APIParameter = {
  /** Parameter name */
  name: string;
  /** Parameter type (if known) */
  type?: string;
  /** Default value (if any) */
  default?: string;
  /** Whether parameter is optional */
  optional?: boolean;
};

/**
 * API information extracted from documentation or code.
 */
export type APIInfo = {
  /** API name (function/method/class name) */
  name: string;
  /** API type (function, method, class, etc.) */
  type?: 'function' | 'method' | 'class' | 'property';
  /** Parameter list */
  parameters?: APIParameter[];
  /** Return type */
  returnType?: string;
  /** Source file path */
  source?: string;
  /** Source URL (for docs) */
  sourceUrl?: string;
  /** Line number (for code) */
  line?: number;
  /** Description/docstring */
  description?: string;
  /** Raw signature string */
  rawSignature?: string;
  /** Whether it's async */
  isAsync?: boolean;
  /** Whether it's private/internal */
  isPrivate?: boolean;
};

/**
 * Represents a detected conflict between documentation and code.
 */
export type Conflict = {
  /** Conflict type */
  type: ConflictType;
  /** Conflict severity */
  severity: ConflictSeverity;
  /** API name involved in the conflict */
  apiName: string;
  /** Documentation information (if available) */
  docsInfo?: APIInfo;
  /** Code information (if available) */
  codeInfo?: APIInfo;
  /** Human-readable description of the difference */
  difference: string;
  /** Suggested action to resolve the conflict */
  suggestion?: string;
};

// ============================================================================
// Input Types
// ============================================================================

/**
 * Documentation data structure.
 * Represents scraped documentation content.
 */
export type DocsData = {
  /** Documentation pages */
  pages?: DocsPage[] | Record<string, DocsPageContent>;
  /** Extracted APIs (if pre-processed) */
  apis?: APIInfo[];
};

/**
 * Documentation page (list format).
 */
export type DocsPage = {
  /** Page URL */
  url?: string;
  /** Page title */
  title?: string;
  /** Pre-extracted APIs */
  apis?: APIInfo[];
  /** Raw content */
  content?: string;
};

/**
 * Documentation page content (dict format).
 */
export type DocsPageContent = {
  /** Page title */
  title?: string;
  /** Page content */
  content?: string;
};

/**
 * Code analysis data structure.
 * Represents analyzed source code.
 */
export type CodeData = {
  /** Code analysis results */
  code_analysis?: {
    /** Analyzed files */
    files?: CodeFile[];
    /** Alternative key for files */
    analyzed_files?: CodeFile[];
  };
  /** Pre-extracted APIs */
  apis?: APIInfo[];
};

/**
 * Analyzed code file.
 */
export type CodeFile = {
  /** File path */
  file?: string;
  /** Classes defined in file */
  classes?: CodeClass[];
  /** Functions defined in file */
  functions?: CodeFunction[];
};

/**
 * Class definition in code.
 */
export type CodeClass = {
  /** Class name */
  name: string;
  /** Line number */
  line_number?: number;
  /** Base classes */
  base_classes?: string[];
  /** Docstring */
  docstring?: string;
  /** Methods */
  methods?: CodeFunction[];
};

/**
 * Function/method definition in code.
 */
export type CodeFunction = {
  /** Function name */
  name: string;
  /** Line number */
  line_number?: number;
  /** Parameters */
  parameters?: APIParameter[];
  /** Return type */
  return_type?: string;
  /** Docstring */
  docstring?: string;
  /** Whether async */
  is_async?: boolean;
};

// ============================================================================
// Output Types
// ============================================================================

/**
 * Summary statistics for conflict report.
 */
export type ConflictSummary = {
  /** Total number of conflicts */
  total: number;
  /** Count by conflict type */
  byType: Record<ConflictType, number>;
  /** Count by severity */
  bySeverity: Record<ConflictSeverity, number>;
  /** Number of unique APIs affected */
  apisAffected: number;
};

/**
 * Conflict detection report.
 */
export type ConflictReport = {
  /** List of detected conflicts */
  conflicts: Conflict[];
  /** Summary statistics */
  summary: ConflictSummary;
  /** Number of APIs found in documentation */
  docsApiCount: number;
  /** Number of APIs found in code */
  codeApiCount: number;
  /** Number of APIs found in both */
  commonApiCount: number;
};

/**
 * Conflict analyzer output type alias.
 */
export type ConflictOutput = ConflictReport;

// ============================================================================
// Analyzer Options
// ============================================================================

/**
 * Conflict analyzer configuration options.
 */
export type ConflictAnalyzerOptions = AnalyzerOptions & {
  /** Conflict types to detect (empty = all) */
  conflictTypes?: ConflictType[];
  /** Minimum similarity ratio for fuzzy name matching (0-1, default: 0.8) */
  nameSimilarityThreshold?: number;
  /** Whether to include private/internal APIs (default: true) */
  includePrivateApis?: boolean;
  /** Whether to include suggestions in output (default: true) */
  includeSuggestions?: boolean;
  /** Lower severity for private APIs missing in docs (default: true) */
  lowerPrivateSeverity?: boolean;
};

/**
 * Default conflict analyzer options.
 */
export const DEFAULT_CONFLICT_OPTIONS: Required<ConflictAnalyzerOptions> = {
  enabled: true,
  timeout: 30000,
  maxFiles: 0,
  includePatterns: [],
  excludePatterns: [],
  conflictTypes: [],
  nameSimilarityThreshold: 0.8,
  includePrivateApis: true,
  includeSuggestions: true,
  lowerPrivateSeverity: true,
};
