/**
 * Modal Content Indexer for Semantic Search.
 *
 * Bridges VLM extraction results (formulas, tables, code blocks) and
 * ModalProcessingService results to the SemanticSearchIndex.
 *
 * This enables semantic search over:
 * - Mathematical formulas with their descriptions
 * - Tables with their captions and content
 * - Code blocks extracted from PDFs
 * - Images with their VLM-generated descriptions
 *
 * @module distill/modal-indexer
 */

import path from 'node:path';
import Database from 'better-sqlite3';

import type { BaseEmbedding } from '../embedding/base.js';
import type { ProcessedModalItem, ModalServiceResult } from '../modal/service.js';
import type { ContextConfig } from '../modal/types.js';
import { ContextExtractor } from '../modal/context-extractor.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('modal-indexer');

// ============================================================================
// Types
// ============================================================================

/**
 * Modal chunk type for indexing.
 * Extends the base 'doc' | 'code' with modal-specific types.
 */
export type ModalChunkKind = 'formula' | 'table' | 'code_block' | 'image' | 'diagram';

/**
 * A chunk ready for embedding and indexing.
 */
export interface ModalChunk {
  /** Unique identifier for this chunk */
  id: string;
  /** Source file path (relative to bundle) */
  path: string;
  /** Repository ID */
  repo: string;
  /** Chunk kind */
  kind: ModalChunkKind;
  /** Page index (1-based for display, stored as-is) */
  pageIndex: number;
  /** Content to embed (description + context) */
  content: string;
  /** Raw extracted content (latex, markdown, code) */
  rawContent: string;
  /** Optional description from VLM */
  description?: string;
  /** Optional caption */
  caption?: string;
  /** Source content for context extraction */
  contextSource?: unknown;
}

/**
 * Options for indexing modal content.
 */
export interface ModalIndexOptions {
  /** Bundle root directory */
  bundleRootDir: string;
  /** Repository ID */
  repoId: string;
  /** Source PDF path (relative to bundle) */
  sourcePath: string;
  /** Embedding provider */
  embedding: BaseEmbedding;
  /** Context extraction config */
  contextConfig?: Partial<ContextConfig>;
  /** Full document content for context extraction */
  documentContent?: unknown;
  /** Batch size for embedding calls */
  batchSize?: number;
}

/**
 * Result of modal indexing operation.
 */
export interface ModalIndexResult {
  ok: boolean;
  chunksWritten: number;
  chunksEmbedded: number;
  byKind: Record<ModalChunkKind, number>;
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
function generateChunkId(sourcePath: string, kind: ModalChunkKind, pageIndex: number, index: number): string {
  return `modal:${sourcePath}:${kind}:p${pageIndex}:${index}`;
}

/**
 * Truncate content to reasonable length for embedding.
 */
function truncateForEmbedding(content: string, maxChars: number = 8000): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + '...';
}

/**
 * Build embedding content from modal item.
 * Combines description, raw content, caption, and context.
 */
function buildEmbeddingContent(chunk: ModalChunk, context?: string): string {
  const parts: string[] = [];

  // Add type indicator for better semantic matching
  const typeLabels: Record<ModalChunkKind, string> = {
    formula: '[Mathematical Formula]',
    table: '[Data Table]',
    code_block: '[Code Block]',
    image: '[Image/Figure]',
    diagram: '[Diagram]',
  };
  parts.push(typeLabels[chunk.kind]);

  // Add caption if available
  if (chunk.caption) {
    parts.push(`Caption: ${chunk.caption}`);
  }

  // Add description (VLM generated)
  if (chunk.description) {
    parts.push(`Description: ${chunk.description}`);
  }

  // Add raw content based on type
  if (chunk.kind === 'formula' && chunk.rawContent) {
    parts.push(`LaTeX: ${chunk.rawContent}`);
  } else if (chunk.kind === 'table' && chunk.rawContent) {
    // Truncate large tables
    const tableContent = chunk.rawContent.length > 2000
      ? chunk.rawContent.slice(0, 2000) + '\n[Table truncated...]'
      : chunk.rawContent;
    parts.push(`Table Content:\n${tableContent}`);
  } else if (chunk.kind === 'code_block' && chunk.rawContent) {
    const codeContent = chunk.rawContent.length > 1500
      ? chunk.rawContent.slice(0, 1500) + '\n// [Code truncated...]'
      : chunk.rawContent;
    parts.push(`Code:\n${codeContent}`);
  }

  // Add surrounding context
  if (context) {
    parts.push(`Context: ${context}`);
  }

  return truncateForEmbedding(parts.join('\n\n'));
}

// ============================================================================
// Modal Service Result to Chunks Converter
// ============================================================================

/**
 * Convert ModalServiceResult to indexable chunks.
 */
export function modalServiceResultToChunks(
  result: ModalServiceResult,
  options: {
    repoId: string;
    sourcePath: string;
  }
): ModalChunk[] {
  const chunks: ModalChunk[] = [];
  const { repoId, sourcePath } = options;

  result.items.forEach((item, idx) => {
    if (!item.success || !item.description) return;

    // Map modal type to chunk kind
    const kindMap: Record<string, ModalChunkKind> = {
      image: 'image',
      table: 'table',
      equation: 'formula',
      diagram: 'diagram',
      code: 'code_block',
    };

    const kind = kindMap[item.type] || 'image';

    const chunk: ModalChunk = {
      id: generateChunkId(sourcePath, kind, 0, idx),
      path: item.path || sourcePath,
      repo: repoId,
      kind,
      pageIndex: 0, // ModalServiceResult doesn't track page
      content: '',
      rawContent: item.extractedText || '',
      description: item.description,
    };

    // Build content including entity info if available
    const parts: string[] = [];

    if (item.entityInfo) {
      parts.push(`[${item.entityInfo.entityType}] ${item.entityInfo.entityName}`);
      parts.push(item.entityInfo.summary);
      if (item.entityInfo.keywords?.length) {
        parts.push(`Keywords: ${item.entityInfo.keywords.join(', ')}`);
      }
    } else {
      parts.push(item.description);
    }

    if (item.extractedText) {
      parts.push(`Content: ${item.extractedText}`);
    }

    chunk.content = truncateForEmbedding(parts.join('\n\n'));
    chunks.push(chunk);
  });

  logger.info('Converted modal service result to chunks', {
    bundleId: result.bundleId,
    totalChunks: chunks.length,
  });

  return chunks;
}

// ============================================================================
// Main Indexer
// ============================================================================

/**
 * Index modal chunks into the semantic search database.
 *
 * This function:
 * 1. Opens/creates the semantic index database
 * 2. Embeds all modal chunks
 * 3. Stores them with 'modal' kind prefix for filtering
 */
export async function indexModalChunks(
  chunks: ModalChunk[],
  options: ModalIndexOptions
): Promise<ModalIndexResult> {
  const startedAt = Date.now();
  const warnings: string[] = [];
  const byKind: Record<ModalChunkKind, number> = {
    formula: 0,
    table: 0,
    code_block: 0,
    image: 0,
    diagram: 0,
  };

  if (chunks.length === 0) {
    return {
      ok: true,
      chunksWritten: 0,
      chunksEmbedded: 0,
      byKind,
      durationMs: Date.now() - startedAt,
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

    // Update meta to indicate modal content is present
    const upsertMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    upsertMeta.run('has_modal_content', 'true');
    upsertMeta.run('modal_indexed_at', new Date().toISOString());

    // Prepare statements
    const insertEmbedding = db.prepare(`
      INSERT OR REPLACE INTO embeddings (id, path, repo, kind, start_line, end_line, content, vector)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const deleteByPath = db.prepare('DELETE FROM embeddings WHERE path = ? AND kind LIKE ?');

    // Remove existing modal embeddings for this source
    deleteByPath.run(options.sourcePath, 'modal_%');

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

          // Use 'modal_' prefix for kind to distinguish from regular doc/code
          const dbKind = `modal_${chunk.kind}`;

          insertEmbedding.run(
            chunk.id,
            chunk.path,
            chunk.repo,
            dbKind,
            chunk.pageIndex, // Use pageIndex as start_line
            chunk.pageIndex, // Use pageIndex as end_line (same for modal)
            chunk.content,
            vectorToBlob(embedding.vector)
          );

          byKind[chunk.kind]++;
          chunksWritten++;
        }
      });

      insertTx();

      logger.debug('Indexed modal batch', {
        batch: i / batchSize + 1,
        totalBatches: Math.ceil(chunks.length / batchSize),
        chunksInBatch: batch.length,
      });
    }

    db.close();
    db = null;

    logger.info('Modal indexing complete', {
      source: options.sourcePath,
      chunksWritten,
      chunksEmbedded,
      byKind,
      durationMs: Date.now() - startedAt,
    });

    return {
      ok: true,
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
    logger.error('Modal indexing failed', err instanceof Error ? err : undefined, {
      source: options.sourcePath,
    });

    return {
      ok: false,
      chunksWritten: 0,
      chunksEmbedded: 0,
      byKind,
      durationMs: Date.now() - startedAt,
      error: message,
    };
  }
}

// ============================================================================
// High-Level API
// ============================================================================

/**
 * Index modal service processing results into semantic search.
 */
export async function indexModalServiceResult(
  result: ModalServiceResult,
  options: ModalIndexOptions
): Promise<ModalIndexResult> {
  const chunks = modalServiceResultToChunks(result, {
    repoId: options.repoId,
    sourcePath: options.sourcePath,
  });

  return indexModalChunks(chunks, options);
}
