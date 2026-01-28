/**
 * Hierarchical RAG Retriever for large-scale paper retrieval.
 * 
 * Phase 3: Implements 3-layer hierarchical retrieval to reduce IGP LLM calls.
 * - L1 (overview): Paper-level coarse filtering (title + abstract)
 * - L2 (section): Section-level retrieval (Introduction, Method, Results...)
 * - L3 (chunk): Fragment-level retrieval (paragraphs, tables, formulas)
 * 
 * Flow: L1 coarse → L2/L3 fine → IGP pruning
 * 
 * @module rag/hierarchical-retriever
 */

import type { ChromaVectorDB } from '../vectordb/chroma-client.js';
import type { 
  ChunkDocument, 
  HierarchicalQueryFilter,
  CollectionLevel,
  L1ContentType,
} from '../vectordb/types.js';
import { L1_LEVELS } from '../vectordb/types.js';
import type { RAGConfig } from './types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('hierarchical-retriever');

// ============================================================================
// Types
// ============================================================================

/**
 * Options for hierarchical retrieval.
 */
export interface HierarchicalRetrieveOptions {
  /** Number of items to retrieve per L1 collection (default: 10) */
  l1TopK?: number;
  /** Number of chunks to retrieve from L2/L3 (default: 15) */
  l2l3TopK?: number;
  /** Filter by arXiv category (e.g., 'cs.AI') */
  arxivCategory?: string;
  /** Skip L1 and query all content (for small collections) */
  skipL1?: boolean;
  /** 
   * L1 content types to query (default: all types).
   * Use this to limit search to specific content types.
   * e.g., ['pdf'] for papers only, ['repo'] for code only
   */
  l1Types?: L1ContentType[];
}

/**
 * Result of hierarchical retrieval.
 */
export interface HierarchicalRetrieveResult {
  /** Final retrieved chunks (from L2/L3) */
  chunks: Array<ChunkDocument & { score: number }>;
  /** Paper IDs from L1 coarse filtering */
  paperIds: string[];
  /** Statistics */
  stats: {
    /** Number of items found per L1 type */
    l1ByType: Record<string, number>;
    /** Total L1 items found */
    l1TotalFound: number;
    /** Number of chunks found in L2/L3 */
    l2l3ChunksFound: number;
    /** Hierarchical retrieval time in ms */
    durationMs: number;
  };
}

// ============================================================================
// Default Options
// ============================================================================

const DEFAULT_OPTIONS: Required<Omit<HierarchicalRetrieveOptions, 'arxivCategory' | 'l1Types'>> = {
  l1TopK: 10,
  l2l3TopK: 15,
  skipL1: false,
};

// ============================================================================
// Hierarchical Retriever
// ============================================================================

/**
 * Hierarchical RAG Retriever.
 * 
 * Implements 3-layer retrieval for 100k+ paper scale:
 * 1. L1 (overview): Coarse filter to find top-K relevant papers
 * 2. L2/L3 (section/chunk): Fine retrieval within selected papers
 * 
 * Performance target:
 * - 100k papers → L1 search: ~10ms
 * - 10 papers × 30 chunks = 300 chunks → L2/L3 search: ~10ms
 * - Total: <100ms before IGP
 */
export class HierarchicalRetriever {
  private chromaDB: ChromaVectorDB;
  private embedding: RAGConfig['embedding'];

  constructor(chromaDB: ChromaVectorDB, embedding: RAGConfig['embedding']) {
    this.chromaDB = chromaDB;
    this.embedding = embedding;
  }

  // --------------------------------------------------------------------------
  // Main Retrieval Methods
  // --------------------------------------------------------------------------

  /**
   * Perform hierarchical retrieval: L1 → L2/L3.
   * 
   * @param query - User's query string
   * @param options - Retrieval options
   * @returns Retrieved chunks with paper IDs and stats
   */
  async retrieve(
    query: string,
    options?: HierarchicalRetrieveOptions
  ): Promise<HierarchicalRetrieveResult> {
    const startTime = Date.now();
    const opts = { ...DEFAULT_OPTIONS, ...options };
    
    logger.info(`[Hierarchical] Starting retrieval for: "${query.slice(0, 50)}..."`);

    // Embed query once for all levels
    const { vector } = await this.embedding.embed(query);

    // Step 1: L1 coarse filtering (find relevant content across all L1 types)
    let paperIds: string[] = [];
    let l1ByType: Record<string, number> = {};
    
    if (!opts.skipL1) {
      const l1Result = await this.retrieveL1Multi(
        vector, 
        opts.l1TopK, 
        opts.l1Types,
        opts.arxivCategory
      );
      paperIds = l1Result.paperIds;
      l1ByType = l1Result.byType;
      logger.info(`[L1] Found ${paperIds.length} relevant items: ${JSON.stringify(l1ByType)}`);
    }

    // Step 2: L2/L3 fine retrieval (within selected content)
    const chunks = await this.retrieveL2L3(
      vector, 
      opts.l2l3TopK, 
      paperIds.length > 0 ? paperIds : undefined,
      opts.arxivCategory
    );
    logger.info(`[L2/L3] Found ${chunks.length} chunks`);

    const durationMs = Date.now() - startTime;
    logger.info(`[Hierarchical] Completed in ${durationMs}ms`);

    return {
      chunks,
      paperIds,
      stats: {
        l1ByType,
        l1TotalFound: paperIds.length,
        l2l3ChunksFound: chunks.length,
        durationMs,
      },
    };
  }

  // --------------------------------------------------------------------------
  // L1: Multi-Type Coarse Filtering
  // --------------------------------------------------------------------------

  /**
   * L1 retrieval: Search all L1 collections in parallel.
   * Returns unique content IDs (paperIds for PDF, bundleIds for others).
   * 
   * @param embedding - Query embedding vector
   * @param topK - Number of items to retrieve per L1 type
   * @param l1Types - Which L1 types to query (default: all)
   * @param arxivCategory - Optional category filter (for PDF only)
   * @returns List of content IDs and stats by type
   */
  private async retrieveL1Multi(
    embedding: number[],
    topK: number,
    l1Types?: L1ContentType[],
    arxivCategory?: string
  ): Promise<{ paperIds: string[]; byType: Record<string, number> }> {
    // Determine which L1 types to query
    const typesToQuery: CollectionLevel[] = l1Types
      ? l1Types.map(t => `l1_${t}` as CollectionLevel)
      : L1_LEVELS;

    const filter: HierarchicalQueryFilter = {};
    if (arxivCategory) {
      filter.arxivCategory = arxivCategory;
    }

    // Query all L1 collections in parallel
    const results = await Promise.all(
      typesToQuery.map(async (level) => {
        try {
          const result = await this.chromaDB.queryHierarchical(
            level,
            embedding,
            topK,
            Object.keys(filter).length > 0 ? filter : undefined
          );
          return { level, chunks: result.chunks };
        } catch {
          // Collection may not exist yet
          return { level, chunks: [] };
        }
      })
    );

    // Extract unique IDs and count by type
    const allIds = new Set<string>();
    const byType: Record<string, number> = {};

    for (const { level, chunks } of results) {
      const typeKey = level.replace('l1_', '');
      byType[typeKey] = 0;
      
      for (const chunk of chunks) {
        // Use paperId for PDF, bundleId for others
        const id = chunk.metadata.paperId || chunk.metadata.bundleId;
        if (id && !allIds.has(id)) {
          allIds.add(id);
          byType[typeKey]++;
        }
      }
    }

    return {
      paperIds: [...allIds],
      byType,
    };
  }

  // --------------------------------------------------------------------------
  // L2/L3: Section/Chunk Fine Retrieval
  // --------------------------------------------------------------------------

  /**
   * L2/L3 retrieval: Search section and chunk collections.
   * Filters by paper IDs from L1 if provided.
   * 
   * @param embedding - Query embedding vector
   * @param topK - Number of chunks to retrieve
   * @param paperIds - Paper IDs to filter (from L1)
   * @param arxivCategory - Optional category filter
   * @returns Retrieved chunks with scores
   */
  private async retrieveL2L3(
    embedding: number[],
    topK: number,
    paperIds?: string[],
    arxivCategory?: string
  ): Promise<Array<ChunkDocument & { score: number }>> {
    const filter: HierarchicalQueryFilter = {};
    if (paperIds && paperIds.length > 0) {
      filter.paperIds = paperIds;
    }
    if (arxivCategory) {
      filter.arxivCategory = arxivCategory;
    }

    // Query both L2 (section) and L3 (chunk) collections
    // Split topK between them (60% L3, 40% L2 for more granular results)
    const l3TopK = Math.ceil(topK * 0.6);
    const l2TopK = topK - l3TopK;

    const [l3Result, l2Result] = await Promise.all([
      this.chromaDB.queryHierarchical(
        'l3_chunk',
        embedding,
        l3TopK,
        Object.keys(filter).length > 0 ? filter : undefined
      ),
      this.chromaDB.queryHierarchical(
        'l2_section',
        embedding,
        l2TopK,
        Object.keys(filter).length > 0 ? filter : undefined
      ),
    ]);

    // Merge and deduplicate by ID
    const seen = new Set<string>();
    const merged: Array<ChunkDocument & { score: number }> = [];

    // L3 chunks first (higher priority for granular content)
    for (const chunk of l3Result.chunks) {
      if (!seen.has(chunk.id)) {
        seen.add(chunk.id);
        merged.push(chunk);
      }
    }

    // Then L2 sections
    for (const chunk of l2Result.chunks) {
      if (!seen.has(chunk.id)) {
        seen.add(chunk.id);
        merged.push(chunk);
      }
    }

    // Sort by score and return top K
    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, topK);
  }

  // --------------------------------------------------------------------------
  // Utility Methods
  // --------------------------------------------------------------------------

  /**
   * Check if hierarchical collections exist.
   * Useful for determining if hierarchical retrieval is available.
   */
  async isHierarchicalIndexed(): Promise<boolean> {
    try {
      // Try to query L1_pdf with minimal results (most common type)
      await this.chromaDB.ensureHierarchicalCollection('l1_pdf');
      return true;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// Convenience Function
// ============================================================================

/**
 * Create a HierarchicalRetriever instance.
 */
export function createHierarchicalRetriever(
  chromaDB: ChromaVectorDB,
  embedding: RAGConfig['embedding']
): HierarchicalRetriever {
  return new HierarchicalRetriever(chromaDB, embedding);
}
