/**
 * RAG Query - Main entry point for RAG operations.
 * 
 * @module rag/query
 */

import { ChromaVectorDB } from '../vectordb/chroma-client.js';
import { indexBundle as bridgeIndexBundle } from '../bridge/index.js';
import { RAGRetriever } from './retriever.js';
import { RAGGenerator } from './generator.js';
import { ContextCompleter } from './context-completer.js';
import { HierarchicalRetriever } from './hierarchical-retriever.js';
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
import { IGPPruner, type IGPOptions } from './pruning/igp-pruner.js';
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
  private retriever: RAGRetriever;
  private hierarchicalRetriever: HierarchicalRetriever;
  private generator: RAGGenerator;
  private contextCompleter: ContextCompleter;

  constructor(config: RAGConfig) {
    this.chromaDB = new ChromaVectorDB({ url: config.chromaUrl });
    this.embedding = config.embedding;
    this.llm = config.llm;
    this.retriever = new RAGRetriever(this.chromaDB, this.embedding);
    this.hierarchicalRetriever = new HierarchicalRetriever(this.chromaDB, this.embedding);
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
      
      // Deduplication check (only if not forcing) - use hierarchical collections
      if (contentHash && !shouldForce) {
        const existing = await this.chromaDB.getChunksByContentHashHierarchical(contentHash);
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

      // Force replace: delete existing chunks first (use hierarchical collections)
      if (contentHash && shouldForce) {
        deletedChunks = await this.chromaDB.deleteByContentHashHierarchical(contentHash);
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

      // Note: AST graph storage removed - code symbols are now directly vectorized
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
   * Query the RAG system.
   */
  async query(question: string, options?: QueryOptions): Promise<QueryResult> {
    const startTime = Date.now();
    const opts = {
      mode: options?.mode ?? 'naive', // Default to naive since KG graph expansion removed
      topK: options?.topK ?? 10,
      enableContextCompletion: options?.enableContextCompletion ?? true,
      maxHops: options?.maxHops ?? 2,
      enableVerification: options?.enableVerification ?? false,
      retryOnLowFaithfulness: options?.retryOnLowFaithfulness ?? false,
      expandToParent: options?.expandToParent ?? false,
      expandToSiblings: options?.expandToSiblings ?? false,
    };

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

    // Phase 3: Determine if hierarchical retrieval should be used
    // Auto-enable for crossBundleMode='all', or when explicitly enabled
    const useHierarchical = options?.enableHierarchicalRetrieval ?? (crossMode === 'all');

    // Retrieve (use hierarchical retriever for large-scale queries)
    let retrieved: { chunks: Array<any & { score: number }>; expandedTypes?: string[] };
    let hierarchicalStats: { l1ByType: Record<string, number>; l1TotalFound: number; l2l3ChunksFound: number; durationMs: number } | undefined;

    if (useHierarchical) {
      // Phase 3: Hierarchical retrieval (L1 → L2/L3)
      logger.info(`[Hierarchical] Retrieving context for: "${question}"`);
      const hierarchicalResult = await this.hierarchicalRetriever.retrieve(question, {
        l1TopK: options?.hierarchicalL1TopK ?? 10,
        l2l3TopK: options?.hierarchicalL2L3TopK ?? 15,
        arxivCategory: options?.arxivCategory,
      });
      
      retrieved = {
        chunks: hierarchicalResult.chunks,
        expandedTypes: [],
      };
      hierarchicalStats = hierarchicalResult.stats;
      
      logger.info(
        `[Hierarchical] Retrieved ${retrieved.chunks.length} chunks ` +
        `(L1: ${JSON.stringify(hierarchicalStats.l1ByType)}, L2/L3: ${hierarchicalStats.l2l3ChunksFound} chunks)`
      );
    } else {
      // Standard retrieval (backward compatible)
      logger.info(`Retrieving context for: "${question}" (mode: ${opts.mode})`);
      retrieved = await this.retriever.retrieve(
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
    }

    // Multi-hop context completion (if enabled)
    let finalChunks = retrieved.chunks;
    let contextCompletionStats: { hopCount: number; searchHistory: string[] } | undefined;
    let igpStats: { originalCount: number; prunedCount: number; pruningRatio: number; iterations: number; durationMs: number } | undefined;

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

    // IGP Pruning (Phase 2) - Apply after context completion, before generation
    // Only enabled when igpOptions.enabled is true
    if (options?.igpOptions?.enabled && finalChunks.length > 0) {
      try {
        const igpPruner = new IGPPruner();
        // Paper Algorithm 1: default to threshold strategy with Tp=0
        const igpOptions: IGPOptions = {
          enabled: true,
          strategy: options.igpOptions.strategy ?? 'threshold',
          threshold: options.igpOptions.threshold ?? 0, // Filter negative-IG chunks
          topK: options.igpOptions.topK ?? 5,
          keepRatio: options.igpOptions.keepRatio ?? 0.5,
          maxIterations: options.igpOptions.maxIterations ?? 1,
          nuOptions: { topK: 5, maxTokens: 20 },
          batchSize: 5,
        };

        const igpResult = await igpPruner.prune(question, finalChunks, igpOptions);
        
        // Update chunks with pruned result
        finalChunks = igpResult.chunks.map(c => ({
          id: c.id,
          content: c.content,
          metadata: c.metadata,
          score: c.score,
        }));

        igpStats = {
          originalCount: igpResult.originalCount,
          prunedCount: igpResult.prunedCount,
          pruningRatio: igpResult.pruningRatio,
          iterations: igpResult.iterations,
          durationMs: igpResult.durationMs,
        };

        logger.info(`IGP pruning: ${igpResult.originalCount} → ${igpResult.prunedCount} chunks (${(igpResult.pruningRatio * 100).toFixed(1)}%)`);
      } catch (err) {
        logger.warn(`IGP pruning failed, using unpruned chunks: ${err}`);
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
        igpStats,
        hierarchicalStats,
        durationMs: Date.now() - startTime,
      },
    };
  }

  /**
   * Delete all data for a bundle (from hierarchical collections).
   */
  async deleteBundle(bundleId: string): Promise<void> {
    await this.chromaDB.deleteByBundleHierarchical(bundleId);
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
