/**
 * Semantic search module for preflight-mcp (optional feature).
 *
 * Provides vector-based semantic search using SQLite for storage.
 * Works alongside existing FTS5 search - does not replace it.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { BaseEmbedding } from '../embedding/base.js';
import type { SemanticSearchHit } from '../embedding/types.js';

export type SemanticIndexConfig = {
  schemaVersion: 3;
  dimension: number;
  provider: string;
  model: string;
  endpoint?: string;
  authMode?: string;
};

/**
 * Modal content types for filtering semantic search.
 */
export type ModalContentKind = 'formula' | 'table' | 'code_block' | 'image' | 'diagram';

/**
 * Card content types for filtering semantic search.
 */
export type CardContentKind = 'summary' | 'use_case' | 'design' | 'limitation' | 'quickstart' | 'api' | 'annotation';

export type SemanticSearchOptions = {
  limit: number;
  threshold?: number;
  /** Filter by content kind: doc, code, modal, card, or all */
  kind?: 'doc' | 'code' | 'modal' | 'card' | 'all';
  fileTypeFilters?: string[];
  /** Filter modal content by specific types (only when kind='modal') */
  modalTypes?: ModalContentKind[];
  /** Include modal content in results when kind='all' (default: true) */
  includeModal?: boolean;
  /** Filter card content by specific types (only when kind='card') */
  cardTypes?: CardContentKind[];
  /** Include card content in results when kind='all' (default: true) */
  includeCard?: boolean;
};

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

export class SemanticSearchIndex {
  private dbPath: string;
  private db: Database.Database | null = null;
  private config: SemanticIndexConfig | null = null;

  constructor(bundleRoot: string) {
    this.dbPath = path.join(bundleRoot, 'indexes', 'semantic.sqlite3');
  }

  getPath(): string {
    return this.dbPath;
  }

  getConfig(): SemanticIndexConfig | null {
    return this.config;
  }

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.dbPath);
      return true;
    } catch {
      return false;
    }
  }

  async open(opts?: { readonly?: boolean }): Promise<boolean> {
    const readonly = opts?.readonly ?? true;

    try {
      await fs.access(this.dbPath);
      this.db = new Database(this.dbPath, { readonly });

      const getMeta = this.db.prepare('SELECT value FROM meta WHERE key = ?');

      const schemaVersion = getMeta.get('schema_version') as { value: string } | undefined;
      const dimension = getMeta.get('dimension') as { value: string } | undefined;
      const provider = getMeta.get('provider') as { value: string } | undefined;
      const model = getMeta.get('model') as { value: string } | undefined;
      const endpoint = getMeta.get('endpoint') as { value: string } | undefined;
      const authMode = getMeta.get('auth_mode') as { value: string } | undefined;

      if (!schemaVersion || !dimension || !provider || !model) return false;
      if (parseInt(schemaVersion.value, 10) !== 3) return false;

      this.config = {
        schemaVersion: 3,
        dimension: parseInt(dimension.value, 10),
        provider: provider.value,
        model: model.value,
        endpoint: endpoint?.value,
        authMode: authMode?.value,
      };

      return true;
    } catch {
      return false;
    }
  }

  async initialize(config: Omit<SemanticIndexConfig, 'schemaVersion'> & { schemaVersion?: 3 }): Promise<void> {
    const cfg: SemanticIndexConfig = {
      schemaVersion: 3,
      dimension: config.dimension,
      provider: config.provider,
      model: config.model,
      endpoint: config.endpoint,
      authMode: config.authMode,
    };

    this.config = cfg;

    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      -- File-level metadata for incremental updates
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        kind TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_files_kind ON files(kind);
      CREATE INDEX IF NOT EXISTS idx_files_repo ON files(repo);

      -- Chunk embeddings
      CREATE TABLE IF NOT EXISTS embeddings (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        repo TEXT NOT NULL,
        kind TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        vector BLOB NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_embeddings_path ON embeddings(path);
      CREATE INDEX IF NOT EXISTS idx_embeddings_kind ON embeddings(kind);
      CREATE INDEX IF NOT EXISTS idx_embeddings_repo ON embeddings(repo);
    `);

    const upsertMeta = this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    upsertMeta.run('schema_version', String(cfg.schemaVersion));
    upsertMeta.run('dimension', String(cfg.dimension));
    upsertMeta.run('provider', cfg.provider);
    upsertMeta.run('model', cfg.model);
    if (cfg.endpoint) upsertMeta.run('endpoint', cfg.endpoint);
    if (cfg.authMode) upsertMeta.run('auth_mode', cfg.authMode);
    upsertMeta.run('updated_at', new Date().toISOString());
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async delete(): Promise<void> {
    this.close();
    try {
      await fs.unlink(this.dbPath);
      await fs.unlink(this.dbPath + '-wal').catch(() => {});
      await fs.unlink(this.dbPath + '-shm').catch(() => {});
    } catch {
      // ignore
    }
  }

  async search(query: string, embedding: BaseEmbedding, options: SemanticSearchOptions): Promise<SemanticSearchHit[]> {
    if (!this.db) {
      const opened = await this.open({ readonly: true });
      if (!opened) return [];
    }

    const queryEmbedding = await embedding.embed(query);

    const conditions: string[] = [];
    const params: unknown[] = [];

    // Handle kind filtering with modal/card support
    if (options.kind && options.kind !== 'all') {
      if (options.kind === 'modal') {
        // Filter for modal content (kind starts with 'modal_')
        if (options.modalTypes && options.modalTypes.length > 0) {
          // Filter specific modal types
          const modalConditions = options.modalTypes.map(() => 'kind = ?');
          conditions.push(`(${modalConditions.join(' OR ')})`);
          for (const modalType of options.modalTypes) {
            params.push(`modal_${modalType}`);
          }
        } else {
          // All modal content
          conditions.push("kind LIKE 'modal_%'");
        }
      } else if (options.kind === 'card') {
        // Filter for card content (kind starts with 'card_')
        if (options.cardTypes && options.cardTypes.length > 0) {
          // Filter specific card types
          const cardConditions = options.cardTypes.map(() => 'kind = ?');
          conditions.push(`(${cardConditions.join(' OR ')})`);
          for (const cardType of options.cardTypes) {
            params.push(`card_${cardType}`);
          }
        } else {
          // All card content
          conditions.push("kind LIKE 'card_%'");
        }
      } else {
        // Regular doc/code filter
        conditions.push('kind = ?');
        params.push(options.kind);
      }
    } else if (options.kind === 'all') {
      // Handle exclusions for 'all' mode
      const exclusions: string[] = [];
      if (options.includeModal === false) {
        exclusions.push("kind NOT LIKE 'modal_%'");
      }
      if (options.includeCard === false) {
        exclusions.push("kind NOT LIKE 'card_%'");
      }
      if (exclusions.length > 0) {
        conditions.push(`(${exclusions.join(' AND ')})`);
      }
    }

    if (options.fileTypeFilters && options.fileTypeFilters.length > 0) {
      const extConditions = options.fileTypeFilters.map(() => 'path LIKE ?');
      conditions.push(`(${extConditions.join(' OR ')})`);
      for (const ext of options.fileTypeFilters) {
        params.push(`%${ext}`);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const stmt = this.db!.prepare(`
      SELECT path, repo, kind, start_line, end_line, content, vector
      FROM embeddings
      ${whereClause}
    `);

    const rows = (params.length > 0 ? stmt.all(...params) : stmt.all()) as Array<{
      path: string;
      repo: string;
      kind: 'doc' | 'code';
      start_line: number;
      end_line: number;
      content: string;
      vector: Buffer;
    }>;

    const results: SemanticSearchHit[] = [];
    const threshold = options.threshold ?? 0;

    for (const row of rows) {
      const storedVector = Array.from(
        new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4)
      );
      const score = cosineSimilarity(queryEmbedding.vector, storedVector);
      if (score < threshold) continue;

      results.push({
        path: row.path,
        repo: row.repo,
        kind: row.kind,
        startLine: row.start_line,
        endLine: row.end_line,
        content: row.content,
        score,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, options.limit);
  }
}

export async function hasSemanticIndex(bundleRoot: string): Promise<boolean> {
  const index = new SemanticSearchIndex(bundleRoot);
  return index.exists();
}
