/**
 * RepoCard Indexer for Semantic Search.
 *
 * Bridges RepoCard to the SemanticSearchIndex, enabling semantic search over:
 * - Project summaries (oneLiner, problemSolved)
 * - Use cases and design highlights
 * - Quick start guides and API references
 * - User annotations (whyIChoseIt, personalNotes)
 *
 * @module distill/card-indexer
 */

import path from 'node:path';
import Database from 'better-sqlite3';

import type { BaseEmbedding } from '../embedding/base.js';
import type { RepoCard } from './types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('card-indexer');

// ============================================================================
// Types
// ============================================================================

/**
 * Card chunk type for indexing.
 * Each field type maps to a semantic search facet.
 */
export type CardChunkKind =
  | 'summary'      // oneLiner + problemSolved combined
  | 'tech_stack'   // language + frameworks for tech-based search
  | 'use_case'     // individual use case
  | 'design'       // individual design highlight
  | 'limitation'   // individual limitation
  | 'quickstart'   // quickStart guide
  | 'api'          // individual API reference
  | 'annotation';  // whyIChoseIt + personalNotes

/**
 * A chunk ready for embedding and indexing.
 */
export interface CardChunk {
  /** Unique identifier for this chunk */
  id: string;
  /** Card ID (source reference) */
  cardId: string;
  /** Bundle ID */
  bundleId: string;
  /** Repository ID */
  repoId: string;
  /** Chunk kind */
  kind: CardChunkKind;
  /** Content to embed */
  content: string;
  /** Index within kind (for arrays like useCases) */
  index: number;
  /** Project name for context */
  projectName: string;
  /** Tags for additional filtering */
  tags: string[];
}

/**
 * Options for indexing a RepoCard.
 */
export interface CardIndexOptions {
  /** Bundle root directory */
  bundleRootDir: string;
  /** Embedding provider */
  embedding: BaseEmbedding;
  /** Whether to include user annotations (whyIChoseIt, personalNotes) */
  includeAnnotations?: boolean;
  /** Batch size for embedding calls */
  batchSize?: number;
}

/**
 * Result of card indexing operation.
 */
export interface CardIndexResult {
  ok: boolean;
  cardId: string;
  chunksWritten: number;
  chunksEmbedded: number;
  byKind: Record<CardChunkKind, number>;
  durationMs: number;
  warnings?: string[];
  error?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert number array to SQLite BLOB.
 */
function vectorToBlob(vector: number[]): Buffer {
  const arr = new Float32Array(vector);
  return Buffer.from(arr.buffer);
}

/**
 * Generate unique chunk ID.
 */
function generateChunkId(cardId: string, kind: CardChunkKind, index: number): string {
  return `card:${cardId}:${kind}:${index}`;
}

/**
 * Truncate content to reasonable length for embedding.
 */
function truncateForEmbedding(content: string, maxChars: number = 8000): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + '...';
}

/**
 * Build embedding content with context prefix.
 */
function buildEmbeddingContent(
  projectName: string,
  kind: CardChunkKind,
  content: string,
  tags: string[]
): string {
  const typeLabels: Record<CardChunkKind, string> = {
    summary: '[Project Summary]',
    tech_stack: '[Tech Stack]',
    use_case: '[Use Case]',
    design: '[Design Highlight]',
    limitation: '[Limitation]',
    quickstart: '[Quick Start Guide]',
    api: '[API Reference]',
    annotation: '[Personal Notes]',
  };

  const parts: string[] = [
    `${typeLabels[kind]} ${projectName}`,
    content,
  ];

  if (tags.length > 0) {
    parts.push(`Tags: ${tags.join(', ')}`);
  }

  return truncateForEmbedding(parts.join('\n\n'));
}

// ============================================================================
// RepoCard to Chunks Converter
// ============================================================================

/**
 * Convert a RepoCard to indexable chunks.
 *
 * Strategy:
 * - summary: Combine oneLiner + problemSolved for main semantic entry
 * - use_case: Each use case as separate chunk for granular search
 * - design: Each design highlight as separate chunk
 * - limitation: Each limitation as separate chunk
 * - quickstart: Full quickStart as single chunk
 * - api: Each API as separate chunk
 * - annotation: User notes combined (optional)
 */
export function repoCardToChunks(
  card: RepoCard,
  options?: { includeAnnotations?: boolean }
): CardChunk[] {
  const chunks: CardChunk[] = [];
  const { includeAnnotations = true } = options || {};

  const baseProps = {
    cardId: card.cardId,
    bundleId: card.bundleId,
    repoId: card.repoId,
    projectName: card.name,
    tags: card.tags || [],
  };

  // Summary chunk: oneLiner + problemSolved
  if (card.oneLiner || card.problemSolved) {
    const summaryContent = [
      card.oneLiner,
      card.problemSolved ? `Problem solved: ${card.problemSolved}` : '',
    ].filter(Boolean).join('\n\n');

    chunks.push({
      ...baseProps,
      id: generateChunkId(card.cardId, 'summary', 0),
      kind: 'summary',
      content: buildEmbeddingContent(card.name, 'summary', summaryContent, card.tags || []),
      index: 0,
    });
  }

  // Tech stack chunk: language + frameworks for technology-based search
  if (card.language || card.frameworks?.length) {
    const techParts: string[] = [];
    if (card.language && card.language !== 'Unknown') {
      techParts.push(`Language: ${card.language}`);
    }
    if (card.frameworks?.length) {
      techParts.push(`Frameworks: ${card.frameworks.join(', ')}`);
    }

    if (techParts.length > 0) {
      chunks.push({
        ...baseProps,
        id: generateChunkId(card.cardId, 'tech_stack', 0),
        kind: 'tech_stack',
        content: buildEmbeddingContent(card.name, 'tech_stack', techParts.join('\n'), card.tags || []),
        index: 0,
      });
    }
  }

  // Use case chunks
  if (card.useCases?.length) {
    card.useCases.forEach((useCase, idx) => {
      if (useCase.trim()) {
        chunks.push({
          ...baseProps,
          id: generateChunkId(card.cardId, 'use_case', idx),
          kind: 'use_case',
          content: buildEmbeddingContent(card.name, 'use_case', useCase, card.tags || []),
          index: idx,
        });
      }
    });
  }

  // Design highlight chunks
  if (card.designHighlights?.length) {
    card.designHighlights.forEach((highlight, idx) => {
      if (highlight.trim()) {
        chunks.push({
          ...baseProps,
          id: generateChunkId(card.cardId, 'design', idx),
          kind: 'design',
          content: buildEmbeddingContent(card.name, 'design', highlight, card.tags || []),
          index: idx,
        });
      }
    });
  }

  // Limitation chunks
  if (card.limitations?.length) {
    card.limitations.forEach((limitation, idx) => {
      if (limitation.trim()) {
        chunks.push({
          ...baseProps,
          id: generateChunkId(card.cardId, 'limitation', idx),
          kind: 'limitation',
          content: buildEmbeddingContent(card.name, 'limitation', limitation, card.tags || []),
          index: idx,
        });
      }
    });
  }

  // Quick start chunk
  if (card.quickStart?.trim()) {
    chunks.push({
      ...baseProps,
      id: generateChunkId(card.cardId, 'quickstart', 0),
      kind: 'quickstart',
      content: buildEmbeddingContent(card.name, 'quickstart', card.quickStart, card.tags || []),
      index: 0,
    });
  }

  // API chunks
  if (card.keyAPIs?.length) {
    card.keyAPIs.forEach((api, idx) => {
      if (api.trim()) {
        chunks.push({
          ...baseProps,
          id: generateChunkId(card.cardId, 'api', idx),
          kind: 'api',
          content: buildEmbeddingContent(card.name, 'api', api, card.tags || []),
          index: idx,
        });
      }
    });
  }

  // Annotation chunk (user-provided content)
  if (includeAnnotations) {
    const annotationParts: string[] = [];
    if (card.whyIChoseIt?.trim()) {
      annotationParts.push(`Why I chose it: ${card.whyIChoseIt}`);
    }
    if (card.personalNotes?.trim()) {
      annotationParts.push(`Notes: ${card.personalNotes}`);
    }

    if (annotationParts.length > 0) {
      chunks.push({
        ...baseProps,
        id: generateChunkId(card.cardId, 'annotation', 0),
        kind: 'annotation',
        content: buildEmbeddingContent(card.name, 'annotation', annotationParts.join('\n\n'), card.tags || []),
        index: 0,
      });
    }
  }

  logger.debug('Converted RepoCard to chunks', {
    cardId: card.cardId,
    projectName: card.name,
    totalChunks: chunks.length,
  });

  return chunks;
}

// ============================================================================
// Main Indexer
// ============================================================================

/**
 * Index a RepoCard into the semantic search database.
 *
 * This function:
 * 1. Converts RepoCard to indexable chunks
 * 2. Opens/creates the semantic index database
 * 3. Embeds all chunks
 * 4. Stores them with 'card_' kind prefix for filtering
 */
export async function indexRepoCard(
  card: RepoCard,
  options: CardIndexOptions
): Promise<CardIndexResult> {
  const startedAt = Date.now();
  const warnings: string[] = [];
  const byKind: Record<CardChunkKind, number> = {
    summary: 0,
    tech_stack: 0,
    use_case: 0,
    design: 0,
    limitation: 0,
    quickstart: 0,
    api: 0,
    annotation: 0,
  };

  // Convert card to chunks
  const chunks = repoCardToChunks(card, {
    includeAnnotations: options.includeAnnotations ?? true,
  });

  if (chunks.length === 0) {
    warnings.push('no_indexable_content');
    return {
      ok: true,
      cardId: card.cardId,
      chunksWritten: 0,
      chunksEmbedded: 0,
      byKind,
      durationMs: Date.now() - startedAt,
      warnings,
    };
  }

  const dbPath = path.join(options.bundleRootDir, 'indexes', 'semantic.sqlite3');
  let db: Database.Database | null = null;

  try {
    // Open or create database
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    // Ensure schema exists (compatible with existing semantic index)
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

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

    // Update meta to indicate card content is present
    const upsertMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    upsertMeta.run('has_card_content', 'true');
    upsertMeta.run('card_indexed_at', new Date().toISOString());

    // Prepare statements
    const insertEmbedding = db.prepare(`
      INSERT OR REPLACE INTO embeddings (id, path, repo, kind, start_line, end_line, content, vector)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const deleteByCard = db.prepare('DELETE FROM embeddings WHERE id LIKE ?');

    // Remove existing card embeddings for this card
    deleteByCard.run(`card:${card.cardId}:%`);

    // Embed and insert in batches
    const batchSize = options.batchSize || 32;
    let chunksEmbedded = 0;
    let chunksWritten = 0;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const contents = batch.map(c => c.content);

      // Generate embeddings
      const embeddings = await options.embedding.embedBatch(contents);
      chunksEmbedded += batch.length;

      // Insert into database
      const insertTx = db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j]!;
          const embedding = embeddings[j]!;

          // Use 'card_' prefix for kind to distinguish from doc/code/modal
          const dbKind = `card_${chunk.kind}`;

          // Use cardId as path for card chunks
          insertEmbedding.run(
            chunk.id,
            `card:${chunk.cardId}`,  // Virtual path for card content
            chunk.repoId,
            dbKind,
            chunk.index,  // Use index as start_line
            chunk.index,  // Use index as end_line
            chunk.content,
            vectorToBlob(embedding.vector)
          );

          byKind[chunk.kind]++;
          chunksWritten++;
        }
      });

      insertTx();

      logger.debug('Indexed card batch', {
        cardId: card.cardId,
        batch: i / batchSize + 1,
        totalBatches: Math.ceil(chunks.length / batchSize),
        chunksInBatch: batch.length,
      });
    }

    db.close();
    db = null;

    logger.info('Card indexing complete', {
      cardId: card.cardId,
      projectName: card.name,
      chunksWritten,
      chunksEmbedded,
      byKind,
      durationMs: Date.now() - startedAt,
    });

    return {
      ok: true,
      cardId: card.cardId,
      chunksWritten,
      chunksEmbedded,
      byKind,
      durationMs: Date.now() - startedAt,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (err) {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }

    const message = err instanceof Error ? err.message : String(err);
    logger.error('Card indexing failed', err instanceof Error ? err : undefined, {
      cardId: card.cardId,
    });

    return {
      ok: false,
      cardId: card.cardId,
      chunksWritten: 0,
      chunksEmbedded: 0,
      byKind,
      durationMs: Date.now() - startedAt,
      error: message,
    };
  }
}

/**
 * Remove all indexed content for a RepoCard.
 */
export async function removeCardIndex(
  cardId: string,
  bundleRootDir: string
): Promise<{ ok: boolean; deleted: number; error?: string }> {
  const dbPath = path.join(bundleRootDir, 'indexes', 'semantic.sqlite3');

  try {
    const db = new Database(dbPath);
    const stmt = db.prepare('DELETE FROM embeddings WHERE id LIKE ?');
    const result = stmt.run(`card:${cardId}:%`);
    db.close();

    logger.info('Removed card index', { cardId, deleted: result.changes });

    return { ok: true, deleted: result.changes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to remove card index', err instanceof Error ? err : undefined, { cardId });
    return { ok: false, deleted: 0, error: message };
  }
}

/**
 * Check if a RepoCard is indexed.
 */
export function isCardIndexed(
  cardId: string,
  bundleRootDir: string
): boolean {
  const dbPath = path.join(bundleRootDir, 'indexes', 'semantic.sqlite3');

  try {
    const db = new Database(dbPath);
    const stmt = db.prepare('SELECT COUNT(*) as count FROM embeddings WHERE id LIKE ?');
    const result = stmt.get(`card:${cardId}:%`) as { count: number } | undefined;
    db.close();

    return (result?.count ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Get indexing stats for cards in a bundle.
 */
export function getCardIndexStats(
  bundleRootDir: string
): { totalChunks: number; byKind: Record<string, number>; cardIds: string[] } {
  const dbPath = path.join(bundleRootDir, 'indexes', 'semantic.sqlite3');

  try {
    const db = new Database(dbPath);

    // Count by kind
    const kindStmt = db.prepare(`
      SELECT kind, COUNT(*) as count
      FROM embeddings
      WHERE kind LIKE 'card_%'
      GROUP BY kind
    `);
    const kindResults = kindStmt.all() as Array<{ kind: string; count: number }>;

    // Get unique card IDs
    const cardStmt = db.prepare(`
      SELECT DISTINCT substr(id, 6, instr(substr(id, 6), ':') - 1) as cardId
      FROM embeddings
      WHERE id LIKE 'card:%'
    `);
    const cardResults = cardStmt.all() as Array<{ cardId: string }>;

    db.close();

    const byKind: Record<string, number> = {};
    let totalChunks = 0;
    for (const row of kindResults) {
      byKind[row.kind] = row.count;
      totalChunks += row.count;
    }

    return {
      totalChunks,
      byKind,
      cardIds: cardResults.map(r => r.cardId),
    };
  } catch {
    return { totalChunks: 0, byKind: {}, cardIds: [] };
  }
}
