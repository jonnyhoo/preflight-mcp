/**
 * Bridge Types for Distill → ChromaDB bridging.
 * @module bridge/types
 */

import type { ChunkType, SourceType } from '../vectordb/types.js';

// ============================================================================
// Semantic Chunk Types
// ============================================================================

export interface SemanticChunk {
  id: string;
  content: string;
  chunkType: ChunkType;
  /** Whether the chunk is semantically complete (no dangling references) */
  isComplete: boolean;
  metadata: SemanticChunkMetadata;
}

export interface SemanticChunkMetadata {
  sourceType: SourceType;
  bundleId: string;
  repoId?: string;
  filePath?: string;
  pageIndex?: number;
  chunkIndex: number;
  /** Original field name in RepoCard (e.g., 'oneLiner', 'useCases') */
  fieldName?: string;
  /** Section heading if applicable */
  sectionHeading?: string;
}

// ============================================================================
// Bridge Source Types
// ============================================================================

export type BridgeSource =
  | { type: 'repocard'; bundleId: string; repoId: string; cardPath: string }
  | { type: 'readme'; bundleId: string; repoId: string; readmePath: string }
  | { type: 'overview'; bundleId: string; overviewPath: string }
  | { type: 'pdf'; bundleId: string; repoId?: string; markdown: string; filePath?: string }
  | { type: 'web'; bundleId: string; markdown: string; url?: string };

export interface BridgeOptions {
  /** Embedding provider instance */
  embedding: {
    embedBatch(texts: string[]): Promise<Array<{ vector: number[] }>>;
  };
  /** Max tokens per chunk (approx) */
  maxChunkTokens?: number;
  /** Min tokens per chunk (avoid tiny chunks) */
  minChunkTokens?: number;
}

export interface BridgeResult {
  chunksWritten: number;
  chunksByType: Record<ChunkType, number>;
  errors: string[];
}

// ============================================================================
// Indexable Files (from manifest.json)
// ============================================================================

export interface IndexableRepo {
  repoId: string;
  /** Path to cards/xxx/CARD.json */
  cardPath: string | null;
  /** Path to repos/xxx/norm/README.md */
  readmePath: string | null;
}

export interface IndexableFiles {
  /** Bundle root OVERVIEW.md */
  overviewPath: string | null;
  /** All repos in the bundle */
  repos: IndexableRepo[];
}

// ============================================================================
// Chunker Options
// ============================================================================

export interface ChunkOptions {
  sourceType: SourceType;
  bundleId: string;
  repoId?: string;
  filePath?: string;
  /** Max tokens per chunk (default: 512) */
  maxTokens?: number;
  /** Min tokens per chunk (default: 50) */
  minTokens?: number;
}

export const DEFAULT_CHUNK_OPTIONS = {
  maxTokens: 512,
  minTokens: 50,
};
