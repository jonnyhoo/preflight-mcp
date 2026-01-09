/**
 * Embedding module for semantic search (optional feature).
 * 
 * This module provides embedding generation capabilities for semantic search.
 * Enable via PREFLIGHT_SEMANTIC_SEARCH=true
 * 
 * Supported providers:
 * - ollama: Local embedding via Ollama (default, zero cloud dependency)
 * - openai: Cloud embedding via OpenAI API
 */

// Types
export type {
  EmbeddingVector,
  EmbeddingProvider,
  EmbeddingConfig,
  OllamaEmbeddingConfig,
  OpenAIEmbeddingConfig,
  EmbeddingDocument,
  SemanticSearchHit,
} from './types.js';

// Base class
export { BaseEmbedding } from './base.js';

// Providers
export { OllamaEmbedding } from './ollama.js';
export { OpenAIEmbedding } from './openai.js';

// Factory function to create embedding provider
import type { EmbeddingConfig } from './types.js';
import { BaseEmbedding } from './base.js';
import { OllamaEmbedding } from './ollama.js';
import { OpenAIEmbedding } from './openai.js';

/**
 * Create an embedding provider based on configuration.
 * 
 * @param config Embedding configuration
 * @returns Configured embedding provider
 */
export function createEmbedding(config: EmbeddingConfig): BaseEmbedding {
  switch (config.provider) {
    case 'ollama':
      return new OllamaEmbedding(config);
    case 'openai':
      return new OpenAIEmbedding(config);
    default:
      throw new Error(`Unsupported embedding provider: ${(config as { provider: string }).provider}`);
  }
}
