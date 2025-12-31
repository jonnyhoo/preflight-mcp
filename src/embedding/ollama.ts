/**
 * Ollama embedding implementation for semantic search (optional feature).
 * 
 * Uses local Ollama server for embedding generation.
 * Zero cloud dependency - runs entirely on local machine.
 * 
 * Enable via PREFLIGHT_SEMANTIC_SEARCH=true
 */

import type { EmbeddingVector, OllamaEmbeddingConfig } from './types.js';
import { BaseEmbedding } from './base.js';

// Known embedding model dimensions
const MODEL_DIMENSIONS: Record<string, number> = {
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
  'snowflake-arctic-embed': 1024,
};

/**
 * Ollama embedding provider.
 * 
 * Supports local embedding models via Ollama API.
 * Default model: nomic-embed-text (768 dimensions)
 */
export class OllamaEmbedding extends BaseEmbedding {
  private dimension: number;
  private host: string;
  private model: string;
  private keepAlive?: string;

  constructor(config: OllamaEmbeddingConfig) {
    super(config);
    this.host = config.host || 'http://localhost:11434';
    this.model = config.model || 'nomic-embed-text';
    this.keepAlive = config.keepAlive;
    this.dimension = MODEL_DIMENSIONS[this.model] || 768;
  }

  /**
   * Generate embedding for single text.
   */
  async embed(text: string): Promise<EmbeddingVector> {
    const processedText = this.preprocessText(text);
    
    const requestBody: Record<string, unknown> = {
      model: this.model,
      input: processedText,
    };

    if (this.keepAlive) {
      requestBody.keep_alive = this.keepAlive;
    }

    const response = await fetch(`${this.host}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama embed failed: ${response.status} ${errorText}`);
    }

    const data = await response.json() as { embeddings?: number[][] };

    if (!data.embeddings || !Array.isArray(data.embeddings) || data.embeddings.length === 0) {
      throw new Error('Ollama API returned invalid response: missing embeddings');
    }

    const vector = data.embeddings[0];
    if (!vector || !Array.isArray(vector)) {
      throw new Error('Ollama API returned invalid embedding data');
    }

    // Update dimension from actual response
    this.dimension = vector.length;

    return {
      vector,
      dimension: vector.length,
    };
  }

  /**
   * Generate embeddings for multiple texts in batch.
   */
  async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
    if (texts.length === 0) {
      return [];
    }

    const processedTexts = this.preprocessTexts(texts);

    const requestBody: Record<string, unknown> = {
      model: this.model,
      input: processedTexts,
    };

    if (this.keepAlive) {
      requestBody.keep_alive = this.keepAlive;
    }

    const response = await fetch(`${this.host}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama batch embed failed: ${response.status} ${errorText}`);
    }

    const data = await response.json() as { embeddings?: number[][] };

    if (!data.embeddings || !Array.isArray(data.embeddings)) {
      throw new Error('Ollama API returned invalid batch response');
    }

    // Update dimension from actual response
    if (data.embeddings.length > 0 && data.embeddings[0]) {
      this.dimension = data.embeddings[0].length;
    }

    return data.embeddings.map((vector) => ({
      vector,
      dimension: vector.length,
    }));
  }

  /**
   * Get embedding dimension.
   */
  getDimension(): number {
    return this.dimension;
  }

  /**
   * Get provider name.
   */
  getProvider(): string {
    return 'ollama';
  }

  /**
   * Get model name.
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Check if Ollama server is available.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.host}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * List available models on the Ollama server.
   */
  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.host}/api/tags`);
      if (!response.ok) return [];
      
      const data = await response.json() as { models?: Array<{ name: string }> };
      return data.models?.map((m) => m.name) || [];
    } catch {
      return [];
    }
  }
}
