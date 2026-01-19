/**
 * AST Cache Module
 *
 * Provides caching for tree-sitter AST trees with:
 * - LRU eviction (maxEntries / maxBytes)
 * - Inflight request deduplication
 * - Reference counting for safe tree lifecycle
 *
 * @module analysis/cache/ast-cache
 */

import type { Tree } from 'web-tree-sitter';
import { parseFileWasm, languageForFile } from '../../ast/parser.js';
import type { TreeSitterLanguageId } from '../../ast/types.js';
import type { FileIndex } from './file-index.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Cache entry for an AST tree.
 */
interface CacheEntry {
  /** Cache key (absPath:fingerprint) */
  key: string;
  /** Absolute file path */
  absPath: string;
  tree: Tree;
  lang: TreeSitterLanguageId;
  fingerprint: string;
  byteSize: number;
  refCount: number;
  pendingDelete: boolean;
  lastAccess: number;
}

/**
 * AstCache options.
 */
export interface AstCacheOptions {
  /** Maximum number of entries (default: 100) */
  maxEntries?: number;
  /** Maximum total byte size (default: 50MB) */
  maxBytes?: number;
}

/**
 * Cache statistics.
 */
export interface AstCacheStats {
  entries: number;
  totalBytes: number;
  hits: number;
  misses: number;
  inflight: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50MB

// ============================================================================
// AstCache Class
// ============================================================================

/**
 * AST cache with LRU eviction and reference counting.
 *
 * **Important**: The `withTree` callback must NOT return Tree or Node objects.
 * All AST access must happen within the callback scope.
 */
export class AstCache {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<CacheEntry | null>>();
  private totalBytes = 0;
  private hits = 0;
  private misses = 0;

  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(options?: AstCacheOptions) {
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /**
   * Execute a callback with access to the AST tree.
   *
   * **Important**: The callback must NOT return Tree or Node objects.
   * All AST operations must happen within the callback scope.
   * The tree is automatically released after the callback completes.
   *
   * @param fileIndex - FileIndex for file metadata and content
   * @param absPath - Absolute path to the file
   * @param callback - Function to execute with the tree
   * @returns Result of the callback
   */
  async withTree<T>(
    fileIndex: FileIndex,
    absPath: string,
    callback: (tree: Tree, lang: TreeSitterLanguageId) => T | Promise<T>
  ): Promise<T | null> {
    const entry = await this.acquire(fileIndex, absPath);
    if (!entry) return null;

    try {
      return await callback(entry.tree, entry.lang);
    } finally {
      this.releaseEntry(entry);
    }
  }

  /**
   * Build cache key from path and fingerprint.
   */
  private buildKey(absPath: string, fingerprint: string): string {
    return `${absPath}:${fingerprint}`;
  }

  /**
   * Acquire a tree (increments ref count).
   */
  private async acquire(fileIndex: FileIndex, absPath: string): Promise<CacheEntry | null> {
    const record = await fileIndex.getRecord(absPath);
    if (!record || !record.lang) return null;

    const fingerprint = record.fingerprint;
    const cacheKey = this.buildKey(absPath, fingerprint);

    // Check cache hit (exact key match ensures fingerprint validity)
    const cached = this.cache.get(cacheKey);
    if (cached) {
      cached.refCount++;
      cached.lastAccess = Date.now();
      this.hits++;
      return cached;
    }

    // Check inflight for same key
    const pending = this.inflight.get(cacheKey);
    if (pending) {
      const entry = await pending;
      if (entry) {
        entry.refCount++;
        this.hits++;
      }
      return entry;
    }

    this.misses++;

    // Parse and cache
    const parsePromise = this.parseAndCache(fileIndex, absPath, fingerprint, cacheKey);
    this.inflight.set(cacheKey, parsePromise);

    try {
      return await parsePromise;
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  /**
   * Release a tree entry (decrements ref count).
   */
  private releaseEntry(entry: CacheEntry): void {
    entry.refCount--;

    if (entry.refCount <= 0 && entry.pendingDelete) {
      this.evictEntryByKey(entry.key);
    }
  }

  /**
   * Parse a file and add to cache.
   */
  private async parseAndCache(
    fileIndex: FileIndex,
    absPath: string,
    fingerprint: string,
    cacheKey: string
  ): Promise<CacheEntry | null> {
    const lang = languageForFile(absPath) as TreeSitterLanguageId | null;
    if (!lang) return null;

    const content = await fileIndex.readNormalized(absPath);
    if (!content) return null;

    const tree = await parseFileWasm(absPath, content);
    if (!tree) return null;

    // Estimate byte size (rough approximation)
    const byteSize = content.length * 2; // Assume ~2 bytes per character for AST

    // Evict if needed before adding
    this.evictIfNeeded(byteSize);

    // Mark old entries for same path as pending delete (different fingerprint)
    for (const [key, existing] of this.cache) {
      if (existing.absPath === absPath && key !== cacheKey) {
        if (existing.refCount > 0) {
          existing.pendingDelete = true;
        } else {
          this.evictEntryByKey(key);
        }
      }
    }

    const entry: CacheEntry = {
      key: cacheKey,
      absPath,
      tree,
      lang,
      fingerprint,
      byteSize,
      refCount: 1,
      pendingDelete: false,
      lastAccess: Date.now(),
    };

    this.cache.set(cacheKey, entry);
    this.totalBytes += byteSize;

    return entry;
  }

  /**
   * Evict entries if cache is over limits.
   */
  private evictIfNeeded(incomingBytes: number): void {
    // Evict by count
    while (this.cache.size >= this.maxEntries) {
      if (!this.evictLRU()) break; // No evictable entries
    }

    // Evict by size
    while (this.totalBytes + incomingBytes > this.maxBytes && this.cache.size > 0) {
      if (!this.evictLRU()) break; // No evictable entries
    }
  }

  /**
   * Evict the least recently used entry.
   * @returns true if an entry was evicted, false if none could be evicted
   */
  private evictLRU(): boolean {
    let oldest: { key: string; access: number } | null = null;

    for (const [key, entry] of this.cache) {
      if (entry.refCount > 0) continue; // Can't evict entries in use

      if (!oldest || entry.lastAccess < oldest.access) {
        oldest = { key, access: entry.lastAccess };
      }
    }

    if (oldest) {
      this.evictEntryByKey(oldest.key);
      return true;
    }
    return false;
  }

  /**
   * Evict a specific entry by key.
   */
  private evictEntryByKey(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;

    entry.tree.delete();
    this.totalBytes -= entry.byteSize;
    this.cache.delete(key);
  }

  /**
   * Invalidate all cached trees for a file path (for file changes).
   */
  invalidate(absPath: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.absPath === absPath) {
        if (entry.refCount > 0) {
          entry.pendingDelete = true;
        } else {
          this.evictEntryByKey(key);
        }
      }
    }
  }

  /**
   * Clear all cached trees.
   */
  clear(): void {
    for (const [key, entry] of this.cache) {
      if (entry.refCount === 0) {
        entry.tree.delete();
      } else {
        entry.pendingDelete = true;
      }
    }

    // Remove only those not in use
    for (const [key, entry] of this.cache) {
      if (entry.refCount === 0) {
        this.cache.delete(key);
      }
    }

    this.totalBytes = Array.from(this.cache.values()).reduce((sum, e) => sum + e.byteSize, 0);
  }

  /**
   * Get cache statistics.
   */
  stats(): AstCacheStats {
    return {
      entries: this.cache.size,
      totalBytes: this.totalBytes,
      hits: this.hits,
      misses: this.misses,
      inflight: this.inflight.size,
    };
  }
}
