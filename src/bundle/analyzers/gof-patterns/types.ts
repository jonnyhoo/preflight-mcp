/**
 * GoF Design Patterns - Type Definitions
 *
 * Type definitions for Gang of Four design pattern detection.
 * Based on the 23 classic patterns from "Design Patterns: Elements of Reusable
 * Object-Oriented Software" (Gamma, Helm, Johnson, Vlissides, 1994).
 *
 * @module bundle/analyzers/gof-patterns/types
 */

import type { AnalyzerOptions } from '../types.js';

// ============================================================================
// Enums
// ============================================================================

/**
 * Pattern categories as defined by GoF.
 */
export enum PatternCategory {
  /** Patterns for object creation mechanisms */
  Creational = 'Creational',
  /** Patterns for object composition */
  Structural = 'Structural',
  /** Patterns for communication between objects */
  Behavioral = 'Behavioral',
}

/**
 * Detection depth levels.
 * Higher levels include more sophisticated analysis but take longer.
 */
export enum DetectionDepth {
  /** Fast detection using naming conventions only */
  Surface = 'surface',
  /** Structural analysis (class relationships, method signatures) */
  Deep = 'deep',
  /** Behavioral analysis (method interactions, state management) */
  Full = 'full',
}

/**
 * Pattern type names (subset for Phase 1).
 * Full list includes all 23 GoF patterns.
 */
export type PatternType =
  // Creational (Phase 1)
  | 'Singleton'
  | 'Factory'
  | 'AbstractFactory'
  | 'Builder'
  | 'Prototype'
  // Structural (Phase 1)
  | 'Adapter'
  | 'Decorator'
  | 'Facade'
  | 'Proxy'
  | 'Bridge'
  | 'Composite'
  | 'Flyweight'
  // Behavioral
  | 'Observer'
  | 'Strategy'
  | 'Command'
  | 'TemplateMethod'
  | 'ChainOfResponsibility'
  | 'State'
  | 'Visitor'
  | 'Iterator'
  | 'Mediator'
  | 'Memento'
  | 'Interpreter';

// ============================================================================
// Pattern Instance Types
// ============================================================================

/**
 * Evidence supporting pattern detection.
 */
export type PatternEvidence = {
  /** Type of evidence */
  type: 'naming' | 'structural' | 'behavioral';
  /** Description of the evidence */
  description: string;
  /** Confidence contribution (0.0-1.0) */
  confidence: number;
};

/**
 * Single detected pattern instance.
 */
export type PatternInstance = {
  /** Pattern type (e.g., 'Singleton', 'Factory') */
  patternType: PatternType;
  /** Pattern category */
  category: PatternCategory;
  /** Detection confidence (0.0-1.0) */
  confidence: number;
  /** File path where pattern was detected */
  location: string;
  /** Class name involved in pattern */
  className?: string;
  /** Method name involved in pattern (if applicable) */
  methodName?: string;
  /** Line number where pattern starts */
  lineNumber?: number;
  /** Evidence supporting the detection */
  evidence: PatternEvidence[];
  /** Related classes participating in the pattern */
  relatedClasses: string[];
  /** Detection depth that found this pattern */
  detectionDepth: DetectionDepth;
};

/**
 * Summary of patterns by type.
 */
export type PatternSummary = {
  [K in PatternType]?: number;
};

/**
 * Summary of patterns by category.
 */
export type CategorySummary = {
  [K in PatternCategory]?: number;
};

/**
 * Pattern detection report for a single file.
 */
export type FilePatternReport = {
  /** File path */
  filePath: string;
  /** Detected programming language */
  language: string;
  /** Patterns found in this file */
  patterns: PatternInstance[];
  /** Number of classes analyzed */
  totalClasses: number;
  /** Number of functions analyzed */
  totalFunctions: number;
  /** Detection depth used */
  analysisDepth: DetectionDepth;
};

/**
 * Complete pattern detection report.
 */
export type PatternReport = {
  /** Reports per file */
  files: FilePatternReport[];
  /** All patterns detected across files */
  allPatterns: PatternInstance[];
  /** Summary by pattern type */
  patternSummary: PatternSummary;
  /** Summary by category */
  categorySummary: CategorySummary;
  /** Total files analyzed */
  totalFiles: number;
  /** Total patterns detected */
  totalPatterns: number;
};

// ============================================================================
// Code Structure Types (for pattern detection)
// ============================================================================

/**
 * Parameter in a method signature.
 */
export type ParameterSignature = {
  /** Parameter name */
  name: string;
  /** Type hint (if available) */
  typeHint?: string;
  /** Default value (if any) */
  defaultValue?: string;
};

/**
 * Method signature for analysis.
 */
export type MethodSignature = {
  /** Method name */
  name: string;
  /** Parameters */
  parameters: ParameterSignature[];
  /** Return type (if available) */
  returnType?: string;
  /** Method docstring/comment */
  docstring?: string;
  /** Line number */
  lineNumber?: number;
  /** Whether method is async */
  isAsync: boolean;
  /** Whether this is a method (vs function) */
  isMethod: boolean;
  /** Decorators/annotations applied */
  decorators: string[];
  /** Whether method is static */
  isStatic: boolean;
  /** Visibility (public/private/protected) */
  visibility: 'public' | 'private' | 'protected';
};

/**
 * Class signature for analysis.
 */
export type ClassSignature = {
  /** Class name */
  name: string;
  /** Base classes/interfaces */
  baseClasses: string[];
  /** Methods defined in the class */
  methods: MethodSignature[];
  /** Class docstring/comment */
  docstring?: string;
  /** Line number */
  lineNumber?: number;
  /** Whether class is abstract */
  isAbstract: boolean;
  /** Decorators/annotations applied */
  decorators: string[];
  /** Implemented interfaces (if distinct from base classes) */
  interfaces: string[];
};

/**
 * Context for pattern detection.
 */
export type DetectionContext = {
  /** Current class being analyzed */
  currentClass: ClassSignature;
  /** All classes in the file */
  allClasses: ClassSignature[];
  /** Full file content (for 'full' depth analysis) */
  fileContent?: string;
  /** File path */
  filePath: string;
  /** Programming language */
  language: string;
};

// ============================================================================
// Analyzer Options
// ============================================================================

/**
 * GoF Pattern Analyzer specific options.
 */
export type GofPatternAnalyzerOptions = AnalyzerOptions & {
  /** Detection depth level */
  detectionDepth: DetectionDepth;
  /** Minimum confidence threshold (0.0-1.0) */
  minConfidence: number;
  /** Pattern types to detect (empty = all) */
  patternTypes: PatternType[];
  /** Categories to detect (empty = all) */
  categories: PatternCategory[];
  /** Whether to include evidence in output */
  includeEvidence: boolean;
};

/**
 * Default options for GoF Pattern Analyzer.
 */
export const DEFAULT_GOF_PATTERN_OPTIONS: Required<GofPatternAnalyzerOptions> = {
  enabled: true,
  timeout: 60000, // 60 seconds for pattern analysis
  maxFiles: 0,
  includePatterns: [],
  excludePatterns: ['**/node_modules/**', '**/vendor/**', '**/.git/**'],
  detectionDepth: DetectionDepth.Deep,
  minConfidence: 0.5,
  patternTypes: [], // Empty = detect all
  categories: [], // Empty = detect all
  includeEvidence: true,
};

// ============================================================================
// Analyzer Output
// ============================================================================

/**
 * GoF Pattern Analyzer output data.
 */
export type GofPatternOutput = PatternReport;

// ============================================================================
// Detector Interface
// ============================================================================

/**
 * Interface for individual pattern detectors.
 */
export type PatternDetector = {
  /** Pattern type this detector handles */
  readonly patternType: PatternType;
  /** Pattern category */
  readonly category: PatternCategory;

  /**
   * Detect pattern in the given context.
   *
   * @param context - Detection context
   * @param depth - Detection depth to use
   * @returns Pattern instance if detected, null otherwise
   */
  detect(context: DetectionContext, depth: DetectionDepth): PatternInstance | null;
};

/**
 * Factory function type for creating pattern detectors.
 */
export type PatternDetectorFactory = () => PatternDetector;
