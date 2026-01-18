/**
 * Conflict Detection Module
 *
 * Detects conflicts between documentation and code sources.
 * Supports detection of missing APIs, signature mismatches, and description conflicts.
 *
 * @module bundle/analyzers/conflicts
 */

// ============================================================================
// Re-exports from detector
// ============================================================================

export {
  // Factory functions
  createConflictDetector,
  detectConflicts,
  // Class
  ConflictDetector,
} from './detector.js';

// ============================================================================
// Re-exports from types
// ============================================================================

export {
  // Types
  type ConflictType,
  type ConflictSeverity,
  type APIParameter,
  type APIInfo,
  type Conflict,
  type DocsData,
  type DocsPage,
  type DocsPageContent,
  type CodeData,
  type CodeFile,
  type CodeClass,
  type CodeFunction,
  type ConflictSummary,
  type ConflictReport,
  type ConflictOutput,
  type ConflictAnalyzerOptions,
  // Constants
  DEFAULT_CONFLICT_OPTIONS,
} from './types.js';
