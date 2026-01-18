/**
 * LRU Cache with TTL support for search result caching.
 * Reduces redundant FTS5 queries for frequently accessed searches.
 */

import crypto from 'node:crypto';

export interface CacheConfig {
  /** Maximum number of entries in the cache */
  maxSize: number;
  /** Time-to-live in milliseconds */
  ttlMs: number;
  /** Enable cache statistics tracking */
  enableStats?: boolean;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  hitRate: number;
}

interface CacheEntry<T> {
  value: T;
  createdAt: number;
  accessedAt: number;
}

/**
 * Generic LRU cache with TTL support.
 */
export class LRUCache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private readonly config: Required<CacheConfig>;
  private stats = { hits: 0, misses: 0, evictions: 0 };

  constructor(config: CacheConfig) {
    this.config = {
      maxSize: config.maxSize,
      ttlMs: config.ttlMs,
      enableStats: config.enableStats ?? false,
    };
  }

  /**
   * Generate a cache key from query parameters.
   */
  static generateKey(params: Record<string, unknown>): string {
    const normalized = JSON.stringify(params, Object.keys(params).sort());
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  /**
   * Get a value from the cache.
   * Returns undefined if not found or expired.
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    
    if (!entry) {
      if (this.config.enableStats) this.stats.misses++;
      return undefined;
    }

    // Check TTL
    const now = Date.now();
    if (now - entry.createdAt > this.config.ttlMs) {
      this.cache.delete(key);
      if (this.config.enableStats) this.stats.misses++;
      return undefined;
    }

    // Update access time (LRU tracking)
    entry.accessedAt = now;
    
    // Move to end (most recently used) by re-inserting
    this.cache.delete(key);
    this.cache.set(key, entry);

    if (this.config.enableStats) this.stats.hits++;
    return entry.value;
  }

  /**
   * Set a value in the cache.
   */
  set(key: string, value: T): void {
    const now = Date.now();

    // Evict oldest entries if at capacity
    while (this.cache.size >= this.config.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
        if (this.config.enableStats) this.stats.evictions++;
      } else {
        break;
      }
    }

    this.cache.set(key, {
      value,
      createdAt: now,
      accessedAt: now,
    });
  }

  /**
   * Check if a key exists and is not expired.
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    
    if (Date.now() - entry.createdAt > this.config.ttlMs) {
      this.cache.delete(key);
      return false;
    }
    
    return true;
  }

  /**
   * Delete a specific key from the cache.
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Clear entries matching a predicate on the key.
   * Useful for invalidating cache by bundle ID or path prefix.
   */
  clearMatching(predicate: (key: string) => boolean): number {
    let cleared = 0;
    for (const key of this.cache.keys()) {
      if (predicate(key)) {
        this.cache.delete(key);
        cleared++;
      }
    }
    return cleared;
  }

  /**
   * Get current cache size.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      size: this.cache.size,
      hitRate: total > 0 ? this.stats.hits / total : 0,
    };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }

  /**
   * Prune expired entries.
   * Call periodically to reclaim memory from expired entries.
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.createdAt > this.config.ttlMs) {
        this.cache.delete(key);
        pruned++;
      }
    }
    
    return pruned;
  }
}

// ============================================================================
// Search-specific cache implementation
// ============================================================================

import type {
  SearchHit,
  GroupedSearchHit,
  SearchScope,
  SearchOptions,
  SearchCacheEntry,
} from './types.js';

export type { SearchCacheEntry } from './types.js';

export interface SearchCacheConfig extends CacheConfig {
  /** Prefix for cache keys (e.g., bundle ID) */
  keyPrefix?: string;
}

/**
 * Specialized cache for search results.
 */
export class SearchResultCache {
  private cache: LRUCache<SearchCacheEntry>;
  private keyPrefix: string;
  /** Maps dbPath to set of cache keys for precise invalidation */
  private dbPathToKeys: Map<string, Set<string>> = new Map();

  constructor(config: SearchCacheConfig = { maxSize: 500, ttlMs: 5 * 60 * 1000 }) {
    this.cache = new LRUCache<SearchCacheEntry>(config);
    this.keyPrefix = config.keyPrefix ?? '';
  }

  /**
   * Generate a cache key from search parameters.
   */
  private generateKey(params: {
    dbPath: string;
    query: string;
    scope: SearchScope;
    limit: number;
    options?: Partial<SearchOptions>;
  }): string {
    const keyData = {
      prefix: this.keyPrefix,
      db: params.dbPath,
      q: params.query,
      s: params.scope,
      l: params.limit,
      filters: params.options?.fileTypeFilters?.sort(),
      group: params.options?.groupByFile,
      score: params.options?.includeScore,
    };
    return LRUCache.generateKey(keyData);
  }

  /**
   * Get cached search results.
   */
  get(params: {
    dbPath: string;
    query: string;
    scope: SearchScope;
    limit: number;
    options?: Partial<SearchOptions>;
  }): SearchCacheEntry | undefined {
    const key = this.generateKey(params);
    return this.cache.get(key);
  }

  /**
   * Cache search results.
   */
  set(
    params: {
      dbPath: string;
      query: string;
      scope: SearchScope;
      limit: number;
      options?: Partial<SearchOptions>;
    },
    result: SearchCacheEntry
  ): void {
    const key = this.generateKey(params);
    this.cache.set(key, result);

    // Track key by dbPath for precise invalidation
    const dbPath = params.dbPath;
    let keySet = this.dbPathToKeys.get(dbPath);
    if (!keySet) {
      keySet = new Set();
      this.dbPathToKeys.set(dbPath, keySet);
    }
    keySet.add(key);
  }

  /**
   * Invalidate cache for a specific database (e.g., after bundle update).
   * Now uses precise invalidation instead of clearing entire cache.
   */
  invalidateByDbPath(dbPath: string): number {
    const keySet = this.dbPathToKeys.get(dbPath);
    if (!keySet || keySet.size === 0) {
      return 0;
    }

    let cleared = 0;
    for (const key of keySet) {
      if (this.cache.delete(key)) {
        cleared++;
      }
    }

    // Clean up the mapping
    this.dbPathToKeys.delete(dbPath);
    return cleared;
  }

  /**
   * Clear all cached results.
   */
  clear(): void {
    this.cache.clear();
    this.dbPathToKeys.clear();
  }

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats {
    return this.cache.getStats();
  }

  /**
   * Prune expired entries.
   */
  prune(): number {
    return this.cache.prune();
  }
}

// Global search cache instance
let globalSearchCache: SearchResultCache | null = null;

/**
 * Get the global search cache instance.
 * Creates one if it doesn't exist.
 */
export function getSearchCache(): SearchResultCache {
  if (!globalSearchCache) {
    globalSearchCache = new SearchResultCache({
      maxSize: parseInt(process.env.PREFLIGHT_SEARCH_CACHE_SIZE ?? '500', 10),
      ttlMs: parseInt(process.env.PREFLIGHT_SEARCH_CACHE_TTL_MS ?? String(5 * 60 * 1000), 10),
      enableStats: true,
    });
  }
  return globalSearchCache;
}

/**
 * Reset the global search cache (useful for testing).
 */
export function resetSearchCache(): void {
  globalSearchCache?.clear();
  globalSearchCache = null;
}

/**
 * Invalidate search cache for a specific bundle.
 * Should be called after bundle updates.
 */
export function invalidateSearchCacheForBundle(dbPath: string): number {
  return globalSearchCache?.invalidateByDbPath(dbPath) ?? 0;
}
