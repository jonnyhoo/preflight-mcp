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
  /**
   * Chunking strategy (default: 'semantic')
   * - 'semantic': Split by heading structure only, ignore token limits
   * - 'token-based': Legacy mode, split by maxTokens
   * - 'hybrid': Semantic split with soft token limit warning
   */
  strategy?: 'semantic' | 'token-based' | 'hybrid';
  /**
   * Heading level to chunk at (default: 2)
   * - 1: Split by # (章节 - Chapter)
   * - 2: Split by ## (节 - Section)
   * - 3: Split by ### (小节 - Subsection)
   * - 4: Split by #### (段 - Paragraph)
   */
  chunkLevel?: 1 | 2 | 3 | 4;
  /** Keep parent section context in chunk prefix (default: true) */
  includeParentContext?: boolean;
  /** Store parent-child chunk relationships in metadata (default: true) */
  trackHierarchy?: boolean;
  
  // Legacy token-based options (for backward compatibility)
  /** Max tokens per chunk (default: 2000, only used in 'token-based' and 'hybrid' modes) */
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
  pageNumber?: number; // Page number where this heading starts
}

interface ContentBlock {
  type: ChunkType;
  content: string;
  heading?: string;
  headingPath?: string[]; // e.g., ["Introduction", "Background"]
  isSpecial: boolean; // formula/table/code - don't split
  pageNumber?: number; // Page number (1-indexed) where this block starts
}

/** Extended block with hierarchy and granularity info */
interface ExtendedBlock extends ContentBlock {
  parentPath?: string[];
  chunkId?: string;
  parentChunkId?: string;
  granularity?: 'section' | 'subsection' | 'paragraph' | 'element';
  assetId?: string; // For figures: image filename
  pageNumber?: number; // Page number (1-indexed) where this block starts
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
  
  // Build a map of line number -> page number
  const lineToPage = new Map<number, number>();
  let currentPage = 1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    const pagebreakMatch = trimmed.match(/^<!--\s*pagebreak:(\d+)\s*-->$/i);
    if (pagebreakMatch) {
      currentPage = parseInt(pagebreakMatch[1]!, 10);
    }
    lineToPage.set(i, currentPage);
  }

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
        pageNumber: lineToPage.get(i) ?? 1, // Assign page number from line map
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
 *   "1. Introduction" -> 1    (with trailing dot)
 *   "2.1 Related Work" -> 2
 *   "2.1. Related Work" -> 2  (with trailing dot)
 *   "3.2.1 Details" -> 3
 *   "3.2.1. Details" -> 3     (with trailing dot)
 *   "Abstract" -> 1
 *   "Conclusion" -> 1
 */
function inferLogicalLevel(headingText: string): number | undefined {
  // Check for numbered sections like "1", "2.1", "3.2.1"
  // Support both formats: "2.1 Title" and "2.1. Title" (trailing dot before space)
  // Pattern: digits optionally separated by dots, optionally ending with a dot, followed by space
  const numberMatch = headingText.match(/^(\d+(?:\.\d+)*)\.?\s+/);
  if (numberMatch) {
    const parts = numberMatch[1]!.split('.');
    return parts.length; // "1" -> 1, "2.1" -> 2, "3.2.1" -> 3
  }
  
  // Appendix sections: "A Pseudocode", "B Dataset", "G Case Study", etc.
  // Also handles "A.1 Details" or "A.1. Details" (Appendix subsection with optional trailing dot)
  const appendixMatch = headingText.match(/^([A-Z](?:\.[0-9]+)*)\.?\s+/);
  if (appendixMatch) {
    const parts = appendixMatch[1]!.split('.');
    // A, B, C = level 1; A.1, B.2 = level 2
    return parts.length;
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
 * Properly tracks section hierarchy, filters PDF artifacts, and tracks page numbers.
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
  
  // Track current page number (1-indexed, default to 1)
  let currentPage = 1;
  let blockStartPage = 1;
  
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
      const heading = getCurrentHeading();
      logger.debug(`[PageTrack] Flushing block: heading="${heading?.slice(0, 30) || 'none'}" page=${blockStartPage} type=${currentType}`);
      blocks.push({
        type: currentType,
        content,
        heading,
        headingPath: getCurrentHeadingPath(),
        isSpecial,
        pageNumber: blockStartPage,
      });
    }
    currentContent = [];
    currentType = 'text';
    // Reset block start page to current page for next block
    blockStartPage = currentPage;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Parse pagebreak comments (from preprocessor): <!-- pagebreak:N -->
    const pagebreakMatch = trimmed.match(/^<!--\s*pagebreak:(\d+)\s*-->$/i);
    if (pagebreakMatch) {
      const newPage = parseInt(pagebreakMatch[1]!, 10);
      logger.debug(`[PageTrack] Found pagebreak at line ${i}: currentPage=${currentPage} -> ${newPage}`);
      
      // If we have accumulated content and page is changing, flush the block
      // This ensures each block is associated with the correct page
      if (currentContent.length > 0 && newPage !== currentPage) {
        logger.debug(`[PageTrack] Flushing block before page change (page ${currentPage} -> ${newPage})`);
        flushBlock();
      }
      
      currentPage = newPage;
      
      // Update blockStartPage for next block
      if (currentContent.length === 0) {
        blockStartPage = currentPage;
      }
      continue; // Don't include pagebreak comment in content
    }
    
    // Also handle MinerU-style page comments: <!-- page: N -->
    const mineruPageMatch = trimmed.match(/^<!--\s*page[:\s]+(\d+)\s*-->$/i);
    if (mineruPageMatch) {
      const newPage = parseInt(mineruPageMatch[1]!, 10);
      
      // Flush block before page change (same logic as above)
      if (currentContent.length > 0 && newPage !== currentPage) {
        flushBlock();
      }
      
      currentPage = newPage;
      
      if (currentContent.length === 0) {
        blockStartPage = currentPage;
      }
      continue;
    }

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

    // Figure detection - both markdown images and VLM figure descriptions
    if (trimmed.match(/^!\[.*\]\(.*\)$/)) {
      flushBlock();
      currentType = 'figure';
      currentContent.push(line);
      flushBlock();
      currentType = 'text';
      continue;
    }
    
    // VLM/MinerU figure/table descriptions - keep them intact
    // Match: [Figure: ...] or [Table: ...] (may span multiple lines)
    if (trimmed.match(/^\[(Figure|Table):/i)) {
      flushBlock();
      currentType = trimmed.match(/^\[Figure:/i) ? 'figure' : 'table';
      currentContent.push(line);
      // If description ends on same line, flush immediately
      if (trimmed.endsWith(']')) {
        flushBlock();
        currentType = 'text';
      }
      continue;
    }
    // Continue collecting figure/table description until closing ]
    if (currentType === 'figure' || currentType === 'table') {
      currentContent.push(line);
      if (trimmed.endsWith(']')) {
        flushBlock();
        currentType = 'text';
      }
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
// Semantic Chunking by Heading Level
// ============================================================================

/**
 * Chunk content by heading structure without token limits.
 * Each chunk corresponds to a section at the specified heading level.
 * 
 * NEW: Also extracts table/formula/figure/code/list as independent sub-chunks
 * with parentChunkId linking back to the section chunk.
 * 
 * @param tree - Heading tree from parseHeadingTree
 * @param markdown - Original markdown source (needed to extract raw content with formatting)
 * @param targetLevel - Target heading level to chunk at (1-4)
 * @param trackHierarchy - Whether to track parent-child relationships
 * @param extractSubChunks - Whether to create independent sub-chunks for special blocks
 * @param granularity - Label for this chunk level
 * @returns Array of content blocks with hierarchy info
 */
function semanticChunkByLevel(
  tree: HeadingNode[],
  markdown: string,
  targetLevel: number,
  trackHierarchy: boolean,
  extractSubChunks = true,
  granularity: ExtendedBlock['granularity'] = 'section'
): ExtendedBlock[] {
  const result: ExtendedBlock[] = [];
  let chunkIndex = 0;
  let subChunkIndex = 0;
  
  // Split markdown into lines for line-based extraction
  const lines = markdown.split('\n');
  
  // Recursive traversal to collect chunks at target level
  function traverse(
    nodes: HeadingNode[],
    parentPath: string[] = [],
    parentChunkId?: string
  ) {
    for (const node of nodes) {
      const currentPath = [...parentPath, node.text];
      const logicalLevel = inferLogicalLevel(node.text) ?? node.level;
      
      // If this node is at target level, create a chunk
      if (logicalLevel === targetLevel) {
        const chunkId = `semantic_${granularity}_${chunkIndex++}`;
        
        // Extract raw markdown content for this section by line range
        // This preserves tables, formulas, code blocks, etc.
        const sectionLines = lines.slice(node.startLine + 1, node.endLine + 1); // +1 to skip the heading itself
        const rawSectionMarkdown = sectionLines.join('\n');
        
        // Detect content blocks within this section using raw markdown
        const blocks = detectContentBlocks(rawSectionMarkdown, currentPath);
        
        // Track whether parent chunk was actually created (for child traversal)
        let parentChunkCreated = false;
        
        if (extractSubChunks) {
          // Separate text content from special blocks (table/formula/figure/code/list)
          const textBlocks: ContentBlock[] = [];
          const specialBlocks: ContentBlock[] = [];
          
          for (const block of blocks) {
            if (block.isSpecial || ['table', 'formula', 'figure', 'code', 'list'].includes(block.type)) {
              specialBlocks.push(block);
            } else {
              textBlocks.push(block);
            }
          }
          
          // Create main section chunk (text only)
          const textContent = textBlocks.map(b => b.content).join('\n\n');
          // Use the node's page number (from parseHeadingTree)
          const sectionPageNumber = node.pageNumber ?? textBlocks[0]?.pageNumber ?? specialBlocks[0]?.pageNumber;
          
          if (textContent.trim()) {
            result.push({
              type: 'text',
              content: textContent,
              heading: node.text,
              headingPath: currentPath,
              isSpecial: false,
              parentPath: parentPath.length > 0 ? parentPath : undefined,
              chunkId,
              parentChunkId: trackHierarchy ? parentChunkId : undefined,
              granularity,
              pageNumber: sectionPageNumber,
            });
            parentChunkCreated = true;
          } else if (specialBlocks.length > 0) {
            // FIX: Create a minimal parent chunk even if only special blocks exist
            // This ensures sub-chunks always have a valid parentChunkId
            result.push({
              type: 'text',
              content: `[Section: ${node.text}]`, // Minimal placeholder
              heading: node.text,
              headingPath: currentPath,
              isSpecial: false,
              parentPath: parentPath.length > 0 ? parentPath : undefined,
              chunkId,
              parentChunkId: trackHierarchy ? parentChunkId : undefined,
              granularity,
              pageNumber: sectionPageNumber,
            });
            parentChunkCreated = true;
          }
          
          // Create independent sub-chunks for special blocks
          for (const block of specialBlocks) {
            const subChunkId = `sub_${block.type}_${subChunkIndex++}`;
            
            // Extract assetId for figures (image filename)
            let assetId: string | undefined;
            if (block.type === 'figure') {
              const imgMatch = block.content.match(/!\[[^\]]*\]\(([^)]+)\)/);
              if (imgMatch) {
                const imgPath = imgMatch[1]!;
                assetId = imgPath.split('/').pop(); // Get filename
              }
            }
            
            result.push({
              type: block.type,
              content: block.content,
              heading: block.heading ?? node.text,
              headingPath: currentPath,
              isSpecial: true,
              parentPath: parentPath.length > 0 ? parentPath : undefined,
              chunkId: subChunkId,
              // Parent chunk is now always created when there are special blocks
              parentChunkId: parentChunkCreated ? chunkId : undefined,
              granularity: 'element',
              assetId,
              pageNumber: block.pageNumber, // Preserve page number from block
            });
          }
        } else {
          // Original behavior: merge all blocks into one chunk
          const mergedContent = blocks.map(b => b.content).join('\n\n');
          // Use the node's page number (from parseHeadingTree)
          const blockPageNumber = node.pageNumber ?? blocks[0]?.pageNumber;
          // Only create chunk if there's actual content
          if (mergedContent.trim()) {
            result.push({
              type: 'text',
              content: mergedContent,
              heading: node.text,
              headingPath: currentPath,
              isSpecial: false,
              parentPath: parentPath.length > 0 ? parentPath : undefined,
              chunkId,
              parentChunkId: trackHierarchy ? parentChunkId : undefined,
              granularity,
              pageNumber: blockPageNumber,
            });
            parentChunkCreated = true;
          }
        }
        
        // Continue traversing children - only use this chunk as parent if it was actually created
        if (node.children.length > 0) {
          const nextParentId = parentChunkCreated ? chunkId : parentChunkId;
          traverse(node.children, currentPath, nextParentId);
        }
      } else if (logicalLevel < targetLevel) {
        // This is a higher-level section, keep traversing
        traverse(node.children, currentPath, parentChunkId);
      } else {
        // This is a lower-level section (deeper than target)
        // Include it in the parent chunk's content (already included via node.content)
        continue;
      }
    }
  }
  
  traverse(tree);
  return result;
}

/**
 * Multi-scale chunking: generates chunks at multiple granularities simultaneously.
 * 
 * Produces coarse (section-level), medium (subsection), and fine (paragraph-level) chunks
 * for optimal retrieval at different query types.
 * 
 * Also captures leaf sections at any level that have no children matching target levels.
 * 
 * @param markdown - Raw markdown content
 * @param trackHierarchy - Whether to track parent-child relationships
 * @returns Combined array of chunks at multiple granularities
 */
function multiScaleChunk(
  markdown: string,
  trackHierarchy: boolean
): ExtendedBlock[] {
  const tree = parseHeadingTree(markdown);
  const result: ExtendedBlock[] = [];
  const processedHeadings = new Set<string>(); // Track which headings have been chunked
  
  // Level 1: Top-level sections (chapters, main Appendix like "# A Pseudocode", "# G Case Study")
  // These may not have sub-sections, so we need to capture them directly
  const level1Chunks = semanticChunkByLevel(tree, markdown, 1, trackHierarchy, true, 'section');
  for (const chunk of level1Chunks) {
    result.push(chunk);
    if (chunk.heading) processedHeadings.add(chunk.heading);
  }
  
  // Level 2: Sections with sub-chunks extracted (2.1, A.1, etc.)
  const coarseChunks = semanticChunkByLevel(tree, markdown, 2, trackHierarchy, true, 'section');
  for (const chunk of coarseChunks) {
    // Avoid duplicates from level 1
    if (!chunk.heading || !processedHeadings.has(chunk.heading)) {
      result.push(chunk);
      if (chunk.heading) processedHeadings.add(chunk.heading);
    }
  }
  
  // Level 4: Fine-grained paragraphs (*******, etc.) without sub-chunks
  const fineChunks = semanticChunkByLevel(tree, markdown, 4, false, false, 'paragraph');
  for (const chunk of fineChunks) {
    // Avoid duplicates
    if (!chunk.heading || !processedHeadings.has(chunk.heading)) {
      result.push(chunk);
      if (chunk.heading) processedHeadings.add(chunk.heading);
    }
  }
  
  logger.debug(`Multi-scale chunking: ${level1Chunks.length} level1 + ${coarseChunks.length} coarse + ${fineChunks.length} fine = ${result.length} total chunks`);
  
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
    strategy: pdfOptions?.strategy ?? 'semantic',
    chunkLevel: pdfOptions?.chunkLevel ?? 2,
    includeParentContext: pdfOptions?.includeParentContext ?? true,
    trackHierarchy: pdfOptions?.trackHierarchy ?? true,
    maxTokens: pdfOptions?.maxTokens ?? 2000,
    minTokens: pdfOptions?.minTokens ?? 100,
    overlapPercent: pdfOptions?.overlapPercent ?? 15,
    // NEW: Enable multi-scale by default for best quality
    multiScale: pdfOptions?.strategy !== 'token-based', // Always use multi-scale unless token-based
    extractSubChunks: true, // Always extract sub-chunks for table/formula/figure
  };

  // 1. Extract document context
  const context = extractDocumentContext(markdown);
  logger.debug(`Extracted context: title="${context.title}"`);

  let chunkedBlocks: ExtendedBlock[];

  // 2. Choose chunking strategy
  if (opts.strategy === 'token-based') {
    // Legacy: Token-based with adaptive sizing (no multi-scale)
    const blocks = detectContentBlocks(markdown);
    chunkedBlocks = adaptiveChunk(blocks, opts.maxTokens, opts.minTokens, opts.overlapPercent).map(b => ({
      ...b,
      granularity: 'section' as const,
    }));
    logger.debug(`Token-based chunking: ${chunkedBlocks.length} chunks`);
  } else {
    // Semantic/Hybrid: Use multi-scale chunking for best quality
    // This generates both coarse (section-level) and fine (paragraph-level) chunks
    chunkedBlocks = multiScaleChunk(markdown, opts.trackHierarchy);
    logger.info(`Multi-scale chunking: ${chunkedBlocks.length} total chunks (coarse + fine + sub-chunks)`);
  }

  // 3. Convert to SemanticChunk with contextual prefix
  // First pass: generate chunk IDs and build mapping from raw chunkId to full ID
  const chunkIdMap = new Map<string, string>();
  const chunksWithIds = chunkedBlocks.map((block, index) => {
    // Build contextual prefix
    const sectionPath = block.headingPath?.join(' > ') || block.heading;
    let prefix = opts.includeParentContext && sectionPath
      ? `[Paper: ${context.title}] [Section: ${sectionPath}]`
      : `[Paper: ${context.title}]`;
    
    // Add granularity indicator for sub-chunks
    if (block.granularity === 'element') {
      prefix += ` [${block.type.toUpperCase()}]`;
    }
    
    // Add prefix to content
    const contentWithContext = `${prefix}\n\n${block.content}`;
    
    // Generate full chunk ID
    const fullChunkId = block.chunkId 
      ? `${block.chunkId}_${generateChunkId(contentWithContext, index).slice(0, 8)}` 
      : generateChunkId(contentWithContext, index);
    
    // Map raw chunkId to full ID for parent reference resolution
    if (block.chunkId) {
      chunkIdMap.set(block.chunkId, fullChunkId);
    }

    return {
      block,
      fullChunkId,
      contentWithContext,
      index,
    };
  });
  
  // Second pass: resolve parentChunkId to full format
  const chunks: SemanticChunk[] = chunksWithIds.map(({ block, fullChunkId, contentWithContext, index }) => {
    // Resolve parentChunkId to full format if it exists
    const resolvedParentChunkId = block.parentChunkId 
      ? chunkIdMap.get(block.parentChunkId) 
      : undefined;
    
    return {
      id: fullChunkId,
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
        headingLevel: block.headingPath ? block.headingPath.length : undefined,
        headingPath: block.headingPath,
        parentChunkId: resolvedParentChunkId,
        // NEW: Additional metadata for quality and traceability
        granularity: block.granularity,
        assetId: block.assetId,
        pageNumber: block.pageNumber,
      },
    };
  });

  logger.info(
    `Academic chunking complete: ${chunks.length} chunks from "${context.title}" ` +
    `(strategy=${opts.strategy}, level=${opts.chunkLevel})`
  );

  return chunks;
}
