/**
 * Multimodal content processing module for preflight-mcp.
 * 
 * This module provides capabilities for processing various content modalities
 * including images, tables, equations, and generic content.
 * 
 * @module modal
 */

// ============================================================================
// Type Exports
// ============================================================================

export type {
  // Content types
  ModalContentType,
  ModalContent,
  ContentSourceFormat,
  
  // Processing results
  ModalEntityInfo,
  ModalProcessResult,
  BatchProcessResult,
  
  // Configuration
  ContextConfig,
  ContextItemInfo,
  ModalProcessorConfig,
  ImageProcessorConfig,
  TableProcessorConfig,
} from './types.js';

export {
  // Type guards
  isVisualContent,
  requiresVision,
  isModalContentType,
  
  // Constants
  MODAL_DEFAULTS,
  SUPPORTED_IMAGE_FORMATS,
} from './types.js';

// ============================================================================
// Context Extractor
// ============================================================================

export { ContextExtractor, createContextExtractor } from './context-extractor.js';

// ============================================================================
// Modal Processing Service
// ============================================================================

export {
  ModalProcessingService,
  createModalService,
  getDefaultModalService,
  detectModalContent,
  type ModalScope,
  type ModalServiceConfig,
  type ProcessModalInput,
  type ProcessedModalItem,
  type ModalServiceResult,
} from './service.js';

// ============================================================================
// Processors
// ============================================================================

export {
  ImageProcessor,
  createImageProcessor,
  getDefaultImageProcessor,
  TableProcessor,
  createTableProcessor,
  getDefaultTableProcessor,
  type OcrConfig,
  type OcrResult,
  type OcrWord,
  type ImageProcessResult,
  type TableProcessorConfig as TableProcessorOptions,
  type TableAnalysis,
  type ColumnType,
  type TableProcessResult,
  BaseModalProcessor,
  GenericModalProcessor,
  createGenericProcessor,
  type BaseProcessorResult,
  type ProcessingContext,
  EquationProcessor,
  createEquationProcessor,
  type EquationProcessorConfig as EqProcessorConfig,
  type EquationAnalysis,
  type EquationType,
} from './processors/index.js';

// ============================================================================
// JSON Parser Utilities
// ============================================================================

export {
  // Main parser
  robustJsonParse,
  parseJson,
  parseJsonWithMeta,
  
  // Specialized parsers
  parseModalResponse,
  extractJsonFromMarkdown,
  
  // Helpers
  extractAllJsonCandidates,
  tryParseJson,
  basicJsonCleanup,
  progressiveQuoteFix,
  extractFieldsWithRegex,
  isValidModalResponse,
  
  // Types
  type EntityInfo,
  type ModalAnalysisResponse,
  type ParseResult,
} from './utils/json-parser.js';
