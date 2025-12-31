/**
 * Semantic search module for preflight-mcp (optional feature).
 * 
 * Provides vector-based semantic search using SQLite for storage.
 * Works alongside existing FTS5 search - does not replace it.
 * 
 * Enable via PREFLIGHT_SEMANTIC_SEARCH=true
 * 
 * Design principles:
 * - Zero external vector database dependency (uses SQLite)
 * - Optional feature - disabled by default
 * - Compatible with existing SearchHit types
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { BaseEmbedding } from '../embedding/base.js';
import type { EmbeddingDocument, SemanticSearchHit } from '../embedding/types.js';

/**
 * Semantic search index configuration.
 */
export type SemanticIndexConfig = {
  /** Embedding dimension (auto-detected from provider) */
  dimension: number;
  /** Embedding provider name (for metadata) */
  provider: string;
  /** Embedding model name (for metadata) */
  model: string;
};

/**
 * Semantic search options.
 */
export type SemanticSearchOptions = {
  /** Maximum results to return */
  limit: number;
  /** Minimum similarity score (0-1) */
  threshold?: number;
  /** Filter by document kind */
  kind?: 'doc' | 'code' | 'all';
  /** Filter by file extensions */
  fileTypeFilters?: string[];
};

/**
 * Calculate cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}

/**
 * Semantic search index manager.
 * 
 * Stores embeddings in SQLite and performs cosine similarity search.
 */
export class SemanticSearchIndex {
  private dbPath: string;
  private db: Database.Database | null = null;
  private config: SemanticIndexConfig | null = null;

  constructor(bundleRoot: string) {
    this.dbPath = path.join(bundleRoot, 'indexes', 'semantic.sqlite3');
  }

  /**
   * Initialize the semantic index database.
   */
  async initialize(config: SemanticIndexConfig): Promise<void> {
    this.config = config;

    // Ensure directory exists
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    // Create tables
    this.db.exec(`
      -- Metadata table
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      -- Embeddings table
      CREATE TABLE IF NOT EXISTS embeddings (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        repo TEXT NOT NULL,
        kind TEXT NOT NULL,
        line_no INTEGER NOT NULL,
        content TEXT NOT NULL,
        vector BLOB NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );

      -- Index for filtering
      CREATE INDEX IF NOT EXISTS idx_embeddings_path ON embeddings(path);
      CREATE INDEX IF NOT EXISTS idx_embeddings_kind ON embeddings(kind);
      CREATE INDEX IF NOT EXISTS idx_embeddings_repo ON embeddings(repo);
    `);

    // Store metadata
    const upsertMeta = this.db.prepare(
      'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'
    );
    upsertMeta.run('dimension', String(config.dimension));
    upsertMeta.run('provider', config.provider);
    upsertMeta.run('model', config.model);
    upsertMeta.run('updated_at', new Date().toISOString());
  }

  /**
   * Check if the index exists and is valid.
   */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.dbPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Open existing index (read-only mode for search).
   */
  async open(): Promise<boolean> {
    try {
      await fs.access(this.dbPath);
      this.db = new Database(this.dbPath, { readonly: true });

      // Load metadata
      const getMeta = this.db.prepare('SELECT value FROM meta WHERE key = ?');
      const dimension = getMeta.get('dimension') as { value: string } | undefined;
      const provider = getMeta.get('provider') as { value: string } | undefined;
      const model = getMeta.get('model') as { value: string } | undefined;

      if (dimension && provider && model) {
        this.config = {
          dimension: parseInt(dimension.value, 10),
          provider: provider.value,
          model: model.value,
        };
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Add documents to the index.
   */
  async addDocuments(
    documents: EmbeddingDocument[],
    embedding: BaseEmbedding
  ): Promise<number> {
    if (!this.db || documents.length === 0) return 0;

    // Generate embeddings in batches
    const batchSize = 50;
    let indexed = 0;

    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO embeddings (id, path, repo, kind, line_no, content, vector)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((docs: EmbeddingDocument[], vectors: number[][]) => {
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i]!;
        const vector = vectors[i]!;
        // Store vector as binary blob (Float32Array)
        const buffer = Buffer.from(new Float32Array(vector).buffer);
        insert.run(doc.id, doc.path, doc.repo, doc.kind, doc.lineNo, doc.content, buffer);
      }
    });

    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);
      const contents = batch.map((d) => d.content);

      try {
        const embeddings = await embedding.embedBatch(contents);
        const vectors = embeddings.map((e) => e.vector);
        insertMany(batch, vectors);
        indexed += batch.length;
      } catch (error) {
        console.error(`[SemanticSearch] Failed to embed batch: ${error}`);
      }
    }

    return indexed;
  }

  /**
   * Search for similar documents.
   */
  async search(
    query: string,
    embedding: BaseEmbedding,
    options: SemanticSearchOptions
  ): Promise<SemanticSearchHit[]> {
    if (!this.db) {
      const opened = await this.open();
      if (!opened) return [];
    }

    // Generate query embedding
    const queryEmbedding = await embedding.embed(query);

    // Build filter conditions
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.kind && options.kind !== 'all') {
      conditions.push('kind = ?');
      params.push(options.kind);
    }

    if (options.fileTypeFilters && options.fileTypeFilters.length > 0) {
      const extConditions = options.fileTypeFilters.map(() => 'path LIKE ?');
      conditions.push(`(${extConditions.join(' OR ')})`);
      for (const ext of options.fileTypeFilters) {
        params.push(`%${ext}`);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Fetch all matching documents (we need to compute similarity in JS)
    // Note: For large indexes, consider using approximate nearest neighbor
    const stmt = this.db!.prepare(`
      SELECT id, path, repo, kind, line_no, content, vector
      FROM embeddings
      ${whereClause}
    `);

    const rows = (params.length > 0 ? stmt.all(...params) : stmt.all()) as Array<{
      id: string;
      path: string;
      repo: string;
      kind: 'doc' | 'code';
      line_no: number;
      content: string;
      vector: Buffer;
    }>;

    // Calculate similarity scores
    const results: SemanticSearchHit[] = [];
    const threshold = options.threshold ?? 0;

    for (const row of rows) {
      // Convert buffer back to float array
      const storedVector = Array.from(new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4));
      const score = cosineSimilarity(queryEmbedding.vector, storedVector);

      if (score >= threshold) {
        results.push({
          path: row.path,
          repo: row.repo,
          kind: row.kind,
          lineNo: row.line_no,
          content: row.content,
          score,
        });
      }
    }

    // Sort by score (descending) and limit
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, options.limit);
  }

  /**
   * Get index statistics.
   */
  getStats(): { totalDocuments: number; dimension: number; provider: string; model: string } | null {
    if (!this.db || !this.config) return null;

    const count = this.db.prepare('SELECT COUNT(*) as count FROM embeddings').get() as { count: number };

    return {
      totalDocuments: count.count,
      dimension: this.config.dimension,
      provider: this.config.provider,
      model: this.config.model,
    };
  }

  /**
   * Clear all documents from the index.
   */
  clear(): void {
    if (!this.db) return;
    this.db.exec('DELETE FROM embeddings');
  }

  /**
   * Delete the index file.
   */
  async delete(): Promise<void> {
    this.close();
    try {
      await fs.unlink(this.dbPath);
      await fs.unlink(this.dbPath + '-wal').catch(() => {});
      await fs.unlink(this.dbPath + '-shm').catch(() => {});
    } catch {
      // Ignore if file doesn't exist
    }
  }
}

/**
 * Check if semantic search is available for a bundle.
 */
export async function hasSemanticIndex(bundleRoot: string): Promise<boolean> {
  const index = new SemanticSearchIndex(bundleRoot);
  return index.exists();
}
