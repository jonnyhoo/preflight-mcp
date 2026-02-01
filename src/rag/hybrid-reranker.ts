/**
 * Hybrid Reranker for combining dense and sparse retrieval.
 * 
 * Uses NUMEN N-gram hashing for exact term matching combined with
 * dense embedding similarity for semantic understanding.
 * 
 * Pattern: Retrieve with dense → Re-rank with hybrid scoring
 * 
 * @module rag/hybrid-reranker
 */

import { NgramHasher, computeHybridScore, shouldUseNgramMatching } from '../embedding/ngram-hasher.js';
import type { NgramHashConfig, NgramVector } from '../embedding/types.js';
import type { ChunkDocument } from '../vectordb/types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('hybrid-reranker');

// ============================================================================
// Types
// ============================================================================

/**
 * Options for hybrid reranking.
 */
export interface HybridRerankOptions {
  /** Enable hybrid reranking (default: auto-detect based on query) */
  enabled?: boolean | 'auto';
  /** Weight for dense similarity (default: 0.7) */
  denseWeight?: number;
  /** N-gram hasher configuration */
  ngramConfig?: NgramHashConfig;
  /** Minimum score threshold to keep (default: 0, keep all) */
  minScore?: number;
}

/**
 * Chunk with hybrid score.
 */
export interface HybridScoredChunk extends ChunkDocument {
  /** Original dense similarity score */
  denseScore: number;
  /** N-gram sparse similarity score */
  sparseScore: number;
  /** Combined hybrid score */
  hybridScore: number;
  /** Final score (may be same as hybridScore or denseScore) */
  score: number;
}

/**
 * Result of hybrid reranking.
 */
export interface HybridRerankResult {
  /** Reranked chunks */
  chunks: HybridScoredChunk[];
  /** Whether hybrid reranking was applied */
  hybridApplied: boolean;
  /** Statistics */
  stats: {
    originalCount: number;
    finalCount: number;
    durationMs: number;
    queryHasTerms: boolean;
  };
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_OPTIONS: Required<Omit<HybridRerankOptions, 'ngramConfig'>> = {
  enabled: 'auto',
  denseWeight: 0.7,
  minScore: 0,
};

// ============================================================================
// HybridReranker Class
// ============================================================================

/**
 * Hybrid Reranker combining dense and sparse retrieval.
 * 
 * Workflow:
 * 1. Receive chunks retrieved by dense search (with scores)
 * 2. Compute N-gram sparse similarity for each chunk
 * 3. Combine dense + sparse scores with weighted average
 * 4. Re-rank by hybrid score
 * 
 * @example
 * ```typescript
 * const reranker = new HybridReranker();
 * 
 * // After dense retrieval
 * const denseChunks = await retriever.naiveRetrieve(query, 20);
 * 
 * // Hybrid rerank
 * const result = reranker.rerank(query, denseChunks.chunks, {
 *   denseWeight: 0.7,
 * });
 * 
 * // Use top reranked chunks
 * const topChunks = result.chunks.slice(0, 10);
 * ```
 */
export class HybridReranker {
  private hasher: NgramHasher;
  private queryCache: Map<string, NgramVector> = new Map();

  constructor(config?: NgramHashConfig) {
    this.hasher = new NgramHasher(config);
  }

  /**
   * Rerank chunks using hybrid dense + sparse scoring.
   * 
   * @param query - User query
   * @param chunks - Chunks from dense retrieval (must have score property)
   * @param options - Reranking options
   * @returns Reranked chunks with hybrid scores
   */
  rerank(
    query: string,
    chunks: Array<ChunkDocument & { score: number }>,
    options?: HybridRerankOptions
  ): HybridRerankResult {
    const startTime = Date.now();
    const opts = { ...DEFAULT_OPTIONS, ...options };

    // Check if we should apply hybrid reranking
    const queryHasTerms = shouldUseNgramMatching(query);
    const shouldApply = opts.enabled === true || 
      (opts.enabled === 'auto' && queryHasTerms);

    if (!shouldApply || chunks.length === 0) {
      // Return original ordering with score mapping
      const result: HybridScoredChunk[] = chunks.map(chunk => ({
        ...chunk,
        denseScore: chunk.score,
        sparseScore: 0,
        hybridScore: chunk.score,
        score: chunk.score,
      }));

      return {
        chunks: result,
        hybridApplied: false,
        stats: {
          originalCount: chunks.length,
          finalCount: chunks.length,
          durationMs: Date.now() - startTime,
          queryHasTerms,
        },
      };
    }

    logger.info(`Applying hybrid reranking: ${chunks.length} chunks, denseWeight=${opts.denseWeight}`);

    // Hash query (with caching)
    const queryVector = this.getQueryVector(query);

    // Compute hybrid scores for all chunks
    const scoredChunks: HybridScoredChunk[] = chunks.map(chunk => {
      const chunkVector = this.hasher.hash(chunk.content);
      const sparseScore = this.hasher.cosineSimilarity(queryVector, chunkVector);
      const hybridScore = computeHybridScore(chunk.score, sparseScore, opts.denseWeight);

      return {
        ...chunk,
        denseScore: chunk.score,
        sparseScore,
        hybridScore,
        score: hybridScore,
      };
    });

    // Sort by hybrid score (descending)
    scoredChunks.sort((a, b) => b.hybridScore - a.hybridScore);

    // Apply minimum score filter
    const filteredChunks = opts.minScore > 0
      ? scoredChunks.filter(c => c.hybridScore >= opts.minScore)
      : scoredChunks;

    const durationMs = Date.now() - startTime;
    logger.info(`Hybrid reranking complete: ${chunks.length} → ${filteredChunks.length} chunks, ${durationMs}ms`);

    // Log score changes for debugging
    if (logger.isDebugEnabled?.()) {
      const reorderCount = this.countReorders(chunks, filteredChunks);
      logger.debug(`Reordering: ${reorderCount} position changes`);
    }

    return {
      chunks: filteredChunks,
      hybridApplied: true,
      stats: {
        originalCount: chunks.length,
        finalCount: filteredChunks.length,
        durationMs,
        queryHasTerms,
      },
    };
  }

  /**
   * Compute N-gram similarity between query and a single text.
   * Useful for on-demand scoring.
   */
  computeSparseScore(query: string, text: string): number {
    const queryVector = this.getQueryVector(query);
    const textVector = this.hasher.hash(text);
    return this.hasher.cosineSimilarity(queryVector, textVector);
  }

  /**
   * Clear the query vector cache.
   */
  clearCache(): void {
    this.queryCache.clear();
  }

  /**
   * Get the N-gram hasher instance.
   */
  getHasher(): NgramHasher {
    return this.hasher;
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  /**
   * Get query vector with caching.
   */
  private getQueryVector(query: string): NgramVector {
    const cached = this.queryCache.get(query);
    if (cached) return cached;

    const vector = this.hasher.hash(query);
    this.queryCache.set(query, vector);
    return vector;
  }

  /**
   * Count how many chunks changed position after reranking.
   */
  private countReorders(
    original: Array<{ id: string }>,
    reranked: Array<{ id: string }>
  ): number {
    let count = 0;
    for (let i = 0; i < Math.min(original.length, reranked.length); i++) {
      if (original[i]!.id !== reranked[i]!.id) {
        count++;
      }
    }
    return count;
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Rerank chunks using hybrid scoring (convenience function).
 * 
 * @param query - User query
 * @param chunks - Chunks from dense retrieval
 * @param options - Reranking options
 * @returns Reranked chunks
 */
export function hybridRerank(
  query: string,
  chunks: Array<ChunkDocument & { score: number }>,
  options?: HybridRerankOptions
): HybridRerankResult {
  const reranker = new HybridReranker(options?.ngramConfig);
  return reranker.rerank(query, chunks, options);
}

/**
 * Check if a query would benefit from hybrid reranking.
 * 
 * @param query - User query
 * @returns True if query contains technical terms, formulas, or metrics
 */
export function queryNeedsHybridRerank(query: string): boolean {
  return shouldUseNgramMatching(query);
}
