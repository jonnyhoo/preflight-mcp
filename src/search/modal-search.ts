/**
 * Multimodal Content Search
 *
 * Functions for indexing and searching multimodal content
 * (images, tables, equations, diagrams) in bundles.
 *
 * @module search/modal-search
 */
import fsSync from 'node:fs';
import Database from 'better-sqlite3';
import { buildFtsQuery } from './sqliteFts.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Supported modal content types for indexing.
 */
export type ModalContentKind = 'image' | 'table' | 'equation' | 'diagram';

/**
 * Search scope for multimodal content.
 */
export type ModalSearchScope = 'all' | ModalContentKind;

/**
 * A multimodal content item to be indexed.
 */
export interface ModalIndexItem {
  /** Source document path */
  sourcePath: string;
  /** Repository ID */
  repoId: string;
  /** Content type */
  kind: ModalContentKind;
  /** Page number (0-based) if from multi-page document */
  pageIndex?: number;
  /** Description or extracted text */
  description: string;
  /** Entity name for this content */
  entityName?: string;
  /** Keywords for improved search */
  keywords?: string[];
  /** SHA256 hash for deduplication */
  contentHash: string;
}

/**
 * Search result for multimodal content.
 */
export interface ModalSearchHit {
  /** Source document path */
  sourcePath: string;
  /** Repository ID */
  repoId: string;
  /** Content type */
  kind: ModalContentKind;
  /** Page number if applicable */
  pageIndex?: number;
  /** Description snippet with highlights */
  snippet: string;
  /** Entity name */
  entityName?: string;
  /** BM25 relevance score */
  score?: number;
}

// ============================================================================
// Table Management
// ============================================================================

/**
 * Create or update the multimodal content index tables.
 */
export function ensureModalTables(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    
    // Create FTS5 table for modal content descriptions
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS modal_content USING fts5(
        description,
        source_path UNINDEXED,
        repo_id UNINDEXED,
        kind UNINDEXED,
        page_index UNINDEXED,
        entity_name UNINDEXED,
        content_hash UNINDEXED,
        tokenize='unicode61'
      );
    `);
    
    // Create regular table for keywords (separate for flexible querying)
    db.exec(`
      CREATE TABLE IF NOT EXISTS modal_keywords (
        content_hash TEXT NOT NULL,
        keyword TEXT NOT NULL,
        PRIMARY KEY (content_hash, keyword)
      );
    `);
    
    // Create index for fast keyword lookups
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_modal_keywords_keyword ON modal_keywords(keyword);
    `);
  } finally {
    db.close();
  }
}

// ============================================================================
// Indexing
// ============================================================================

/**
 * Index multimodal content items.
 */
export function indexModalContent(
  dbPath: string,
  items: ModalIndexItem[]
): { indexed: number; skipped: number } {
  if (items.length === 0) {
    return { indexed: 0, skipped: 0 };
  }
  
  const db = new Database(dbPath);
  let indexed = 0;
  let skipped = 0;
  
  try {
    db.pragma('journal_mode = WAL');
    
    // Ensure tables exist
    ensureModalTables(dbPath);
    
    const insertContent = db.prepare(`
      INSERT OR REPLACE INTO modal_content 
      (description, source_path, repo_id, kind, page_index, entity_name, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    const insertKeyword = db.prepare(`
      INSERT OR IGNORE INTO modal_keywords (content_hash, keyword) VALUES (?, ?)
    `);
    
    const checkExists = db.prepare(`
      SELECT content_hash FROM modal_content WHERE content_hash = ?
    `);
    
    const transaction = db.transaction((contentItems: ModalIndexItem[]) => {
      for (const item of contentItems) {
        // Skip if already indexed with same hash
        const existing = checkExists.get(item.contentHash) as { content_hash: string } | undefined;
        if (existing) {
          skipped++;
          continue;
        }
        
        // Insert main content
        insertContent.run(
          item.description,
          item.sourcePath,
          item.repoId,
          item.kind,
          item.pageIndex ?? null,
          item.entityName ?? null,
          item.contentHash
        );
        
        // Insert keywords
        if (item.keywords && item.keywords.length > 0) {
          for (const keyword of item.keywords) {
            insertKeyword.run(item.contentHash, keyword.toLowerCase());
          }
        }
        
        indexed++;
      }
    });
    
    transaction(items);
    
    return { indexed, skipped };
  } finally {
    db.close();
  }
}

// ============================================================================
// Search
// ============================================================================

/**
 * Search multimodal content.
 */
export function searchModalContent(
  dbPath: string,
  query: string,
  options: {
    scope?: ModalSearchScope;
    limit?: number;
    includeScore?: boolean;
  } = {}
): ModalSearchHit[] {
  const { scope = 'all', limit = 20, includeScore = false } = options;
  
  // Check if database file exists before opening in readonly mode
  if (!fsSync.existsSync(dbPath)) {
    return [];
  }
  
  const db = new Database(dbPath, { readonly: true });
  try {
    // Check if modal_content table exists
    const tableExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='modal_content'`
    ).get() as { name: string } | undefined;
    
    if (!tableExists) {
      return [];
    }
    
    const ftsQuery = buildFtsQuery(query);
    const whereKind = scope !== 'all' ? `AND kind = '${scope}'` : '';
    
    const stmt = db.prepare(`
      SELECT
        source_path,
        repo_id,
        kind,
        page_index,
        entity_name,
        snippet(modal_content, 0, '[', ']', '…', 15) AS snippet,
        bm25(modal_content) AS score
      FROM modal_content
      WHERE modal_content MATCH ? ${whereKind}
      ORDER BY bm25(modal_content)
      LIMIT ?
    `);
    
    const rows = stmt.all(ftsQuery, limit) as Array<{
      source_path: string;
      repo_id: string;
      kind: ModalContentKind;
      page_index: number | null;
      entity_name: string | null;
      snippet: string;
      score: number;
    }>;
    
    return rows.map(r => ({
      sourcePath: r.source_path,
      repoId: r.repo_id,
      kind: r.kind,
      pageIndex: r.page_index ?? undefined,
      snippet: r.snippet,
      entityName: r.entity_name ?? undefined,
      score: includeScore ? r.score : undefined,
    }));
  } finally {
    db.close();
  }
}

/**
 * Search multimodal content by keywords.
 */
export function searchModalByKeywords(
  dbPath: string,
  keywords: string[],
  options: {
    scope?: ModalSearchScope;
    limit?: number;
  } = {}
): ModalSearchHit[] {
  const { scope = 'all', limit = 20 } = options;
  
  if (keywords.length === 0) {
    return [];
  }
  
  // Check if database file exists before opening in readonly mode
  if (!fsSync.existsSync(dbPath)) {
    return [];
  }
  
  const db = new Database(dbPath, { readonly: true });
  try {
    // Check if tables exist
    const tableExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='modal_keywords'`
    ).get() as { name: string } | undefined;
    
    if (!tableExists) {
      return [];
    }
    
    const whereKind = scope !== 'all' ? `AND c.kind = '${scope}'` : '';
    const placeholders = keywords.map(() => '?').join(', ');
    
    const stmt = db.prepare(`
      SELECT DISTINCT
        c.source_path,
        c.repo_id,
        c.kind,
        c.page_index,
        c.entity_name,
        c.description AS snippet
      FROM modal_content c
      INNER JOIN modal_keywords k ON c.content_hash = k.content_hash
      WHERE k.keyword IN (${placeholders}) ${whereKind}
      LIMIT ?
    `);
    
    const normalizedKeywords = keywords.map(k => k.toLowerCase());
    const rows = stmt.all(...normalizedKeywords, limit) as Array<{
      source_path: string;
      repo_id: string;
      kind: ModalContentKind;
      page_index: number | null;
      entity_name: string | null;
      snippet: string;
    }>;
    
    return rows.map(r => ({
      sourcePath: r.source_path,
      repoId: r.repo_id,
      kind: r.kind,
      pageIndex: r.page_index ?? undefined,
      snippet: r.snippet.slice(0, 200) + (r.snippet.length > 200 ? '…' : ''),
      entityName: r.entity_name ?? undefined,
    }));
  } finally {
    db.close();
  }
}

// ============================================================================
// Statistics
// ============================================================================

/**
 * Get modal content statistics for a database.
 */
export function getModalContentStats(dbPath: string): {
  totalItems: number;
  byKind: Record<ModalContentKind, number>;
  uniqueDocuments: number;
} {
  // Check if database file exists before opening in readonly mode
  if (!fsSync.existsSync(dbPath)) {
    return {
      totalItems: 0,
      byKind: { image: 0, table: 0, equation: 0, diagram: 0 },
      uniqueDocuments: 0,
    };
  }
  
  const db = new Database(dbPath, { readonly: true });
  try {
    const tableExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='modal_content'`
    ).get() as { name: string } | undefined;
    
    if (!tableExists) {
      return {
        totalItems: 0,
        byKind: { image: 0, table: 0, equation: 0, diagram: 0 },
        uniqueDocuments: 0,
      };
    }
    
    const total = db.prepare('SELECT COUNT(*) as count FROM modal_content').get() as { count: number };
    const byKindRows = db.prepare(
      'SELECT kind, COUNT(*) as count FROM modal_content GROUP BY kind'
    ).all() as Array<{ kind: ModalContentKind; count: number }>;
    const uniqueDocs = db.prepare(
      'SELECT COUNT(DISTINCT source_path) as count FROM modal_content'
    ).get() as { count: number };
    
    const byKind: Record<ModalContentKind, number> = {
      image: 0,
      table: 0,
      equation: 0,
      diagram: 0,
    };
    
    for (const row of byKindRows) {
      byKind[row.kind] = row.count;
    }
    
    return {
      totalItems: total.count,
      byKind,
      uniqueDocuments: uniqueDocs.count,
    };
  } finally {
    db.close();
  }
}
