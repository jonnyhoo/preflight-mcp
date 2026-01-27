/**
 * IG Ranker - Information Gain based ranking for RAG chunk candidates.
 * 
 * Based on "Less is More" paper (arXiv:2410.XXXXX):
 * IG(d, q) = NU(q) - NU(q|d)
 * 
 * Higher IG means the chunk provides more useful information for answering the query.
 * 
 * @module rag/pruning/ig-ranker
 */

import { NUCalculator, type NUOptions, type NUResult } from './nu-calculator.js';
import type { ChunkDocument } from '../../vectordb/types.js';
import { createModuleLogger } from '../../logging/logger.js';

const logger = createModuleLogger('ig-ranker');

// ============================================================================
// Types
// ============================================================================

/**
 * Chunk with retrieval score (from vector search).
 */
export interface ChunkWithScore {
  id: string;
  content: string;
  metadata: ChunkDocument['metadata'];
  /** Vector similarity score from retrieval */
  score: number;
}

/**
 * Chunk with both retrieval score and Information Gain score.
 */
export interface RankedChunk extends ChunkWithScore {
  /** Information Gain score: IG = NU(q) - NU(q|d) */
  igScore: number;
  /** Normalized Uncertainty with this chunk as context */
  nuWithContext?: number;
}

/**
 * Options for IG Ranker.
 */
export interface IGRankerOptions {
  /** Enable IG ranking (if false, returns chunks as-is) */
  enabled: boolean;
  /** Options for NU computation */
  nuOptions?: NUOptions;
  /** Batch size for parallel NU computation (default: 5) */
  batchSize?: number;
  /** Include original retrieval score in final ranking (default: false) */
  combineWithRetrievalScore?: boolean;
  /** Weight for IG score vs retrieval score (0-1, default: 0.7) */
  igWeight?: number;
}

/**
 * Result of IG ranking with statistics.
 */
export interface IGRankResult {
  /** Ranked chunks with IG scores */
  rankedChunks: RankedChunk[];
  /** Baseline NU (uncertainty without any context) */
  baselineNU: number;
  /** Total computation time in ms */
  durationMs: number;
  /** Number of chunks processed */
  chunksProcessed: number;
  /** Number of batches used */
  batchesUsed: number;
}

// ============================================================================
// IGRanker Class
// ============================================================================

/**
 * Information Gain Ranker for RAG chunk candidates.
 * 
 * Ranks chunks by how much they reduce the model's uncertainty when answering
 * a given query. Higher IG = more informative chunk.
 */
export class IGRanker {
  private nuCalculator: NUCalculator;

  constructor() {
    this.nuCalculator = new NUCalculator();
  }

  /**
   * Rank candidates by Information Gain.
   * 
   * @param query - The user query
   * @param candidates - Candidate chunks from retrieval
   * @param options - Ranking options
   * @returns Ranked chunks with IG scores (descending order)
   * 
   * @example
   * ```typescript
   * const ranker = new IGRanker();
   * const result = await ranker.rankByIG(
   *   'What is the main contribution of this paper?',
   *   retrievedChunks,
   *   { enabled: true, batchSize: 5 }
   * );
   * 
   * // Top chunks have highest IG (most informative)
   * console.log(result.rankedChunks[0].igScore);
   * ```
   */
  async rankByIG(
    query: string,
    candidates: ChunkWithScore[],
    options: IGRankerOptions
  ): Promise<IGRankResult> {
    const startTime = Date.now();

    // If not enabled, return original order with igScore = 0
    if (!options.enabled) {
      return {
        rankedChunks: candidates.map(c => ({ ...c, igScore: 0 })),
        baselineNU: 0,
        durationMs: Date.now() - startTime,
        chunksProcessed: candidates.length,
        batchesUsed: 0,
      };
    }

    const batchSize = options.batchSize ?? 5;
    const nuOptions = options.nuOptions ?? { topK: 5, maxTokens: 30 };

    logger.info(`Starting IG ranking: ${candidates.length} candidates, batchSize=${batchSize}`);

    // Step 1: Compute baseline NU(q) - uncertainty without any context
    logger.debug('Computing baseline NU(q)...');
    const queryPrompt = this.buildQueryPrompt(query);
    const baselineResult = await this.nuCalculator.computeNU(queryPrompt, nuOptions);
    const baselineNU = baselineResult.nu;
    logger.debug(`Baseline NU(q) = ${baselineNU.toFixed(4)}`);

    // Step 2: Compute NU(q|d) for each candidate in batches
    const rankedChunks: RankedChunk[] = [];
    const batches = this.splitIntoBatches(candidates, batchSize);
    
    logger.debug(`Processing ${batches.length} batches...`);

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx]!;
      logger.debug(`Batch ${batchIdx + 1}/${batches.length}: ${batch.length} chunks`);

      // Process batch in parallel
      const batchResults = await Promise.all(
        batch.map(async (chunk) => {
          try {
            const contextPrompt = this.buildContextPrompt(query, chunk.content);
            const nuResult = await this.nuCalculator.computeNU(contextPrompt, nuOptions);
            
            // IG = NU(q) - NU(q|d)
            // Higher IG = chunk reduces uncertainty more = more informative
            const igScore = baselineNU - nuResult.nu;

            return {
              ...chunk,
              igScore,
              nuWithContext: nuResult.nu,
            };
          } catch (err) {
            // On error, assign negative IG (less informative)
            logger.warn(`Failed to compute NU for chunk ${chunk.id}: ${err}`);
            return {
              ...chunk,
              igScore: -1, // Penalize failed chunks
              nuWithContext: undefined,
            };
          }
        })
      );

      rankedChunks.push(...batchResults);
    }

    // Step 3: Optionally combine IG score with retrieval score
    if (options.combineWithRetrievalScore) {
      const igWeight = options.igWeight ?? 0.7;
      const retrievalWeight = 1 - igWeight;

      // Normalize IG scores to 0-1 range
      const igScores = rankedChunks.map(c => c.igScore);
      const minIG = Math.min(...igScores);
      const maxIG = Math.max(...igScores);
      const igRange = maxIG - minIG || 1; // Avoid division by zero

      for (const chunk of rankedChunks) {
        const normalizedIG = (chunk.igScore - minIG) / igRange;
        // Combine: weighted sum of normalized IG and original retrieval score
        chunk.igScore = igWeight * normalizedIG + retrievalWeight * chunk.score;
      }
    }

    // Step 4: Sort by IG score (descending - highest IG first)
    rankedChunks.sort((a, b) => b.igScore - a.igScore);

    const durationMs = Date.now() - startTime;
    logger.info(`IG ranking complete: ${durationMs}ms, baseline NU=${baselineNU.toFixed(4)}`);

    // Log top 3 results
    if (rankedChunks.length > 0) {
      logger.debug('Top ranked chunks:');
      rankedChunks.slice(0, 3).forEach((c, i) => {
        logger.debug(`  ${i + 1}. IG=${c.igScore.toFixed(4)}, id=${c.id.slice(0, 20)}...`);
      });
    }

    return {
      rankedChunks,
      baselineNU,
      durationMs,
      chunksProcessed: candidates.length,
      batchesUsed: batches.length,
    };
  }

  /**
   * Build prompt for query-only NU computation (no context).
   */
  private buildQueryPrompt(query: string): string {
    return `Answer the following question briefly:\n\nQuestion: ${query}\n\nAnswer:`;
  }

  /**
   * Build prompt for query with context (NU(q|d)).
   */
  private buildContextPrompt(query: string, context: string): string {
    // Truncate context to avoid exceeding token limits
    const maxContextChars = 1500;
    const truncatedContext = context.length > maxContextChars
      ? context.slice(0, maxContextChars) + '...'
      : context;

    return `Based on the following context, answer the question briefly:\n\nContext: ${truncatedContext}\n\nQuestion: ${query}\n\nAnswer:`;
  }

  /**
   * Split array into batches.
   */
  private splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Check if a specific LLM config supports logprobs (delegate to NUCalculator).
   */
  static supportsLogprobs(apiBase: string): boolean {
    return NUCalculator.supportsLogprobs(apiBase);
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Rank chunks by Information Gain (convenience function).
 * 
 * @param query - User query
 * @param candidates - Candidate chunks
 * @param options - Ranking options
 * @returns Ranking result with scored chunks
 */
export async function rankByIG(
  query: string,
  candidates: ChunkWithScore[],
  options: IGRankerOptions
): Promise<IGRankResult> {
  const ranker = new IGRanker();
  return ranker.rankByIG(query, candidates, options);
}
