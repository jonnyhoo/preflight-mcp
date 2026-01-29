/**
 * Bridge module - Distill → ChromaDB bridging.
 * @module bridge
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ChunkDocument, CollectionLevel, SourceType } from '../vectordb/types.js';
import { ChromaVectorDB } from '../vectordb/chroma-client.js';
import type { BridgeSource, BridgeOptions, BridgeResult, PdfIndexArtifact } from './types.js';
import { 
  locateFilesToIndex, 
  bridgeRepoCard, 
  bridgeReadme, 
  bridgeOverview 
} from './repocard-bridge.js';
import { bridgePdfMarkdown } from './markdown-bridge.js';
import { preprocessPdfMarkdown } from '../rag/pdf-preprocessor.js';
import { extractArxivCategory } from '../bundle/content-id.js';
import { classifyBundleRepo } from '../bundle/repo-classifier.js';
import { bridgeCodeFiles } from './code-bridge.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('bridge');

// Types
export type {
  SemanticChunk,
  SemanticChunkMetadata,
  BridgeSource,
  BridgeOptions,
  BridgeResult,
  IndexableFiles,
  IndexableRepo,
  ChunkOptions,
} from './types.js';

export { DEFAULT_CHUNK_OPTIONS } from './types.js';

// Chunker
export { semanticChunk, simpleChunk } from './semantic-chunker.js';

// RepoCard bridge
export { 
  repoCardToChunks, 
  locateFilesToIndex,
  bridgeRepoCard,
  bridgeReadme,
  bridgeOverview,
} from './repocard-bridge.js';

// Markdown bridge (PDF/Web)
export type {
  MarkdownSource,
  MarkdownBridgeResult,
  PdfBridgeSource,
  WebBridgeSource,
} from './markdown-bridge.js';

export {
  bridgeMarkdown,
  bridgePdfMarkdown,
  bridgeWebMarkdown,
} from './markdown-bridge.js';

// Code bridge
export type {
  CodeBridgeOptions,
  CodeBridgeResult,
} from './code-bridge.js';

export {
  bridgeCodeFiles,
  bridgeCodeFile,
} from './code-bridge.js';

// Repo classifier
export type {
  RepoType,
  RepoClassification,
} from '../bundle/repo-classifier.js';

export {
  classifyRepo,
  classifyBundleRepo,
  isCodeBundle,
  isDocumentationBundle,
} from '../bundle/repo-classifier.js';

// ============================================================================
// Unified Bridge Interface
// ============================================================================

/**
 * Index a bundle to ChromaDB.
 * Processes all indexable files (OVERVIEW.md, CARD.json, README.md, code files).
 * 
 * Indexing strategy based on repo classification:
 * - Code repos: L1_repo (CARD) + L2_code (functions/classes)
 * - Documentation repos: L1_doc (overview) + L2_section (markdown sections)
 * - Hybrid repos: Both strategies
 */
export async function indexBundle(
  bundlePath: string,
  bundleId: string,
  chromaDB: ChromaVectorDB,
  options: BridgeOptions
): Promise<BridgeResult> {
  const totalResult: BridgeResult = {
    chunksWritten: 0,
    chunksByType: {} as BridgeResult['chunksByType'],
    errors: [],
  };

  const allChunks: ChunkDocument[] = [];
  const pdfArtifacts: PdfIndexArtifact[] = [];

  // Locate all indexable files
  const files = await locateFilesToIndex(bundlePath);
  logger.info(`Found ${files.repos.length} repos to index`);

  // Index OVERVIEW.md
  if (files.overviewPath) {
    try {
      const { chunks, result } = await bridgeOverview(files.overviewPath, bundleId, options);
      allChunks.push(...chunks);
      mergeResults(totalResult, result);
      logger.info(`Indexed OVERVIEW.md: ${result.chunksWritten} chunks`);
    } catch (err) {
      const msg = `Failed to index OVERVIEW.md: ${err}`;
      logger.error(msg);
      totalResult.errors.push(msg);
    }
  }

  // Index each repo
  for (const repo of files.repos) {
    // Index CARD.json
    if (repo.cardPath) {
      try {
        const { chunks, result } = await bridgeRepoCard(repo.cardPath, bundleId, options);
        allChunks.push(...chunks);
        mergeResults(totalResult, result);
        logger.info(`Indexed ${repo.repoId} CARD.json: ${result.chunksWritten} chunks`);
      } catch (err) {
        const msg = `Failed to index ${repo.repoId} CARD.json: ${err}`;
        logger.error(msg);
        totalResult.errors.push(msg);
      }
    }

    // Index README.md
    if (repo.readmePath) {
      try {
        const { chunks, result } = await bridgeReadme(
          repo.readmePath, 
          bundleId, 
          repo.repoId, 
          options
        );
        allChunks.push(...chunks);
        mergeResults(totalResult, result);
        logger.info(`Indexed ${repo.repoId} README.md: ${result.chunksWritten} chunks`);
      } catch (err) {
        const msg = `Failed to index ${repo.repoId} README.md: ${err}`;
        logger.error(msg);
        totalResult.errors.push(msg);
      }
    }

    // Index code files (for github/local repos)
    if (repo.kind === 'github' || repo.kind === 'local') {
      try {
        // Determine code path: prefer repos/<repoId>/norm if exists, fallback to repos/<repoId>
        const baseRepoPath = path.join(bundlePath, 'repos', repo.repoId);
        const normPath = path.join(baseRepoPath, 'norm');
        let codePath: string;
        try {
          await fs.access(normPath);
          codePath = normPath; // Use norm/ subdirectory (bundle structure)
          logger.debug(`Using norm path for code analysis: ${normPath}`);
        } catch {
          codePath = baseRepoPath; // Fallback to repo root
        }
        
        // Classify the repo to determine indexing strategy
        const classification = await classifyBundleRepo(bundlePath, repo.repoId);
        logger.info(`Repo ${repo.repoId} classified as ${classification.type} (code ratio: ${classification.codeRatio.toFixed(2)})`);
        
        // Index code for code and hybrid repos
        if (classification.type === 'code' || classification.type === 'hybrid') {
          const { chunks, result } = await bridgeCodeFiles(
            codePath,
            bundleId,
            repo.repoId,
            options
          );
          allChunks.push(...chunks);
          mergeResults(totalResult, result);
          logger.info(`Indexed ${repo.repoId} code: ${result.chunksWritten} chunks (${result.symbolsIndexed} symbols)`);
        }
      } catch (err) {
        const msg = `Failed to index ${repo.repoId} code: ${err}`;
        logger.error(msg);
        totalResult.errors.push(msg);
      }
    }

    // Index PDF markdown (pdf_xxx.md)
    if (repo.pdfMarkdownPath) {
      try {
        let pdfMarkdown = await fs.readFile(repo.pdfMarkdownPath, 'utf8');
        
        // Apply Index-Time PDF preprocessing for best quality
        // This must happen BEFORE chunking (bundle will be deleted after indexing)
        // IMPORTANT: repo.pdfMarkdownPath is typically under bundle root (e.g. <bundle>/pdf_xxx.md).
        // Use the actual bundlePath here; do NOT climb directories, otherwise images won't resolve.
        const preprocessResult = await preprocessPdfMarkdown(pdfMarkdown, {
          bundlePath,
          enableImageDescription: true,
          enableDehyphenation: true,
        });
        pdfMarkdown = preprocessResult.markdown;
        
        // DEBUG: Check if pagebreak comments exist
        const pagebreakCount = (pdfMarkdown.match(/<!-- pagebreak:\d+ -->/g) || []).length;
        logger.info(`[DEBUG] Pagebreak comments in preprocessed markdown: ${pagebreakCount}`);
        const lines = pdfMarkdown.split('\n');
        logger.info(`[DEBUG] First 10 lines of preprocessed markdown:`);
        for (let i = 0; i < Math.min(10, lines.length); i++) {
          logger.info(`[DEBUG]   Line ${i}: ${lines[i]?.substring(0, 80) ?? ''}`);
        }
        
        if (preprocessResult.stats.pageMarkersRemoved > 0 ||
            preprocessResult.stats.tablesConverted > 0 ||
            preprocessResult.stats.imagesDescribed > 0) {
          logger.info(
            `PDF preprocessing: ${preprocessResult.stats.pageMarkersRemoved} page markers, ` +
            `${preprocessResult.stats.tablesConverted} tables, ` +
            `${preprocessResult.stats.imagesDescribed} images`
          );
        }
        
        // Extract arXiv category from PDF first page (Phase 3)
        const categoryInfo = extractArxivCategory(pdfMarkdown);
        if (categoryInfo.primary) {
          logger.info(`Extracted arXiv category: ${categoryInfo.primary} (all: ${categoryInfo.all.join(', ')})`);
        }

        const pdfResult = await bridgePdfMarkdown(
          {
            bundleId,
            repoId: repo.repoId,
            pdfPath: repo.pdfMarkdownPath,
            markdown: pdfMarkdown,
          },
          options
        );

        // Add arXiv category to all PDF chunks
        if (categoryInfo.primary) {
          for (const chunk of pdfResult.chunks) {
            chunk.metadata.arxivCategory = categoryInfo.primary;
          }
        }

        allChunks.push(...pdfResult.chunks);
        mergeResults(totalResult, pdfResult);

        // Capture artifacts for index-time QA (exactly what we indexed)
        pdfArtifacts.push({
          repoId: repo.repoId,
          pdfMarkdownPath: repo.pdfMarkdownPath,
          markdown: pdfMarkdown,
          preprocessStats: preprocessResult.stats,
          chunks: pdfResult.chunks,
        });

        logger.info(`Indexed ${repo.repoId} PDF markdown: ${pdfResult.chunksWritten} chunks`);
      } catch (err) {
        const msg = `Failed to index ${repo.repoId} PDF markdown: ${err}`;
        logger.error(msg);
        totalResult.errors.push(msg);
      }
    }
  }

  // Add contentHash, paperId, paperVersion to all chunk metadata (for deduplication)
  if (options.contentHash || options.paperId) {
    for (const chunk of allChunks) {
      if (options.contentHash) {
        chunk.metadata.contentHash = options.contentHash;
      }
      if (options.paperId) {
        chunk.metadata.paperId = options.paperId;
      }
      if (options.paperVersion) {
        chunk.metadata.paperVersion = options.paperVersion;
      }
    }
  }

  // Upsert to hierarchical collections (Phase 3: L1/L2/L3)
  if (allChunks.length > 0) {
    try {
      await upsertToHierarchicalCollections(chromaDB, allChunks);
      totalResult.chunksWritten = allChunks.length;
      logger.info(`Upserted ${allChunks.length} chunks to hierarchical collections`);
    } catch (err) {
      const msg = `Failed to upsert chunks: ${err}`;
      logger.error(msg);
      totalResult.errors.push(msg);
    }
  }

  if (pdfArtifacts.length > 0) {
    totalResult.pdfArtifacts = pdfArtifacts;
  }

  return totalResult;
}

function mergeResults(target: BridgeResult, source: BridgeResult): void {
  for (const [type, count] of Object.entries(source.chunksByType)) {
    const key = type as keyof BridgeResult['chunksByType'];
    target.chunksByType[key] = (target.chunksByType[key] ?? 0) + count;
  }
  target.errors.push(...source.errors);
}

// ============================================================================
// Hierarchical Collection Distribution (Phase 3)
// ============================================================================

/**
 * Determine which L1 content type a chunk belongs to.
 * Used for routing to the correct L1 collection.
 */
function getL1ContentType(chunk: ChunkDocument): 'pdf' | 'repo' | 'doc' | 'memory' | 'web' | null {
  const { sourceType } = chunk.metadata;
  
  // PDF papers
  if (['pdf_text', 'pdf_table', 'pdf_formula', 'pdf_image'].includes(sourceType)) {
    return 'pdf';
  }
  
  // Code repositories (including code chunks)
  if (sourceType === 'repocard' || sourceType === 'readme' || sourceType === 'code') {
    return 'repo';
  }
  
  // Overview (generic docs)
  if (sourceType === 'overview') {
    return 'doc';
  }
  
  // Default: treat as doc
  return 'doc';
}

/**
 * Determine which collection level a chunk should be assigned to.
 * 
 * L1 Rules (coarse-grained overviews):
 * - overview sourceType → L1_doc
 * - repocard sourceType → L1_repo
 * - pdf_text with granularity='section' and headingLevel=1 (Abstract, Introduction) → L1_pdf
 * 
 * L2 Rules (section-level):
 * - pdf_text with section granularity or headingLevel ≤ 2 → L2_section
 * 
 * L3 Rules (fragment-level):
 * - All others (paragraphs, tables, formulas, images) → L3_chunk
 */
function getCollectionLevel(chunk: ChunkDocument): CollectionLevel {
  const { sourceType, granularity, headingLevel, sectionHeading } = chunk.metadata;
  const l1Type = getL1ContentType(chunk);
  
  // L1: Overview-level content
  // - Bundle overview
  if (sourceType === 'overview') {
    return 'l1_doc';
  }
  
  // - RepoCard (repository summary)
  if (sourceType === 'repocard') {
    return 'l1_repo';
  }
  
  // - PDF Abstract/Introduction (headingLevel=1 with specific section names)
  // Handles both "Abstract" and "1. Introduction" formats
  if (
    sourceType === 'pdf_text' &&
    granularity === 'section' &&
    headingLevel === 1 &&
    sectionHeading
  ) {
    // Extract section name without number prefix (e.g., "1. Introduction" -> "Introduction")
    const sectionName = sectionHeading.replace(/^\d+\.?\s*/, '').trim();
    if (/^(abstract|introduction|summary|overview)$/i.test(sectionName)) {
      return 'l1_pdf';
    }
  }
  
  // L2: Section-level content
  // - Explicit section granularity
  // - Top-level headings (h1, h2) in PDF
  // - Code chunks (functions, classes, methods)
  if (
    granularity === 'section' ||
    (sourceType === 'pdf_text' && headingLevel && headingLevel <= 2)
  ) {
    return 'l2_section';
  }
  
  // Code chunks go to L2_section (they represent logical units like functions/classes)
  if (sourceType === 'code') {
    return 'l2_section';
  }
  
  // L3: Fragment-level (default)
  // - Paragraphs, tables, formulas, figures
  // - Lower-level headings (h3+)
  return 'l3_chunk';
}

/**
 * Upsert chunks to hierarchical collections based on their level.
 * Phase 3: Distributes chunks to l1_{type}, l2_section, l3_chunk.
 */
async function upsertToHierarchicalCollections(
  chromaDB: ChromaVectorDB,
  chunks: ChunkDocument[]
): Promise<void> {
  // Group chunks by collection level
  const levelGroups = new Map<CollectionLevel, ChunkDocument[]>();

  for (const chunk of chunks) {
    const level = getCollectionLevel(chunk);
    chunk.metadata.collectionLevel = level;
    
    if (!levelGroups.has(level)) {
      levelGroups.set(level, []);
    }
    levelGroups.get(level)!.push(chunk);
  }

  // Upsert to each level in parallel
  const promises: Promise<void>[] = [];
  const stats: string[] = [];
  
  for (const [level, levelChunks] of levelGroups) {
    if (levelChunks.length > 0) {
      promises.push(chromaDB.upsertHierarchicalChunks(level, levelChunks));
      stats.push(`${level}=${levelChunks.length}`);
    }
  }

  await Promise.all(promises);
  
  logger.info(`Hierarchical distribution: ${stats.join(', ')}`);
}
