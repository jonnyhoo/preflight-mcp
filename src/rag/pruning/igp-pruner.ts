/**
 * IGP Pruner - Iterative Graph Pruning for RAG chunk filtering.
 * 
 * Based on "Less is More" paper (arXiv:2410.XXXXX).
 * Uses Information Gain (IG) to iteratively prune low-relevance chunks.
 * 
 * @module rag/pruning/igp-pruner
 */

import { IGRanker, type ChunkWithScore, type RankedChunk, type IGRankerOptions } from './ig-ranker.js';
import type { NUOptions } from './nu-calculator.js';
import { createModuleLogger } from '../../logging/logger.js';

const logger = createModuleLogger('igp-pruner');

// ============================================================================
// Types
// ============================================================================

/**
 * IGP pruning options.
 * 
 * Based on "Less is More" paper (arXiv:2601.17532) Algorithm 1.
 * Default strategy is 'threshold' with Tp=0 (filter negative-utility evidence).
 */
export interface IGPOptions {
  /** Enable IGP pruning (default: false) */
  enabled: boolean;
  
  /**
   * Pruning strategy (default: 'threshold' per paper Algorithm 1)
   * - 'threshold': Keep chunks with IG >= Tp (paper's recommended approach)
   * - 'topK': Keep top K chunks by IG score (fallback)
   * - 'ratio': Keep top X% of chunks
   * 
   * Paper finding: "gains are driven primarily by utility-aware admission control
   * (threshold-based pruning) rather than reordering alone"
   */
  strategy?: 'threshold' | 'topK' | 'ratio';
  
  /**
   * IG threshold Tp for admission control (default: 0)
   * - Tp = 0: Filter negative-utility evidence (IG < 0)
   * - Tp > 0: More conservative, filter weak-utility evidence
   * - Paper optimal: Tp ≈ 0.05 (Figure 4)
   */
  threshold?: number;
  
  /** Number of top chunks to keep (for 'topK' strategy, default: 5) */
  topK?: number;
  
  /** Ratio of chunks to keep (for 'ratio' strategy, 0-1, default: 0.5) */
  keepRatio?: number;
  
  /** Max iterations for iterative pruning (default: 1, single pass) */
  maxIterations?: number;
  
  /** NU computation options */
  nuOptions?: NUOptions;
  
  /** Batch size for parallel processing (default: 5) */
  batchSize?: number;
}

/**
 * Result of IGP pruning with statistics.
 */
export interface IGPResult {
  /** Pruned chunks (ranked by IG, descending) */
  chunks: RankedChunk[];
  /** Number of chunks before pruning */
  originalCount: number;
  /** Number of chunks after pruning */
  prunedCount: number;
  /** Pruning ratio (prunedCount / originalCount) */
  pruningRatio: number;
  /** Number of iterations performed */
  iterations: number;
  /** Total duration in ms */
  durationMs: number;
  /** Baseline NU (uncertainty without context) */
  baselineNU: number;
}

// ============================================================================
// IGPPruner Class
// ============================================================================

/**
 * Iterative Graph Pruning (IGP) for RAG chunk filtering.
 * 
 * Prunes low-relevance chunks based on Information Gain (IG) scores.
 * Uses relative strategies (topK, ratio) for model-agnostic pruning.
 */
export class IGPPruner {
  private igRanker: IGRanker;

  constructor() {
    this.igRanker = new IGRanker();
  }

  /**
   * Prune chunks using IGP.
   * 
   * @param query - User query
   * @param chunks - Candidate chunks from retrieval
   * @param options - IGP options
   * @returns Pruned chunks with IG scores
   * 
   * @example
   * ```typescript
   * const pruner = new IGPPruner();
   * const result = await pruner.prune(
   *   'What is machine learning?',
   *   retrievedChunks,
   *   { enabled: true, strategy: 'topK', topK: 5 }
   * );
   * 
   * // Use pruned chunks for generation
   * const answer = await generator.generate(query, result.chunks);
   * ```
   */
  async prune(
    query: string,
    chunks: ChunkWithScore[],
    options: IGPOptions
  ): Promise<IGPResult> {
    const startTime = Date.now();

    // If not enabled or no chunks, return as-is
    if (!options.enabled || chunks.length === 0) {
      return {
        chunks: chunks.map(c => ({ ...c, igScore: 0 })),
        originalCount: chunks.length,
        prunedCount: chunks.length,
        pruningRatio: 1.0,
        iterations: 0,
        durationMs: Date.now() - startTime,
        baselineNU: 0,
      };
    }

    const strategy = options.strategy ?? 'threshold';
    const maxIterations = options.maxIterations ?? 1;
    
    logger.info(`Starting IGP: ${chunks.length} chunks, strategy=${strategy}, maxIter=${maxIterations}`);

    let currentChunks = chunks;
    let totalIterations = 0;
    let baselineNU = 0;

    // Iterative pruning loop
    for (let iter = 0; iter < maxIterations; iter++) {
      totalIterations++;
      
      // Rank chunks by IG
      const rankResult = await this.igRanker.rankByIG(query, currentChunks, {
        enabled: true,
        nuOptions: options.nuOptions ?? { topK: 5, maxTokens: 20 },
        batchSize: options.batchSize ?? 5,
      });

      baselineNU = rankResult.baselineNU;
      const rankedChunks = rankResult.rankedChunks;

      // Apply pruning strategy
      const prunedChunks = this.applyStrategy(rankedChunks, options);

      logger.info(`Iteration ${iter + 1}: ${currentChunks.length} → ${prunedChunks.length} chunks`);

      // Check convergence: if no chunks were pruned, stop
      if (prunedChunks.length === currentChunks.length) {
        logger.info(`IGP converged after ${iter + 1} iterations`);
        currentChunks = prunedChunks;
        break;
      }

      // Update for next iteration
      currentChunks = prunedChunks;
    }

    const durationMs = Date.now() - startTime;
    const pruningRatio = currentChunks.length / chunks.length;

    logger.info(`IGP complete: ${chunks.length} → ${currentChunks.length} (${(pruningRatio * 100).toFixed(1)}%), ${durationMs}ms`);

    return {
      chunks: currentChunks as RankedChunk[],
      originalCount: chunks.length,
      prunedCount: currentChunks.length,
      pruningRatio,
      iterations: totalIterations,
      durationMs,
      baselineNU,
    };
  }

  /**
   * Apply pruning strategy to ranked chunks.
   */
  private applyStrategy(
    rankedChunks: RankedChunk[],
    options: IGPOptions
  ): RankedChunk[] {
    const strategy = options.strategy ?? 'threshold';

    switch (strategy) {
      case 'threshold': {
        // Paper Algorithm 1, Line 8: L ← [d ∈ L: IG(d, q; φ, K) ≥ Tp]
        // Default Tp = 0: filter negative-utility evidence
        const threshold = options.threshold ?? 0;
        const filtered = rankedChunks.filter(c => c.igScore >= threshold);
        
        // If all chunks have negative IG (unusual), keep top 1 as fallback
        if (filtered.length === 0 && rankedChunks.length > 0) {
          logger.warn(`All chunks have IG < ${threshold}, keeping top 1 as fallback`);
          return rankedChunks.slice(0, 1);
        }
        return filtered;
      }

      case 'topK': {
        const topK = options.topK ?? 5;
        return rankedChunks.slice(0, Math.min(topK, rankedChunks.length));
      }

      case 'ratio': {
        const keepRatio = options.keepRatio ?? 0.5;
        const keepCount = Math.ceil(rankedChunks.length * keepRatio);
        return rankedChunks.slice(0, Math.max(1, keepCount)); // Keep at least 1
      }

      default:
        return rankedChunks;
    }
  }

  /**
   * Check if logprobs are supported for IGP.
   */
  static supportsLogprobs(apiBase: string): boolean {
    return IGRanker.supportsLogprobs(apiBase);
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Prune chunks using IGP (convenience function).
 */
export async function pruneWithIGP(
  query: string,
  chunks: ChunkWithScore[],
  options: IGPOptions
): Promise<IGPResult> {
  const pruner = new IGPPruner();
  return pruner.prune(query, chunks, options);
}
