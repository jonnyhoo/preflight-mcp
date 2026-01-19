/**
 * Analysis Cache Module
 *
 * Provides caching infrastructure for analysis operations:
 * - FileIndex: File metadata and content caching
 * - AstCache: AST tree caching with LRU eviction
 * - AnalysisContext: Unified context for running checks
 * - Suppression: Comment-based suppression scanning
 *
 * @module analysis/cache
 */

export { FileIndex, type FileRecord, type FileIndexOptions, type FingerprintMode } from './file-index.js';
export { AstCache, type AstCacheOptions, type AstCacheStats } from './ast-cache.js';
export { AnalysisContext, createAnalysisContext, type AnalysisContextOptions } from './context.js';
export {
  scanSuppressions,
  isLineSuppressed,
  getSuppressedRules,
  type SuppressionDirective,
  type SuppressionIndex,
} from './suppression.js';
