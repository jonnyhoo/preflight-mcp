/**
 * Modal content processing service.
 *
 * Provides unified orchestration for Image/Table/Equation processors.
 * Supports batch processing and result aggregation.
 *
 * @module modal/service
 */

import type {
  ModalContent,
  ModalContentType,
  ModalProcessResult,
  BatchProcessResult,
  ModalEntityInfo,
} from './types.js';
import type { EvidencePointer } from '../mcp/envelope.js';
import { createRange } from '../mcp/envelope.js';
import {
  ImageProcessor,
  TableProcessor,
  EquationProcessor,
  GenericModalProcessor,
  type BaseProcessorResult,
} from './processors/index.js';
import { ContextExtractor } from './context-extractor.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('modal-service');

// ============================================================================
// Types
// ============================================================================

/**
 * Modal processing scope for filtering content types.
 */
export type ModalScope = 'images' | 'tables' | 'equations' | 'all';

/**
 * Service configuration.
 */
export interface ModalServiceConfig {
  /** Enable image processing */
  processImages?: boolean;
  /** Enable table processing */
  processTables?: boolean;
  /** Enable equation processing */
  processEquations?: boolean;
  /** Context extraction window size */
  contextWindowSize?: number;
  /** Max tokens for context */
  maxContextTokens?: number;
  /** Enable parallel processing */
  parallelProcessing?: boolean;
  /** Max concurrent processors */
  maxConcurrency?: number;
}

/**
 * Input for processing modal content.
 */
export interface ProcessModalInput {
  /** Bundle ID */
  bundleId: string;
  /** Content items to process */
  items: ModalContent[];
  /** Processing scope */
  scope?: ModalScope;
  /** Optional context source for each item */
  contextSource?: unknown;
}

/**
 * Result for a single processed item.
 */
export interface ProcessedModalItem {
  /** Original content type */
  type: ModalContentType;
  /** Source path if available */
  path?: string;
  /** Processing success */
  success: boolean;
  /** Error if failed */
  error?: string;
  /** Generated description */
  description?: string;
  /** Extracted text content */
  extractedText?: string;
  /** Entity information */
  entityInfo?: ModalEntityInfo;
  /** Evidence pointer for citations */
  evidence?: EvidencePointer;
  /** Processing time in ms */
  processingTimeMs: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Complete processing result.
 */
export interface ModalServiceResult {
  bundleId: string;
  scope: ModalScope;
  totalItems: number;
  processedItems: number;
  successCount: number;
  errorCount: number;
  items: ProcessedModalItem[];
  summary: string;
  totalProcessingTimeMs: number;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: Required<ModalServiceConfig> = {
  processImages: true,
  processTables: true,
  processEquations: true,
  contextWindowSize: 5,
  maxContextTokens: 65536,  // No limits
  parallelProcessing: false,
  maxConcurrency: 4,
};

// ============================================================================
// Modal Processing Service
// ============================================================================

/**
 * Service for processing multimodal content.
 */
export class ModalProcessingService {
  private config: Required<ModalServiceConfig>;
  private imageProcessor: ImageProcessor;
  private tableProcessor: TableProcessor;
  private equationProcessor: EquationProcessor;
  private genericProcessor: GenericModalProcessor;
  private contextExtractor: ContextExtractor;

  constructor(config: ModalServiceConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize processors
    this.imageProcessor = new ImageProcessor();
    this.tableProcessor = new TableProcessor();
    this.equationProcessor = new EquationProcessor();
    this.genericProcessor = new GenericModalProcessor();

    // Initialize context extractor
    this.contextExtractor = new ContextExtractor({
      maxTokens: this.config.maxContextTokens,
      windowSize: this.config.contextWindowSize,
    });
  }

  /**
   * Process modal content items.
   */
  async process(input: ProcessModalInput): Promise<ModalServiceResult> {
    const startTime = Date.now();
    const scope = input.scope ?? 'all';

    logger.info('Starting modal processing', {
      bundleId: input.bundleId,
      itemCount: input.items.length,
      scope,
    });

    // Filter items by scope
    const filteredItems = this.filterByScope(input.items, scope);

    // Process items
    const processedItems: ProcessedModalItem[] = [];

    if (this.config.parallelProcessing) {
      // Parallel processing with concurrency limit
      const batches = this.chunkArray(filteredItems, this.config.maxConcurrency);
      for (const batch of batches) {
        const batchResults = await Promise.all(
          batch.map((item, index) =>
            this.processItem(item, input.bundleId, input.contextSource, index)
          )
        );
        processedItems.push(...batchResults);
      }
    } else {
      // Sequential processing
      for (let i = 0; i < filteredItems.length; i++) {
        const item = filteredItems[i];
        if (!item) continue;
        const result = await this.processItem(item, input.bundleId, input.contextSource, i);
        processedItems.push(result);
      }
    }

    // Calculate statistics
    const successCount = processedItems.filter((r) => r.success).length;
    const errorCount = processedItems.filter((r) => !r.success).length;
    const totalProcessingTimeMs = Date.now() - startTime;

    // Generate summary
    const summary = this.generateSummary(processedItems, scope);

    logger.info('Modal processing complete', {
      bundleId: input.bundleId,
      processed: processedItems.length,
      success: successCount,
      errors: errorCount,
      timeMs: totalProcessingTimeMs,
    });

    return {
      bundleId: input.bundleId,
      scope,
      totalItems: input.items.length,
      processedItems: processedItems.length,
      successCount,
      errorCount,
      items: processedItems,
      summary,
      totalProcessingTimeMs,
    };
  }

  /**
   * Process a single modal item.
   */
  private async processItem(
    item: ModalContent,
    bundleId: string,
    contextSource: unknown | undefined,
    index: number
  ): Promise<ProcessedModalItem> {
    const startTime = Date.now();

    try {
      // Extract context if available
      let context: string | undefined;
      if (contextSource) {
        context = this.contextExtractor.extractContext(contextSource, {
          type: item.type,
          index,
        });
      }

      // Process based on type
      const result = await this.processWithProcessor(item, context);

      // Create evidence pointer if successful
      let evidence: EvidencePointer | undefined;
      if (result.success && item.sourcePath) {
        evidence = {
          path: item.sourcePath,
          range: createRange(1, 1),
          snippet: result.description?.slice(0, 200),
        };
      }

      // Convert partial entity info to full if needed
      const entityInfo: ModalEntityInfo | undefined = result.entityInfo
        ? {
            entityName: result.entityInfo.entityName ?? 'unknown',
            entityType: result.entityInfo.entityType ?? item.type,
            summary: result.entityInfo.summary ?? '',
            keywords: result.entityInfo.keywords,
            relatedEntities: result.entityInfo.relatedEntities,
          }
        : undefined;

      return {
        type: item.type,
        path: item.sourcePath,
        success: result.success,
        error: result.error,
        description: result.description,
        extractedText: result.extractedContent,
        entityInfo,
        evidence,
        processingTimeMs: result.processingTimeMs,
        metadata: result.metadata,
      };
    } catch (err) {
      return {
        type: item.type,
        path: item.sourcePath,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        processingTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Process content with appropriate processor based on type.
   */
  private async processWithProcessor(
    item: ModalContent,
    context?: string
  ): Promise<BaseProcessorResult> {
    switch (item.type) {
      case 'image': {
        const result = await this.imageProcessor.processImage(item);
        return {
          success: result.success,
          description: result.extractedContext ? `OCR extracted text: ${result.extractedContext}` : 'Image processed',
          extractedContent: result.extractedContext,
          confidence: result.confidence,
          error: result.error,
          processingTimeMs: result.processingTimeMs,
          metadata: result.metadata,
        };
      }
      case 'table': {
        const result = await this.tableProcessor.processTable(item);
        const analysis = result.metadata?.analysis as Record<string, unknown> | undefined;
        const summary = result.metadata?.summary as string | undefined;
        return {
          success: result.success,
          description: summary || (result.extractedContext ? `Table content: ${result.extractedContext.slice(0, 200)}` : 'Table processed'),
          extractedContent: result.extractedContext,
          confidence: result.confidence,
          error: result.error,
          processingTimeMs: result.processingTimeMs,
          metadata: { analysis },
          entityInfo: {
            entityType: 'table',
            summary: summary || 'Table data',
            keywords: analysis ? ['table', 'data', 'structured'] : undefined,
          },
        };
      }
      case 'equation': {
        // Wrap context in ProcessingContext format
        const processingContext = context ? { surroundingText: context } : undefined;
        const result = await this.equationProcessor.process(item, processingContext);
        return {
          success: true,
          description: result.description,
          extractedContent: result.rawResponse,
          confidence: result.confidence,
          processingTimeMs: 0, // Already tracked in result
          entityInfo: result.entityInfo,
          metadata: result.warnings ? { warnings: result.warnings } : undefined,
        };
      }
      default: {
        const processingContext = context ? { surroundingText: context } : undefined;
        const result = await this.genericProcessor.process(item, processingContext);
        return {
          success: true,
          description: result.description,
          extractedContent: result.rawResponse,
          confidence: result.confidence,
          processingTimeMs: 0,
          entityInfo: result.entityInfo,
          metadata: result.warnings ? { warnings: result.warnings } : undefined,
        };
      }
    }
  }

  /**
   * Filter items by scope.
   */
  private filterByScope(items: ModalContent[], scope: ModalScope): ModalContent[] {
    if (scope === 'all') {
      return items.filter((item) => this.isTypeEnabled(item.type));
    }

    const typeMapping: Record<ModalScope, ModalContentType[]> = {
      images: ['image'],
      tables: ['table'],
      equations: ['equation'],
      all: ['image', 'table', 'equation', 'generic'],
    };

    const allowedTypes = typeMapping[scope] || [];
    return items.filter(
      (item) => allowedTypes.includes(item.type) && this.isTypeEnabled(item.type)
    );
  }

  /**
   * Check if a content type is enabled in config.
   */
  private isTypeEnabled(type: ModalContentType): boolean {
    switch (type) {
      case 'image':
        return this.config.processImages;
      case 'table':
        return this.config.processTables;
      case 'equation':
        return this.config.processEquations;
      default:
        return true;
    }
  }


  /**
   * Generate processing summary.
   */
  private generateSummary(items: ProcessedModalItem[], scope: ModalScope): string {
    const parts: string[] = [];

    // Overall statistics
    const byType = new Map<string, { success: number; error: number }>();
    for (const item of items) {
      const stats = byType.get(item.type) ?? { success: 0, error: 0 };
      if (item.success) {
        stats.success++;
      } else {
        stats.error++;
      }
      byType.set(item.type, stats);
    }

    parts.push(`## Modal Processing Summary (scope: ${scope})`);
    parts.push(`Total items processed: ${items.length}`);
    parts.push('');

    // Per-type statistics
    parts.push('### By Type');
    for (const [type, stats] of byType) {
      const total = stats.success + stats.error;
      const successRate = total > 0 ? ((stats.success / total) * 100).toFixed(0) : 0;
      parts.push(`- **${type}**: ${stats.success}/${total} success (${successRate}%)`);
    }

    // Errors if any
    const errors = items.filter((i) => !i.success);
    if (errors.length > 0) {
      parts.push('');
      parts.push('### Errors');
      for (const err of errors.slice(0, 5)) {
        parts.push(`- ${err.type}${err.path ? ` (${err.path})` : ''}: ${err.error}`);
      }
      if (errors.length > 5) {
        parts.push(`- ... and ${errors.length - 5} more errors`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Chunk array into batches.
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Get service configuration.
   */
  getConfig(): Required<ModalServiceConfig> {
    return { ...this.config };
  }

  /**
   * Update service configuration.
   */
  setConfig(config: Partial<ModalServiceConfig>): void {
    this.config = { ...this.config, ...config };
    this.contextExtractor.setConfig({
      maxTokens: this.config.maxContextTokens,
      windowSize: this.config.contextWindowSize,
    });
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

let defaultService: ModalProcessingService | null = null;

/**
 * Create a new modal processing service.
 */
export function createModalService(config?: ModalServiceConfig): ModalProcessingService {
  return new ModalProcessingService(config);
}

/**
 * Get or create the default modal processing service.
 */
export function getDefaultModalService(): ModalProcessingService {
  if (!defaultService) {
    defaultService = new ModalProcessingService();
  }
  return defaultService;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Detect modal content types in a list of files.
 */
export function detectModalContent(files: Array<{ path: string; mimeType?: string }>): {
  images: string[];
  tables: string[];
  equations: string[];
} {
  const images: string[] = [];
  const tables: string[] = [];
  const equations: string[] = [];

  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
  const tableExtensions = ['.csv', '.xlsx', '.xls'];
  const equationPatterns = [/\.tex$/, /\.latex$/, /equation/i];

  for (const file of files) {
    const ext = file.path.slice(file.path.lastIndexOf('.')).toLowerCase();

    if (imageExtensions.includes(ext)) {
      images.push(file.path);
    } else if (tableExtensions.includes(ext)) {
      tables.push(file.path);
    } else if (equationPatterns.some((p) => p.test(file.path))) {
      equations.push(file.path);
    }
  }

  return { images, tables, equations };
}

export default ModalProcessingService;
