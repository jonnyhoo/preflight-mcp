import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { type IngestedFile } from '../bundle/ingest.js';
import { getSearchCache } from './cache.js';
import type {
  IndexBuildOptions,
  IncrementalIndexResult,
  SearchScope,
  SearchHit,
  GroupedSearchHit,
  SearchOptions,
  SearchCacheEntry,
} from './types.js';

// Re-export types for external consumers
export type {
  IndexBuildOptions,
  IncrementalIndexResult,
  SearchScope,
  SearchHit,
  GroupedSearchHit,
  SearchOptions,
  SearchCacheEntry,
} from './types.js';

// Re-export claim verification (backward compatibility)
export type { EvidenceType, EvidenceHit, VerificationResult } from './claim-verification.js';
export { verifyClaimInIndex } from './claim-verification.js';

// Re-export modal search (backward compatibility)
export type {
  ModalContentKind,
  ModalSearchScope,
  ModalIndexItem,
  ModalSearchHit,
} from './modal-search.js';
export {
  ensureModalTables,
  indexModalContent,
  searchModalContent,
  searchModalByKeywords,
  getModalContentStats,
} from './modal-search.js';

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

/**
 * Check if incremental indexing is supported for this database.
 * Returns true if the file_meta table exists.
 */
export function supportsIncrementalIndex(dbPath: string): boolean {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='file_meta'`
      ).get() as { name: string } | undefined;
      return !!row;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/**
 * Get stored file metadata (SHA256 hashes) from the index.
 */
function getStoredFileMeta(db: Database.Database): Map<string, string> {
  const meta = new Map<string, string>();
  try {
    const rows = db.prepare('SELECT path, sha256 FROM file_meta').all() as Array<{ path: string; sha256: string }>;
    for (const row of rows) {
      meta.set(row.path, row.sha256);
    }
  } catch {
    // Table doesn't exist yet
  }
  return meta;
}

/**
 * Perform incremental index update based on file SHA256 hashes.
 * Only re-indexes files that have changed since the last index build.
 * 
 * @returns Statistics about what was updated
 */
export async function incrementalIndexUpdate(
  dbPath: string,
  files: IngestedFile[],
  opts: IndexBuildOptions
): Promise<IncrementalIndexResult> {
  // Check if database exists and supports incremental updates
  const dbExists = await fs.access(dbPath).then(() => true).catch(() => false);
  
  if (!dbExists || !supportsIncrementalIndex(dbPath)) {
    // Fall back to full rebuild
    await rebuildIndex(dbPath, files, opts);
    return {
      added: files.length,
      updated: 0,
      removed: 0,
      unchanged: 0,
      totalIndexed: files.length,
    };
  }

  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    // Get existing file metadata
    const storedMeta = getStoredFileMeta(db);
    const currentPaths = new Set(files.map(f => f.bundleNormRelativePath));

    let added = 0;
    let updated = 0;
    let removed = 0;
    let unchanged = 0;

    // Find files to remove (in index but not in current files)
    const pathsToRemove: string[] = [];
    for (const storedPath of storedMeta.keys()) {
      if (!currentPaths.has(storedPath)) {
        pathsToRemove.push(storedPath);
      }
    }

    // Remove deleted files from index
    if (pathsToRemove.length > 0) {
      const deleteLines = db.prepare('DELETE FROM lines WHERE path = ?');
      const deleteMeta = db.prepare('DELETE FROM file_meta WHERE path = ?');
      
      const removeTransaction = db.transaction((paths: string[]) => {
        for (const p of paths) {
          deleteLines.run(p);
          deleteMeta.run(p);
        }
      });
      removeTransaction(pathsToRemove);
      removed = pathsToRemove.length;
    }

    // Categorize files: new, changed, or unchanged
    const filesToIndex: IngestedFile[] = [];
    const filesToUpdate: IngestedFile[] = [];

    for (const f of files) {
      if (f.kind === 'doc' && !opts.includeDocs) continue;
      if (f.kind === 'code' && !opts.includeCode) continue;

      const storedSha = storedMeta.get(f.bundleNormRelativePath);
      
      if (!storedSha) {
        // New file
        filesToIndex.push(f);
        added++;
      } else if (storedSha !== f.sha256) {
        // Changed file
        filesToUpdate.push(f);
        updated++;
      } else {
        // Unchanged
        unchanged++;
      }
    }

    // Prepare statements
    const insertLine = db.prepare(
      'INSERT INTO lines (content, path, repo, kind, lineNo) VALUES (?, ?, ?, ?, ?)'
    );
    const deleteLines = db.prepare('DELETE FROM lines WHERE path = ?');
    const upsertMeta = db.prepare(
      'INSERT OR REPLACE INTO file_meta (path, sha256, indexed_at) VALUES (?, ?, ?)'
    );

    // Process updates (delete old lines, insert new)
    const updateTransaction = db.transaction((updateFiles: IngestedFile[]) => {
      const now = new Date().toISOString();
      
      for (const f of updateFiles) {
        try {
          // Delete old lines
          deleteLines.run(f.bundleNormRelativePath);
          
          // Insert new lines
          const text = fsSync.readFileSync(f.bundleNormAbsPath, 'utf8');
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? '';
            if (!line.trim()) continue;
            insertLine.run(line, f.bundleNormRelativePath, f.repoId, f.kind, i + 1);
          }
          
          // Update metadata
          upsertMeta.run(f.bundleNormRelativePath, f.sha256, now);
        } catch (err) {
          // Log error but continue with other files to avoid transaction rollback
          console.error(`Failed to index file ${f.bundleNormRelativePath}:`, err);
          throw err; // Re-throw to trigger transaction rollback and ensure finally block runs
        }
      }
    });

    // Process new files
    const insertTransaction = db.transaction((newFiles: IngestedFile[]) => {
      const now = new Date().toISOString();
      
      for (const f of newFiles) {
        try {
          const text = fsSync.readFileSync(f.bundleNormAbsPath, 'utf8');
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? '';
            if (!line.trim()) continue;
            insertLine.run(line, f.bundleNormRelativePath, f.repoId, f.kind, i + 1);
          }
          
          // Insert metadata
          upsertMeta.run(f.bundleNormRelativePath, f.sha256, now);
        } catch (err) {
          console.error(`Failed to index file ${f.bundleNormRelativePath}:`, err);
          throw err; // Re-throw to trigger transaction rollback and ensure finally block runs
        }
      }
    });

    // Execute transactions in batches to avoid memory overflow
    // Process 100 files at a time to keep memory usage bounded
    const BATCH_SIZE = 100;
    
    if (filesToUpdate.length > 0) {
      for (let i = 0; i < filesToUpdate.length; i += BATCH_SIZE) {
        const batch = filesToUpdate.slice(i, i + BATCH_SIZE);
        updateTransaction(batch);
      }
    }
    
    if (filesToIndex.length > 0) {
      for (let i = 0; i < filesToIndex.length; i += BATCH_SIZE) {
        const batch = filesToIndex.slice(i, i + BATCH_SIZE);
        insertTransaction(batch);
      }
    }

    return {
      added,
      updated,
      removed,
      unchanged,
      totalIndexed: added + updated + unchanged,
    };
  } finally {
    db.close();
  }
}

// Note: rebuildIndex signature changed
// Old callers should use the wrapper below
export async function rebuildIndex(
  dbPathOrFiles: string | IngestedFile[],
  filesOrDbPath: IngestedFile[] | string,
  opts: IndexBuildOptions
): Promise<void> {
  // Handle both old and new signatures for backward compatibility
  let dbPath: string;
  let files: IngestedFile[];
  
  if (typeof dbPathOrFiles === 'string') {
    // Old signature: rebuildIndex(dbPath, files, opts)
    dbPath = dbPathOrFiles;
    files = filesOrDbPath as IngestedFile[];
  } else {
    // New signature: rebuildIndex(files, dbPath, opts)
    files = dbPathOrFiles;
    dbPath = filesOrDbPath as string;
  }

  await ensureDir(path.dirname(dbPath));
  await fs.rm(dbPath, { force: true });
  // Also remove WAL/SHM files if present.
  await fs.rm(dbPath + '-wal', { force: true });
  await fs.rm(dbPath + '-shm', { force: true });

  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    // Create FTS5 table for full-text search
    db.exec(`
      CREATE VIRTUAL TABLE lines USING fts5(
        content,
        path UNINDEXED,
        repo UNINDEXED,
        kind UNINDEXED,
        lineNo UNINDEXED,
        tokenize='unicode61'
      );
    `);

    // Create file_meta table for incremental indexing support
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_meta (
        path TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
    `);

    const insertLine = db.prepare(
      `INSERT INTO lines (content, path, repo, kind, lineNo) VALUES (?, ?, ?, ?, ?)`
    );
    const insertMeta = db.prepare(
      `INSERT OR REPLACE INTO file_meta (path, sha256, indexed_at) VALUES (?, ?, ?)`
    );

    const insertMany = db.transaction((fileList: IngestedFile[]) => {
      const now = new Date().toISOString();
      
      for (const f of fileList) {
        if (f.kind === 'doc' && !opts.includeDocs) continue;
        if (f.kind === 'code' && !opts.includeCode) continue;

        try {
          // Read file synchronously inside transaction for better performance.
          const text = fsSync.readFileSync(f.bundleNormAbsPath, 'utf8');
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? '';
            // Skip empty lines to keep the index smaller.
            if (!line.trim()) continue;
            insertLine.run(line, f.bundleNormRelativePath, f.repoId, f.kind, i + 1);
          }
          
          // Store file metadata for incremental updates
          insertMeta.run(f.bundleNormRelativePath, f.sha256, now);
        } catch (err) {
          console.error(`Failed to index file ${f.bundleNormRelativePath}:`, err);
          throw err;
        }
      }
    });

    // Process files in batches to avoid memory overflow
    const BATCH_SIZE = 100;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      insertMany(batch);
    }
  } finally {
    db.close();
  }
}

/**
 * Extract code context for a search hit.
 * Finds the surrounding function/class definition and surrounding lines.
 */
function extractContext(
  fileContent: string,
  hitLineNo: number
): { functionName?: string; className?: string; startLine: number; endLine: number; surroundingLines: string[] } | undefined {
  const lines = fileContent.split('\n');
  const hitIndex = hitLineNo - 1; // Convert 1-based to 0-based

  if (hitIndex < 0 || hitIndex >= lines.length) {
    return undefined;
  }

  // Extract surrounding lines (Â±3 lines)
  const surroundStart = Math.max(0, hitIndex - 3);
  const surroundEnd = Math.min(lines.length - 1, hitIndex + 3);
  const surroundingLines = lines.slice(surroundStart, surroundEnd + 1);

  // Find function/class definition by scanning upwards (max 50 lines)
  let functionName: string | undefined;
  let className: string | undefined;
  let startLine = hitLineNo;
  let endLine = hitLineNo;

  const scanStartIndex = Math.max(0, hitIndex - 50);

  // Patterns for TypeScript/JavaScript/Python/Go functions and classes
  const functionPatterns = [
    // TypeScript/JavaScript
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?\(/,
    /^\s*(?:async\s+)?([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*\{/,
    /^\s*([a-zA-Z_$][\w$]*)\s*:\s*(?:async\s+)?function\s*\(/,
    // Python
    /^\s*(?:async\s+)?def\s+([a-zA-Z_][\w]*)\s*\(/,
    // Go
    /^\s*func\s+(?:\([^)]*\)\s*)?([a-zA-Z_][\w]*)\s*\(/,
  ];

  const classPatterns = [
    // TypeScript/JavaScript
    /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([a-zA-Z_$][\w$]*)/,
    /^\s*(?:export\s+)?interface\s+([a-zA-Z_$][\w$]*)/,
    /^\s*(?:export\s+)?type\s+([a-zA-Z_$][\w$]*)\s*=/,
    // Python
    /^\s*class\s+([a-zA-Z_][\w]*)\s*[:(]/,
    // Go
    /^\s*type\s+([a-zA-Z_][\w]*)\s+struct/,
  ];

  // Scan upward to find function or class definition
  for (let i = hitIndex; i >= scanStartIndex; i--) {
    const line = lines[i] ?? '';

    // Try to match function patterns
    if (!functionName) {
      for (const pattern of functionPatterns) {
        const match = line.match(pattern);
        if (match?.[1]) {
          functionName = match[1];
          startLine = i + 1; // Convert to 1-based
          break;
        }
      }
    }

    // Try to match class patterns (only if we haven't found function yet)
    if (!className) {
      for (const pattern of classPatterns) {
        const match = line.match(pattern);
        if (match?.[1]) {
          className = match[1];
          if (!functionName) {
            startLine = i + 1;
          }
          break;
        }
      }
    }

    // If we found function name, stop scanning
    if (functionName) {
      break;
    }
  }

  // Find end of the function/block by scanning downward for closing brace
  // Simple bracket matching (stops at first balanced closing brace)
  if (functionName || className) {
    let braceCount = 0;
    let foundOpenBrace = false;

    for (let i = startLine - 1; i < lines.length && i < hitIndex + 100; i++) {
      const line = lines[i] ?? '';

      for (const char of line) {
        if (char === '{') {
          braceCount++;
          foundOpenBrace = true;
        } else if (char === '}') {
          braceCount--;
          if (foundOpenBrace && braceCount === 0) {
            endLine = i + 1;
            return {
              functionName,
              className,
              startLine,
              endLine,
              surroundingLines,
            };
          }
        }
      }
    }

    // If we didn't find closing brace, estimate end line
    endLine = Math.min(lines.length, startLine + 50);
  }

  return {
    functionName,
    className,
    startLine,
    endLine,
    surroundingLines,
  };
}

export function tokenizeForSafeQuery(input: string): string[] {
  const s = input.trim();
  if (!s) return [];
  // Include unicode letters/digits/underscore/dot/slash/dash.
  const re = /[\p{L}\p{N}_.\/-]{2,}/gu;
  const out: string[] = [];
  for (const m of s.matchAll(re)) {
    const tok = m[0];
    if (tok) out.push(tok);
    if (out.length >= 12) break;
  }
  return out;
}

export function buildFtsQuery(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith('fts:')) {
    return trimmed.slice(4).trim();
  }

  const tokens = tokenizeForSafeQuery(trimmed);
  if (tokens.length === 0) {
    // Quote the whole thing (best-effort) to avoid syntax errors.
    const escaped = trimmed.replaceAll('"', '""');
    return `"${escaped}"`;
  }

  // Quote each token to keep syntax safe.
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ');
}

export function searchIndex(
  dbPath: string,
  query: string,
  scope: SearchScope,
  limit: number,
  bundleRoot?: string,
  options?: { skipCache?: boolean }
): SearchHit[] {
  // Check cache first (unless skipCache is set)
  if (!options?.skipCache) {
    const cache = getSearchCache();
    const cached = cache.get({ dbPath, query, scope, limit });
    if (cached) {
      return cached.hits;
    }
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const ftsQuery = buildFtsQuery(query);

    const whereKind =
      scope === 'docs' ? `kind = 'doc' AND` : scope === 'code' ? `kind = 'code' AND` : '';

    const stmt = db.prepare(
      `
      SELECT
        path,
        repo,
        kind,
        lineNo,
        snippet(lines, 0, '[', ']', 'â€?, 10) AS snippet
      FROM lines
      WHERE ${whereKind} lines MATCH ?
      ORDER BY bm25(lines)
      LIMIT ?
      `
    );

    const rows = stmt.all(ftsQuery, limit) as Array<{
      path: string;
      repo: string;
      kind: 'doc' | 'code';
      lineNo: number;
      snippet: string;
    }>;

    // Cache for file contents to avoid re-reading same files
    const fileCache = new Map<string, string>();

    const results = rows.map((r) => {
      const hit: SearchHit = {
        path: r.path,
        repo: r.repo,
        kind: r.kind,
        lineNo: r.lineNo,
        snippet: r.snippet,
      };

      // Add context for code files if bundleRoot is provided
      if (r.kind === 'code' && bundleRoot) {
        try {
          // r.path is bundleNormRelativePath (e.g., "repos/owner/repo/norm/path/to/file.ts")
          // Construct absolute path to the normalized file
          const filePath = path.join(bundleRoot, r.path);
          
          // Read file content (use cache to avoid re-reading)
          let fileContent = fileCache.get(filePath);
          if (!fileContent) {
            fileContent = fsSync.readFileSync(filePath, 'utf8');
            fileCache.set(filePath, fileContent);
          }

          // Extract context
          const context = extractContext(fileContent, r.lineNo);
          if (context) {
            hit.context = context;
          }
        } catch (err) {
          // Silently skip context extraction on error (file not found, etc.)
          // Context is optional enhancement, shouldn't break search
        }
      }

      return hit;
    });

    // Cache the results (unless skipCache is set)
    if (!options?.skipCache) {
      const cache = getSearchCache();
      cache.set(
        { dbPath, query, scope, limit },
        { hits: results, meta: {} }
      );
    }

    return results;
  } finally {
    db.close();
  }
}

/**
 * Advanced search with EDDA enhancements.
 * Supports groupByFile, includeScore, and fileTypeFilters.
 */
export function searchIndexAdvanced(
  dbPath: string,
  query: string,
  options: SearchOptions & { skipCache?: boolean }
): { hits: SearchHit[]; grouped?: GroupedSearchHit[]; meta: { tokenBudgetHint?: string } } {
  // Check cache first (unless skipCache is set)
  if (!options.skipCache) {
    const cache = getSearchCache();
    const cached = cache.get({ dbPath, query, scope: options.scope, limit: options.limit, options });
    if (cached) {
      return cached;
    }
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const ftsQuery = buildFtsQuery(query);
    const { scope, limit, bundleRoot, includeScore, fileTypeFilters, groupByFile } = options;

    const whereKind =
      scope === 'docs' ? `kind = 'doc' AND` : scope === 'code' ? `kind = 'code' AND` : '';

    // Fetch more results if we need to filter by file type
    const fetchLimit = fileTypeFilters?.length ? Math.min(limit * 3, 500) : limit;

    const stmt = db.prepare(
      `
      SELECT
        path,
        repo,
        kind,
        lineNo,
        snippet(lines, 0, '[', ']', 'â€?, 10) AS snippet,
        bm25(lines) AS score
      FROM lines
      WHERE ${whereKind} lines MATCH ?
      ORDER BY bm25(lines)
      LIMIT ?
      `
    );

    let rows = stmt.all(ftsQuery, fetchLimit) as Array<{
      path: string;
      repo: string;
      kind: 'doc' | 'code';
      lineNo: number;
      snippet: string;
      score: number;
    }>;

    // Apply file type filters
    if (fileTypeFilters && fileTypeFilters.length > 0) {
      const normalizedFilters = fileTypeFilters.map(f => f.toLowerCase());
      rows = rows.filter(r => {
        const ext = path.extname(r.path).toLowerCase();
        return normalizedFilters.includes(ext);
      });
    }

    // Limit after filtering
    rows = rows.slice(0, limit);

    // Build grouped results if requested
    let grouped: GroupedSearchHit[] | undefined;
    if (groupByFile) {
      const byFile = new Map<string, {
        path: string;
        repo: string;
        kind: 'doc' | 'code';
        lines: number[];
        topSnippet: string;
        topScore: number;
      }>();

      for (const r of rows) {
        const existing = byFile.get(r.path);
        if (existing) {
          existing.lines.push(r.lineNo);
          // Keep the snippet with best score (lower is better in FTS5)
          if (r.score < existing.topScore) {
            existing.topSnippet = r.snippet;
            existing.topScore = r.score;
          }
        } else {
          byFile.set(r.path, {
            path: r.path,
            repo: r.repo,
            kind: r.kind,
            lines: [r.lineNo],
            topSnippet: r.snippet,
            topScore: r.score,
          });
        }
      }

      grouped = Array.from(byFile.values()).map(g => ({
        path: g.path,
        repo: g.repo,
        kind: g.kind,
        hitCount: g.lines.length,
        lines: g.lines.sort((a, b) => a - b),
        topSnippet: g.topSnippet,
        topScore: includeScore ? g.topScore : undefined,
      }));
    }

    // Cache for file contents
    const fileCache = new Map<string, string>();

    const hits = rows.map((r) => {
      const hit: SearchHit = {
        path: r.path,
        repo: r.repo,
        kind: r.kind,
        lineNo: r.lineNo,
        snippet: r.snippet,
        score: includeScore ? r.score : undefined,
      };

      // Add context for code files if bundleRoot is provided
      if (r.kind === 'code' && bundleRoot && !groupByFile) {
        try {
          const filePath = path.join(bundleRoot, r.path);
          let fileContent = fileCache.get(filePath);
          if (!fileContent) {
            fileContent = fsSync.readFileSync(filePath, 'utf8');
            fileCache.set(filePath, fileContent);
          }
          const context = extractContext(fileContent, r.lineNo);
          if (context) {
            hit.context = context;
          }
        } catch {
          // Skip context on error
        }
      }

      return hit;
    });

    // Calculate token budget hint
    let tokenBudgetHint: string | undefined;
    if (groupByFile && grouped) {
      const ungroupedTokens = rows.length * 100; // rough estimate
      const groupedTokens = grouped.length * 80;
      const savings = Math.round((1 - groupedTokens / ungroupedTokens) * 100);
      if (savings > 0) {
        tokenBudgetHint = `groupByFile saves ~${savings}% tokens (${grouped.length} files vs ${rows.length} hits)`;
      }
    }

    const result = {
      hits: groupByFile ? [] : hits, // Return empty hits when grouped
      grouped,
      meta: { tokenBudgetHint },
    };

    // Cache the results (unless skipCache is set)
    if (!options.skipCache) {
      const cache = getSearchCache();
      cache.set(
        { dbPath, query, scope: options.scope, limit: options.limit, options },
        result
      );
    }

    return result;
  } finally {
    db.close();
  }
}

