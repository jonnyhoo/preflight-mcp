/**
 * RAG Types for retrieval and generation.
 * @module rag/types
 */

import type { ChunkDocument, EntityDocument } from '../vectordb/types.js';
import type { AstGraphNode } from '../kg/types.js';

// ============================================================================
// Query Options
// ============================================================================

export type QueryMode = 'naive' | 'local' | 'hybrid';

export interface QueryOptions {
  /** Retrieval mode (default: hybrid) */
  mode?: QueryMode;
  /** Number of chunks to retrieve (default: 10) */
  topK?: number;
  /** Enable multi-hop context completion (default: true) */
  enableContextCompletion?: boolean;
  /** Max hops for context completion (default: 2) */
  maxHops?: number;
  /** Enable answer verification (default: false for speed) */
  enableVerification?: boolean;
  /** Retry generation if faithfulness is low */
  retryOnLowFaithfulness?: boolean;
  /** Filter by bundle ID */
  bundleId?: string;
  /** Filter by repo ID */
  repoId?: string;
  
  // Hierarchical retrieval options
  /** Expand to parent chunks when retrieving children (default: false) */
  expandToParent?: boolean;
  /** Expand to sibling chunks at the same level (default: false) */
  expandToSiblings?: boolean;
}

export const DEFAULT_QUERY_OPTIONS: Required<Omit<QueryOptions, 'bundleId' | 'repoId'>> = {
  mode: 'hybrid',
  topK: 10,
  enableContextCompletion: true,
  maxHops: 2,
  enableVerification: false,
  retryOnLowFaithfulness: false,
  expandToParent: true,
  expandToSiblings: true,
};

// ============================================================================
// Retrieval Result
// ============================================================================

export interface RetrieveResult {
  chunks: Array<ChunkDocument & { score: number }>;
  entities?: EntityDocument[];
  expandedTypes?: string[];
}

// ============================================================================
// Generation Result
// ============================================================================

export interface SourceEvidence {
  chunkId: string;
  content: string;
  sourceType: string;
  filePath?: string;
  repoId?: string;
  /** Page number (1-indexed) where this content appears in the PDF */
  pageIndex?: number;
}

export interface GenerateResult {
  answer: string;
  sources: SourceEvidence[];
  relatedEntities?: string[];
  faithfulnessScore?: number;
  verification?: VerificationResult;
}

export interface VerificationResult {
  answerCorrect: boolean;
  requiresContent: boolean;
  faithfulnessScore: number;
  issues: string[];
}

// ============================================================================
// Query Result
// ============================================================================

export interface QueryResult {
  answer: string;
  sources: SourceEvidence[];
  relatedEntities?: string[];
  faithfulnessScore?: number;
  stats: {
    chunksRetrieved: number;
    entitiesFound?: number;
    graphExpansion?: number;
    /** Number of hops in multi-hop context completion */
    contextCompletionHops?: number;
    durationMs: number;
  };
}

// ============================================================================
// Index Result
// ============================================================================

export interface IndexResult {
  chunksWritten: number;
  entitiesCount?: number;
  relationsCount?: number;
  errors: string[];
  durationMs: number;
  /** Whether indexing was skipped due to duplicate content */
  skipped?: boolean;
  /** Content hash of the indexed/existing content */
  contentHash?: string;
  /** Paper identifier if detected */
  paperId?: string;
  /** Paper version if detected */
  paperVersion?: string;
  /** Number of existing chunks (when skipped=true or replaced) */
  existingChunks?: number;
  /** Number of chunks deleted (when force=true) */
  deletedChunks?: number;
}

// ============================================================================
// RAG Config
// ============================================================================

export interface RAGConfig {
  /** ChromaDB server URL */
  chromaUrl?: string;
  /** Embedding provider config */
  embedding: {
    embed(text: string): Promise<{ vector: number[] }>;
    embedBatch(texts: string[]): Promise<Array<{ vector: number[] }>>;
  };
  /** LLM for generation */
  llm?: {
    complete(prompt: string): Promise<string>;
  };
}
