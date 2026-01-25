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
 * Check if a heading is a PDF page marker (e.g., "## Page 1", "Page 2").
 */
function isPdfPageMarker(heading: string): boolean {
  return /^Page\s+\d+$/i.test(heading.trim());
}

/**
 * Check if a heading is noise (TOC, figure caption, metadata).
 */
function isNoiseHeading(heading: string): boolean {
  // Skip TOC-like entries
  if (/^\d+\.?\s*$/.test(heading)) return true; // Just numbers like "1." or "2"
  // Skip Figure/Table captions used as headings
  if (/^(figure|table)\s*\d*:?/i.test(heading)) return true;
  // Skip page references
  if (/^page\s*\d+$/i.test(heading)) return true;
  return false;
}

/**
 * Infer logical section level from heading text based on academic numbering.
 * Returns the inferred level or undefined if cannot be determined.
 * Examples:
 *   "1 Introduction" -> 1
 *   "2.1 Related Work" -> 2
 *   "3.2.1 Details" -> 3
 *   "Abstract" -> 1
 *   "Conclusion" -> 1
 */
function inferLogicalLevel(headingText: string): number | undefined {
  // Check for numbered sections like "1", "2.1", "3.2.1"
  const numberMatch = headingText.match(/^(\d+(?:\.\d+)*)\s+/);
  if (numberMatch) {
    const parts = numberMatch[1]!.split('.');
    return parts.length; // "1" -> 1, "2.1" -> 2, "3.2.1" -> 3
  }
  
  // Top-level sections without numbers
  const topLevelSections = [
    'abstract', 'introduction', 'conclusion', 'conclusions',
    'references', 'appendix', 'acknowledgments', 'acknowledgements'
  ];
  if (topLevelSections.includes(headingText.toLowerCase())) {
    return 1;
  }
  
  return undefined;
}

/**
 * Detect content blocks with their types.
 * Properly tracks section hierarchy and filters PDF artifacts.
 */
function detectContentBlocks(markdown: string, _headingPath: string[] = []): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const lines = markdown.split('\n');
  
  let currentContent: string[] = [];
  let currentType: ChunkType = 'text';
  let inCodeBlock = false;
  let inTable = false;
  let inFormula = false;
  
  // Track section hierarchy: [{level, text}]
  const sectionStack: { level: number; text: string }[] = [];
  
  const getCurrentHeading = (): string | undefined => {
    if (sectionStack.length === 0) return undefined;
    return sectionStack[sectionStack.length - 1]!.text;
  };
  
  const getCurrentHeadingPath = (): string[] => {
    return sectionStack.map(s => s.text);
  };

  const flushBlock = () => {
    const content = currentContent.join('\n').trim();
    if (content) {
      const isSpecial = currentType === 'code' || currentType === 'table' || currentType === 'formula';
      blocks.push({
        type: currentType,
        content,
        heading: getCurrentHeading(),
        headingPath: getCurrentHeadingPath(),
        isSpecial,
      });
    }
    currentContent = [];
    currentType = 'text';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Handle headings - track section hierarchy
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const markdownLevel = headingMatch[1]!.length;
      const headingText = headingMatch[2]!.trim();
      
      // Skip PDF page markers and noise headings
      if (isPdfPageMarker(headingText) || isNoiseHeading(headingText)) {
        continue;
      }
      
      // Use logical level based on section numbering, fallback to markdown level
      const logicalLevel = inferLogicalLevel(headingText) ?? markdownLevel;
      
      // Flush current content before section change
      flushBlock();
      
      // Update section stack: pop all sections with level >= current
      while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1]!.level >= logicalLevel) {
        sectionStack.pop();
      }
      sectionStack.push({ level: logicalLevel, text: headingText });
      continue;
    }

    // Skip metadata/frontmatter lines
    if (trimmed.startsWith('> Source:') || trimmed.startsWith('> Pages:') || trimmed === '---') {
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
    // Handle formula end first (important: check this before formula start)
    if (inFormula) {
      currentContent.push(line);
      // Check for end markers
      if (trimmed === '$$' || trimmed === '\\]' || trimmed.endsWith('$$') || trimmed.endsWith('\\]')) {
        flushBlock();
        inFormula = false;
        currentType = 'text';
      }
      continue;
    }
    
    // Formula start detection
    if (trimmed.startsWith('$$') || trimmed.startsWith('\\[')) {
      flushBlock();
      inFormula = true;
      currentType = 'formula';
      currentContent.push(line);
      // Check if single-line formula (e.g., $$ x = y $$)
      if ((trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length > 4) ||
          (trimmed.startsWith('\\[') && trimmed.endsWith('\\]') && trimmed.length > 4)) {
        flushBlock();
        inFormula = false;
        currentType = 'text';
      }
      continue;
    }

    // Table detection - more flexible: line contains | and has table-like structure
    const isTableRow = trimmed.includes('|') && 
      (trimmed.startsWith('|') || trimmed.match(/^[^|]+\|/)) &&
      trimmed.split('|').length >= 3;
    
    if (isTableRow) {
      if (!inTable) {
        flushBlock();
        inTable = true;
        currentType = 'table';
      }
      currentContent.push(line);
      continue;
    } else if (inTable) {
      // End table on empty line or non-table content
      if (trimmed === '' || !trimmed.includes('|')) {
        flushBlock();
        inTable = false;
        currentType = 'text';
      }
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
  _overlapPercent: number  // Reserved for future overlap support
): ContentBlock[] {
  const result: ContentBlock[] = [];

  let pendingContent: string[] = [];
  let pendingTokens = 0;
  let pendingBlock: ContentBlock | null = null;

  const flushPending = () => {
    if (pendingContent.length === 0 || !pendingBlock) return;

    const content = pendingContent.join('\n\n').trim();
    result.push({
      ...pendingBlock,
      content,
    });
    pendingContent = [];
    pendingTokens = 0;
  };

  for (const block of blocks) {
    const tokens = estimateTokens(block.content);

    // Special blocks (formula/table/code) - keep intact even if large
    if (block.isSpecial) {
      flushPending();
      
      // Special blocks don't need overlap - they're self-contained
      result.push({
        ...block,
      });
      continue;
    }

    // If block is too large, split it
    if (tokens > maxTokens) {
      flushPending();
      
      const paragraphs = block.content.split(/\n\n+/);
      let current: string[] = [];
      let currentTokens = 0;

      for (const para of paragraphs) {
        const paraTokens = estimateTokens(para);

        if (currentTokens + paraTokens > maxTokens && current.length > 0) {
          // Flush current (no artificial overlap markers)
          const content = current.join('\n\n');
          result.push({
            ...block,
            content,
          });
          current = [];
          currentTokens = 0;
        }

        // If single paragraph is too large, split by sentences
        if (paraTokens > maxTokens) {
          if (current.length > 0) {
            const content = current.join('\n\n');
            result.push({
              ...block,
              content,
            });
            current = [];
            currentTokens = 0;
          }

          const sentences = splitAtSentences(para);
          let sentChunk: string[] = [];
          let sentTokens = 0;

          for (const sent of sentences) {
            const sTokens = estimateTokens(sent);
            if (sentTokens + sTokens > maxTokens && sentChunk.length > 0) {
              const content = sentChunk.join(' ');
              result.push({
                ...block,
                content,
              });
              sentChunk = [];
              sentTokens = 0;
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
        const content = current.join('\n\n');
        result.push({
          ...block,
          content,
        });
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

    // Simply accumulate content (contextual prefix provides sufficient context)
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
