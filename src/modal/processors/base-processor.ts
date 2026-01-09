/**
 * Base modal processor abstract class.
 *
 * This module provides the foundation for all modal content processors,
 * defining a unified interface for processing different content types.
 *
 * Design reference: RAG-Anything modalprocessors.py BaseModalProcessor
 *
 * @module modal/processors/base-processor
 */

import type {
  ModalContent,
  ModalContentType,
  ModalProcessResult,
  ModalEntityInfo,
  ModalProcessorConfig,
  ContextConfig,
} from '../types.js';
import type { EvidencePointer } from '../../mcp/envelope.js';
import { createModuleLogger } from '../../logging/logger.js';

const logger = createModuleLogger('base-processor');

// ============================================================================
// Types
// ============================================================================

/**
 * Base processor result before full transformation.
 */
export interface BaseProcessorResult {
  /** Whether processing succeeded */
  success: boolean;
  
  /** Detailed description of the content */
  description?: string;
  
  /** Entity information */
  entityInfo?: Partial<ModalEntityInfo>;
  
  /** Processing confidence (0-1) */
  confidence?: number;
  
  /** Error message if failed */
  error?: string;
  
  /** Processing time in milliseconds */
  processingTimeMs: number;
  
  /** Raw extracted content */
  extractedContent?: string;
  
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Processing context passed to processors.
 */
export interface ProcessingContext {
  /** Surrounding text context */
  surroundingText?: string;
  
  /** Page index if from document */
  pageIndex?: number;
  
  /** Document title/name */
  documentTitle?: string;
  
  /** Section path in document hierarchy */
  sectionPath?: string[];
  
  /** Additional hints for processing */
  hints?: Record<string, unknown>;
}

// ============================================================================
// Abstract Base Processor
// ============================================================================

/**
 * Abstract base class for modal content processors.
 * 
 * All specialized processors (Image, Table, Equation, etc.) should extend this class
 * and implement the abstract methods.
 */
export abstract class BaseModalProcessor {
  /** Processor name for identification */
  abstract readonly name: string;
  
  /** Content types this processor can handle */
  abstract readonly supportedTypes: readonly ModalContentType[];
  
  /** Processor configuration */
  protected config: ModalProcessorConfig;
  
  /** Context configuration */
  protected contextConfig: ContextConfig;

  constructor(config: ModalProcessorConfig = {}) {
    this.config = {
      maxResponseTokens: 4096,
      temperature: 0.3,
      includeRawResponse: false,
      timeoutMs: 60000,
      ...config,
    };
    this.contextConfig = config.contextConfig ?? {};
  }

  /**
   * Check if this processor can handle the given content type.
   */
  canProcess(type: ModalContentType): boolean {
    return this.supportedTypes.includes(type);
  }

  /**
   * Process modal content and return structured result.
   * This is the main entry point for processing.
   */
  async process(
    content: ModalContent,
    context?: ProcessingContext
  ): Promise<ModalProcessResult> {
    const startTime = Date.now();

    try {
      // Validate content type
      if (!this.canProcess(content.type)) {
        throw new Error(
          `Processor ${this.name} cannot handle content type: ${content.type}`
        );
      }

      // Extract context if provided
      const contextText = this.buildContextString(content, context);

      // Process content (implemented by subclasses)
      const result = await this.processContent(content, contextText);

      // Transform to final result
      return this.transformResult(result, content, context);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`${this.name} processing failed: ${errMsg}`);

      // Return error result
      return this.createErrorResult(errMsg, Date.now() - startTime);
    }
  }

  /**
   * Process content - to be implemented by subclasses.
   */
  protected abstract processContent(
    content: ModalContent,
    context?: string
  ): Promise<BaseProcessorResult>;

  /**
   * Build context string from content and processing context.
   */
  protected buildContextString(
    content: ModalContent,
    context?: ProcessingContext
  ): string {
    const parts: string[] = [];

    // Add document context
    if (context?.documentTitle) {
      parts.push(`Document: ${context.documentTitle}`);
    }

    // Add section path
    if (context?.sectionPath && context.sectionPath.length > 0) {
      parts.push(`Section: ${context.sectionPath.join(' > ')}`);
    }

    // Add page info
    if (context?.pageIndex !== undefined) {
      parts.push(`Page: ${context.pageIndex + 1}`);
    }

    // Add captions
    if (content.captions && content.captions.length > 0) {
      parts.push(`Caption: ${content.captions.join('; ')}`);
    }

    // Add surrounding text
    if (context?.surroundingText) {
      parts.push(`Context: ${context.surroundingText}`);
    }

    return parts.join('\n');
  }

  /**
   * Transform base result to full ModalProcessResult.
   */
  protected transformResult(
    result: BaseProcessorResult,
    content: ModalContent,
    context?: ProcessingContext
  ): ModalProcessResult {
    // Build entity info with defaults
    const entityInfo: ModalEntityInfo = {
      entityName: result.entityInfo?.entityName ?? this.generateEntityName(content, context),
      entityType: result.entityInfo?.entityType ?? content.type,
      summary: result.entityInfo?.summary ?? result.description ?? '',
      keywords: result.entityInfo?.keywords,
      relatedEntities: result.entityInfo?.relatedEntities,
    };

    // Build evidence pointers
    const evidence = this.buildEvidence(content, context);

    return {
      description: result.description ?? '',
      entityInfo,
      evidence,
      confidence: result.confidence ?? 0.8,
      method: this.getProcessingMethod(),
      warnings: result.error ? [result.error] : undefined,
      rawResponse: this.config.includeRawResponse
        ? result.extractedContent
        : undefined,
      processingTimeMs: result.processingTimeMs,
    };
  }

  /**
   * Generate entity name from content and context.
   */
  protected generateEntityName(
    content: ModalContent,
    context?: ProcessingContext
  ): string {
    const parts: string[] = [];

    // Add type
    parts.push(content.type);

    // Add page if available
    if (content.pageIndex !== undefined) {
      parts.push(`p${content.pageIndex + 1}`);
    } else if (context?.pageIndex !== undefined) {
      parts.push(`p${context.pageIndex + 1}`);
    }

    // Add section hint
    if (context?.sectionPath && context.sectionPath.length > 0) {
      const lastSection = context.sectionPath[context.sectionPath.length - 1];
      if (lastSection) {
        parts.push(lastSection.slice(0, 20));
      }
    }

    return parts.join('_');
  }

  /**
   * Build evidence pointers for the processed content.
   */
  protected buildEvidence(
    content: ModalContent,
    context?: ProcessingContext
  ): EvidencePointer[] {
    const evidence: EvidencePointer[] = [];

    // Create source evidence
    if (content.sourcePath) {
      // Build minimal pointer; detailed ranges can be added upstream
      evidence.push({
        path: content.sourcePath,
        range: { startLine: 1, endLine: 1 },
        snippet: content.captions?.[0] ?? `${content.type} content`,
      });
    }

    // Add position evidence if available
    if (content.position) {
      evidence.push({
        path: content.sourcePath ?? 'unknown',
        range: { startLine: 1, endLine: 1 },
        snippet: `Position: (${content.position.x}, ${content.position.y})`,
      });
    }

    return evidence;
  }

  /**
   * Get the processing method used.
   */
  protected getProcessingMethod(): 'llm' | 'heuristic' | 'hybrid' {
    return 'heuristic';
  }

  /**
   * Create an error result.
   */
  protected createErrorResult(
    error: string,
    processingTimeMs: number
  ): ModalProcessResult {
    return {
      description: `Processing failed: ${error}`,
      entityInfo: {
        entityName: 'error',
        entityType: 'error',
        summary: error,
      },
      evidence: [],
      confidence: 0,
      method: 'heuristic',
      warnings: [error],
      processingTimeMs,
    };
  }

  /**
   * Estimate token count for text.
   */
  protected estimateTokens(text: string): number {
    // Simple estimate: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  /**
   * Truncate text to fit within token limit.
   */
  protected truncateToTokens(text: string, maxTokens: number): string {
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars - 3) + '...';
  }
}

// ============================================================================
// Generic Processor Implementation
// ============================================================================

/**
 * Generic processor for handling any content type.
 * Used as a fallback when no specialized processor is available.
 */
export class GenericModalProcessor extends BaseModalProcessor {
  readonly name = 'generic';
  readonly supportedTypes: readonly ModalContentType[] = [
    'text', 'generic', 'image', 'table', 'equation', 'code', 'diagram'
  ];

  protected async processContent(
    content: ModalContent,
    context?: string
  ): Promise<BaseProcessorResult> {
    const startTime = Date.now();

    try {
      // Extract text representation of content
      let extractedContent: string;
      
      if (typeof content.content === 'string') {
        extractedContent = content.content;
      } else if (Buffer.isBuffer(content.content)) {
        extractedContent = `[Binary content: ${content.content.length} bytes]`;
      } else if (typeof content.content === 'object') {
        extractedContent = JSON.stringify(content.content, null, 2);
      } else {
        extractedContent = String(content.content);
      }

      // Generate description
      const description = this.generateDescription(content, extractedContent, context);

      return {
        success: true,
        description,
        extractedContent,
        confidence: 0.7,
        processingTimeMs: Date.now() - startTime,
        entityInfo: {
          summary: description.slice(0, 200),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        processingTimeMs: Date.now() - startTime,
      };
    }
  }

  private generateDescription(
    content: ModalContent,
    extracted: string,
    context?: string
  ): string {
    const parts: string[] = [];

    parts.push(`Content type: ${content.type}`);

    if (content.pageIndex !== undefined) {
      parts.push(`Located on page ${content.pageIndex + 1}`);
    }

    if (content.captions && content.captions.length > 0) {
      parts.push(`Caption: "${content.captions[0]}"`);
    }

    // Add content preview
    const preview = extracted.slice(0, 500);
    if (preview) {
      parts.push(`Content preview: ${preview}${extracted.length > 500 ? '...' : ''}`);
    }

    if (context) {
      parts.push(`Context: ${context.slice(0, 200)}`);
    }

    return parts.join('\n');
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a generic modal processor.
 */
export function createGenericProcessor(
  config?: ModalProcessorConfig
): GenericModalProcessor {
  return new GenericModalProcessor(config);
}

export default BaseModalProcessor;
