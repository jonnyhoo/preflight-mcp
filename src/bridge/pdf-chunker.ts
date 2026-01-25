/**
 * Academic PDF Chunker - Optimized for research papers.
 * 
 * Features:
 * - **Hierarchical**: Preserves markdown heading structure
 * - **Contextual**: Adds document context prefix to each chunk
 * - **Adaptive**: Keeps formulas/tables/code intact (may exceed token limit)
 * - **Overlap**: 15% overlap at sentence boundaries
 * 
 * @module bridge/pdf-chunker
 */

import crypto from 'node:crypto';
import type { ChunkType } from '../vectordb/types.js';
import type { SemanticChunk, ChunkOptions } from './types.js';
import { DEFAULT_CHUNK_OPTIONS } from './types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('pdf-chunker');

// ============================================================================
// Types
// ============================================================================

export interface PdfChunkOptions {
  /** Max tokens per chunk (default: 400 for academic papers) */
  maxTokens?: number;
  /** Min tokens per chunk (default: 100) */
  minTokens?: number;
  /** Overlap percentage between chunks (default: 15) */
  overlapPercent?: number;
}

export interface DocumentContext {
  /** Paper title (from first # heading) */
  title: string;
  /** Paper abstract (if found) */
  abstract?: string;
}

interface HeadingNode {
  level: number;
  text: string;
  startLine: number;
  endLine: number;
  content: string;
  children: HeadingNode[];
}

interface ContentBlock {
  type: ChunkType;
  content: string;
  heading?: string;
  headingPath?: string[]; // e.g., ["Introduction", "Background"]
  isSpecial: boolean; // formula/table/code - don't split
}

// ============================================================================
// Token Estimation
// ============================================================================

/**
 * Estimate token count (rough approximation: ~4 chars per token for English).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Generate unique chunk ID.
 */
function generateChunkId(content: string, index: number): string {
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
  return `chunk_${hash}_${index}`;
}

// ============================================================================
// Document Context Extraction
// ============================================================================

/**
 * Extract document context (title, abstract) from markdown.
 */
export function extractDocumentContext(markdown: string): DocumentContext {
  const lines = markdown.split('\n');
  
  // Find title: first # heading
  let title = 'Untitled Paper';
  for (const line of lines) {
    const match = line.match(/^#\s+(.+)$/);
    if (match) {
      title = match[1]!.trim();
      break;
    }
  }

  // Find abstract: content under ## Abstract heading
  let abstract: string | undefined;
  const abstractMatch = markdown.match(/##\s*Abstract\s*\n([\s\S]*?)(?=\n##|\n#\s|$)/i);
  if (abstractMatch) {
    abstract = abstractMatch[1]!.trim().slice(0, 500); // Limit abstract length
  }

  return { title, abstract };
}

// ============================================================================
// Markdown Structure Parsing
// ============================================================================

/**
 * Parse markdown into heading tree.
 */
function parseHeadingTree(markdown: string): HeadingNode[] {
  const lines = markdown.split('\n');
  const root: HeadingNode[] = [];
  const stack: { node: HeadingNode; level: number }[] = [];
  
  let currentContent: string[] = [];
  let contentStartLine = 0;

  const flushContent = (endLine: number) => {
    if (currentContent.length === 0) return;
    const content = currentContent.join('\n').trim();
    if (content && stack.length > 0) {
      const parent = stack[stack.length - 1]!;
      parent.node.content += (parent.node.content ? '\n\n' : '') + content;
    }
    currentContent = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      flushContent(i - 1);
      
      const level = headingMatch[1]!.length;
      const text = headingMatch[2]!.trim();
      const node: HeadingNode = {
        level,
        text,
        startLine: i,
        endLine: i,
        content: '',
        children: [],
      };

      // Pop stack until we find a parent with lower level
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
        const popped = stack.pop()!;
        popped.node.endLine = i - 1;
      }

      // Add to parent or root
      if (stack.length === 0) {
        root.push(node);
      } else {
        stack[stack.length - 1]!.node.children.push(node);
      }

      stack.push({ node, level });
      contentStartLine = i + 1;
    } else {
      currentContent.push(line);
    }
  }

  // Flush remaining content
  flushContent(lines.length - 1);

  // Close remaining nodes
  while (stack.length > 0) {
    const popped = stack.pop()!;
    popped.node.endLine = lines.length - 1;
  }

  return root;
}

// ============================================================================
// Content Block Detection
// ============================================================================

/**
 * Detect content blocks with their types.
 */
function detectContentBlocks(markdown: string, headingPath: string[] = []): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const lines = markdown.split('\n');
  
  let currentContent: string[] = [];
  let currentType: ChunkType = 'text';
  let currentHeading: string | undefined;
  let inCodeBlock = false;
  let inTable = false;
  let inFormula = false;

  const flushBlock = () => {
    const content = currentContent.join('\n').trim();
    if (content) {
      const isSpecial = currentType === 'code' || currentType === 'table' || currentType === 'formula';
      blocks.push({
        type: currentType,
        content,
        heading: currentHeading,
        headingPath: [...headingPath],
        isSpecial,
      });
    }
    currentContent = [];
    currentType = 'text';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Skip headings (they're handled separately)
    if (trimmed.match(/^#{1,6}\s+/)) {
      const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
      if (headingMatch) {
        currentHeading = headingMatch[1];
      }
      continue;
    }

    // Code block detection
    if (trimmed.startsWith('```')) {
      if (!inCodeBlock) {
        flushBlock();
        inCodeBlock = true;
        currentType = 'code';
        currentContent.push(line);
      } else {
        currentContent.push(line);
        flushBlock();
        inCodeBlock = false;
        currentType = 'text';
      }
      continue;
    }

    if (inCodeBlock) {
      currentContent.push(line);
      continue;
    }

    // Formula detection ($$...$$, \[...\])
    if (trimmed.startsWith('$$') || trimmed.startsWith('\\[')) {
      if (!inFormula) {
        flushBlock();
        inFormula = true;
        currentType = 'formula';
        currentContent.push(line);
        // Check if single-line formula
        if ((trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length > 4) ||
            (trimmed.startsWith('\\[') && trimmed.endsWith('\\]'))) {
          flushBlock();
          inFormula = false;
          currentType = 'text';
        }
      } else {
        currentContent.push(line);
      }
      continue;
    }
    if (inFormula && (trimmed.endsWith('$$') || trimmed.endsWith('\\]'))) {
      currentContent.push(line);
      flushBlock();
      inFormula = false;
      currentType = 'text';
      continue;
    }
    if (inFormula) {
      currentContent.push(line);
      continue;
    }

    // Table detection
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      if (!inTable) {
        flushBlock();
        inTable = true;
        currentType = 'table';
      }
      currentContent.push(line);
      continue;
    } else if (inTable) {
      flushBlock();
      inTable = false;
      currentType = 'text';
    }

    // Figure detection
    if (trimmed.match(/^!\[.*\]\(.*\)$/)) {
      flushBlock();
      currentType = 'figure';
      currentContent.push(line);
      flushBlock();
      currentType = 'text';
      continue;
    }

    // List detection
    if (trimmed.match(/^[-*+]\s+/) || trimmed.match(/^\d+\.\s+/)) {
      if (currentType !== 'list') {
        flushBlock();
        currentType = 'list';
      }
      currentContent.push(line);
      continue;
    } else if (currentType === 'list' && trimmed === '') {
      currentContent.push(line);
      continue;
    } else if (currentType === 'list' && !trimmed.match(/^\s+/)) {
      flushBlock();
      currentType = 'text';
    }

    // Regular text
    currentContent.push(line);
  }

  flushBlock();
  return blocks;
}

// ============================================================================
// Sentence Splitting
// ============================================================================

/**
 * Split text at sentence boundaries.
 */
function splitAtSentences(text: string): string[] {
  // Match sentences ending with .!? followed by space or end
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)/g) || [text];
  return sentences.map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Create overlap by taking sentences from the end of previous chunk.
 */
function createOverlapPrefix(prevContent: string, overlapTokens: number): string {
  const sentences = splitAtSentences(prevContent);
  let overlap = '';
  let tokens = 0;
  
  // Take sentences from the end
  for (let i = sentences.length - 1; i >= 0 && tokens < overlapTokens; i--) {
    const sentence = sentences[i]!;
    const sentenceTokens = estimateTokens(sentence);
    if (tokens + sentenceTokens <= overlapTokens) {
      overlap = sentence + ' ' + overlap;
      tokens += sentenceTokens;
    } else {
      break;
    }
  }

  return overlap.trim();
}

// ============================================================================
// Adaptive Chunking
// ============================================================================

/**
 * Split content into chunks with adaptive sizing.
 */
function adaptiveChunk(
  blocks: ContentBlock[],
  maxTokens: number,
  minTokens: number,
  overlapPercent: number
): ContentBlock[] {
  const result: ContentBlock[] = [];
  const overlapTokens = Math.floor(maxTokens * overlapPercent / 100);

  let pendingContent: string[] = [];
  let pendingTokens = 0;
  let pendingBlock: ContentBlock | null = null;
  let prevChunkContent = '';

  const flushPending = () => {
    if (pendingContent.length === 0 || !pendingBlock) return;

    const content = pendingContent.join('\n\n').trim();
    result.push({
      ...pendingBlock,
      content,
    });
    prevChunkContent = content;
    pendingContent = [];
    pendingTokens = 0;
  };

  for (const block of blocks) {
    const tokens = estimateTokens(block.content);

    // Special blocks (formula/table/code) - keep intact even if large
    if (block.isSpecial) {
      flushPending();
      
      // Add overlap prefix if we have previous content
      let content = block.content;
      if (prevChunkContent && overlapTokens > 0) {
        const overlap = createOverlapPrefix(prevChunkContent, overlapTokens);
        if (overlap) {
          content = `[...] ${overlap}\n\n${content}`;
        }
      }

      result.push({
        ...block,
        content,
      });
      prevChunkContent = block.content;
      continue;
    }

    // If block is too large, split it
    if (tokens > maxTokens) {
      flushPending();
      
      const paragraphs = block.content.split(/\n\n+/);
      let current: string[] = [];
      let currentTokens = 0;
      let isFirst = true;

      for (const para of paragraphs) {
        const paraTokens = estimateTokens(para);

        if (currentTokens + paraTokens > maxTokens && current.length > 0) {
          // Flush current
          let content = current.join('\n\n');
          if (!isFirst && prevChunkContent && overlapTokens > 0) {
            const overlap = createOverlapPrefix(prevChunkContent, overlapTokens);
            if (overlap) {
              content = `[...] ${overlap}\n\n${content}`;
            }
          }
          result.push({
            ...block,
            content,
          });
          prevChunkContent = current.join('\n\n');
          current = [];
          currentTokens = 0;
          isFirst = false;
        }

        // If single paragraph is too large, split by sentences
        if (paraTokens > maxTokens) {
          if (current.length > 0) {
            let content = current.join('\n\n');
            if (!isFirst && prevChunkContent && overlapTokens > 0) {
              const overlap = createOverlapPrefix(prevChunkContent, overlapTokens);
              if (overlap) {
                content = `[...] ${overlap}\n\n${content}`;
              }
            }
            result.push({
              ...block,
              content,
            });
            prevChunkContent = current.join('\n\n');
            current = [];
            currentTokens = 0;
            isFirst = false;
          }

          const sentences = splitAtSentences(para);
          let sentChunk: string[] = [];
          let sentTokens = 0;

          for (const sent of sentences) {
            const sTokens = estimateTokens(sent);
            if (sentTokens + sTokens > maxTokens && sentChunk.length > 0) {
              let content = sentChunk.join(' ');
              if (!isFirst && prevChunkContent && overlapTokens > 0) {
                const overlap = createOverlapPrefix(prevChunkContent, overlapTokens);
                if (overlap) {
                  content = `[...] ${overlap}\n\n${content}`;
                }
              }
              result.push({
                ...block,
                content,
              });
              prevChunkContent = sentChunk.join(' ');
              sentChunk = [];
              sentTokens = 0;
              isFirst = false;
            }
            sentChunk.push(sent);
            sentTokens += sTokens;
          }
          if (sentChunk.length > 0) {
            current.push(sentChunk.join(' '));
            currentTokens += sentTokens;
          }
        } else {
          current.push(para);
          currentTokens += paraTokens;
        }
      }

      if (current.length > 0) {
        let content = current.join('\n\n');
        if (!isFirst && prevChunkContent && overlapTokens > 0) {
          const overlap = createOverlapPrefix(prevChunkContent, overlapTokens);
          if (overlap) {
            content = `[...] ${overlap}\n\n${content}`;
          }
        }
        result.push({
          ...block,
          content,
        });
        prevChunkContent = current.join('\n\n');
      }
      continue;
    }

    // Normal accumulation
    if (pendingBlock === null) {
      pendingBlock = block;
    }

    // If adding this block exceeds max, flush first
    if (pendingTokens + tokens > maxTokens && pendingTokens >= minTokens) {
      flushPending();
      pendingBlock = block;
    }

    // Add overlap prefix for first block after flush
    if (pendingContent.length === 0 && prevChunkContent && overlapTokens > 0) {
      const overlap = createOverlapPrefix(prevChunkContent, overlapTokens);
      if (overlap) {
        pendingContent.push(`[...] ${overlap}`);
        pendingTokens += estimateTokens(overlap);
      }
    }

    pendingContent.push(block.content);
    pendingTokens += tokens;
  }

  flushPending();
  return result;
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Academic paper chunking with hierarchical context, adaptive sizing, and overlap.
 * 
 * @param markdown - Raw markdown content from PDF parser
 * @param chunkOptions - Base chunk options (sourceType, bundleId, etc.)
 * @param pdfOptions - PDF-specific options (maxTokens, overlap, etc.)
 * @returns Array of semantic chunks ready for embedding
 * 
 * @example
 * ```typescript
 * const chunks = academicChunk(pdfMarkdown, {
 *   sourceType: 'pdf_text',
 *   bundleId: 'abc123',
 *   repoId: 'pdf/arxiv-2601.14287',
 * }, {
 *   maxTokens: 400,
 *   overlapPercent: 15,
 * });
 * ```
 */
export function academicChunk(
  markdown: string,
  chunkOptions: ChunkOptions,
  pdfOptions?: PdfChunkOptions
): SemanticChunk[] {
  const opts = {
    maxTokens: pdfOptions?.maxTokens ?? 400,
    minTokens: pdfOptions?.minTokens ?? 100,
    overlapPercent: pdfOptions?.overlapPercent ?? 15,
  };

  // 1. Extract document context
  const context = extractDocumentContext(markdown);
  logger.debug(`Extracted context: title="${context.title}"`);

  // 2. Detect content blocks
  const blocks = detectContentBlocks(markdown);
  logger.debug(`Detected ${blocks.length} content blocks`);

  // 3. Apply adaptive chunking with overlap
  const chunkedBlocks = adaptiveChunk(blocks, opts.maxTokens, opts.minTokens, opts.overlapPercent);
  logger.debug(`After adaptive chunking: ${chunkedBlocks.length} chunks`);

  // 4. Convert to SemanticChunk with contextual prefix
  const chunks: SemanticChunk[] = chunkedBlocks.map((block, index) => {
    // Build contextual prefix
    const sectionPath = block.headingPath?.join(' > ') || block.heading;
    let prefix = `[Paper: ${context.title}]`;
    if (sectionPath) {
      prefix += ` [Section: ${sectionPath}]`;
    }
    
    // Add prefix to content
    const contentWithContext = `${prefix}\n\n${block.content}`;

    return {
      id: generateChunkId(contentWithContext, index),
      content: contentWithContext,
      chunkType: block.type,
      isComplete: true, // Academic chunks are self-contained with context
      metadata: {
        sourceType: chunkOptions.sourceType,
        bundleId: chunkOptions.bundleId,
        repoId: chunkOptions.repoId,
        filePath: chunkOptions.filePath,
        chunkIndex: index,
        sectionHeading: block.heading,
      },
    };
  });

  logger.info(
    `Academic chunking complete: ${chunks.length} chunks from "${context.title}" ` +
    `(maxTokens=${opts.maxTokens}, overlap=${opts.overlapPercent}%)`
  );

  return chunks;
}
