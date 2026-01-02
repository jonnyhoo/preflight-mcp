/**
 * Multimodal content types for preflight-mcp.
 * 
 * This module defines the type system for handling various content modalities
 * including images, tables, equations, and generic content.
 * 
 * Design reference: RAG-Anything modalprocessors.py
 */

import type { EvidencePointer, SourceRange } from '../mcp/envelope.js';

// ============================================================================
// Content Type Definitions
// ============================================================================

/**
 * Supported modal content types.
 * Each type has a specialized processor for optimal analysis.
 */
export type ModalContentType = 
  | 'image'     // Visual content (photos, diagrams, charts, screenshots)
  | 'table'     // Tabular data (structured rows/columns)
  | 'equation'  // Mathematical formulas (LaTeX, MathML)
  | 'code'      // Source code (handled by existing AST system)
  | 'text'      // Plain text content
  | 'diagram'   // Technical diagrams (flowcharts, architecture)
  | 'generic';  // Fallback for unrecognized content

/**
 * Raw modal content before processing.
 */
export interface ModalContent {
  /** Content modality type */
  type: ModalContentType;
  
  /** 
   * Raw content data.
   * - For images: file path or base64 string
   * - For tables: HTML/markdown string or structured data
   * - For equations: LaTeX/MathML string
   * - For text: plain text string
   */
  content: string | Buffer | Record<string, unknown>;
  
  /** Source file path if from a document */
  sourcePath?: string;
  
  /** Page index if from a multi-page document (0-based) */
  pageIndex?: number;
  
  /** Position within the page if available */
  position?: {
    x: number;
    y: number;
    width?: number;
    height?: number;
  };
  
  /** Captions or labels associated with the content */
  captions?: string[];
  
  /** Footnotes or annotations */
  footnotes?: string[];
  
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Processing Result Types
// ============================================================================

/**
 * Entity information extracted from modal content.
 * Used for knowledge graph construction and semantic search.
 */
export interface ModalEntityInfo {
  /** Generated or provided entity name */
  entityName: string;
  
  /** Entity type (mirrors ModalContentType but can be more specific) */
  entityType: string;
  
  /** Concise summary (recommended max 100 words) */
  summary: string;
  
  /** Extracted keywords for searchability */
  keywords?: string[];
  
  /** Related entity names discovered during analysis */
  relatedEntities?: string[];
}

/**
 * Result of processing a modal content item.
 */
export interface ModalProcessResult {
  /** Detailed description of the content */
  description: string;
  
  /** Extracted entity information */
  entityInfo: ModalEntityInfo;
  
  /** Evidence pointers for citation (reuses existing system) */
  evidence: EvidencePointer[];
  
  /** Processing confidence score (0.0 - 1.0) */
  confidence: number;
  
  /** Processing method used */
  method: 'llm' | 'heuristic' | 'hybrid';
  
  /** Warnings encountered during processing */
  warnings?: string[];
  
  /** Raw LLM response if applicable (for debugging) */
  rawResponse?: string;
  
  /** Processing time in milliseconds */
  processingTimeMs?: number;
}

// ============================================================================
// Context Extraction Configuration
// ============================================================================

/**
 * Content source format hints for context extraction.
 */
export type ContentSourceFormat = 
  | 'minerU'       // MinerU parsed output format
  | 'docling'      // Docling parsed output format
  | 'text_chunks'  // Simple text chunk array
  | 'markdown'     // Markdown with embedded content
  | 'html'         // HTML document
  | 'auto';        // Auto-detect format

/**
 * Configuration for context extraction.
 */
export interface ContextConfig {
  /** Maximum tokens for context window */
  maxTokens?: number;
  
  /** Number of items before/after current item to include */
  windowSize?: number;
  
  /** Content source format hint */
  format?: ContentSourceFormat;
  
  /** Whether to include page boundaries in context */
  respectPageBoundaries?: boolean;
  
  /** Custom tokenizer function (defaults to simple word split) */
  tokenizer?: (text: string) => string[];
}

/**
 * Item information for context extraction.
 * Identifies the current item being processed within a larger document.
 */
export interface ContextItemInfo {
  /** Page index (0-based) */
  pageIndex?: number;
  
  /** Item index within the content list */
  index?: number;
  
  /** Content type being processed */
  type?: ModalContentType;
  
  /** Unique identifier if available */
  id?: string;
  
  /** Additional context hints */
  hints?: Record<string, unknown>;
}

// ============================================================================
// Processor Configuration
// ============================================================================

/**
 * Base configuration for modal processors.
 */
export interface ModalProcessorConfig {
  /** LLM model to use for analysis */
  llmModel?: string;
  
  /** Maximum tokens for LLM response */
  maxResponseTokens?: number;
  
  /** Temperature for LLM generation */
  temperature?: number;
  
  /** Whether to include raw response in result */
  includeRawResponse?: boolean;
  
  /** Timeout in milliseconds for processing */
  timeoutMs?: number;
  
  /** Context configuration */
  contextConfig?: ContextConfig;
}

/**
 * Image-specific processor configuration.
 */
export interface ImageProcessorConfig extends ModalProcessorConfig {
  /** Maximum image size in bytes before downscaling */
  maxImageSizeBytes?: number;
  
  /** Whether to encode image as base64 for LLM */
  encodeBase64?: boolean;
  
  /** Supported image formats */
  supportedFormats?: string[];
}

/**
 * Table-specific processor configuration.
 */
export interface TableProcessorConfig extends ModalProcessorConfig {
  /** Maximum rows to include in analysis */
  maxRows?: number;
  
  /** Maximum columns to include in analysis */
  maxColumns?: number;
  
  /** Whether to infer data types */
  inferTypes?: boolean;
}

/**
 * Equation-specific processor configuration.
 */
export interface EquationProcessorConfig extends ModalProcessorConfig {
  /** Preferred input format */
  inputFormat?: 'latex' | 'mathml' | 'auto';
  
  /** Whether to render equation to image for LLM */
  renderToImage?: boolean;
}

// ============================================================================
// Batch Processing Types
// ============================================================================

/**
 * Result of batch processing multiple modal items.
 */
export interface BatchProcessResult {
  /** Successfully processed items */
  processed: Array<{
    index: number;
    content: ModalContent;
    result: ModalProcessResult;
  }>;
  
  /** Failed items with error details */
  failed: Array<{
    index: number;
    content: ModalContent;
    error: string;
  }>;
  
  /** Processing statistics */
  stats: {
    totalItems: number;
    processedCount: number;
    failedCount: number;
    totalTimeMs: number;
    averageTimeMs: number;
  };
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if content type is a visual modality.
 */
export function isVisualContent(type: ModalContentType): boolean {
  return type === 'image' || type === 'diagram' || type === 'table';
}

/**
 * Check if content type requires LLM vision capabilities.
 */
export function requiresVision(type: ModalContentType): boolean {
  return type === 'image' || type === 'diagram';
}

/**
 * Check if a value is a valid ModalContentType.
 */
export function isModalContentType(value: unknown): value is ModalContentType {
  const validTypes: ModalContentType[] = [
    'image', 'table', 'equation', 'code', 'text', 'diagram', 'generic'
  ];
  return typeof value === 'string' && validTypes.includes(value as ModalContentType);
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Default configuration values.
 */
export const MODAL_DEFAULTS = {
  maxTokens: 4096,
  windowSize: 3,
  maxResponseTokens: 2048,
  temperature: 0.3,
  timeoutMs: 60000,
  maxImageSizeBytes: 10 * 1024 * 1024, // 10MB
  maxTableRows: 100,
  maxTableColumns: 50,
} as const;

/**
 * Supported image formats.
 */
export const SUPPORTED_IMAGE_FORMATS = [
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.svg'
] as const;
