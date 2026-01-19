/**
 * Analysis Context Module
 *
 * Provides a unified context for analysis operations,
 * combining FileIndex and AstCache.
 *
 * @module analysis/cache/context
 */

import { FileIndex, type FileIndexOptions } from './file-index.js';
import { AstCache, type AstCacheOptions } from './ast-cache.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Analysis context options.
 */
export interface AnalysisContextOptions {
  /** Root path for analysis */
  rootPath: string;
  /** File patterns to exclude (glob) */
  excludePatterns?: string[];
  /** FileIndex options */
  fileIndex?: Partial<FileIndexOptions>;
  /** AstCache options */
  astCache?: AstCacheOptions;
}

// ============================================================================
// AnalysisContext Class
// ============================================================================

/**
 * Analysis context for running checks.
 *
 * Provides shared FileIndex and AstCache instances for all checks.
 * Must be disposed after use to clean up resources.
 */
export class AnalysisContext {
  /** File index for metadata and content */
  readonly fileIndex: FileIndex;
  /** AST cache for parsed trees */
  readonly ast: AstCache;

  private disposed = false;

  constructor(options: AnalysisContextOptions) {
    this.fileIndex = new FileIndex({
      rootPath: options.rootPath,
      excludePatterns: options.excludePatterns,
      ...options.fileIndex,
    });

    this.ast = new AstCache(options.astCache);
  }

  /**
   * Get the root path.
   */
  getRoot(): string {
    return this.fileIndex.getRoot();
  }

  /**
   * Check if the context has been disposed.
   */
  isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Dispose the context and release all resources.
   * Must be called when analysis is complete.
   */
  dispose(): void {
    if (this.disposed) return;

    this.ast.clear();
    this.fileIndex.clear();
    this.disposed = true;
  }

  /**
   * Get statistics for the context.
   */
  stats(): {
    fileIndex: { files: number; contentCacheSize: number };
    astCache: { entries: number; totalBytes: number; hits: number; misses: number };
  } {
    return {
      fileIndex: this.fileIndex.stats(),
      astCache: this.ast.stats(),
    };
  }
}

/**
 * Create an analysis context.
 */
export function createAnalysisContext(options: AnalysisContextOptions): AnalysisContext {
  return new AnalysisContext(options);
}
