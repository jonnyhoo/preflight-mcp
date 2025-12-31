/**
 * Context Extractor for multimodal content processing.
 * 
 * Extracts surrounding context for modal items to improve LLM analysis quality.
 * Supports multiple content source formats including MinerU, Docling, and plain text.
 * 
 * Design reference: RAG-Anything modalprocessors.py:49-357 (ContextExtractor class)
 */

import type { 
  ContextConfig, 
  ContextItemInfo, 
  ContentSourceFormat,
  ModalContentType,
} from './types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('context-extractor');

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: Required<ContextConfig> = {
  maxTokens: 4096,
  windowSize: 3,
  format: 'auto',
  respectPageBoundaries: true,
  tokenizer: defaultTokenizer,
};

/**
 * Simple word-based tokenizer for token counting.
 */
function defaultTokenizer(text: string): string[] {
  return text.split(/\s+/).filter(t => t.length > 0);
}

// ============================================================================
// Content Item Interface (for MinerU/Docling format)
// ============================================================================

/**
 * Content item from MinerU/Docling parsed output.
 */
interface ContentItem {
  type?: string;
  text?: string;
  content?: string;
  page_idx?: number;
  pageIndex?: number;
  index?: number;
  [key: string]: unknown;
}

// ============================================================================
// Context Extractor Class
// ============================================================================

/**
 * Universal context extractor supporting multiple content source formats.
 * 
 * Extracts surrounding text context for a given item to provide
 * better context for LLM analysis of images, tables, equations, etc.
 */
export class ContextExtractor {
  private config: Required<ContextConfig>;

  constructor(config: Partial<ContextConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Extract context for current item from content source.
   * 
   * @param contentSource - Source content (list, dict, string, or other format)
   * @param currentItemInfo - Information about current item being processed
   * @param contentFormat - Format hint for content source
   * @returns Extracted context text
   */
  extractContext(
    contentSource: unknown,
    currentItemInfo: ContextItemInfo,
    contentFormat: ContentSourceFormat = 'auto'
  ): string {
    if (!contentSource) {
      return '';
    }

    try {
      // Use format hint if provided, otherwise auto-detect
      if (contentFormat === 'minerU' && Array.isArray(contentSource)) {
        return this.extractFromContentList(contentSource as ContentItem[], currentItemInfo);
      } else if (contentFormat === 'docling' && Array.isArray(contentSource)) {
        return this.extractFromContentList(contentSource as ContentItem[], currentItemInfo);
      } else if (contentFormat === 'text_chunks' && Array.isArray(contentSource)) {
        return this.extractFromTextChunks(contentSource as string[], currentItemInfo);
      } else if (typeof contentSource === 'string') {
        return this.extractFromTextSource(contentSource, currentItemInfo);
      } else {
        // Auto-detect content source format
        return this.autoDetectAndExtract(contentSource, currentItemInfo);
      }
    } catch (err) {
      logger.error('Error extracting context', err instanceof Error ? err : undefined, { currentItemInfo });
      return '';
    }
  }

  /**
   * Auto-detect content format and extract context.
   */
  private autoDetectAndExtract(
    contentSource: unknown,
    currentItemInfo: ContextItemInfo
  ): string {
    if (Array.isArray(contentSource)) {
      // Check if it's a list of content items or plain strings
      if (contentSource.length > 0) {
        const firstItem = contentSource[0];
        if (typeof firstItem === 'string') {
          return this.extractFromTextChunks(contentSource as string[], currentItemInfo);
        } else if (typeof firstItem === 'object' && firstItem !== null) {
          return this.extractFromContentList(contentSource as ContentItem[], currentItemInfo);
        }
      }
      return '';
    } else if (typeof contentSource === 'object' && contentSource !== null) {
      return this.extractFromDictSource(contentSource as Record<string, unknown>, currentItemInfo);
    } else if (typeof contentSource === 'string') {
      return this.extractFromTextSource(contentSource, currentItemInfo);
    }

    logger.warn('Unsupported content source type', { type: typeof contentSource });
    return '';
  }

  /**
   * Extract context from MinerU/Docling-style content list.
   */
  private extractFromContentList(
    contentList: ContentItem[],
    currentItemInfo: ContextItemInfo
  ): string {
    if (!contentList || contentList.length === 0) {
      return '';
    }

    // Determine extraction strategy based on item info
    if (currentItemInfo.pageIndex !== undefined) {
      return this.extractPageContext(contentList, currentItemInfo);
    } else if (currentItemInfo.index !== undefined) {
      return this.extractChunkContext(contentList, currentItemInfo);
    }

    // Fallback: extract text from all items within token budget
    const allText = contentList
      .map(item => this.extractTextFromItem(item))
      .filter(text => text.length > 0)
      .join('\n\n');

    return this.truncateContext(allText);
  }

  /**
   * Extract context based on page index.
   */
  private extractPageContext(
    contentList: ContentItem[],
    currentItemInfo: ContextItemInfo
  ): string {
    const currentPage = currentItemInfo.pageIndex ?? 0;
    const windowSize = this.config.windowSize;
    const contextParts: string[] = [];

    // Group items by page
    const pageGroups = new Map<number, ContentItem[]>();
    for (const item of contentList) {
      const pageIdx = item.page_idx ?? item.pageIndex ?? 0;
      if (!pageGroups.has(pageIdx)) {
        pageGroups.set(pageIdx, []);
      }
      pageGroups.get(pageIdx)!.push(item);
    }

    // Determine page range to include
    const startPage = this.config.respectPageBoundaries 
      ? currentPage 
      : Math.max(0, currentPage - 1);
    const endPage = this.config.respectPageBoundaries 
      ? currentPage 
      : currentPage + 1;

    // Extract text from pages in range
    for (let page = startPage; page <= endPage; page++) {
      const pageItems = pageGroups.get(page) || [];
      for (const item of pageItems) {
        // Skip the current item itself (by type and index)
        if (this.isCurrentItem(item, currentItemInfo)) {
          continue;
        }
        const text = this.extractTextFromItem(item);
        if (text) {
          contextParts.push(text);
        }
      }
    }

    const context = contextParts.join('\n\n');
    return this.truncateContext(context);
  }

  /**
   * Extract context based on item index within the list.
   */
  private extractChunkContext(
    contentList: ContentItem[],
    currentItemInfo: ContextItemInfo
  ): string {
    const currentIndex = currentItemInfo.index ?? 0;
    const windowSize = this.config.windowSize;
    const contextParts: string[] = [];

    // Calculate window bounds
    const startIdx = Math.max(0, currentIndex - windowSize);
    const endIdx = Math.min(contentList.length - 1, currentIndex + windowSize);

    // Extract text from items within window
    for (let i = startIdx; i <= endIdx; i++) {
      if (i === currentIndex) continue; // Skip current item
      
      const item = contentList[i];
      if (!item) continue;
      const text = this.extractTextFromItem(item);
      if (text) {
        contextParts.push(text);
      }
    }

    const context = contextParts.join('\n\n');
    return this.truncateContext(context);
  }

  /**
   * Extract text content from a single content item.
   */
  private extractTextFromItem(item: ContentItem): string {
    if (!item) return '';

    // Handle different item structures
    const itemType = item.type?.toLowerCase() || 'text';

    // Only extract text from text-type items
    if (itemType === 'text' || itemType === 'heading' || itemType === 'paragraph') {
      return (item.text || item.content || '').toString().trim();
    }

    // For tables, extract caption if available
    if (itemType === 'table') {
      const caption = (item as Record<string, unknown>).table_caption || 
                      (item as Record<string, unknown>).caption;
      return caption ? `[Table: ${caption}]` : '';
    }

    // For images, extract caption if available
    if (itemType === 'image') {
      const caption = (item as Record<string, unknown>).image_caption || 
                      (item as Record<string, unknown>).caption;
      return caption ? `[Image: ${caption}]` : '';
    }

    // For equations, extract the equation text
    if (itemType === 'equation') {
      const equation = (item as Record<string, unknown>).equation_text || 
                       (item as Record<string, unknown>).latex;
      return equation ? `[Equation: ${equation}]` : '';
    }

    return '';
  }

  /**
   * Check if an item matches the current item being processed.
   */
  private isCurrentItem(item: ContentItem, currentItemInfo: ContextItemInfo): boolean {
    // Check by ID if available
    if (currentItemInfo.id && (item as Record<string, unknown>).id === currentItemInfo.id) {
      return true;
    }

    // Check by type and index
    if (currentItemInfo.type && currentItemInfo.index !== undefined) {
      const itemType = item.type?.toLowerCase();
      const itemIndex = item.index;
      return itemType === currentItemInfo.type && itemIndex === currentItemInfo.index;
    }

    return false;
  }

  /**
   * Extract context from a dictionary source.
   */
  private extractFromDictSource(
    dictSource: Record<string, unknown>,
    currentItemInfo: ContextItemInfo
  ): string {
    // Try to find content list in common keys
    const contentKeys = ['contents', 'content', 'items', 'data', 'pages'];
    
    for (const key of contentKeys) {
      if (Array.isArray(dictSource[key])) {
        return this.extractFromContentList(
          dictSource[key] as ContentItem[],
          currentItemInfo
        );
      }
    }

    // Try to extract text directly
    if (typeof dictSource.text === 'string') {
      return this.extractFromTextSource(dictSource.text, currentItemInfo);
    }

    if (typeof dictSource.content === 'string') {
      return this.extractFromTextSource(dictSource.content, currentItemInfo);
    }

    return '';
  }

  /**
   * Extract context from a plain text source.
   */
  private extractFromTextSource(
    textSource: string,
    currentItemInfo: ContextItemInfo
  ): string {
    if (!textSource || textSource.trim().length === 0) {
      return '';
    }

    // For text source, just truncate to fit token budget
    return this.truncateContext(textSource);
  }

  /**
   * Extract context from a list of text chunks.
   */
  private extractFromTextChunks(
    textChunks: string[],
    currentItemInfo: ContextItemInfo
  ): string {
    if (!textChunks || textChunks.length === 0) {
      return '';
    }

    const currentIndex = currentItemInfo.index ?? Math.floor(textChunks.length / 2);
    const windowSize = this.config.windowSize;
    const contextParts: string[] = [];

    // Calculate window bounds
    const startIdx = Math.max(0, currentIndex - windowSize);
    const endIdx = Math.min(textChunks.length - 1, currentIndex + windowSize);

    // Collect chunks within window (excluding current)
    for (let i = startIdx; i <= endIdx; i++) {
      if (i === currentIndex) continue;
      const chunk = textChunks[i]?.trim();
      if (chunk) {
        contextParts.push(chunk);
      }
    }

    const context = contextParts.join('\n\n');
    return this.truncateContext(context);
  }

  /**
   * Truncate context to fit within token budget.
   */
  private truncateContext(context: string): string {
    if (!context) return '';

    const tokens = this.config.tokenizer(context);
    
    if (tokens.length <= this.config.maxTokens) {
      return context.trim();
    }

    // Need to truncate - use binary search for efficiency
    let low = 0;
    let high = context.length;
    let result = context;

    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const truncated = context.slice(0, mid);
      const tokenCount = this.config.tokenizer(truncated).length;

      if (tokenCount <= this.config.maxTokens) {
        result = truncated;
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    // Try to truncate at a sentence or word boundary
    const truncated = this.truncateAtBoundary(result);
    
    logger.debug('Context truncated', {
      originalLength: context.length,
      truncatedLength: truncated.length,
      originalTokens: tokens.length,
      maxTokens: this.config.maxTokens,
    });

    return truncated;
  }

  /**
   * Truncate text at a natural boundary (sentence or word).
   */
  private truncateAtBoundary(text: string): string {
    if (!text) return '';

    // Try to find last sentence boundary
    const sentenceEnd = Math.max(
      text.lastIndexOf('. '),
      text.lastIndexOf('。'),
      text.lastIndexOf('! '),
      text.lastIndexOf('? ')
    );

    if (sentenceEnd > text.length * 0.7) {
      return text.slice(0, sentenceEnd + 1).trim();
    }

    // Try to find last word boundary
    const lastSpace = text.lastIndexOf(' ');
    if (lastSpace > text.length * 0.8) {
      return text.slice(0, lastSpace).trim() + '...';
    }

    return text.trim() + '...';
  }

  /**
   * Update configuration.
   */
  setConfig(config: Partial<ContextConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration.
   */
  getConfig(): Required<ContextConfig> {
    return { ...this.config };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new ContextExtractor with optional configuration.
 */
export function createContextExtractor(config?: Partial<ContextConfig>): ContextExtractor {
  return new ContextExtractor(config);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Estimate token count for a string (rough approximation).
 * Uses ~4 characters per token as a simple heuristic.
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Extract plain text from mixed content list.
 */
export function extractPlainText(contentList: ContentItem[]): string {
  const extractor = new ContextExtractor({ maxTokens: Infinity });
  return contentList
    .map(item => (extractor as unknown as { extractTextFromItem: (item: ContentItem) => string }).extractTextFromItem?.(item) || '')
    .filter(text => text.length > 0)
    .join('\n\n');
}
