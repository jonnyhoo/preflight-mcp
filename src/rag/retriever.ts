/**
 * RAG Retriever - Vector similarity search for code and documents.
 * 
 * Note: KG graph expansion removed - code symbols are now directly vectorized.
 * All modes (naive/local/hybrid) now use pure vector similarity search.
 * 
 * @module rag/retriever
 */

import type { ChromaVectorDB } from '../vectordb/chroma-client.js';
import type { ChunkDocument, QueryFilter } from '../vectordb/types.js';
import type { RetrieveResult, QueryMode, RAGConfig } from './types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('rag-retriever');

// ============================================================================
// RAG Retriever
// ============================================================================

export class RAGRetriever {
  private chromaDB: ChromaVectorDB;
  private embedding: RAGConfig['embedding'];

  constructor(
    chromaDB: ChromaVectorDB,
    embedding: RAGConfig['embedding'],
  ) {
    this.chromaDB = chromaDB;
    this.embedding = embedding;
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
   * Hybrid retrieval: Now same as naive (KG graph expansion removed).
   * @deprecated Use naiveRetrieve directly
   */
  async hybridRetrieve(
    query: string,
    topK: number,
    filter?: QueryFilter
  ): Promise<RetrieveResult> {
    return this.naiveRetrieve(query, topK, filter);
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
    }
  ): Promise<RetrieveResult> {
    let result: RetrieveResult;
    
    switch (mode) {
      case 'naive':
        result = await this.naiveRetrieve(query, topK, filter);
        break;
      case 'local':
        result = await this.localRetrieve(query, topK, filter);
        break;
      case 'hybrid':
        result = await this.hybridRetrieve(query, topK, filter);
        break;
      default:
        result = await this.hybridRetrieve(query, topK, filter);
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
