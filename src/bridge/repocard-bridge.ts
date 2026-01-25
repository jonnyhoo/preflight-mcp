/**
 * RepoCard Bridge - Convert RepoCard JSON to vector chunks.
 * 
 * @module bridge/repocard-bridge
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RepoCard } from '../distill/types.js';
import type { ChunkDocument } from '../vectordb/types.js';
import type { SemanticChunk, BridgeOptions, BridgeResult, ChunkOptions, IndexableFiles } from './types.js';
import { semanticChunk, simpleChunk } from './semantic-chunker.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('bridge');

// ============================================================================
// RepoCard → Chunks
// ============================================================================

/**
 * Convert RepoCard to semantic chunks.
 */
export function repoCardToChunks(card: RepoCard, bundleId: string): SemanticChunk[] {
  const chunks: SemanticChunk[] = [];
  const baseOptions: ChunkOptions = {
    sourceType: 'repocard',
    bundleId,
    repoId: card.repoId,
  };
  let index = 0;

  // Summary chunk: oneLiner + problemSolved
  const summaryContent = [
    `# ${card.name}`,
    '',
    card.oneLiner,
    '',
    card.problemSolved,
  ].join('\n');
  chunks.push(simpleChunk(summaryContent, 'summary', 'summary', baseOptions, index++));

  // Use cases
  if (card.useCases.length > 0) {
    const useCasesContent = [
      '## Use Cases',
      '',
      ...card.useCases.map((uc) => `- ${uc}`),
    ].join('\n');
    chunks.push(simpleChunk(useCasesContent, 'list', 'useCases', baseOptions, index++));
  }

  // Design highlights
  if (card.designHighlights.length > 0) {
    const designContent = [
      '## Design Highlights',
      '',
      ...card.designHighlights.map((d) => `- ${d}`),
    ].join('\n');
    chunks.push(simpleChunk(designContent, 'list', 'designHighlights', baseOptions, index++));
  }

  // Key APIs
  if (card.keyAPIs.length > 0) {
    const apiContent = [
      '## Key APIs',
      '',
      ...card.keyAPIs.map((api) => `- \`${api}\``),
    ].join('\n');
    chunks.push(simpleChunk(apiContent, 'api', 'keyAPIs', baseOptions, index++));
  }

  // Quick start
  if (card.quickStart) {
    const quickStartContent = [
      '## Quick Start',
      '',
      card.quickStart,
    ].join('\n');
    chunks.push(simpleChunk(quickStartContent, 'code', 'quickStart', baseOptions, index++));
  }

  // Limitations
  if (card.limitations.length > 0) {
    const limitationsContent = [
      '## Limitations',
      '',
      ...card.limitations.map((l) => `- ${l}`),
    ].join('\n');
    chunks.push(simpleChunk(limitationsContent, 'list', 'limitations', baseOptions, index++));
  }

  // Tags and frameworks
  const metaContent = [
    '## Metadata',
    '',
    `Language: ${card.language}`,
    `Frameworks: ${card.frameworks.join(', ') || 'None'}`,
    `Tags: ${card.tags.join(', ') || 'None'}`,
  ].join('\n');
  chunks.push(simpleChunk(metaContent, 'text', 'metadata', baseOptions, index++));

  return chunks;
}

// ============================================================================
// File Locator
// ============================================================================

interface BundleManifest {
  bundleId: string;
  repos?: Array<{
    id: string;
    kind?: string; // 'github' | 'pdf' | 'web' etc.
  }>;
}

/**
 * Locate all indexable files in a bundle.
 */
export async function locateFilesToIndex(bundlePath: string): Promise<IndexableFiles> {
  const manifestPath = path.join(bundlePath, 'manifest.json');
  
  let manifest: BundleManifest;
  try {
    const content = await fs.readFile(manifestPath, 'utf8');
    manifest = JSON.parse(content);
  } catch {
    logger.warn(`No manifest.json found at ${bundlePath}`);
    return { overviewPath: null, repos: [] };
  }

  // Check OVERVIEW.md
  const overviewPath = path.join(bundlePath, 'OVERVIEW.md');
  const hasOverview = await fileExists(overviewPath);

  // Process repos
  const repos = await Promise.all(
    (manifest.repos ?? []).map(async (repo) => {
      const repoId = repo.id;
      const kind = repo.kind;
      // PDF repos use '_' as separator, others use '~'
      const safeRepoId = kind === 'pdf' 
        ? repoId.replace(/\//g, '_') 
        : repoId.replace(/\//g, '~');
      
      const cardPath = path.join(bundlePath, 'cards', safeRepoId, 'CARD.json');
      const readmePath = path.join(bundlePath, 'repos', repoId, 'norm', 'README.md');
      // Also check root README
      const rootReadmePath = path.join(bundlePath, 'repos', repoId, 'README.md');

      // PDF markdown path for PDF repos
      let pdfMarkdownPath: string | undefined;
      if (kind === 'pdf') {
        const pdfMdPath = path.join(bundlePath, `pdf_${safeRepoId}.md`);
        if (await fileExists(pdfMdPath)) {
          pdfMarkdownPath = pdfMdPath;
          logger.debug(`Found PDF markdown: ${pdfMdPath}`);
        }
      }

      return {
        repoId,
        kind,
        cardPath: await fileExists(cardPath) ? cardPath : null,
        readmePath: await fileExists(readmePath) 
          ? readmePath 
          : await fileExists(rootReadmePath) 
            ? rootReadmePath 
            : null,
        pdfMarkdownPath,
      };
    })
  );

  return {
    overviewPath: hasOverview ? overviewPath : null,
    repos,
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Bridge Functions
// ============================================================================

/**
 * Bridge a RepoCard JSON file to ChromaDB.
 */
export async function bridgeRepoCard(
  cardPath: string,
  bundleId: string,
  options: BridgeOptions
): Promise<{ chunks: ChunkDocument[]; result: BridgeResult }> {
  const content = await fs.readFile(cardPath, 'utf8');
  const card: RepoCard = JSON.parse(content);
  
  // Convert to semantic chunks
  const semanticChunks = repoCardToChunks(card, bundleId);
  
  // Generate embeddings
  const texts = semanticChunks.map((c) => c.content);
  const embeddings = await options.embedding.embedBatch(texts);
  
  // Convert to ChunkDocuments with embeddings
  const chunks: ChunkDocument[] = semanticChunks.map((c, i) => ({
    id: c.id,
    content: c.content,
    metadata: {
      sourceType: c.metadata.sourceType,
      bundleId: c.metadata.bundleId,
      repoId: c.metadata.repoId,
      filePath: cardPath,
      chunkIndex: c.metadata.chunkIndex,
      chunkType: c.chunkType,
      fieldName: c.metadata.fieldName,
    },
    embedding: embeddings[i]?.vector,
  }));

  // Count by type
  const chunksByType: Record<string, number> = {};
  for (const c of chunks) {
    const type = c.metadata.chunkType;
    chunksByType[type] = (chunksByType[type] ?? 0) + 1;
  }

  return {
    chunks,
    result: {
      chunksWritten: chunks.length,
      chunksByType: chunksByType as BridgeResult['chunksByType'],
      errors: [],
    },
  };
}

/**
 * Bridge a README markdown file to ChromaDB.
 */
export async function bridgeReadme(
  readmePath: string,
  bundleId: string,
  repoId: string,
  options: BridgeOptions
): Promise<{ chunks: ChunkDocument[]; result: BridgeResult }> {
  const content = await fs.readFile(readmePath, 'utf8');
  
  // Semantic chunk the markdown
  const semanticChunks = semanticChunk(content, {
    sourceType: 'readme',
    bundleId,
    repoId,
    filePath: readmePath,
    maxTokens: options.maxChunkTokens ?? 512,
    minTokens: options.minChunkTokens ?? 50,
  });
  
  // Generate embeddings
  const texts = semanticChunks.map((c) => c.content);
  const embeddings = await options.embedding.embedBatch(texts);
  
  // Convert to ChunkDocuments
  const chunks: ChunkDocument[] = semanticChunks.map((c, i) => ({
    id: c.id,
    content: c.content,
    metadata: {
      sourceType: c.metadata.sourceType,
      bundleId: c.metadata.bundleId,
      repoId: c.metadata.repoId,
      filePath: readmePath,
      chunkIndex: c.metadata.chunkIndex,
      chunkType: c.chunkType,
    },
    embedding: embeddings[i]?.vector,
  }));

  const chunksByType: Record<string, number> = {};
  for (const c of chunks) {
    const type = c.metadata.chunkType;
    chunksByType[type] = (chunksByType[type] ?? 0) + 1;
  }

  return {
    chunks,
    result: {
      chunksWritten: chunks.length,
      chunksByType: chunksByType as BridgeResult['chunksByType'],
      errors: [],
    },
  };
}

/**
 * Bridge OVERVIEW.md to ChromaDB.
 */
export async function bridgeOverview(
  overviewPath: string,
  bundleId: string,
  options: BridgeOptions
): Promise<{ chunks: ChunkDocument[]; result: BridgeResult }> {
  const content = await fs.readFile(overviewPath, 'utf8');
  
  const semanticChunks = semanticChunk(content, {
    sourceType: 'overview',
    bundleId,
    filePath: overviewPath,
    maxTokens: options.maxChunkTokens ?? 512,
    minTokens: options.minChunkTokens ?? 50,
  });
  
  const texts = semanticChunks.map((c) => c.content);
  const embeddings = await options.embedding.embedBatch(texts);
  
  const chunks: ChunkDocument[] = semanticChunks.map((c, i) => ({
    id: c.id,
    content: c.content,
    metadata: {
      sourceType: c.metadata.sourceType,
      bundleId: c.metadata.bundleId,
      filePath: overviewPath,
      chunkIndex: c.metadata.chunkIndex,
      chunkType: c.chunkType,
    },
    embedding: embeddings[i]?.vector,
  }));

  const chunksByType: Record<string, number> = {};
  for (const c of chunks) {
    const type = c.metadata.chunkType;
    chunksByType[type] = (chunksByType[type] ?? 0) + 1;
  }

  return {
    chunks,
    result: {
      chunksWritten: chunks.length,
      chunksByType: chunksByType as BridgeResult['chunksByType'],
      errors: [],
    },
  };
}
