/**
 * Documentation Check Module - Type Definitions
 *
 * Defines types for checking documentation-code consistency.
 * Supports TypeScript/JavaScript JSDoc and Python docstrings.
 *
 * @module analysis/doccheck/types
 */

// ============================================================================
// Issue Types
// ============================================================================

/**
 * Types of documentation issues that can be detected.
 */
export type DocIssueType =
  // Parameter issues
  | 'param_missing'        // DOC101: Parameter exists but not documented
  | 'param_extra'          // DOC102: Documented parameter doesn't exist
  | 'param_name_mismatch'  // DOC103: Parameter name in doc doesn't match code (similar names)
  | 'param_order_mismatch' // DOC104: Parameter order in doc doesn't match code
  | 'param_type_mismatch'  // DOC105: Parameter type in doc doesn't match code
  // Return issues
  | 'return_missing'       // DOC201: Function returns but no @returns doc
  | 'return_extra'         // DOC202: @returns doc but function doesn't return
  | 'return_type_mismatch' // DOC203: Return type in doc doesn't match code
  // Yields issues (Python only)
  | 'yield_missing'        // DOC402: Has yield statement but no Yields section
  | 'yield_extra'          // DOC403: Has Yields section but no yield statement
  | 'yield_type_mismatch'  // DOC404: Yields type doesn't match annotation
  // Raises issues (Python only)
  | 'raises_missing'       // DOC501: Has raise statement but no Raises section
  | 'raises_extra'         // DOC502: Has Raises section but no raise statement
  | 'raises_type_mismatch' // DOC503: Raises exception type doesn't match
  // Attribute issues (Python only)
  | 'attr_missing'         // DOC601: Class attribute not documented
  | 'attr_extra'           // DOC602: Documented attribute doesn't exist
  | 'attr_type_mismatch'   // DOC603: Attribute type mismatch
  // Type hint location issues (Python only)
  | 'type_in_both'         // DOC106: Type hint in both signature and docstring
  | 'type_in_docstring_only' // DOC107: Type hint in docstring but should be in signature
  // Default value issues (Python only)
  | 'default_missing'      // DOC301: Parameter has default but not documented as optional
  | 'default_mismatch'     // DOC302: Default value in doc doesn't match code
  // General issues
  | 'missing_doc'          // Function/class has no documentation
  | 'style_mismatch';      // DOC003: Docstring style doesn't match expected

/**
 * Issue severity levels.
 */
export type DocIssueSeverity = 'error' | 'warning' | 'info';

/**
 * Supported languages for documentation checking.
 */
export type DocCheckLanguage = 'typescript' | 'javascript' | 'python';

/**
 * Python docstring styles.
 */
export type PythonDocstringStyle = 'google' | 'numpy' | 'sphinx';

/**
 * A single documentation issue.
 */
export interface DocIssue {
  /** Issue type */
  type: DocIssueType;
  /** Issue severity */
  severity: DocIssueSeverity;
  /** File path */
  file: string;
  /** Line number (1-indexed) */
  line: number;
  /** Function/method/class name */
  name: string;
  /** Human-readable message */
  message: string;
  /** Expected value (for mismatch issues) */
  expected?: string;
  /** Actual value (for mismatch issues) */
  actual?: string;
}

// ============================================================================
// Function/Parameter Types
// ============================================================================

/**
 * Parameter information extracted from code.
 */
export interface ParamInfo {
  /** Parameter name */
  name: string;
  /** Parameter type (if available) */
  type?: string;
  /** Whether parameter is optional */
  optional?: boolean;
  /** Default value (if any) */
  defaultValue?: string;
}

/**
 * Parameter documentation from JSDoc/docstring.
 */
export interface DocParamInfo {
  /** Parameter name */
  name: string;
  /** Documented type */
  type?: string;
  /** Description */
  description?: string;
  /** Whether documented as optional */
  optional?: boolean;
  /** Documented default value */
  defaultValue?: string;
}

/**
 * Function information extracted from code.
 */
export interface FunctionInfo {
  /** Function/method name */
  name: string;
  /** File path */
  file: string;
  /** Line number */
  line: number;
  /** Parameters from code */
  params: ParamInfo[];
  /** Return type from code */
  returnType?: string;
  /** Whether function is exported (TS/JS) or public (Python) */
  isExported: boolean;
  /** Whether function is async */
  isAsync?: boolean;
  /** Parent class name (for methods) */
  className?: string;
}

/**
 * Yields documentation from docstring (Python only).
 */
export interface DocYieldsInfo {
  /** Yield type */
  type?: string;
  /** Description */
  description?: string;
}

/**
 * Raises documentation from docstring (Python only).
 */
export interface DocRaisesInfo {
  /** Exception class name */
  exception: string;
  /** Description */
  description?: string;
}

/**
 * Attribute documentation from docstring (Python only).
 */
export interface DocAttributeInfo {
  /** Attribute name */
  name: string;
  /** Attribute type */
  type?: string;
  /** Description */
  description?: string;
}

/**
 * Documentation information extracted from JSDoc/docstring.
 */
export interface DocInfo {
  /** Whether documentation exists */
  exists: boolean;
  /** Documented parameters */
  params: DocParamInfo[];
  /** Return type documentation */
  returns?: {
    type?: string;
    description?: string;
  };
  /** Yields documentation (Python only) */
  yields?: DocYieldsInfo;
  /** Raises documentation (Python only) */
  raises?: DocRaisesInfo[];
  /** Attributes documentation (Python only) */
  attributes?: DocAttributeInfo[];
  /** Description text */
  description?: string;
  /** Raw documentation text */
  raw?: string;
}

/**
 * Combined function and documentation info for analysis.
 */
export interface FunctionDocInfo {
  /** Function information from code */
  func: FunctionInfo;
  /** Documentation information */
  doc: DocInfo;
}

// ============================================================================
// Result Types
// ============================================================================

/**
 * File-level check result.
 */
export interface FileCheckResult {
  /** File path */
  file: string;
  /** Language detected */
  language: DocCheckLanguage;
  /** Issues found */
  issues: DocIssue[];
  /** Number of functions checked */
  functionsChecked: number;
  /** Number of functions with documentation */
  functionsDocumented: number;
}

/**
 * Overall documentation check result.
 */
export interface DocCheckResult {
  /** All issues found */
  issues: DocIssue[];
  /** Per-file results */
  files: FileCheckResult[];
  /** Summary statistics */
  summary: DocCheckSummary;
}

/**
 * Summary statistics for documentation check.
 */
export interface DocCheckSummary {
  /** Total files checked */
  totalFiles: number;
  /** Total functions checked */
  totalFunctions: number;
  /** Functions with documentation */
  documentedFunctions: number;
  /** Documentation coverage percentage */
  coveragePercent: number;
  /** Issues by type */
  issuesByType: Record<DocIssueType, number>;
  /** Issues by severity */
  issuesBySeverity: Record<DocIssueSeverity, number>;
  /** Issues by language */
  issuesByLanguage: Record<DocCheckLanguage, number>;
}

// ============================================================================
// Options Types
// ============================================================================

/**
 * Documentation check options.
 */
export interface DocCheckOptions {
  /** Only check exported/public functions (default: true) */
  onlyExported?: boolean;
  /** Check parameter types match (default: false, types can drift) */
  checkParamTypes?: boolean;
  /** Check return types match (default: false) */
  checkReturnTypes?: boolean;
  /** Require documentation for all exported functions (default: false) */
  requireDocs?: boolean;
  /** File patterns to include (glob) */
  includePatterns?: string[];
  /** File patterns to exclude (glob) */
  excludePatterns?: string[];
  /** Python docstring style: 'google' | 'numpy' | 'sphinx' (default: 'google') */
  pythonStyle?: 'google' | 'numpy' | 'sphinx';
  /** Allow __init__ to have its own docstring (default: false, params should be in class docstring) */
  allowInitDocstring?: boolean;
  /** Expect type hints in function signature (default: true, Python only) */
  argTypeHintsInSignature?: boolean;
  /** Expect type hints in docstring (default: false, Python only) */
  argTypeHintsInDocstring?: boolean;
}

/**
 * Default documentation check options.
 * Full-power mode: all checks enabled by default for thorough validation.
 */
export const DEFAULT_DOCCHECK_OPTIONS: Required<DocCheckOptions> = {
  onlyExported: true,
  checkParamTypes: true,      // Full-power: check parameter types
  checkReturnTypes: true,     // Full-power: check return types
  requireDocs: true,          // Full-power: require documentation
  includePatterns: [],
  excludePatterns: ['**/node_modules/**', '**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**'],
  pythonStyle: 'google',
  allowInitDocstring: false,  // Params should be in class docstring by default
  argTypeHintsInSignature: true,   // Types should be in signature (PEP 484)
  argTypeHintsInDocstring: false,  // Types should NOT be duplicated in docstring
};

// ============================================================================
// Severity Mapping
// ============================================================================

/**
 * Mapping from issue type to DOC code (for noqa support).
 */
export const ISSUE_TO_DOC_CODE: Record<DocIssueType, string> = {
  // Parameter issues
  param_missing: 'DOC101',
  param_extra: 'DOC102',
  param_name_mismatch: 'DOC103',
  param_order_mismatch: 'DOC104',
  param_type_mismatch: 'DOC105',
  // Return issues
  return_missing: 'DOC201',
  return_extra: 'DOC202',
  return_type_mismatch: 'DOC203',
  // Yields issues (Python only)
  yield_missing: 'DOC402',
  yield_extra: 'DOC403',
  yield_type_mismatch: 'DOC404',
  // Raises issues (Python only)
  raises_missing: 'DOC501',
  raises_extra: 'DOC502',
  raises_type_mismatch: 'DOC503',
  // Attribute issues (Python only)
  attr_missing: 'DOC601',
  attr_extra: 'DOC602',
  attr_type_mismatch: 'DOC603',
  // Type hint location issues (Python only)
  type_in_both: 'DOC106',
  type_in_docstring_only: 'DOC107',
  // Default value issues (Python only)
  default_missing: 'DOC301',
  default_mismatch: 'DOC302',
  // General issues
  missing_doc: 'DOC001',
  style_mismatch: 'DOC003',
};

/**
 * Default severity for each issue type.
 */
export const ISSUE_SEVERITY: Record<DocIssueType, DocIssueSeverity> = {
  // Parameter issues
  param_missing: 'warning',
  param_extra: 'error',
  param_name_mismatch: 'error',
  param_order_mismatch: 'warning',
  param_type_mismatch: 'info',
  // Return issues
  return_missing: 'info',
  return_extra: 'warning',
  return_type_mismatch: 'info',
  // Yields issues (Python only)
  yield_missing: 'warning',
  yield_extra: 'warning',
  yield_type_mismatch: 'info',
  // Raises issues (Python only)
  raises_missing: 'warning',
  raises_extra: 'warning',
  raises_type_mismatch: 'info',
  // Attribute issues (Python only)
  attr_missing: 'warning',
  attr_extra: 'warning',
  attr_type_mismatch: 'info',
  // Type hint location issues (Python only)
  type_in_both: 'info',
  type_in_docstring_only: 'info',
  // Default value issues (Python only)
  default_missing: 'info',
  default_mismatch: 'info',
  // General issues
  missing_doc: 'info',
  style_mismatch: 'info',
};
