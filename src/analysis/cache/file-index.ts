/**
 * File Index Module
 *
 * Provides file indexing, content reading, and fingerprinting.
 * Used to avoid redundant file reads and track file changes.
 *
 * @module analysis/cache/file-index
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { minimatch } from 'minimatch';

import { DEFAULT_CHECK_OPTIONS } from '../check/types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * File record with metadata.
 */
export interface FileRecord {
  /** Absolute path */
  absPath: string;
  /** Relative path from root */
  relPath: string;
  /** File extension (lowercase, with dot) */
  ext: string;
  /** Detected language identifier (null if unsupported) */
  lang: string | null;
  /** File size in bytes */
  size: number;
  /** Modification time in milliseconds */
  mtimeMs: number;
  /** Fingerprint (mtime+size or sha1) */
  fingerprint: string;
}

/**
 * Fingerprint mode.
 */
export type FingerprintMode = 'mtime-size' | 'sha1';

/**
 * FileIndex options.
 */
export interface FileIndexOptions {
  /** Root directory for relative paths */
  rootPath: string;
  /** File patterns to exclude (glob) */
  excludePatterns?: string[];
  /** Fingerprint mode (default: 'mtime-size') */
  fingerprintMode?: FingerprintMode;
}

// ============================================================================
// Extension to Language Mapping
// ============================================================================

const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.java': 'java',
  '.rs': 'rust',
};

// ============================================================================
// FileIndex Class
// ============================================================================

/**
 * File index for tracking files and their metadata.
 */
export class FileIndex {
  private records = new Map<string, FileRecord>();
  private contentCache = new Map<string, string>();
  private readonly rootPath: string;
  private readonly excludePatterns: string[];
  private readonly fingerprintMode: FingerprintMode;

  constructor(options: FileIndexOptions) {
    this.rootPath = path.resolve(options.rootPath);
    this.excludePatterns = options.excludePatterns ?? DEFAULT_CHECK_OPTIONS.excludePatterns;
    this.fingerprintMode = options.fingerprintMode ?? 'mtime-size';
  }

  /**
   * Get the root path.
   */
  getRoot(): string {
    return this.rootPath;
  }

  /**
   * Check if a file should be excluded.
   */
  isExcluded(filePath: string): boolean {
    const relPath = this.toRelPath(filePath);
    return this.excludePatterns.some((p) => minimatch(relPath, p));
  }

  /**
   * Convert absolute path to relative path.
   */
  toRelPath(absPath: string): string {
    return path.relative(this.rootPath, absPath).replace(/\\/g, '/');
  }

  /**
   * Convert relative path to absolute path.
   */
  toAbsPath(relPath: string): string {
    return path.resolve(this.rootPath, relPath);
  }

  /**
   * Get file record (creates if not exists).
   * Validates and refreshes cached records if file has changed.
   */
  async getRecord(absPath: string): Promise<FileRecord | null> {
    const resolved = path.resolve(absPath);

    // Check cached record validity
    const cached = this.records.get(resolved);
    if (cached && (await this.isValid(cached))) {
      return cached;
    }

    // Clean up stale content cache if record changed
    if (cached) {
      this.contentCache.delete(cached.fingerprint);
    }

    // Create new record
    try {
      const stats = await fs.stat(resolved);
      if (!stats.isFile()) return null;

      const ext = path.extname(resolved).toLowerCase();
      const record: FileRecord = {
        absPath: resolved,
        relPath: this.toRelPath(resolved),
        ext,
        lang: EXT_TO_LANG[ext] ?? null,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        fingerprint: await this.computeFingerprint(resolved, stats.size, stats.mtimeMs),
      };

      this.records.set(resolved, record);
      return record;
    } catch {
      return null;
    }
  }

  /**
   * Check if a cached record is still valid.
   */
  private async isValid(record: FileRecord): Promise<boolean> {
    if (this.fingerprintMode === 'sha1') {
      // For sha1, always recompute
      return false;
    }

    try {
      const stats = await fs.stat(record.absPath);
      return stats.mtimeMs === record.mtimeMs && stats.size === record.size;
    } catch {
      return false;
    }
  }

  /**
   * Compute fingerprint for a file.
   */
  private async computeFingerprint(
    absPath: string,
    size: number,
    mtimeMs: number
  ): Promise<string> {
    if (this.fingerprintMode === 'sha1') {
      const content = await fs.readFile(absPath);
      return crypto.createHash('sha1').update(content).digest('hex');
    }
    return `${mtimeMs}:${size}`;
  }

  /**
   * Read file content with normalization (CRLF -> LF).
   * Automatically creates/validates file record for caching.
   */
  async readNormalized(absPath: string): Promise<string | null> {
    // Get or create record to ensure fingerprint is current
    const record = await this.getRecord(absPath);
    if (!record) return null;

    // Check content cache with valid fingerprint
    const cached = this.contentCache.get(record.fingerprint);
    if (cached !== undefined) return cached;

    try {
      const content = await fs.readFile(record.absPath, 'utf8');
      const normalized = content.replace(/\r\n/g, '\n');

      // Cache content with current fingerprint
      this.contentCache.set(record.fingerprint, normalized);

      return normalized;
    } catch {
      return null;
    }
  }

  /**
   * Invalidate a file record.
   */
  invalidate(absPath: string): void {
    const resolved = path.resolve(absPath);
    const record = this.records.get(resolved);
    if (record) {
      this.contentCache.delete(record.fingerprint);
      this.records.delete(resolved);
    }
  }

  /**
   * Clear all cached data.
   */
  clear(): void {
    this.records.clear();
    this.contentCache.clear();
  }

  /**
   * Get all cached records.
   */
  getAllRecords(): FileRecord[] {
    return Array.from(this.records.values());
  }

  /**
   * Get statistics.
   */
  stats(): { files: number; contentCacheSize: number } {
    return {
      files: this.records.size,
      contentCacheSize: this.contentCache.size,
    };
  }
}
