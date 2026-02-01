/**
 * NUMEN N-Gram Hasher for exact term matching in PDF retrieval.
 * 
 * Based on NUMEN paper (arXiv:2601.XXXXX) - "N-Gram Hashing for Dense Retrieval".
 * 
 * Key features:
 * - Character-level 3/4/5-gram extraction
 * - CRC32 hashing to high-dimensional sparse vector
 * - Log saturation + L2 normalization
 * - Optimized for PDF术语/公式精确匹配
 * 
 * Performance target: 1000 characters < 10ms
 * 
 * @module embedding/ngram-hasher
 */

import type { NgramHashConfig, NgramVector, NgramWeights } from './types.js';

// ============================================================================
// Constants
// ============================================================================

/** Default vector dimension (8k for balance of accuracy and storage) */
const DEFAULT_DIMENSION = 8192;

/** Default n-gram weights from paper ablation study */
const DEFAULT_WEIGHTS: NgramWeights = {
  gram3: 1.0,   // High coverage, low specificity
  gram4: 5.0,   // Medium specificity
  gram5: 10.0,  // High specificity, best for exact terms
};

// ============================================================================
// CRC32 Implementation (optimized, no external dependency)
// ============================================================================

/**
 * Pre-computed CRC32 lookup table for fast hashing.
 */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc >>> 0; // Ensure unsigned
  }
  return table;
})();

/**
 * Compute CRC32 hash of a string.
 * 
 * @param str - Input string
 * @returns 32-bit unsigned hash value
 */
function crc32(str: string): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < str.length; i++) {
    const byte = str.charCodeAt(i) & 0xFF;
    crc = CRC32_TABLE[(crc ^ byte) & 0xFF]! ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0; // Ensure unsigned
}

// ============================================================================
// NgramHasher Class
// ============================================================================

/**
 * NUMEN N-Gram Hasher for sparse vector generation.
 * 
 * Generates high-dimensional sparse vectors by hashing character n-grams.
 * Designed for exact term matching in hybrid retrieval systems.
 * 
 * @example
 * ```typescript
 * const hasher = new NgramHasher({ dimension: 8192 });
 * 
 * // Hash a single text
 * const vector = hasher.hash('Transformer architecture');
 * console.log(`Sparsity: ${vector.sparsity.toFixed(2)}`);
 * 
 * // Compute similarity between two texts
 * const v1 = hasher.hash('BERT model');
 * const v2 = hasher.hash('BERT architecture');
 * const similarity = hasher.cosineSimilarity(v1, v2);
 * ```
 */
export class NgramHasher {
  private dimension: number;
  private weights: NgramWeights;
  private lowercase: boolean;
  private preserveWhitespace: boolean;

  constructor(config?: NgramHashConfig) {
    this.dimension = config?.dimension ?? DEFAULT_DIMENSION;
    this.weights = {
      ...DEFAULT_WEIGHTS,
      ...config?.weights,
    };
    this.lowercase = config?.lowercase ?? true;
    this.preserveWhitespace = config?.preserveWhitespace ?? true;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Generate n-gram hash vector for a text.
   * 
   * @param text - Input text to hash
   * @returns Normalized sparse vector
   */
  hash(text: string): NgramVector {
    // Preprocess text
    let processed = this.lowercase ? text.toLowerCase() : text;
    if (!this.preserveWhitespace) {
      processed = processed.replace(/\s+/g, '');
    }

    // Initialize accumulator vector
    const vector = new Float32Array(this.dimension);

    // Extract and accumulate n-grams
    this.accumulateNgrams(processed, 3, this.weights.gram3, vector);
    this.accumulateNgrams(processed, 4, this.weights.gram4, vector);
    this.accumulateNgrams(processed, 5, this.weights.gram5, vector);

    // Apply log saturation: v[i] = log(1 + v[i])
    for (let i = 0; i < this.dimension; i++) {
      if (vector[i]! > 0) {
        vector[i] = Math.log1p(vector[i]!);
      }
    }

    // L2 normalization
    let norm = 0;
    for (let i = 0; i < this.dimension; i++) {
      norm += vector[i]! * vector[i]!;
    }
    norm = Math.sqrt(norm);

    if (norm > 0) {
      for (let i = 0; i < this.dimension; i++) {
        vector[i]! /= norm;
      }
    }

    // Count non-zero elements
    let nonZeroCount = 0;
    for (let i = 0; i < this.dimension; i++) {
      if (vector[i]! !== 0) {
        nonZeroCount++;
      }
    }

    return {
      vector: Array.from(vector),
      dimension: this.dimension,
      nonZeroCount,
      sparsity: nonZeroCount / this.dimension,
    };
  }

  /**
   * Generate hash vectors for multiple texts in batch.
   * 
   * @param texts - Array of input texts
   * @returns Array of normalized sparse vectors
   */
  hashBatch(texts: string[]): NgramVector[] {
    return texts.map(text => this.hash(text));
  }

  /**
   * Compute cosine similarity between two n-gram vectors.
   * 
   * @param v1 - First vector
   * @param v2 - Second vector
   * @returns Cosine similarity (0-1, higher is more similar)
   */
  cosineSimilarity(v1: NgramVector, v2: NgramVector): number {
    if (v1.dimension !== v2.dimension) {
      throw new Error(`Dimension mismatch: ${v1.dimension} vs ${v2.dimension}`);
    }

    let dotProduct = 0;
    for (let i = 0; i < v1.dimension; i++) {
      dotProduct += v1.vector[i]! * v2.vector[i]!;
    }

    // Vectors are already L2 normalized, so dot product equals cosine similarity
    return dotProduct;
  }

  /**
   * Compute dot product similarity (unnormalized).
   * 
   * @param v1 - First vector
   * @param v2 - Second vector
   * @returns Dot product
   */
  dotProduct(v1: NgramVector, v2: NgramVector): number {
    if (v1.dimension !== v2.dimension) {
      throw new Error(`Dimension mismatch: ${v1.dimension} vs ${v2.dimension}`);
    }

    let sum = 0;
    for (let i = 0; i < v1.dimension; i++) {
      sum += v1.vector[i]! * v2.vector[i]!;
    }
    return sum;
  }

  /**
   * Get the configured dimension.
   */
  getDimension(): number {
    return this.dimension;
  }

  /**
   * Get the configured weights.
   */
  getWeights(): NgramWeights {
    return { ...this.weights };
  }

  // --------------------------------------------------------------------------
  // Internal Methods
  // --------------------------------------------------------------------------

  /**
   * Extract n-grams from text and accumulate weighted hashes into vector.
   */
  private accumulateNgrams(
    text: string,
    n: number,
    weight: number,
    vector: Float32Array
  ): void {
    if (text.length < n) return;

    for (let i = 0; i <= text.length - n; i++) {
      const gram = text.substring(i, i + n);
      const hash = crc32(gram);
      const idx = hash % this.dimension;
      vector[idx]! += weight;
    }
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Create a hash vector for a single text (convenience function).
 * 
 * @param text - Input text
 * @param config - Optional configuration
 * @returns Normalized sparse vector
 */
export function hashNgrams(text: string, config?: NgramHashConfig): NgramVector {
  const hasher = new NgramHasher(config);
  return hasher.hash(text);
}

/**
 * Compute n-gram similarity between two texts (convenience function).
 * 
 * @param text1 - First text
 * @param text2 - Second text
 * @param config - Optional configuration
 * @returns Cosine similarity (0-1)
 */
export function ngramSimilarity(
  text1: string,
  text2: string,
  config?: NgramHashConfig
): number {
  const hasher = new NgramHasher(config);
  const v1 = hasher.hash(text1);
  const v2 = hasher.hash(text2);
  return hasher.cosineSimilarity(v1, v2);
}

// ============================================================================
// Hybrid Scoring
// ============================================================================

/**
 * Compute hybrid score combining dense and sparse similarities.
 * 
 * @param denseSim - Dense embedding cosine similarity (0-1)
 * @param sparseSim - Sparse n-gram cosine similarity (0-1)
 * @param denseWeight - Weight for dense similarity (default: 0.7)
 * @returns Weighted hybrid score (0-1)
 */
export function computeHybridScore(
  denseSim: number,
  sparseSim: number,
  denseWeight: number = 0.7
): number {
  const sparseWeight = 1 - denseWeight;
  return denseWeight * denseSim + sparseWeight * sparseSim;
}

/**
 * Check if a query likely benefits from n-gram matching.
 * 
 * Returns true for queries containing:
 * - Technical terms (capitalized words like "BERT", "ResNet")
 * - Formulas/equations (contains special chars like =, +, ^)
 * - Specific model names or metrics
 * 
 * @param query - User query
 * @returns True if n-gram matching would be beneficial
 */
export function shouldUseNgramMatching(query: string): boolean {
  // Check for capitalized technical terms (e.g., BERT, ResNet, GPT-4)
  const hasTechnicalTerm = /\b[A-Z]{2,}(?:-[A-Za-z0-9]+)?|\b[A-Z][a-z]+[A-Z]/.test(query);
  
  // Check for formula-like patterns (e.g., "Eq.5", "accuracy=0.95", "O(n^2)")
  const hasFormula = /[=+\-*/^()]|Eq\.\d|accuracy|precision|recall|F1|loss/i.test(query);
  
  // Check for specific metric queries
  const hasMetricQuery = /\b(highest|best|top|maximum|minimum)\s+\w*\s*(accuracy|score|performance)/i.test(query);
  
  return hasTechnicalTerm || hasFormula || hasMetricQuery;
}
