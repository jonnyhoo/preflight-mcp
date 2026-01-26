/**
 * Markdown Bridge - Bridge MinerU/VLM Parser Markdown output to ChromaDB.
 * 
 * This module handles markdown content from:
 * - MinerU Parser: Cloud API for PDF parsing
 * - VLM Parallel Parser: N VLMs concurrent PDF page processing
 * 
 * @module bridge/markdown-bridge
 */

import type { ChunkDocument } from '../vectordb/types.js';
import type { SemanticChunk, BridgeOptions, BridgeResult, ChunkOptions } from './types.js';
import { semanticChunk } from './semantic-chunker.js';
import { academicChunk } from './pdf-chunker.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('markdown-bridge');

// ============================================================================
// Types
// ============================================================================

export interface MarkdownSource {
  /** Source type for metadata */
  type: 'pdf' | 'web';
  /** Bundle ID */
  bundleId: string;
  /** Optional repo ID */
  repoId?: string;
  /** Original file path or URL */
  filePath?: string;
  /** Original URL (for web sources) */
  url?: string;
}

export interface MarkdownBridgeResult extends BridgeResult {
  /** Generated chunks before writing */
  chunks: ChunkDocument[];
}

// ============================================================================
// Source Type Mapping
// ============================================================================

/**
 * Map chunk type to source type for metadata.
 */
function mapSourceType(
  sourceType: 'pdf' | 'web',
  chunkType: SemanticChunk['chunkType']
): ChunkDocument['metadata']['sourceType'] {
  if (sourceType === 'web') {
    return 'readme'; // Web docs treated as readme-like content
  }

  // PDF source types based on chunk content type
  switch (chunkType) {
    case 'table':
      return 'pdf_table';
    case 'formula':
      return 'pdf_formula';
    case 'figure':
      return 'pdf_image';
    default:
      return 'pdf_text';
  }
}

// ============================================================================
// Main Bridge Function
// ============================================================================

/**
 * Bridge markdown content to ChromaDB-ready chunks.
 * 
 * @param markdown - Raw markdown content from parser
 * @param source - Source metadata
 * @param options - Bridge options (embedding provider, chunk sizes)
 * @returns Chunks ready for ChromaDB insertion
 */
export async function bridgeMarkdown(
  markdown: string,
  source: MarkdownSource,
  options: BridgeOptions
): Promise<MarkdownBridgeResult> {
  const result: MarkdownBridgeResult = {
    chunksWritten: 0,
    chunksByType: {
      text: 0,
      heading: 0,
      table: 0,
      figure: 0,
      formula: 0,
      code: 0,
      list: 0,
      summary: 0,
      api: 0,
    },
    errors: [],
    chunks: [],
  };

  try {
    // 1. Semantic chunking
    const chunkOptions: ChunkOptions = {
      sourceType: source.type === 'pdf' ? 'pdf_text' : 'readme',
      bundleId: source.bundleId,
      repoId: source.repoId,
      filePath: source.filePath,
      maxTokens: options.maxChunkTokens ?? 512,
      minTokens: options.minChunkTokens ?? 50,
    };

    const semanticChunks = semanticChunk(markdown, chunkOptions);
    logger.info(`Created ${semanticChunks.length} semantic chunks from markdown`);

    // 2. Generate embeddings
    const texts = semanticChunks.map((c) => c.content);
    const embeddings = await options.embedding.embedBatch(texts);
    logger.debug(`Generated ${embeddings.length} embeddings`);

    // 3. Convert to ChunkDocument format
    const chunks: ChunkDocument[] = semanticChunks.map((chunk, i) => {
      const embedding = embeddings[i];
      const chunkDoc: ChunkDocument = {
        id: chunk.id,
        content: chunk.content,
        metadata: {
          sourceType: mapSourceType(source.type, chunk.chunkType),
          bundleId: source.bundleId,
          repoId: source.repoId,
          filePath: source.filePath,
          chunkIndex: chunk.metadata.chunkIndex,
          chunkType: chunk.chunkType,
          fieldName: chunk.metadata.fieldName,
        },
        embedding: embedding?.vector,
      };
      return chunkDoc;
    });

    // Count by type
    for (const chunk of semanticChunks) {
      const type = chunk.chunkType;
      result.chunksByType[type] = (result.chunksByType[type] ?? 0) + 1;
    }

    result.chunks = chunks;
    result.chunksWritten = chunks.length;

    logger.info(
      `Bridged ${chunks.length} chunks: ` +
        Object.entries(result.chunksByType)
          .filter(([_, count]) => count > 0)
          .map(([type, count]) => `${type}=${count}`)
          .join(', ')
    );
  } catch (err) {
    const msg = `Failed to bridge markdown: ${err}`;
    logger.error(msg);
    result.errors.push(msg);
  }

  return result;
}

// ============================================================================
// PDF-specific Bridge
// ============================================================================

export interface PdfBridgeSource {
  /** Bundle ID */
  bundleId: string;
  /** PDF repo ID (e.g., "pdf/arxiv-2601.15487") */
  repoId: string;
  /** Original PDF path or URL */
  pdfPath?: string;
  /** Markdown content from MinerU/VLM parser */
  markdown: string;
  /** Total page count (if known) */
  pageCount?: number;
}

/**
 * Bridge PDF parser output (markdown) to ChromaDB chunks.
 * 
 * Uses academic chunking strategy optimized for research papers:
 * - Hierarchical: Preserves markdown heading structure
 * - Contextual: Adds document context prefix to each chunk
 * - Adaptive: Keeps formulas/tables/code intact
 * - Overlap: 15% overlap at sentence boundaries
 * 
 * @example
 * ```typescript
 * const result = await bridgePdfMarkdown({
 *   bundleId: 'abc123',
 *   repoId: 'pdf/arxiv-2601.15487',
 *   pdfPath: 'https://arxiv.org/pdf/2601.15487',
 *   markdown: mineruOutput.markdown,
 * }, options);
 * ```
 */
export async function bridgePdfMarkdown(
  source: PdfBridgeSource,
  options: BridgeOptions
): Promise<MarkdownBridgeResult> {
  const result: MarkdownBridgeResult = {
    chunksWritten: 0,
    chunksByType: {
      text: 0,
      heading: 0,
      table: 0,
      figure: 0,
      formula: 0,
      code: 0,
      list: 0,
      summary: 0,
      api: 0,
    },
    errors: [],
    chunks: [],
  };

  try {
    // Use academic chunking strategy for PDFs
    const chunkOptions: ChunkOptions = {
      sourceType: 'pdf_text',
      bundleId: source.bundleId,
      repoId: source.repoId,
      filePath: source.pdfPath,
      maxTokens: options.maxChunkTokens ?? 400,
      minTokens: options.minChunkTokens ?? 100,
    };

    const semanticChunks = academicChunk(source.markdown, chunkOptions, {
      strategy: 'semantic', // Use semantic chunking by default for PDFs
      chunkLevel: 2, // Split by ## (sections)
      includeParentContext: true,
      trackHierarchy: true,
      maxTokens: options.maxChunkTokens ?? 2000, // Soft limit for hybrid mode
      minTokens: options.minChunkTokens ?? 100,
      overlapPercent: 15,
    });
    logger.info(`Created ${semanticChunks.length} academic chunks from PDF`);

    // Generate embeddings
    const texts = semanticChunks.map((c) => c.content);
    const embeddings = await options.embedding.embedBatch(texts);
    logger.debug(`Generated ${embeddings.length} embeddings`);

    // Convert to ChunkDocument format
    const chunks: ChunkDocument[] = semanticChunks.map((chunk, i) => {
      const embedding = embeddings[i];
      const chunkDoc: ChunkDocument = {
        id: chunk.id,
        content: chunk.content,
        metadata: {
          sourceType: mapSourceType('pdf', chunk.chunkType),
          bundleId: source.bundleId,
          repoId: source.repoId,
          filePath: source.pdfPath,
          chunkIndex: chunk.metadata.chunkIndex,
          chunkType: chunk.chunkType,
          fieldName: chunk.metadata.fieldName,
          // Hierarchical metadata
          sectionHeading: chunk.metadata.sectionHeading,
          headingLevel: chunk.metadata.headingLevel,
          headingPath: chunk.metadata.headingPath,
          parentChunkId: chunk.metadata.parentChunkId,
          // Multi-scale metadata (for best quality retrieval)
          granularity: chunk.metadata.granularity,
          assetId: chunk.metadata.assetId,
        },
        embedding: embedding?.vector,
      };
      return chunkDoc;
    });

    // Count by type
    for (const chunk of semanticChunks) {
      const type = chunk.chunkType;
      result.chunksByType[type] = (result.chunksByType[type] ?? 0) + 1;
    }

    result.chunks = chunks;
    result.chunksWritten = chunks.length;

    logger.info(
      `Bridged ${chunks.length} PDF chunks: ` +
        Object.entries(result.chunksByType)
          .filter(([_, count]) => count > 0)
          .map(([type, count]) => `${type}=${count}`)
          .join(', ')
    );
  } catch (err) {
    const msg = `Failed to bridge PDF markdown: ${err}`;
    logger.error(msg);
    result.errors.push(msg);
  }

  return result;
}

// ============================================================================
// Web-specific Bridge
// ============================================================================

export interface WebBridgeSource {
  /** Bundle ID */
  bundleId: string;
  /** Web repo ID (e.g., "web/docs.example.com") */
  repoId?: string;
  /** Original URL */
  url: string;
  /** Markdown content from web crawl */
  markdown: string;
}

/**
 * Bridge web crawl output (markdown) to ChromaDB chunks.
 * 
 * @example
 * ```typescript
 * const result = await bridgeWebMarkdown({
 *   bundleId: 'abc123',
 *   url: 'https://docs.example.com/guide',
 *   markdown: crawledContent,
 * }, options);
 * ```
 */
export async function bridgeWebMarkdown(
  source: WebBridgeSource,
  options: BridgeOptions
): Promise<MarkdownBridgeResult> {
  return bridgeMarkdown(
    source.markdown,
    {
      type: 'web',
      bundleId: source.bundleId,
      repoId: source.repoId,
      filePath: source.url,
      url: source.url,
    },
    options
  );
}
