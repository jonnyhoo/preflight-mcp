/**
 * RAG Query - Main entry point for RAG operations.
 * 
 * @module rag/query
 */

import { ChromaVectorDB } from '../vectordb/chroma-client.js';
import { indexBundle as bridgeIndexBundle } from '../bridge/index.js';
import { buildAstGraph } from '../kg/ast-graph-builder.js';
import { KGStorage } from '../kg/storage.js';
import { RAGRetriever } from './retriever.js';
import { RAGGenerator } from './generator.js';
import type { 
  QueryOptions, 
  QueryResult, 
  IndexResult,
  RAGConfig,
  DEFAULT_QUERY_OPTIONS,
} from './types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('rag');

// ============================================================================
// RAG Engine
// ============================================================================

/**
 * RAG Engine - Orchestrates indexing and querying.
 */
export class RAGEngine {
  private chromaDB: ChromaVectorDB;
  private embedding: RAGConfig['embedding'];
  private llm: RAGConfig['llm'];
  private kgStorage: KGStorage;
  private retriever: RAGRetriever;
  private generator: RAGGenerator;

  constructor(config: RAGConfig) {
    this.chromaDB = new ChromaVectorDB({ url: config.chromaUrl });
    this.embedding = config.embedding;
    this.llm = config.llm;
    this.kgStorage = new KGStorage();
    this.retriever = new RAGRetriever(this.chromaDB, this.embedding, this.kgStorage);
    this.generator = new RAGGenerator(this.llm);
  }

  /**
   * Check if ChromaDB is available.
   */
  async isAvailable(): Promise<boolean> {
    return this.chromaDB.isAvailable();
  }

  /**
   * Index a bundle to ChromaDB.
   */
  async indexBundle(bundlePath: string, bundleId: string): Promise<IndexResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let chunksWritten = 0;
    let entitiesCount = 0;
    let relationsCount = 0;

    try {
      // 1. Bridge: Index documents (CARD.json, README.md, OVERVIEW.md)
      logger.info(`Indexing documents from ${bundlePath}...`);
      const bridgeResult = await bridgeIndexBundle(
        bundlePath,
        bundleId,
        this.chromaDB,
        { embedding: this.embedding }
      );
      chunksWritten = bridgeResult.chunksWritten;
      errors.push(...bridgeResult.errors);
      logger.info(`Indexed ${chunksWritten} document chunks`);

      // 2. KG: Build AST graph for code repos
      logger.info(`Building AST graph...`);
      const graphResult = await buildAstGraph(bundlePath);
      
      if (graphResult.graph.nodes.size > 0) {
        // Load into KGStorage for retrieval
        this.kgStorage.loadGraph(graphResult.graph);
        const stats = this.kgStorage.getStats();
        entitiesCount = stats.nodeCount;
        relationsCount = stats.edgeCount;

        // Store AST graph to ChromaDB (as JSON, no embedding needed)
        const graphJson = this.kgStorage.toJSON();
        await this.chromaDB.storeAstGraph(bundleId, graphJson);
        logger.info(`Stored AST graph: ${entitiesCount} nodes, ${relationsCount} edges`);
      }

      errors.push(...graphResult.errors);
    } catch (err) {
      const msg = `Index failed: ${err}`;
      logger.error(msg);
      errors.push(msg);
    }

    return {
      chunksWritten,
      entitiesCount,
      relationsCount,
      errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Load AST graph from ChromaDB for a bundle.
   * Call this before querying if the graph wasn't built in current session.
   */
  async loadAstGraph(bundleId: string): Promise<boolean> {
    try {
      const graphJson = await this.chromaDB.loadAstGraph(bundleId);
      if (graphJson) {
        this.kgStorage = KGStorage.fromJSON(graphJson);
        // Update retriever with loaded KG
        this.retriever = new RAGRetriever(this.chromaDB, this.embedding, this.kgStorage);
        const stats = this.kgStorage.getStats();
        logger.info(`Loaded AST graph: ${stats.nodeCount} nodes, ${stats.edgeCount} edges`);
        return true;
      }
      return false;
    } catch (err) {
      logger.warn(`Failed to load AST graph: ${err}`);
      return false;
    }
  }

  /**
   * Query the RAG system.
   */
  async query(question: string, options?: QueryOptions): Promise<QueryResult> {
    const startTime = Date.now();
    const opts = {
      mode: options?.mode ?? 'hybrid',
      topK: options?.topK ?? 10,
      enableContextCompletion: options?.enableContextCompletion ?? true,
      maxHops: options?.maxHops ?? 2,
      enableVerification: options?.enableVerification ?? false,
      retryOnLowFaithfulness: options?.retryOnLowFaithfulness ?? false,
    };

    // If KG is empty and bundleId provided, try to load from ChromaDB
    if (this.kgStorage.getStats().nodeCount === 0 && options?.bundleId) {
      await this.loadAstGraph(options.bundleId);
    }

    // Build filter
    const filter = options?.bundleId || options?.repoId
      ? { bundleId: options.bundleId, repoId: options.repoId }
      : undefined;

    // Retrieve
    logger.info(`Retrieving context for: "${question}" (mode: ${opts.mode})`);
    const retrieved = await this.retriever.retrieve(
      question,
      opts.mode,
      opts.topK,
      filter
    );

    logger.info(`Retrieved ${retrieved.chunks.length} chunks`);

    // Generate
    const generated = await this.generator.generate(question, retrieved, {
      enableVerification: opts.enableVerification,
      retryOnLowFaithfulness: opts.retryOnLowFaithfulness,
    });

    return {
      answer: generated.answer,
      sources: generated.sources,
      relatedEntities: generated.relatedEntities,
      faithfulnessScore: generated.faithfulnessScore,
      stats: {
        chunksRetrieved: retrieved.chunks.length,
        entitiesFound: retrieved.expandedTypes?.length,
        graphExpansion: retrieved.expandedTypes?.length ?? 0,
        durationMs: Date.now() - startTime,
      },
    };
  }

  /**
   * Delete all data for a bundle.
   */
  async deleteBundle(bundleId: string): Promise<void> {
    await this.chromaDB.deleteByBundle(bundleId);
    logger.info(`Deleted data for bundle: ${bundleId}`);
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

let defaultEngine: RAGEngine | null = null;

/**
 * Initialize RAG with config.
 */
export function initRAG(config: RAGConfig): RAGEngine {
  defaultEngine = new RAGEngine(config);
  return defaultEngine;
}

/**
 * Get the default RAG engine.
 */
export function getRAGEngine(): RAGEngine | null {
  return defaultEngine;
}

/**
 * Index a bundle (convenience function).
 */
export async function indexBundle(
  bundlePath: string,
  bundleId: string,
  config: RAGConfig
): Promise<IndexResult> {
  const engine = new RAGEngine(config);
  return engine.indexBundle(bundlePath, bundleId);
}

/**
 * Query RAG (convenience function).
 */
export async function ragQuery(
  question: string,
  config: RAGConfig,
  options?: QueryOptions
): Promise<QueryResult> {
  const engine = new RAGEngine(config);
  return engine.query(question, options);
}
