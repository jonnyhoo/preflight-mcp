/**
 * Knowledge Distillation Module
 *
 * Provides knowledge extraction and indexing for code bundles:
 * - VLM extraction for PDF documents (formulas, tables, code)
 * - LLM-powered repo card generation
 * - Semantic indexing for modal content and cards
 *
 * @module distill
 */

// ============================================================================
// Type Exports
// ============================================================================

// types.ts - Core repo card types
export type {
  FieldEvidence,
  GenerationMeta,
  CardWarning,
  RepoCard,
  BundleContext,
  LLMCardResponse,
  CardExport,
  GenerateCardResult,
} from './types.js';

// vlm-extractor.ts - VLM extraction types
export type {
  VLMConfig,
  PageDetectionResult,
  ExtractedFormula,
  ExtractedTable,
  ExtractedCode,
  PageExtraction,
  ExtractionResult,
  ExtractOptions,
} from './vlm-extractor.js';

// llm-client.ts - LLM client types
export type {
  LLMConfig,
  LLMResponse,
  LLMCallResult,
} from './llm-client.js';

// modal-indexer.ts - Modal indexing types
export type {
  ModalChunkKind,
  ModalChunk,
  ModalIndexOptions,
  ModalIndexResult,
} from './modal-indexer.js';

// card-indexer.ts - Card indexing types
export type {
  CardChunkKind,
  CardChunk,
  CardIndexOptions,
  CardIndexResult,
} from './card-indexer.js';

// ============================================================================
// Utility Function Exports
// ============================================================================

export { toSafeRepoId, fromSafeRepoId } from './types.js';

// ============================================================================
// VLM Extractor Exports
// ============================================================================

export {
  getVLMConfig,
  renderPageToBase64,
  callVLM,
  detectStructuredPages,
  extractFromPDF,
  formatAsMarkdown,
} from './vlm-extractor.js';

// ============================================================================
// LLM Client Exports
// ============================================================================

export {
  getLLMConfig,
  callLLM,
  callLLMWithJSON,
  CARD_GENERATION_SYSTEM_PROMPT,
  buildCardGenerationPrompt,
  truncateContext,
} from './llm-client.js';

// ============================================================================
// Repo Card Exports
// ============================================================================

export {
  extractBundleContext,
  generateCardWithLLM,
  generateCardFallback,
  generateRepoCard,
  exportCardForRAG,
} from './repo-card.js';

// ============================================================================
// Modal Indexer Exports
// ============================================================================

export {
  extractionResultToChunks,
  modalServiceResultToChunks,
  indexModalChunks,
  indexVLMExtraction,
  indexModalServiceResult,
} from './modal-indexer.js';

// ============================================================================
// Card Indexer Exports
// ============================================================================

export {
  repoCardToChunks,
  indexRepoCard,
} from './card-indexer.js';
