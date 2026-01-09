/**
 * Unified Analysis Layer - Type Definitions
 *
 * Defines data models for extension point detection and type semantic analysis.
 * Used to enhance Bundle quality analysis.
 *
 * @module analysis/types
 */

// ============================================================================
// Extension Point Types
// ============================================================================

/**
 * Kind of extension point detected in code.
 */
export type ExtensionPointKind =
  | 'union-type'        // String literal union types (e.g., 'a' | 'b' | 'c')
  | 'optional-callback' // Optional function properties/parameters
  | 'interface'         // Extensible interface definitions
  | 'generic-param'     // Generic type parameters with constraints
  | 'design-comment';   // Design intent comments (TODO, @see, etc.)

/**
 * Inferred semantic purpose of an extension point.
 */
export type InferredPurpose =
  | 'format-support'    // Supports multiple input/output formats
  | 'mode-selector'     // Mode/scope selection
  | 'content-type'      // Content type discrimination
  | 'plugin-type'       // Plugin/processor type
  | 'callback-injection' // Callback/handler injection point
  | 'enum-options'      // General enumeration options
  | 'unknown';

/**
 * Single extension point detected in source code.
 */
export interface ExtensionPointInfo {
  /** Kind of extension point */
  kind: ExtensionPointKind;
  /** Name of the type/property/interface */
  name: string;
  /** File path (bundle-relative) */
  file: string;
  /** Line number (1-indexed) */
  line: number;
  /** Human-readable semantic description */
  semantics: string;
  /** Specific values (union members, generic constraints, etc.) */
  values?: string[];
  /** Inferred purpose */
  inferredPurpose?: InferredPurpose;
  /** Extensibility score (0-100) */
  extensibilityScore?: number;
}

// ============================================================================
// Type Semantics
// ============================================================================

/**
 * Information about a union type definition.
 */
export interface UnionTypeInfo {
  /** Type alias name */
  name: string;
  /** Union members (literal values or type names) */
  members: string[];
  /** File path */
  file: string;
  /** Line number */
  line: number;
  /** Inferred purpose based on name and members */
  inferredPurpose?: InferredPurpose;
  /** Full type text */
  fullType?: string;
}

/**
 * Information about an optional callback property.
 */
export interface OptionalCallbackInfo {
  /** Property/parameter name */
  name: string;
  /** Function signature */
  signature: string;
  /** File path */
  file: string;
  /** Line number */
  line: number;
  /** Parent interface/class name */
  parent?: string;
  /** Parameter types */
  paramTypes?: string[];
  /** Return type */
  returnType?: string;
}

/**
 * Information about a generic type parameter.
 */
export interface GenericParamInfo {
  /** Parameter name (e.g., T, K) */
  name: string;
  /** Constraint type (e.g., extends BaseType) */
  constraint?: string;
  /** Default type */
  defaultType?: string;
  /** File path */
  file: string;
  /** Line number */
  line: number;
  /** Parent type/function name */
  parent: string;
}

/**
 * Design intent comment/annotation.
 */
export interface DesignHintInfo {
  /** Comment text */
  comment: string;
  /** File path */
  file: string;
  /** Line number */
  line: number;
  /** Intent classification */
  intent: 'todo' | 'extension-point' | 'reference' | 'deprecated' | 'reserved' | 'general';
  /** Referenced entity if any */
  referencedEntity?: string;
}

/**
 * Aggregated type semantics for a file or bundle.
 */
export interface TypeSemantics {
  /** Union type definitions */
  unionTypes: UnionTypeInfo[];
  /** Optional callback properties */
  optionalCallbacks: OptionalCallbackInfo[];
  /** Generic type parameters */
  genericParams: GenericParamInfo[];
  /** Design intent comments */
  designHints: DesignHintInfo[];
}

// ============================================================================
// Analysis Result Types
// ============================================================================

/**
 * Result of analyzing a single file.
 */
export interface FileAnalysisResult {
  /** File path (bundle-relative) */
  file: string;
  /** Extension points found */
  extensionPoints: ExtensionPointInfo[];
  /** Type semantics extracted */
  typeSemantics: TypeSemantics;
  /** Analysis duration in milliseconds */
  analysisTimeMs: number;
  /** Errors encountered */
  errors?: string[];
}

/**
 * Result of unified bundle analysis (Phase 3).
 */
export interface UnifiedAnalysisResult {
  /** All extension points */
  extensionPoints: ExtensionPointInfo[];
  /** Aggregated type semantics */
  typeSemantics: TypeSemantics;
  /** Summary statistics */
  summary: {
    /** Total extension points found */
    totalExtensionPoints: number;
    /** By kind breakdown */
    byKind: Partial<Record<ExtensionPointKind, number>>;
    /** By inferred purpose */
    byPurpose: Partial<Record<InferredPurpose, number>>;
    /** Top extension points by score */
    topExtensionPoints: Array<{ name: string; score: number; file: string }>;
    /** Files analyzed */
    filesAnalyzed: number;
    /** Total analysis time */
    totalAnalysisTimeMs: number;
  };
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for the unified analyzer.
 */
export interface UnifiedAnalyzerConfig {
  /** File patterns to analyze (glob) */
  includePatterns?: string[];
  /** File patterns to exclude (glob) */
  excludePatterns?: string[];
  /** Enable union type analysis */
  analyzeUnionTypes?: boolean;
  /** Enable optional callback detection */
  analyzeOptionalCallbacks?: boolean;
  /** Enable generic parameter analysis */
  analyzeGenerics?: boolean;
  /** Enable design comment scanning */
  analyzeDesignHints?: boolean;
  /** Minimum extensibility score to include */
  minExtensibilityScore?: number;
  /** TypeScript config path (for ts-morph) */
  tsConfigPath?: string;
}

/**
 * Default analyzer configuration.
 * Supports TypeScript, JavaScript, Python, Go, and Rust.
 */
export const DEFAULT_ANALYZER_CONFIG: Required<UnifiedAnalyzerConfig> = {
  includePatterns: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs', '**/*.py', '**/*.go', '**/*.rs'],
  excludePatterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/target/**',
    '**/*.test.ts',
    '**/*.spec.ts',
    '**/*.test.js',
    '**/*.spec.js',
    '**/*_test.py',
    '**/test_*.py',
    '**/tests/**',
    '**/*_test.go',
    '**/*_test.rs',
  ],
  analyzeUnionTypes: true,
  analyzeOptionalCallbacks: true,
  analyzeGenerics: true,
  analyzeDesignHints: true,
  minExtensibilityScore: 0,
  tsConfigPath: '',
};

// ============================================================================
// Helper Types
// ============================================================================

/**
 * Position in source file.
 */
export interface SourcePosition {
  line: number;
  column: number;
}

/**
 * Range in source file.
 */
export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}
