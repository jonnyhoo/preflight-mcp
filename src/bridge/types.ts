/**
 * Bridge Types for Distill → ChromaDB bridging.
 * @module bridge/types
 */

import type { ChunkDocument, ChunkType, SourceType } from '../vectordb/types.js';

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
  
  // Hierarchical chunking metadata (for semantic PDF chunking)
  /** Markdown heading level (1-6) */
  headingLevel?: number;
  /** Full heading path from root (e.g., ['Introduction', 'Background']) */
  headingPath?: string[];
  /** Parent chunk ID for hierarchical navigation */
  parentChunkId?: string;
  
  // Multi-scale chunking metadata (for best quality retrieval)
  /** Chunk granularity: section, subsection, paragraph, element */
  granularity?: 'section' | 'subsection' | 'paragraph' | 'element';
  /** Asset ID for figures (image filename) */
  assetId?: string;
  /** Page number (1-indexed) where this chunk starts in the PDF */
  pageNumber?: number;
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
  /** Source file SHA256 hash for deduplication */
  contentHash?: string;
  /** Paper identifier (e.g., 'arxiv:2601.14287') */
  paperId?: string;
  /** Paper version (e.g., 'v1') */
  paperVersion?: string;
}

export interface PdfIndexArtifact {
  repoId: string;
  pdfMarkdownPath: string;
  markdown: string;
  preprocessStats?: {
    pageMarkersRemoved: number;
    tablesConverted: number;
    imagesDescribed: number;
    hyphenationsFixed: number;
    processingTimeMs: number;
  };
  chunks: ChunkDocument[];
}

export interface BridgeResult {
  chunksWritten: number;
  chunksByType: Record<ChunkType, number>;
  errors: string[];
  /**
   * Optional PDF artifacts captured during indexing.
   * Used for index-time QA so we can evaluate exactly what we indexed (bundle will be deleted).
   */
  pdfArtifacts?: PdfIndexArtifact[];
}

// ============================================================================
// Indexable Files (from manifest.json)
// ============================================================================

export interface IndexableRepo {
  repoId: string;
  /** Repo kind: 'github' | 'pdf' | 'web' etc. */
  kind?: string;
  /** Path to cards/xxx/CARD.json */
  cardPath: string | null;
  /** Path to repos/xxx/norm/README.md */
  readmePath: string | null;
  /** Path to pdf_{safeRepoId}.md for PDF repos */
  pdfMarkdownPath?: string;
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
