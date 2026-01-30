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

/**
 * Cross-bundle retrieval mode.
 * - 'single': Query single bundle only (default, backward compatible)
 * - 'specified': Query specific bundles via bundleIds
 * - 'all': Query all indexed bundles
 */
export type CrossBundleMode = 'single' | 'specified' | 'all';

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
  /** Filter by bundle ID (used when crossBundleMode='single') */
  bundleId?: string;
  /** Filter by repo ID */
  repoId?: string;
  
  // Cross-bundle retrieval options (Phase 1)
  /** Cross-bundle retrieval mode (default: 'single' for backward compatibility) */
  crossBundleMode?: CrossBundleMode;
  /** Bundle IDs to query (used when crossBundleMode='specified') */
  bundleIds?: string[];
  
  // Hierarchical retrieval options
  /** Expand to parent chunks when retrieving children (default: false) */
  expandToParent?: boolean;
  /** Expand to sibling chunks at the same level (default: false) */
  expandToSiblings?: boolean;
  
  // Phase 3: Hierarchical retrieval for large-scale paper search
  /** Enable hierarchical retrieval (L1→L2/L3) for 100k+ paper scale (default: auto based on crossBundleMode) */
  enableHierarchicalRetrieval?: boolean;
  /** Number of papers to retrieve in L1 coarse filtering (default: 10) */
  hierarchicalL1TopK?: number;
  /** Number of chunks to retrieve in L2/L3 fine filtering (default: 15) */
  hierarchicalL2L3TopK?: number;
  /** Filter by arXiv category (e.g., 'cs.AI') */
  arxivCategory?: string;
  
  // IGP (Iterative Graph Pruning) options (Phase 2)
  /** IGP pruning options for cross-bundle queries */
  igpOptions?: IGPQueryOptions;
}

/**
 * IGP options for RAG queries.
 * 
 * Based on "Less is More" paper (arXiv:2601.17532) Algorithm 1.
 * Default strategy is 'threshold' with Tp=0 (filter negative-utility evidence).
 * 
 * @see IGPPruner for full options
 */
export interface IGPQueryOptions {
  /** Enable IGP pruning (default: false) */
  enabled: boolean;
  /**
   * Pruning strategy (default: 'threshold' per paper Algorithm 1)
   * - 'threshold': Keep chunks with IG >= Tp (recommended)
   * - 'topK': Keep top K chunks by IG score
   * - 'ratio': Keep top X% of chunks
   */
  strategy?: 'threshold' | 'topK' | 'ratio';
  /**
   * IG threshold Tp for admission control (default: 0)
   * - Tp = 0: Filter negative-utility evidence
   * - Tp = 0.05: Paper's recommended value (more conservative)
   */
  threshold?: number;
  /** Number of top chunks to keep (for 'topK' strategy, default: 5) */
  topK?: number;
  /** Ratio of chunks to keep (for 'ratio' strategy, 0-1, default: 0.5) */
  keepRatio?: number;
  /** Max iterations for iterative pruning (default: 1) */
  maxIterations?: number;
}

export const DEFAULT_QUERY_OPTIONS: Required<Omit<QueryOptions, 'bundleId' | 'repoId' | 'bundleIds' | 'igpOptions' | 'arxivCategory'>> & { igpOptions: IGPQueryOptions } = {
  mode: 'hybrid',
  topK: 10,
  enableContextCompletion: true,
  maxHops: 2,
  enableVerification: false,
  retryOnLowFaithfulness: false,
  crossBundleMode: 'single',
  expandToParent: true,
  expandToSiblings: true,
  // Phase 3: Hierarchical retrieval defaults
  enableHierarchicalRetrieval: false, // Auto-enabled when crossBundleMode='all'
  hierarchicalL1TopK: 10,
  hierarchicalL2L3TopK: 15,
  igpOptions: { enabled: false }, // IGP disabled by default
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
  /** Section heading (e.g., "3.2 Method", "Abstract") from PDF structure */
  sectionHeading?: string;
  
  // Cross-bundle source tracking (Phase 1)
  /** Bundle ID this evidence came from */
  bundleId?: string;
  /** Paper identifier (e.g., arXiv:2601.02553) */
  paperId?: string;
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
    /** IGP pruning statistics (Phase 2) */
    igpStats?: {
      /** Original chunk count before IGP */
      originalCount: number;
      /** Chunk count after IGP pruning */
      prunedCount: number;
      /** Pruning ratio (prunedCount / originalCount) */
      pruningRatio: number;
      /** Number of IGP iterations */
      iterations: number;
      /** IGP processing time in ms */
      durationMs: number;
    };
    /** Hierarchical retrieval statistics (Phase 3) */
    hierarchicalStats?: {
      /** Number of items found per L1 content type */
      l1ByType: Record<string, number>;
      /** Total L1 items found */
      l1TotalFound: number;
      /** Number of chunks found in L2/L3 fine filtering */
      l2l3ChunksFound: number;
      /** Hierarchical retrieval time in ms */
      durationMs: number;
    };
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
  /** Quality score from QA (0-100, higher is better) */
  qualityScore?: number;
  /** QA report summary for display */
  qaSummary?: {
    passed: boolean;
    parseOk: boolean;
    chunkOk: boolean;
    ragOk?: boolean;
    tablesDetected: number;
    figuresDetected: number;
    totalChunks: number;
    orphanChunks: number;
    ragPassedCount?: number;
    ragTotalCount?: number;
    avgFaithfulness?: number;
    issues: string[];
    // Code repo specific fields
    /** Whether this is a code repo (vs PDF) */
    isCodeRepo?: boolean;
    /** CARD.json completeness score (0-100) */
    cardScore?: number;
    /** Number of classes found */
    classCount?: number;
    /** Number of functions found */
    functionCount?: number;
    /** Whether README exists */
    hasReadme?: boolean;
    /** Related paper ID if linked */
    relatedPaperId?: string;
  };
  /** Whether indexing was rejected due to low quality score */
  rejected?: boolean;
  /** Rejection reason */
  rejectionReason?: string;
}

/**
 * Options for indexing a bundle.
 */
export interface IndexOptions {
  /** Force replace existing content with same hash */
  force?: boolean;
  /** Minimum quality score (0-100) to accept indexing. If QA score < threshold, chunks are rolled back. Default: 0 (no rejection). Recommended: 60 for production. */
  qualityThreshold?: number;
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
