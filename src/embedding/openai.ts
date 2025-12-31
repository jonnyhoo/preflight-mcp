/**
 * OpenAI embedding implementation for semantic search (optional feature).
 * 
 * Uses OpenAI API for embedding generation.
 * Requires OPENAI_API_KEY environment variable.
 * 
 * Enable via PREFLIGHT_SEMANTIC_SEARCH=true
 */

import type { EmbeddingVector, OpenAIEmbeddingConfig } from './types.js';
import { BaseEmbedding } from './base.js';

// Known OpenAI embedding model dimensions
const MODEL_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

/**
 * OpenAI embedding provider.
 * 
 * Supports OpenAI embedding models and compatible endpoints.
 * Default model: text-embedding-3-small (1536 dimensions)
 */
export class OpenAIEmbedding extends BaseEmbedding {
  private dimension: number;
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: OpenAIEmbeddingConfig) {
    super(config);
    this.apiKey = config.apiKey;
    this.model = config.model || 'text-embedding-3-small';
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    this.dimension = MODEL_DIMENSIONS[this.model] || 1536;
  }

  /**
   * Generate embedding for single text.
   */
  async embed(text: string): Promise<EmbeddingVector> {
    const processedText = this.preprocessText(text);

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: processedText,
        encoding_format: 'float',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI embed failed: ${response.status} ${errorText}`);
    }

    const data = await response.json() as {
      data?: Array<{ embedding?: number[] }>;
    };

    if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
      throw new Error('OpenAI API returned invalid response: missing data');
    }

    const embedding = data.data[0]?.embedding;
    if (!embedding || !Array.isArray(embedding)) {
      throw new Error('OpenAI API returned invalid embedding data');
    }

    // Update dimension from actual response
    this.dimension = embedding.length;

    return {
      vector: embedding,
      dimension: embedding.length,
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

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: processedTexts,
        encoding_format: 'float',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI batch embed failed: ${response.status} ${errorText}`);
    }

    const data = await response.json() as {
      data?: Array<{ embedding?: number[]; index?: number }>;
    };

    if (!data.data || !Array.isArray(data.data)) {
      throw new Error('OpenAI API returned invalid batch response');
    }

    // Sort by index to ensure correct order
    const sortedData = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    // Update dimension from actual response
    if (sortedData.length > 0 && sortedData[0]?.embedding) {
      this.dimension = sortedData[0].embedding.length;
    }

    return sortedData.map((item) => {
      if (!item.embedding) {
        throw new Error('OpenAI API returned invalid embedding in batch');
      }
      return {
        vector: item.embedding,
        dimension: item.embedding.length,
      };
    });
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
    return 'openai';
  }

  /**
   * Get model name.
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Check if OpenAI API is available.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get supported models.
   */
  static getSupportedModels(): string[] {
    return Object.keys(MODEL_DIMENSIONS);
  }
}
