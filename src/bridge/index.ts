/**
 * Bridge module - Distill → ChromaDB bridging.
 * @module bridge
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ChunkDocument } from '../vectordb/types.js';
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

// ============================================================================
// Unified Bridge Interface
// ============================================================================

/**
 * Index a bundle to ChromaDB.
 * Processes all indexable files (OVERVIEW.md, CARD.json, README.md).
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
        
        if (preprocessResult.stats.pageMarkersRemoved > 0 ||
            preprocessResult.stats.tablesConverted > 0 ||
            preprocessResult.stats.imagesDescribed > 0) {
          logger.info(
            `PDF preprocessing: ${preprocessResult.stats.pageMarkersRemoved} page markers, ` +
            `${preprocessResult.stats.tablesConverted} tables, ` +
            `${preprocessResult.stats.imagesDescribed} images`
          );
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

  // Batch upsert to ChromaDB
  if (allChunks.length > 0) {
    try {
      await chromaDB.upsertChunks(allChunks);
      totalResult.chunksWritten = allChunks.length;
      logger.info(`Upserted ${allChunks.length} chunks to ChromaDB`);
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
