/**
 * RAG Retriever - Multi-mode retrieval with graph expansion.
 * Based on Reliable Graph-RAG paper.
 * 
 * @module rag/retriever
 */

import type { ChromaVectorDB } from '../vectordb/chroma-client.js';
import type { ChunkDocument, QueryFilter } from '../vectordb/types.js';
import type { KGStorage } from '../kg/storage.js';
import type { RetrieveResult, QueryMode, RAGConfig } from './types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('rag-retriever');

// ============================================================================
// RAG Retriever
// ============================================================================

export class RAGRetriever {
  private chromaDB: ChromaVectorDB;
  private kgStorage: KGStorage | null;
  private embedding: RAGConfig['embedding'];

  constructor(
    chromaDB: ChromaVectorDB,
    embedding: RAGConfig['embedding'],
    kgStorage?: KGStorage
  ) {
    this.chromaDB = chromaDB;
    this.embedding = embedding;
    this.kgStorage = kgStorage ?? null;
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
   * Local retrieval: Vector search + entity neighbor expansion.
   */
  async localRetrieve(
    query: string,
    topK: number,
    filter?: QueryFilter
  ): Promise<RetrieveResult> {
    // First, do naive retrieval
    const naiveResult = await this.naiveRetrieve(query, topK, filter);

    if (!this.kgStorage) {
      return naiveResult;
    }

    // Extract type names mentioned in chunks
    const mentionedTypes = this.extractMentionedTypes(naiveResult.chunks);
    
    if (mentionedTypes.length === 0) {
      return naiveResult;
    }

    // Get 1-hop neighbors for each mentioned type
    const expandedTypes = new Set<string>();
    for (const typeName of mentionedTypes) {
      const neighbors = this.kgStorage.getNeighbors(typeName, 1);
      neighbors.forEach(n => expandedTypes.add(n.name));
    }

    // Get chunks related to expanded types
    const expandedChunks = await this.getChunksByTypes([...expandedTypes], filter);

    // Merge and deduplicate
    const merged = this.mergeChunks(naiveResult.chunks, expandedChunks);

    return {
      chunks: merged,
      expandedTypes: [...expandedTypes],
    };
  }

  /**
   * Hybrid retrieval: Vector + bidirectional graph traversal + InterfaceConsumerExpand.
   * This is the core algorithm from the paper.
   */
  async hybridRetrieve(
    query: string,
    topK: number,
    filter?: QueryFilter
  ): Promise<RetrieveResult> {
    // 1. Vector retrieval for initial chunks
    const naiveResult = await this.naiveRetrieve(query, topK, filter);

    if (!this.kgStorage) {
      return naiveResult;
    }

    // 2. Extract mentioned types from chunks
    const mentionedTypes = this.extractMentionedTypes(naiveResult.chunks);
    
    if (mentionedTypes.length === 0) {
      return naiveResult;
    }

    logger.debug(`Found ${mentionedTypes.length} mentioned types: ${mentionedTypes.join(', ')}`);

    // 3. Bidirectional graph traversal
    const expandedTypes = new Set<string>();
    
    for (const typeName of mentionedTypes) {
      // Successors: what this type depends on
      const successors = this.kgStorage.getSuccessors(typeName, 1);
      successors.forEach(n => expandedTypes.add(n.name));

      // Predecessors: what depends on this type
      const predecessors = this.kgStorage.getPredecessors(typeName, 1);
      predecessors.forEach(n => expandedTypes.add(n.name));
    }

    // 4. InterfaceConsumerExpand: If mentioned type is interface, expand to implementors
    for (const typeName of mentionedTypes) {
      const node = this.kgStorage.getNode(typeName);
      if (node?.kind === 'interface') {
        const implementors = this.kgStorage.getImplementors(typeName);
        implementors.forEach(n => expandedTypes.add(n.name));
        logger.debug(`Interface ${typeName} has ${implementors.length} implementors`);
      }
    }

    logger.debug(`Graph expansion found ${expandedTypes.size} related types`);

    // 5. Get chunks for expanded types
    const expandedChunks = await this.getChunksByTypes([...expandedTypes], filter);

    // 6. Rank and merge results
    const merged = this.rankAndMerge(naiveResult.chunks, expandedChunks, topK);

    return {
      chunks: merged,
      expandedTypes: [...expandedTypes],
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

  // --------------------------------------------------------------------------
  // Helper Methods
  // --------------------------------------------------------------------------

  /**
   * Extract type names mentioned in chunks.
   * Uses simple pattern matching for common patterns.
   */
  private extractMentionedTypes(
    chunks: Array<ChunkDocument & { score: number }>
  ): string[] {
    if (!this.kgStorage) return [];

    const mentioned = new Set<string>();
    const knownTypes = new Set(this.kgStorage.getAllNodes().map(n => n.name));

    for (const chunk of chunks) {
      const content = chunk.content;
      
      // Pattern 1: Backtick-wrapped identifiers: `TypeName`
      const backtickMatches = content.match(/`([A-Z][a-zA-Z0-9_]*)`/g);
      if (backtickMatches) {
        for (const match of backtickMatches) {
          const name = match.slice(1, -1);
          if (knownTypes.has(name)) {
            mentioned.add(name);
          }
        }
      }

      // Pattern 2: PascalCase words (likely class/interface names)
      const pascalMatches = content.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g);
      if (pascalMatches) {
        for (const name of pascalMatches) {
          if (knownTypes.has(name)) {
            mentioned.add(name);
          }
        }
      }

      // Pattern 3: Code blocks might have class definitions
      const classMatches = content.match(/class\s+([A-Z][a-zA-Z0-9_]*)/g);
      if (classMatches) {
        for (const match of classMatches) {
          const name = match.replace('class ', '');
          if (knownTypes.has(name)) {
            mentioned.add(name);
          }
        }
      }
    }

    return [...mentioned];
  }

  /**
   * Get chunks related to specific types by searching for type names.
   */
  private async getChunksByTypes(
    typeNames: string[],
    filter?: QueryFilter
  ): Promise<Array<ChunkDocument & { score: number }>> {
    if (typeNames.length === 0) return [];

    // Create a query from type names
    const query = typeNames.slice(0, 5).join(' '); // Limit to avoid too long query
    const { vector } = await this.embedding.embed(query);
    
    // Use hierarchical query (Phase 3)
    const result = await this.chromaDB.queryHierarchicalRaw(vector, 5, filter);
    return result.chunks;
  }

  /**
   * Simple merge of two chunk arrays, deduplicating by ID.
   */
  private mergeChunks(
    primary: Array<ChunkDocument & { score: number }>,
    secondary: Array<ChunkDocument & { score: number }>
  ): Array<ChunkDocument & { score: number }> {
    const seen = new Set<string>();
    const result: Array<ChunkDocument & { score: number }> = [];

    for (const chunk of primary) {
      if (!seen.has(chunk.id)) {
        seen.add(chunk.id);
        result.push(chunk);
      }
    }

    for (const chunk of secondary) {
      if (!seen.has(chunk.id)) {
        seen.add(chunk.id);
        result.push(chunk);
      }
    }

    return result;
  }

  /**
   * Rank and merge chunks, keeping top K.
   */
  private rankAndMerge(
    primary: Array<ChunkDocument & { score: number }>,
    expanded: Array<ChunkDocument & { score: number }>,
    topK: number
  ): Array<ChunkDocument & { score: number }> {
    // Boost primary results slightly
    const boosted = primary.map(c => ({ ...c, score: c.score * 1.1 }));
    
    // Merge
    const merged = this.mergeChunks(boosted, expanded);
    
    // Sort by score and take top K
    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, topK);
  }
}
