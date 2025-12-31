/**
 * Unified Analysis Layer Module
 *
 * Provides enhanced code analysis capabilities for Bundle quality improvement:
 * - Type semantic analysis (union types, optional callbacks, generics)
 * - Design pattern and comment detection
 * - Extension point identification and scoring
 *
 * @module analysis
 */

// ============================================================================
// Type Exports
// ============================================================================

export type {
  // Extension point types
  ExtensionPointKind,
  ExtensionPointInfo,
  InferredPurpose,
  // Type semantics
  UnionTypeInfo,
  OptionalCallbackInfo,
  GenericParamInfo,
  DesignHintInfo,
  TypeSemantics,
  // Result types
  FileAnalysisResult,
  UnifiedAnalysisResult,
  // Configuration
  UnifiedAnalyzerConfig,
  // Utility types
  SourcePosition,
  SourceRange,
} from './types.js';

export { DEFAULT_ANALYZER_CONFIG } from './types.js';

// ============================================================================
// Analyzer Exports
// ============================================================================

export {
  TypeSemanticAnalyzer,
  createTypeSemanticAnalyzer,
} from './type-semantic-analyzer.js';

export {
  PatternAnalyzer,
  createPatternAnalyzer,
} from './pattern-analyzer.js';

export {
  UnifiedAnalyzer,
  createUnifiedAnalyzer,
} from './unified-analyzer.js';
