/**
 * IGP Pruning Module - Iterative Graph Pruning for RAG.
 * 
 * Based on "Less is More" paper (arXiv:2410.XXXXX).
 * 
 * @module rag/pruning
 */

export { NUCalculator, computeNU } from './nu-calculator.js';
export type { NUOptions, NUResult } from './nu-calculator.js';

export { IGRanker, rankByIG } from './ig-ranker.js';
export type { 
  ChunkWithScore, 
  RankedChunk, 
  IGRankerOptions, 
  IGRankResult 
} from './ig-ranker.js';

export { IGPPruner, pruneWithIGP } from './igp-pruner.js';
export type { IGPOptions, IGPResult } from './igp-pruner.js';
