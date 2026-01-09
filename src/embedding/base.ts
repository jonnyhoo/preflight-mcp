/**
 * Base embedding class for semantic search (optional feature).
 * 
 * This module is part of the optional semantic search capability.
 * Enable via PREFLIGHT_SEMANTIC_SEARCH=true
 */

import type { EmbeddingVector, EmbeddingConfig } from './types.js';

/**
 * Abstract base class for embedding providers.
 * 
 * Implementations must provide:
 * - embed(text): Generate embedding for single text
 * - embedBatch(texts): Generate embeddings for multiple texts
 * - getDimension(): Return the vector dimension
 * - getProvider(): Return the provider name
 */
export abstract class BaseEmbedding {
  protected config: EmbeddingConfig;

  constructor(config: EmbeddingConfig) {
    this.config = config;
  }

  /**
   * Preprocess text before embedding.
   * Default: trim and normalize whitespace.
   */
  protected preprocessText(text: string): string {
    return text.trim().replace(/\s+/g, ' ');
  }

  /**
   * Preprocess array of texts.
   */
  protected preprocessTexts(texts: string[]): string[] {
    return texts.map((text) => this.preprocessText(text));
  }

  /**
   * Generate embedding vector for a single text.
   * @param text Text content to embed
   * @returns Embedding vector
   */
  abstract embed(text: string): Promise<EmbeddingVector>;

  /**
   * Generate embedding vectors for multiple texts in batch.
   * @param texts Array of text contents
   * @returns Array of embedding vectors
   */
  abstract embedBatch(texts: string[]): Promise<EmbeddingVector[]>;

  /**
   * Get the embedding vector dimension.
   */
  abstract getDimension(): number;

  /**
   * Get the provider name.
   */
  abstract getProvider(): string;

  /**
   * Get the model name being used.
   */
  abstract getModel(): string;

  /**
   * Check if the embedding service is available.
   * @returns true if the service is reachable and ready
   */
  abstract isAvailable(): Promise<boolean>;
}
