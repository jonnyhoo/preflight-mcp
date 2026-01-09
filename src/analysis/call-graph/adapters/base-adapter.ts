/**
 * Base Language Adapter for Call Graph Analysis
 *
 * Provides common functionality for all language adapters:
 * - File and cache management
 * - Common utility methods
 * - Abstract method declarations for language-specific implementations
 *
 * This base class was extracted to reduce code duplication across adapters.
 *
 * @module analysis/call-graph/adapters/base-adapter
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  CallGraphAdapter,
  CallGraphLanguage,
  CallGraphNode,
  CallHierarchyItem,
  IncomingCall,
  OutgoingCall,
  SourceLocation,
  SymbolDefinition,
  SymbolKind,
  SymbolReference,
  createNodeId,
} from '../types.js';

// ============================================================================
// Base Adapter Abstract Class
// ============================================================================

/**
 * Abstract base class for language-specific call graph adapters.
 * Provides common caching and utility functionality.
 */
export abstract class BaseLanguageAdapter implements CallGraphAdapter {
  /** Supported language - must be set by subclass */
  abstract readonly language: CallGraphLanguage;

  /** File extensions supported by this adapter */
  protected abstract readonly supportedExtensions: string[];

  /** Project root path */
  protected rootPath: string = '';

  /** Cache for file contents */
  protected fileCache: Map<string, string> = new Map();

  /** Whether the adapter has been initialized */
  protected initialized: boolean = false;

  // ============================================================================
  // Lifecycle Methods
  // ============================================================================

  /**
   * Initialize the adapter with the project root path.
   * Override in subclasses to perform language-specific initialization.
   */
  async initialize(rootPath: string): Promise<void> {
    this.rootPath = rootPath;
    this.initialized = true;
  }

  /**
   * Shutdown the adapter and clean up resources.
   * Override in subclasses to perform language-specific cleanup.
   */
  async shutdown(): Promise<void> {
    this.fileCache.clear();
    this.initialized = false;
  }

  // ============================================================================
  // File Support
  // ============================================================================

  /**
   * Check if a file is supported by this adapter based on extension.
   */
  supportsFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return this.supportedExtensions.includes(ext);
  }

  // ============================================================================
  // File Cache Management
  // ============================================================================

  /**
   * Read file content with caching.
   * Returns null if file cannot be read.
   */
  protected readFileCached(filePath: string): string | null {
    // Check cache first
    const cached = this.fileCache.get(filePath);
    if (cached !== undefined) {
      return cached;
    }

    // Read from disk
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      this.fileCache.set(filePath, content);
      return content;
    } catch {
      return null;
    }
  }

  /**
   * Clear the file cache, optionally for a specific file.
   */
  protected clearCache(filePath?: string): void {
    if (filePath) {
      this.fileCache.delete(filePath);
    } else {
      this.fileCache.clear();
    }
  }

  /**
   * Invalidate cache for files matching a pattern.
   */
  protected invalidateCacheMatching(pattern: RegExp): number {
    let cleared = 0;
    for (const key of this.fileCache.keys()) {
      if (pattern.test(key)) {
        this.fileCache.delete(key);
        cleared++;
      }
    }
    return cleared;
  }

  // ============================================================================
  // Path Utilities
  // ============================================================================

  /**
   * Convert absolute path to relative path from root.
   */
  protected toRelativePath(absolutePath: string): string {
    return path.relative(this.rootPath, absolutePath);
  }

  /**
   * Convert relative path to absolute path from root.
   */
  protected toAbsolutePath(relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
      return relativePath;
    }
    return path.join(this.rootPath, relativePath);
  }

  /**
   * Normalize path separators to forward slashes.
   */
  protected normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
  }

  // ============================================================================
  // Source Location Utilities
  // ============================================================================

  /**
   * Create a source location object.
   */
  protected createLocation(
    filePath: string,
    line: number,
    column: number,
    endLine?: number,
    endColumn?: number
  ): SourceLocation {
    return {
      filePath,
      line,
      column,
      endLine,
      endColumn,
    };
  }

  /**
   * Generate a unique node ID for a symbol.
   */
  protected generateNodeId(
    filePath: string,
    line: number,
    column: number,
    name: string
  ): string {
    return createNodeId(filePath, line, column, name);
  }

  // ============================================================================
  // Abstract Methods - Must be implemented by subclasses
  // ============================================================================

  /**
   * Find all references to a symbol at the given position.
   */
  abstract findReferences(
    filePath: string,
    line: number,
    column: number
  ): Promise<SymbolReference[]>;

  /**
   * Get the definition of a symbol at the given position.
   */
  abstract getDefinition(
    filePath: string,
    line: number,
    column: number
  ): Promise<SymbolDefinition | null>;

  /**
   * Prepare call hierarchy item at the given position.
   */
  abstract prepareCallHierarchy(
    filePath: string,
    line: number,
    column: number
  ): Promise<CallHierarchyItem | null>;

  /**
   * Get incoming calls (callers) for a call hierarchy item.
   */
  abstract getIncomingCalls(item: CallHierarchyItem): Promise<IncomingCall[]>;

  /**
   * Get outgoing calls (callees) for a call hierarchy item.
   */
  abstract getOutgoingCalls(item: CallHierarchyItem): Promise<OutgoingCall[]>;

  /**
   * Get all callable symbols in a file.
   */
  abstract getFileSymbols(filePath: string): Promise<CallGraphNode[]>;

  // ============================================================================
  // Optional Override Points
  // ============================================================================

  /**
   * Check if the adapter is ready to process requests.
   * Override in subclasses that need async initialization.
   */
  protected isReady(): boolean {
    return this.initialized;
  }

  /**
   * Ensure the adapter is initialized before processing requests.
   * Throws an error if not initialized.
   */
  protected ensureInitialized(): void {
    if (!this.isReady()) {
      throw new Error(
        `${this.language} adapter not initialized. Call initialize() first.`
      );
    }
  }
}

// ============================================================================
// Helper Exports
// ============================================================================

/**
 * Common symbol kind mapping for languages that use similar conventions.
 */
export const COMMON_SYMBOL_KINDS = {
  function: 'function' as SymbolKind,
  method: 'method' as SymbolKind,
  constructor: 'constructor' as SymbolKind,
  getter: 'getter' as SymbolKind,
  setter: 'setter' as SymbolKind,
  class: 'class' as SymbolKind,
  interface: 'interface' as SymbolKind,
  module: 'module' as SymbolKind,
  enum: 'enum' as SymbolKind,
} as const;

/**
 * Check if a name follows common export conventions (starts with uppercase).
 */
export function isExportedByConvention(name: string): boolean {
  return /^[A-Z]/.test(name);
}
