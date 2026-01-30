import fs from 'node:fs/promises';
import path from 'node:path';
import type { WebCrawlConfig } from '../web/types.js';

/**
 * Input configuration for web crawling (used in RepoInput).
 * Excludes baseUrl since it's provided separately via the 'url' field.
 */
export type WebCrawlInputConfig = Omit<WebCrawlConfig, 'baseUrl'>;

// =============================================================================
// Manifest Cache - LRU cache to avoid repeated disk reads during listBundles
// =============================================================================

interface ManifestCacheEntry {
  manifest: BundleManifestV1;
  cachedAt: number;
  mtime: number; // File modification time for invalidation
}

class ManifestCache {
  private cache = new Map<string, ManifestCacheEntry>();
  private ttlMs: number;
  private maxSize: number;

  constructor(ttlMs = 5 * 60_000, maxSize = 100) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  /**
   * Get a cached manifest if valid, otherwise return undefined.
   */
  get(manifestPath: string, currentMtime: number): BundleManifestV1 | undefined {
    const entry = this.cache.get(manifestPath);
    if (!entry) return undefined;

    const now = Date.now();
    // Invalidate if TTL expired or file was modified
    if (now - entry.cachedAt > this.ttlMs || entry.mtime !== currentMtime) {
      this.cache.delete(manifestPath);
      return undefined;
    }

    return entry.manifest;
  }

  /**
   * Store a manifest in cache.
   */
  set(manifestPath: string, manifest: BundleManifestV1, mtime: number): void {
    // Evict oldest entries if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(manifestPath, {
      manifest,
      cachedAt: Date.now(),
      mtime,
    });
  }

  /**
   * Invalidate a specific cache entry.
   */
  invalidate(manifestPath: string): void {
    this.cache.delete(manifestPath);
  }

  /**
   * Clear all cache entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Update cache configuration.
   */
  configure(ttlMs: number, maxSize: number): void {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  /**
   * Get cache statistics.
   */
  stats(): { size: number; ttlMs: number; maxSize: number } {
    return {
      size: this.cache.size,
      ttlMs: this.ttlMs,
      maxSize: this.maxSize,
    };
  }
}

// Global manifest cache singleton
const manifestCache = new ManifestCache();

/**
 * Configure the manifest cache (call from config initialization).
 */
export function configureManifestCache(ttlMs: number, maxSize: number): void {
  manifestCache.configure(ttlMs, maxSize);
}

/**
 * Clear the manifest cache (useful for testing or after bundle updates).
 */
export function clearManifestCache(): void {
  manifestCache.clear();
}

/**
 * Invalidate a specific manifest cache entry.
 */
export function invalidateManifestCache(manifestPath: string): void {
  manifestCache.invalidate(manifestPath);
}

/**
 * Get manifest cache statistics.
 */
export function getManifestCacheStats(): { size: number; ttlMs: number; maxSize: number } {
  return manifestCache.stats();
}

// =============================================================================
// Types
// =============================================================================

export type RepoInput =
  | {
      kind: 'github';
      repo: string; // owner/repo
      ref?: string; // optional branch/tag/sha
    }
  | {
      /**
       * Import a repository from a local directory (e.g., extracted ZIP).
       * `repo` is the logical identifier in owner/repo form (used for storage layout and dedup).
       */
      kind: 'local';
      repo: string; // owner/repo (logical id)
      path: string; // local directory path
      ref?: string; // optional label for the local snapshot
    }
  | {
      /**
       * Import documentation from a website URL.
       * Web sources are crawled and converted to markdown.
       */
      kind: 'web';
      url: string; // base URL to crawl
      config?: WebCrawlInputConfig; // optional crawl configuration (baseUrl is provided via 'url')
    }
  | {
      /**
       * Import a PDF document from URL or local path.
       * For URLs: PDF is downloaded and parsed for text extraction.
       * For local paths: PDF is parsed directly.
       */
      kind: 'pdf';
      url?: string; // PDF URL to download (optional if path is provided)
      path?: string; // Local file path to PDF (optional if url is provided)
      name?: string; // optional display name for the document
    }
  | {
      /**
       * Import markdown documents from a local directory.
       * All .md and .markdown files are recursively ingested.
       */
      kind: 'markdown';
      path: string; // Local directory path containing markdown files
      name?: string; // optional display name for the document collection
    };

export type BundleIndexConfig = {
  backend: 'sqlite-fts5-lines';
  includeDocs: boolean;
  includeCode: boolean;
};

export type BundleRepo = {
  kind: 'github' | 'local' | 'web' | 'pdf' | 'markdown';
  id: string; // owner/repo for github/local, 'web/{safeId}' for web, 'pdf/{safeId}' for pdf, 'markdown/{safeId}' for markdown
  /**
   * Source of the snapshot for this repo.
   * - github: git shallow clone or GitHub archive (zipball) fallback
   * - local: local directory import
   * - crawl: web crawl
   * - download: remote PDF download
   */
  source?: 'git' | 'archive' | 'local' | 'crawl' | 'download';
  headSha?: string; // for web/pdf: content fingerprint
  fetchedAt: string; // ISO
  notes?: string[];
  // Web-specific fields
  baseUrl?: string; // web: starting URL
  pageCount?: number; // web: number of crawled pages
  usedLlmsTxt?: boolean; // web: whether llms.txt fast path was used
  // PDF-specific fields
  pdfUrl?: string; // pdf: original URL
  localPath?: string; // pdf: local file path after download
  fileSize?: number; // pdf: file size in bytes
};

/** @deprecated Context7 integration removed. Kept for backward compatibility with existing bundles. */
export type BundleLibrary = {
  kind: 'context7';
  input: string;
  id?: string;
  fetchedAt: string;
  notes?: string[];
  files?: string[];
};

/**
 * Skipped file entry - records files that were not indexed during bundle creation.
 * Used for transparency when search returns 0 results.
 */
export type SkippedFileEntry = {
  /** File path (relative to repo root) */
  path: string;
  /** Reason for skipping */
  reason: 'too_large' | 'binary' | 'non_utf8' | 'max_total_reached';
  /** File size in bytes (if known) */
  size?: number;
};

export type BundleManifestV1 = {
  schemaVersion: 1;
  bundleId: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Bundle type: 'repository' (default) for code repos, 'document' for document-only bundles.
   */
  type?: 'repository' | 'document';
  /**
   * Stable input fingerprint used for de-duplication.
   * When present, two bundles with the same fingerprint were created from the same normalized inputs.
   */
  fingerprint?: string;
  // NEW: Human-readable metadata
  displayName?: string; // e.g., "React Framework"
  description?: string; // Brief description of the bundle
  tags?: string[];      // Auto-detected or manual tags for categorization
  primaryLanguage?: string; // Primary programming language
  inputs: {
    repos: RepoInput[];
    libraries?: string[];
    topics?: string[];
  };
  repos: BundleRepo[];
  libraries?: BundleLibrary[];
  index: BundleIndexConfig;
  /**
   * Files that were skipped during indexing.
   * Stored for transparency - helps explain why search might miss certain content.
   */
  skippedFiles?: SkippedFileEntry[];
};

/**
 * Read manifest with caching support.
 * Uses LRU cache to avoid repeated disk reads during listBundles.
 */
export async function readManifest(manifestPath: string): Promise<BundleManifestV1> {
  // Get file stats for cache invalidation
  let mtime: number;
  try {
    const stats = await fs.stat(manifestPath);
    mtime = stats.mtimeMs;
  } catch {
    // File doesn't exist or can't be read - will throw below
    mtime = 0;
  }

  // Check cache first
  const cached = manifestCache.get(manifestPath, mtime);
  if (cached) {
    return cached;
  }

  // Read from disk
  const raw = await fs.readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as BundleManifestV1;
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported manifest schemaVersion: ${String((parsed as any).schemaVersion)}`);
  }

  // Store in cache
  manifestCache.set(manifestPath, parsed, mtime);

  return parsed;
}

/**
 * Read manifest without caching (use when you need fresh data).
 */
export async function readManifestUncached(manifestPath: string): Promise<BundleManifestV1> {
  const raw = await fs.readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as BundleManifestV1;
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported manifest schemaVersion: ${String((parsed as any).schemaVersion)}`);
  }
  return parsed;
}

export async function writeManifest(manifestPath: string, manifest: BundleManifestV1): Promise<void> {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}
