/**
 * Bridge module - Distill → ChromaDB bridging.
 * @module bridge
 */

import type { ChunkDocument } from '../vectordb/types.js';
import { ChromaVectorDB } from '../vectordb/chroma-client.js';
import type { BridgeSource, BridgeOptions, BridgeResult } from './types.js';
import { 
  locateFilesToIndex, 
  bridgeRepoCard, 
  bridgeReadme, 
  bridgeOverview 
} from './repocard-bridge.js';
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

  return totalResult;
}

function mergeResults(target: BridgeResult, source: BridgeResult): void {
  for (const [type, count] of Object.entries(source.chunksByType)) {
    const key = type as keyof BridgeResult['chunksByType'];
    target.chunksByType[key] = (target.chunksByType[key] ?? 0) + count;
  }
  target.errors.push(...source.errors);
}
