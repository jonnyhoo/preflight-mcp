/**
 * RAG Retriever - Vector similarity search for code and documents.
 * 
 * Supports three retrieval modes:
 * - naive: Pure dense vector search
 * - local: Same as naive (KG expansion removed)
 * - hybrid: Dense search + N-gram reranking for exact term matching
 * 
 * @module rag/retriever
 */

import type { ChromaVectorDB } from '../vectordb/chroma-client.js';
import type { ChunkDocument, QueryFilter } from '../vectordb/types.js';
import type { RetrieveResult, QueryMode, RAGConfig } from './types.js';
import { HybridReranker, type HybridRerankOptions } from './hybrid-reranker.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('rag-retriever');

// ============================================================================
// RAG Retriever
// ============================================================================

/**
 * Options for hybrid retrieval.
 */
export interface HybridRetrieveOptions {
  /** Enable hybrid reranking (default: 'auto') */
  enableHybridRerank?: boolean | 'auto';
  /** Dense weight for hybrid scoring (default: 0.7) */
  hybridDenseWeight?: number;
}

export class RAGRetriever {
  private chromaDB: ChromaVectorDB;
  private embedding: RAGConfig['embedding'];
  private hybridReranker: HybridReranker;

  constructor(
    chromaDB: ChromaVectorDB,
    embedding: RAGConfig['embedding'],
  ) {
    this.chromaDB = chromaDB;
    this.embedding = embedding;
    this.hybridReranker = new HybridReranker();
  }

  /**
   * Naive retrieval: Pure vector similarity search.
   * Queries hierarchical collections (L2_section + L3_chunk) for Phase 3 compatibility.
   */
  async naiveRetrieve(
    query: string,
    topK: number,
    filter?: QueryFilter
  ): Promise<RetrieveResult> {
    const { vector } = await this.embedding.embed(query);
    
    // Phase 3: Query hierarchical collections (L2 + L3) instead of legacy chunks collection
    // This is compatible with new indexing that writes to l1_pdf, l2_section, l3_chunk
    const hierarchicalFilter = filter ? {
      bundleId: filter.bundleId,
      bundleIds: filter.bundleIds,
      repoId: filter.repoId,
    } : undefined;
    
    const result = await this.chromaDB.queryHierarchicalRaw(vector, topK, hierarchicalFilter);

    return {
      chunks: result.chunks,
    };
  }

  /**
   * Local retrieval: Now same as naive (KG graph expansion removed).
   * @deprecated Use naiveRetrieve directly
   */
  async localRetrieve(
    query: string,
    topK: number,
    filter?: QueryFilter
  ): Promise<RetrieveResult> {
    return this.naiveRetrieve(query, topK, filter);
  }

  /**
   * Hybrid retrieval: Dense search + N-gram reranking.
   * 
   * Uses NUMEN N-gram hashing to boost exact term matches.
   * Particularly effective for:
   * - Technical terms (BERT, ResNet, GPT-4)
   * - Formula keywords (softmax, attention)
   * - Metric queries (highest accuracy)
   * 
   * @param query - User query
   * @param topK - Number of results to return
   * @param filter - Optional filters
   * @param options - Hybrid reranking options
   */
  async hybridRetrieve(
    query: string,
    topK: number,
    filter?: QueryFilter,
    options?: HybridRetrieveOptions
  ): Promise<RetrieveResult & { hybridStats?: { applied: boolean; queryHasTerms: boolean; durationMs: number } }> {
    // Retrieve more candidates for reranking (2x topK)
    const candidateCount = Math.min(topK * 2, 50);
    const candidates = await this.naiveRetrieve(query, candidateCount, filter);
    
    // Apply hybrid reranking
    const rerankOptions: HybridRerankOptions = {
      enabled: options?.enableHybridRerank ?? 'auto',
      denseWeight: options?.hybridDenseWeight ?? 0.7,
    };
    
    const rerankResult = this.hybridReranker.rerank(query, candidates.chunks, rerankOptions);
    
    // Take top-K after reranking
    const rerankedChunks = rerankResult.chunks.slice(0, topK);
    
    return {
      chunks: rerankedChunks,
      entities: candidates.entities,
      expandedTypes: candidates.expandedTypes,
      hybridStats: {
        applied: rerankResult.hybridApplied,
        queryHasTerms: rerankResult.stats.queryHasTerms,
        durationMs: rerankResult.stats.durationMs,
      },
    };
  }

  /**
   * Main retrieve method - dispatches to appropriate mode.
   */
  async retrieve(
    query: string,
    mode: QueryMode,
    topK: number,
    filter?: QueryFilter,
    options?: {
      expandToParent?: boolean;
      expandToSiblings?: boolean;
      enableHybridRerank?: boolean | 'auto';
      hybridDenseWeight?: number;
    }
  ): Promise<RetrieveResult & { hybridStats?: { applied: boolean; queryHasTerms: boolean; durationMs: number } }> {
    let result: RetrieveResult & { hybridStats?: { applied: boolean; queryHasTerms: boolean; durationMs: number } };
    
    const hybridOptions: HybridRetrieveOptions = {
      enableHybridRerank: options?.enableHybridRerank,
      hybridDenseWeight: options?.hybridDenseWeight,
    };
    
    switch (mode) {
      case 'naive':
        result = await this.naiveRetrieve(query, topK, filter);
        break;
      case 'local':
        result = await this.localRetrieve(query, topK, filter);
        break;
      case 'hybrid':
        result = await this.hybridRetrieve(query, topK, filter, hybridOptions);
        break;
      default:
        result = await this.hybridRetrieve(query, topK, filter, hybridOptions);
    }
    
    // Apply hierarchical expansion if requested
    if (options?.expandToParent || options?.expandToSiblings) {
      result = await this.expandHierarchy(result, options);
    }
    
    return result;
  }
  
  /**
   * Expand chunks hierarchically by adding parent/sibling chunks.
   */
  private async expandHierarchy(
    result: RetrieveResult,
    options: {
      expandToParent?: boolean;
      expandToSiblings?: boolean;
    }
  ): Promise<RetrieveResult> {
    const parentIds = new Set<string>();
    const siblingParentIds = new Set<string>();
    
    // Collect parent IDs from retrieved chunks
    for (const chunk of result.chunks) {
      const parentId = chunk.metadata.parentChunkId;
      if (parentId) {
        if (options.expandToParent) {
          parentIds.add(parentId);
        }
        if (options.expandToSiblings) {
          siblingParentIds.add(parentId);
        }
      }
    }
    
    const expandedChunks: Array<ChunkDocument & { score: number }> = [...result.chunks];
    const seenIds = new Set(result.chunks.map(c => c.id));
    
    // Fetch parent chunks (use hierarchical collections)
    if (options.expandToParent && parentIds.size > 0) {
      const parents = await this.chromaDB.getHierarchicalChunks([...parentIds]);
      for (const parent of parents) {
        if (!seenIds.has(parent.id)) {
          expandedChunks.push({
            ...parent,
            score: 0.7, // Lower score for parent context
          });
          seenIds.add(parent.id);
          logger.debug(`Added parent chunk: ${parent.id}`);
        }
      }
    }
    
    // Fetch sibling chunks (chunks sharing the same parent, use hierarchical collections)
    if (options.expandToSiblings && siblingParentIds.size > 0) {
      for (const parentId of siblingParentIds) {
        const siblings = await this.chromaDB.getHierarchicalChunksByParentId(parentId);
        for (const sibling of siblings) {
          if (!seenIds.has(sibling.id)) {
            expandedChunks.push({
              ...sibling,
              score: 0.6, // Lower score for sibling context
            });
            seenIds.add(sibling.id);
            logger.debug(`Added sibling chunk: ${sibling.id}`);
          }
        }
      }
    }
    
    return {
      ...result,
      chunks: expandedChunks,
    };
  }

}
