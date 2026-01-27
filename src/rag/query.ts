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
import { ContextCompleter } from './context-completer.js';
import type { SemanticChunk } from '../bridge/types.js';
import path from 'node:path';
import { readManifest, type BundleManifestV1 } from '../bundle/manifest.js';
import { extractPaperId } from '../bundle/content-id.js';
import type { 
  QueryOptions, 
  QueryResult, 
  IndexResult,
  RAGConfig,
  DEFAULT_QUERY_OPTIONS,
} from './types.js';
import { createModuleLogger } from '../logging/logger.js';
import { persistQAReport, runFullQA } from '../quality/index-qa.js';

const logger = createModuleLogger('rag');

// ============================================================================
// Index Options
// ============================================================================

/**
 * Index options for deduplication control.
 */
export interface IndexOptions {
  /** 
   * Force re-index even if content already exists.
   * Default: true for PDF content (to handle parser/strategy changes)
   * Default: false for other content
   */
  force?: boolean;
}

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
  private contextCompleter: ContextCompleter;

  constructor(config: RAGConfig) {
    this.chromaDB = new ChromaVectorDB({ url: config.chromaUrl });
    this.embedding = config.embedding;
    this.llm = config.llm;
    this.kgStorage = new KGStorage();
    this.retriever = new RAGRetriever(this.chromaDB, this.embedding, this.kgStorage);
    this.generator = new RAGGenerator(this.llm);
    this.contextCompleter = new ContextCompleter({
      chromaDB: this.chromaDB,
      embedding: this.embedding,
    });
  }

  /**
   * Convert ChunkDocument to SemanticChunk format.
   */
  private toSemanticChunk(chunk: { id: string; content: string; metadata: any }): SemanticChunk {
    return {
      id: chunk.id,
      content: chunk.content,
      chunkType: (chunk.metadata.chunkType as SemanticChunk['chunkType']) ?? 'text',
      isComplete: true,
      metadata: {
        sourceType: chunk.metadata.sourceType,
        bundleId: chunk.metadata.bundleId,
        repoId: chunk.metadata.repoId,
        filePath: chunk.metadata.filePath,
        chunkIndex: chunk.metadata.chunkIndex,
      },
    };
  }

  /**
   * Check if ChromaDB is available.
   */
  async isAvailable(): Promise<boolean> {
    return this.chromaDB.isAvailable();
  }

  /**
   * Index a bundle to ChromaDB.
   * Performs deduplication check based on source file contentHash.
   */
  async indexBundle(
    bundlePath: string,
    bundleId: string,
    options?: IndexOptions
  ): Promise<IndexResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let chunksWritten = 0;
    let entitiesCount = 0;
    let relationsCount = 0;
    let contentHash: string | undefined;
    let paperId: string | undefined;
    let paperVersion: string | undefined;
    let existingChunks: number | undefined;
    let deletedChunks: number | undefined;

    try {
      // Read manifest to get contentHash (headSha) and source URL
      const manifestPath = path.join(bundlePath, 'manifest.json');
      let manifest: BundleManifestV1 | undefined;
      try {
        manifest = await readManifest(manifestPath);
      } catch {
        logger.warn(`Could not read manifest, skipping dedup check`);
      }

      // Extract contentHash and paperId from manifest
      if (manifest?.repos?.[0]) {
        const repo = manifest.repos[0];
        contentHash = repo.headSha;
        
        // Extract paperId from PDF URL if available
        // Check both repos[].pdfUrl and inputs.repos[].url
        const inputRepo = manifest.inputs?.repos?.[0] as { url?: string; name?: string } | undefined;
        const pdfUrl = repo.pdfUrl ?? inputRepo?.url;
        if (pdfUrl) {
          const paperInfo = extractPaperId(pdfUrl);
          paperId = paperInfo.paperId;
          paperVersion = paperInfo.version;
        }
        
        // Fallback: use name from inputs.repos[].name (user can set this manually)
        // Format: "arxiv-2601.14287-v1" or just "my-paper-name"
        if (!paperId && inputRepo?.name) {
          const paperInfo = extractPaperId(inputRepo.name);
          if (paperInfo.paperId) {
            paperId = paperInfo.paperId;
            paperVersion = paperInfo.version;
          } else {
            // Use name as-is if no arXiv/DOI pattern found
            paperId = `name:${inputRepo.name}`;
          }
        }
      }

      // Determine if this is PDF content (based on paperId or URL patterns)
      const isPdfContent = !!(paperId || manifest?.repos?.[0]?.pdfUrl);
      
      // For PDF: default to force=true (to handle parser/strategy changes)
      // User can explicitly set force=false to skip if already indexed
      const shouldForce = options?.force ?? isPdfContent;
      
      // Deduplication check (only if not forcing)
      if (contentHash && !shouldForce) {
        const existing = await this.chromaDB.getChunksByContentHash(contentHash);
        if (existing.length > 0) {
          logger.info(`Content already indexed: ${contentHash.slice(0, 12)}... (${existing.length} chunks)`);
          return {
            chunksWritten: 0,
            entitiesCount: 0,
            relationsCount: 0,
            errors: [],
            durationMs: Date.now() - startTime,
            skipped: true,
            contentHash,
            paperId,
            paperVersion,
            existingChunks: existing.length,
          };
        }
      }

      // Force replace: delete existing chunks first
      if (contentHash && shouldForce) {
        deletedChunks = await this.chromaDB.deleteByContentHash(contentHash);
        if (deletedChunks > 0) {
          logger.info(`Deleted ${deletedChunks} existing chunks for replacement (PDF auto-force: ${isPdfContent && options?.force === undefined})`);
        }
      }

      // 1. Bridge: Index documents (CARD.json, README.md, OVERVIEW.md)
      logger.info(`Indexing documents from ${bundlePath}...`);
      const bridgeResult = await bridgeIndexBundle(
        bundlePath,
        bundleId,
        this.chromaDB,
        { 
          embedding: this.embedding,
          contentHash,
          paperId,
          paperVersion,
        }
      );
      chunksWritten = bridgeResult.chunksWritten;
      errors.push(...bridgeResult.errors);
      logger.info(`Indexed ${chunksWritten} document chunks`);

      // 1.1 Index-Time QA for PDF (must run before bundle deletion; persist to vector DB)
      if (isPdfContent && contentHash && bridgeResult.pdfArtifacts && bridgeResult.pdfArtifacts.length > 0) {
        for (const artifact of bridgeResult.pdfArtifacts) {
          try {
            const queryFn = this.llm
              ? async (question: string) => {
                  const r = await this.query(question, {
                    bundleId,
                    mode: 'naive',
                    topK: 12,
                    enableContextCompletion: true,
                    maxHops: 3,
                    enableVerification: true,
                    retryOnLowFaithfulness: true,
                  });
                  return { answer: r.answer, faithfulness: r.faithfulnessScore };
                }
              : undefined;

            const report = await runFullQA(
              artifact.markdown,
              artifact.chunks,
              contentHash,
              paperId,
              queryFn
            );

            await persistQAReport(this.chromaDB, report, this.embedding);

            if (!report.passed) {
              const msg = `Index QA failed for ${paperId ?? contentHash.slice(0, 12)}: ${report.allIssues.join('; ')}`;
              logger.error(msg);
              errors.push(msg);
            }
          } catch (err) {
            const msg = `Index QA error: ${err}`;
            logger.error(msg);
            errors.push(msg);
          }
        }
      }

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
      contentHash,
      paperId,
      paperVersion,
      deletedChunks,
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
      expandToParent: options?.expandToParent ?? false,
      expandToSiblings: options?.expandToSiblings ?? false,
    };

    // If KG is empty and bundleId provided, try to load from ChromaDB
    if (this.kgStorage.getStats().nodeCount === 0 && options?.bundleId) {
      await this.loadAstGraph(options.bundleId);
    }

    // Build filter (Phase 1: Cross-bundle support)
    let filter: { bundleId?: string; bundleIds?: string[]; repoId?: string } | undefined;
    
    const crossMode = options?.crossBundleMode ?? 'single';
    if (crossMode === 'all') {
      // Query all bundles: no bundleId filter
      filter = options?.repoId ? { repoId: options.repoId } : undefined;
    } else if (crossMode === 'specified' && options?.bundleIds && options.bundleIds.length > 0) {
      // Query specified bundles
      filter = {
        bundleIds: options.bundleIds,
        repoId: options?.repoId,
      };
    } else {
      // Single bundle mode (default, backward compatible)
      filter = options?.bundleId || options?.repoId
        ? { bundleId: options.bundleId, repoId: options.repoId }
        : undefined;
    }

    // Retrieve
    logger.info(`Retrieving context for: "${question}" (mode: ${opts.mode})`);
    const retrieved = await this.retriever.retrieve(
      question,
      opts.mode,
      opts.topK,
      filter,
      {
        expandToParent: opts.expandToParent,
        expandToSiblings: opts.expandToSiblings,
      }
    );

    logger.info(`Retrieved ${retrieved.chunks.length} chunks`);

    // Multi-hop context completion (if enabled)
    let finalChunks = retrieved.chunks;
    let contextCompletionStats: { hopCount: number; searchHistory: string[] } | undefined;

    if (opts.enableContextCompletion && retrieved.chunks.length > 0) {
      try {
        // Set filter for context completer
        this.contextCompleter.setFilter(filter);

        // Convert to SemanticChunk format for completer
        const semanticChunks = retrieved.chunks.map(c => this.toSemanticChunk(c));

        const completionResult = await this.contextCompleter.complete(
          semanticChunks,
          { maxDepth: opts.maxHops, maxBreadth: 5 }
        );

        // Add new chunks with lower score
        if (completionResult.chunks.length > retrieved.chunks.length) {
          const existingIds = new Set(retrieved.chunks.map(c => c.id));
          
          finalChunks = [...retrieved.chunks];
          for (const chunk of completionResult.chunks) {
            if (!existingIds.has(chunk.id)) {
              finalChunks.push({
                id: chunk.id,
                content: chunk.content,
                metadata: {
                  sourceType: chunk.metadata.sourceType,
                  bundleId: chunk.metadata.bundleId,
                  repoId: chunk.metadata.repoId,
                  filePath: chunk.metadata.filePath,
                  chunkIndex: chunk.metadata.chunkIndex,
                  chunkType: chunk.chunkType,
                },
                score: 0.5, // Lower score for hop-retrieved chunks
              });
            }
          }
          
          logger.info(
            `Context completion: ${completionResult.hopCount} hops, ` +
            `added ${finalChunks.length - retrieved.chunks.length} chunks`
          );
        }

        contextCompletionStats = {
          hopCount: completionResult.hopCount,
          searchHistory: completionResult.searchHistory,
        };
      } catch (err) {
        logger.warn(`Context completion failed: ${err}`);
      }
    }

    // Generate with final context
    const generated = await this.generator.generate(
      question,
      { ...retrieved, chunks: finalChunks },
      {
        enableVerification: opts.enableVerification,
        retryOnLowFaithfulness: opts.retryOnLowFaithfulness,
      }
    );

    return {
      answer: generated.answer,
      sources: generated.sources,
      relatedEntities: generated.relatedEntities,
      faithfulnessScore: generated.faithfulnessScore,
      stats: {
        chunksRetrieved: finalChunks.length,
        entitiesFound: retrieved.expandedTypes?.length,
        graphExpansion: retrieved.expandedTypes?.length ?? 0,
        contextCompletionHops: contextCompletionStats?.hopCount,
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
