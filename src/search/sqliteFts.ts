import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { type IngestedFile } from '../bundle/ingest.js';

export type IndexBuildOptions = {
  includeDocs: boolean;
  includeCode: boolean;
};

export type IncrementalIndexResult = {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  totalIndexed: number;
};

export type SearchScope = 'docs' | 'code' | 'all';

export type SearchHit = {
  path: string; // bundle-relative posix path
  repo: string; // owner/repo
  kind: 'doc' | 'code';
  lineNo: number;
  snippet: string;
  /** BM25 relevance score (lower is more relevant, FTS5 convention) */
  score?: number;
  context?: {
    functionName?: string;
    className?: string;
    startLine: number;
    endLine: number;
    surroundingLines: string[];
  };
};

/**
 * Grouped search hit - aggregates multiple hits from the same file.
 * Used when groupByFile=true to reduce token consumption.
 */
export type GroupedSearchHit = {
  path: string;
  repo: string;
  kind: 'doc' | 'code';
  /** Number of matching lines in this file */
  hitCount: number;
  /** Line numbers of all matches */
  lines: number[];
  /** Best matching snippet (highest relevance) */
  topSnippet: string;
  /** Best score (most relevant) */
  topScore?: number;
};

/**
 * Extended search options for EDDA token efficiency.
 */
export type SearchOptions = {
  /** Search scope */
  scope: SearchScope;
  /** Max results */
  limit: number;
  /** Bundle root path (for context extraction) */
  bundleRoot?: string;
  /** Include BM25 score in results */
  includeScore?: boolean;
  /** Filter by file extensions (e.g., [".py", ".ts"]) */
  fileTypeFilters?: string[];
  /** Group results by file */
  groupByFile?: boolean;
};

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
      `INSERT INTO file_meta (path, sha256, indexed_at) VALUES (?, ?, ?)`
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

  // Extract surrounding lines (±3 lines)
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

function tokenizeForSafeQuery(input: string): string[] {
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
  bundleRoot?: string
): SearchHit[] {
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
        snippet(lines, 0, '[', ']', '…', 10) AS snippet
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

    return rows.map((r) => {
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
  options: SearchOptions
): { hits: SearchHit[]; grouped?: GroupedSearchHit[]; meta: { tokenBudgetHint?: string } } {
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
        snippet(lines, 0, '[', ']', '…', 10) AS snippet,
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

    return {
      hits: groupByFile ? [] : hits, // Return empty hits when grouped
      grouped,
      meta: { tokenBudgetHint },
    };
  } finally {
    db.close();
  }
}

// --- Claim Verification Types and Functions ---

/**
 * Evidence classification based on content analysis.
 */
export type EvidenceType = 'supporting' | 'contradicting' | 'related';

/**
 * A piece of evidence with classification and relevance score.
 */
export type EvidenceHit = SearchHit & {
  evidenceType: EvidenceType;
  relevanceScore: number; // 0-1, higher = more relevant
};

/**
 * Result of claim verification.
 */
export type VerificationResult = {
  claim: string;
  found: boolean;
  confidence: number; // 0-1, overall confidence in verification
  confidenceLabel: 'high' | 'medium' | 'low' | 'none';
  summary: string;
  supporting: EvidenceHit[];
  contradicting: EvidenceHit[];
  related: EvidenceHit[];
};

// Negation patterns that might indicate contradiction
const NEGATION_PATTERNS = [
  /\b(not|no|never|cannot|can't|won't|doesn't|don't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't)\b/i,
  /\b(deprecated|removed|obsolete|discontinued|unsupported|disabled)\b/i,
  /\b(instead of|rather than|unlike|contrary to|in contrast)\b/i,
];

// Affirmation patterns that might indicate support
const AFFIRMATION_PATTERNS = [
  /\b(is|are|was|were|has|have|does|do|can|will|should|must)\b/i,
  /\b(supports?|enables?|provides?|allows?|includes?)\b/i,
  /\b(recommended|required|default|standard|official)\b/i,
];

/**
 * Classify evidence as supporting, contradicting, or related.
 * Uses heuristic analysis of content patterns.
 */
function classifyEvidence(snippet: string, claimTokens: string[]): { type: EvidenceType; score: number } {
  const lowerSnippet = snippet.toLowerCase();
  
  // Count how many claim tokens appear in the snippet
  const tokenMatches = claimTokens.filter(t => lowerSnippet.includes(t.toLowerCase())).length;
  const tokenRatio = claimTokens.length > 0 ? tokenMatches / claimTokens.length : 0;
  
  // Check for negation patterns
  const hasNegation = NEGATION_PATTERNS.some(p => p.test(snippet));
  
  // Check for affirmation patterns
  const hasAffirmation = AFFIRMATION_PATTERNS.some(p => p.test(snippet));
  
  // Base score on token match ratio
  let score = tokenRatio * 0.7 + 0.3; // 0.3-1.0 range
  
  // Classify based on patterns
  let type: EvidenceType;
  
  if (tokenRatio >= 0.5) {
    // High token match - likely directly relevant
    if (hasNegation && !hasAffirmation) {
      type = 'contradicting';
      score *= 0.9; // Slightly lower confidence for contradictions
    } else if (hasAffirmation || !hasNegation) {
      type = 'supporting';
    } else {
      type = 'related';
      score *= 0.8;
    }
  } else if (tokenRatio >= 0.25) {
    // Moderate token match - probably related
    type = 'related';
    score *= 0.7;
  } else {
    // Low token match - tangentially related
    type = 'related';
    score *= 0.5;
  }
  
  return { type, score: Math.min(1, Math.max(0, score)) };
}

/**
 * Calculate overall confidence based on evidence distribution.
 */
function calculateConfidence(supporting: EvidenceHit[], contradicting: EvidenceHit[], related: EvidenceHit[]): {
  confidence: number;
  label: 'high' | 'medium' | 'low' | 'none';
} {
  const totalEvidence = supporting.length + contradicting.length + related.length;
  
  if (totalEvidence === 0) {
    return { confidence: 0, label: 'none' };
  }
  
  // Weight by evidence type and scores
  const supportingWeight = supporting.reduce((sum, e) => sum + e.relevanceScore, 0);
  const contradictingWeight = contradicting.reduce((sum, e) => sum + e.relevanceScore * 0.8, 0);
  const relatedWeight = related.reduce((sum, e) => sum + e.relevanceScore * 0.3, 0);
  
  const totalWeight = supportingWeight + contradictingWeight + relatedWeight;
  
  // Calculate confidence based on supporting evidence ratio
  let confidence: number;
  if (totalWeight === 0) {
    confidence = 0;
  } else if (contradictingWeight > supportingWeight) {
    // More contradicting than supporting evidence
    confidence = 0.2 * (supportingWeight / totalWeight);
  } else {
    // More supporting than contradicting evidence
    confidence = (supportingWeight - contradictingWeight * 0.5) / totalWeight;
  }
  
  // Apply quantity bonus (more evidence = more confidence, up to a point)
  const quantityBonus = Math.min(0.2, totalEvidence * 0.02);
  confidence = Math.min(1, confidence + quantityBonus);
  
  // Determine label
  let label: 'high' | 'medium' | 'low' | 'none';
  if (confidence >= 0.7) label = 'high';
  else if (confidence >= 0.4) label = 'medium';
  else if (confidence > 0) label = 'low';
  else label = 'none';
  
  return { confidence, label };
}

/**
 * Generate a human-readable summary of the verification result.
 */
function generateVerificationSummary(
  claim: string,
  supporting: EvidenceHit[],
  contradicting: EvidenceHit[],
  related: EvidenceHit[],
  confidence: number,
  label: string
): string {
  const total = supporting.length + contradicting.length + related.length;
  
  if (total === 0) {
    return `No evidence found for: "${claim.slice(0, 50)}${claim.length > 50 ? '...' : ''}"`;
  }
  
  const parts: string[] = [];
  parts.push(`Found ${total} piece(s) of evidence (confidence: ${label})`);
  
  if (supporting.length > 0) {
    parts.push(`${supporting.length} supporting`);
  }
  if (contradicting.length > 0) {
    parts.push(`${contradicting.length} potentially contradicting`);
  }
  if (related.length > 0 && supporting.length + contradicting.length === 0) {
    parts.push(`${related.length} related but inconclusive`);
  }
  
  return parts.join('; ');
}

/**
 * Verify a claim against the search index.
 * Returns classified evidence with confidence scoring.
 * 
 * This differs from searchIndex by:
 * 1. Classifying results as supporting/contradicting/related
 * 2. Calculating an overall confidence score
 * 3. Providing a human-readable summary
 */
export function verifyClaimInIndex(
  dbPath: string,
  claim: string,
  scope: SearchScope,
  limit: number,
  bundleRoot?: string
): VerificationResult {
  // Get raw search results
  const rawHits = searchIndex(dbPath, claim, scope, limit, bundleRoot);
  
  // Extract tokens from claim for classification
  const claimTokens = tokenizeForSafeQuery(claim);
  
  // Classify each hit
  const supporting: EvidenceHit[] = [];
  const contradicting: EvidenceHit[] = [];
  const related: EvidenceHit[] = [];
  
  for (const hit of rawHits) {
    const { type, score } = classifyEvidence(hit.snippet, claimTokens);
    const evidenceHit: EvidenceHit = {
      ...hit,
      evidenceType: type,
      relevanceScore: score,
    };
    
    switch (type) {
      case 'supporting':
        supporting.push(evidenceHit);
        break;
      case 'contradicting':
        contradicting.push(evidenceHit);
        break;
      case 'related':
        related.push(evidenceHit);
        break;
    }
  }
  
  // Sort each category by relevance score
  supporting.sort((a, b) => b.relevanceScore - a.relevanceScore);
  contradicting.sort((a, b) => b.relevanceScore - a.relevanceScore);
  related.sort((a, b) => b.relevanceScore - a.relevanceScore);
  
  // Calculate confidence
  const { confidence, label } = calculateConfidence(supporting, contradicting, related);
  
  // Generate summary
  const summary = generateVerificationSummary(claim, supporting, contradicting, related, confidence, label);
  
  return {
    claim,
    found: rawHits.length > 0,
    confidence,
    confidenceLabel: label,
    summary,
    supporting,
    contradicting,
    related,
  };
}
