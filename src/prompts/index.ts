/**
 * Prompt Template Module
 *
 * Provides prompt templates for multimodal content processing.
 * Used by modal processing and VLM integration.
 *
 * @module prompts
 */

// ============================================================================
// Type Exports
// ============================================================================

export type { PromptTemplate, PromptInput } from './types.js';

// ============================================================================
// Template Functions
// ============================================================================

export { getImagePrompt, getTablePrompt, getEquationPrompt } from './templates.js';
