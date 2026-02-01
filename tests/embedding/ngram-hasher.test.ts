/**
 * Tests for NUMEN N-Gram Hasher.
 * 
 * Tests:
 * 1. Basic functionality: hash generation, normalization
 * 2. Similarity computation: exact match, partial match, no match
 * 3. Performance: 1000 chars < 10ms
 * 4. Technical term matching: BERT, ResNet, Transformer
 * 5. Formula/metric matching
 * 6. Configuration options
 */

import { describe, it, expect } from '@jest/globals';
import {
  NgramHasher,
  hashNgrams,
  ngramSimilarity,
  computeHybridScore,
  shouldUseNgramMatching,
} from '../../src/embedding/ngram-hasher.js';

// ============================================================================
// Test Fixtures
// ============================================================================

const TECHNICAL_TERMS = [
  'BERT',
  'ResNet',
  'Transformer',
  'GPT-4',
  'ImageNet',
  'attention mechanism',
  'softmax',
  'ReLU',
  'Adam optimizer',
  'cross-entropy loss',
];

const SAMPLE_TEXTS = {
  short: 'BERT model',
  medium: 'The Transformer architecture uses attention mechanisms for sequence modeling.',
  long: `
    In this paper, we introduce BERT, a new language representation model. 
    BERT stands for Bidirectional Encoder Representations from Transformers.
    Unlike previous models, BERT is designed to pre-train deep bidirectional 
    representations from unlabeled text by jointly conditioning on both left 
    and right context in all layers. The pre-trained BERT model can be 
    fine-tuned with just one additional output layer to create state-of-the-art 
    models for a wide range of tasks, such as question answering and language 
    inference, without substantial task-specific architecture modifications.
  `.trim(),
};

// ============================================================================
// Basic Functionality Tests
// ============================================================================

describe('NgramHasher', () => {
  describe('Basic Functionality', () => {
    it('should generate a vector with correct dimension', () => {
      const hasher = new NgramHasher({ dimension: 8192 });
      const result = hasher.hash('test text');

      expect(result.dimension).toBe(8192);
      expect(result.vector).toHaveLength(8192);
    });

    it('should generate normalized vectors (L2 norm ≈ 1)', () => {
      const hasher = new NgramHasher();
      const result = hasher.hash('test text for normalization');

      // Compute L2 norm
      let norm = 0;
      for (const v of result.vector) {
        norm += v * v;
      }
      norm = Math.sqrt(norm);

      expect(norm).toBeCloseTo(1.0, 5);
    });

    it('should handle empty string', () => {
      const hasher = new NgramHasher();
      const result = hasher.hash('');

      expect(result.nonZeroCount).toBe(0);
      expect(result.sparsity).toBe(0);
    });

    it('should handle very short strings (< 3 chars)', () => {
      const hasher = new NgramHasher();
      const result = hasher.hash('ab');

      // 2-char string cannot produce any n-grams (n >= 3)
      expect(result.nonZeroCount).toBe(0);
    });

    it('should produce sparse vectors', () => {
      const hasher = new NgramHasher({ dimension: 8192 });
      const result = hasher.hash(SAMPLE_TEXTS.medium);

      // Sparsity should be low (most elements are zero)
      expect(result.sparsity).toBeLessThan(0.1); // < 10% non-zero
      expect(result.nonZeroCount).toBeGreaterThan(0);
    });

    it('should be case insensitive by default', () => {
      const hasher = new NgramHasher();
      const v1 = hasher.hash('BERT');
      const v2 = hasher.hash('bert');

      // Use toBeCloseTo for floating-point comparison
      expect(hasher.cosineSimilarity(v1, v2)).toBeCloseTo(1.0, 5);
    });

    it('should support case-sensitive mode', () => {
      const hasher = new NgramHasher({ lowercase: false });
      const v1 = hasher.hash('BERT');
      const v2 = hasher.hash('bert');

      // Different case should produce different vectors
      expect(hasher.cosineSimilarity(v1, v2)).toBeLessThan(1.0);
    });
  });

  // ============================================================================
  // Similarity Tests
  // ============================================================================

  describe('Similarity Computation', () => {
    it('should return 1.0 for identical texts', () => {
      const hasher = new NgramHasher();
      const v1 = hasher.hash('BERT model');
      const v2 = hasher.hash('BERT model');

      // Use toBeCloseTo for floating-point comparison
      expect(hasher.cosineSimilarity(v1, v2)).toBeCloseTo(1.0, 5);
    });

    it('should return high similarity for similar texts', () => {
      const hasher = new NgramHasher();
      const v1 = hasher.hash('BERT model architecture');
      const v2 = hasher.hash('BERT model design');

      const sim = hasher.cosineSimilarity(v1, v2);
      // Texts share "BERT model" but differ in suffix
      expect(sim).toBeGreaterThan(0.4);
    });

    it('should return low similarity for different texts', () => {
      const hasher = new NgramHasher();
      const v1 = hasher.hash('BERT natural language processing');
      const v2 = hasher.hash('cooking recipes and ingredients');

      const sim = hasher.cosineSimilarity(v1, v2);
      expect(sim).toBeLessThan(0.3);
    });

    it('should detect exact term match', () => {
      const hasher = new NgramHasher();
      
      const query = hasher.hash('ResNet');
      const doc1 = hasher.hash('ResNet achieves high accuracy on ImageNet');
      const doc2 = hasher.hash('VGG network is a deep CNN model');

      const sim1 = hasher.cosineSimilarity(query, doc1);
      const sim2 = hasher.cosineSimilarity(query, doc2);

      // doc1 contains "ResNet", doc2 doesn't
      expect(sim1).toBeGreaterThan(sim2);
    });

    it('should throw on dimension mismatch', () => {
      const hasher1 = new NgramHasher({ dimension: 8192 });
      const hasher2 = new NgramHasher({ dimension: 4096 });

      const v1 = hasher1.hash('test');
      const v2 = hasher2.hash('test');

      expect(() => hasher1.cosineSimilarity(v1, v2)).toThrow('Dimension mismatch');
    });
  });

  // ============================================================================
  // Performance Tests
  // ============================================================================

  describe('Performance', () => {
    it('should hash 1000 characters in < 10ms', () => {
      const hasher = new NgramHasher({ dimension: 8192 });
      
      // Generate 1000-char text
      const text = 'a'.repeat(1000);

      const startTime = performance.now();
      hasher.hash(text);
      const duration = performance.now() - startTime;

      console.log(`1000 chars: ${duration.toFixed(2)}ms`);
      expect(duration).toBeLessThan(10);
    });

    it('should hash medium text (500 chars) in < 5ms', () => {
      const hasher = new NgramHasher({ dimension: 8192 });
      const text = SAMPLE_TEXTS.medium.repeat(5); // ~500 chars

      const startTime = performance.now();
      hasher.hash(text);
      const duration = performance.now() - startTime;

      console.log(`500 chars: ${duration.toFixed(2)}ms`);
      expect(duration).toBeLessThan(5);
    });

    it('should batch hash 100 texts efficiently', () => {
      const hasher = new NgramHasher({ dimension: 8192 });
      const texts = Array(100).fill(SAMPLE_TEXTS.short);

      const startTime = performance.now();
      hasher.hashBatch(texts);
      const duration = performance.now() - startTime;

      console.log(`100 batch: ${duration.toFixed(2)}ms (${(duration / 100).toFixed(2)}ms/text)`);
      expect(duration).toBeLessThan(100); // < 1ms per text average
    });

    it('should handle large dimension (32k) acceptably', () => {
      const hasher = new NgramHasher({ dimension: 32768 });
      const text = SAMPLE_TEXTS.long;

      const startTime = performance.now();
      hasher.hash(text);
      const duration = performance.now() - startTime;

      console.log(`32k dim: ${duration.toFixed(2)}ms`);
      expect(duration).toBeLessThan(50); // Still reasonable
    });
  });

  // ============================================================================
  // Technical Term Matching Tests
  // ============================================================================

  describe('Technical Term Matching', () => {
    it('should match technical terms exactly', () => {
      const hasher = new NgramHasher();

      for (const term of TECHNICAL_TERMS.slice(0, 5)) {
        const query = hasher.hash(term);
        const docWithTerm = hasher.hash(`The ${term} is widely used in deep learning.`);
        const docWithoutTerm = hasher.hash('This document discusses something else entirely.');

        const simWith = hasher.cosineSimilarity(query, docWithTerm);
        const simWithout = hasher.cosineSimilarity(query, docWithoutTerm);

        expect(simWith).toBeGreaterThan(simWithout);
      }
    });

    it('should distinguish similar model names', () => {
      const hasher = new NgramHasher();

      const queryBERT = hasher.hash('BERT');
      const queryGPT = hasher.hash('GPT');

      const docBERT = hasher.hash('BERT is a bidirectional transformer');
      const docGPT = hasher.hash('GPT is an autoregressive transformer');

      // BERT query should match BERT doc better
      expect(hasher.cosineSimilarity(queryBERT, docBERT))
        .toBeGreaterThan(hasher.cosineSimilarity(queryBERT, docGPT));

      // GPT query should match GPT doc better
      expect(hasher.cosineSimilarity(queryGPT, docGPT))
        .toBeGreaterThan(hasher.cosineSimilarity(queryGPT, docBERT));
    });

    it('should handle hyphenated terms', () => {
      const hasher = new NgramHasher();

      const query = hasher.hash('GPT-4');
      const doc1 = hasher.hash('GPT-4 is the latest model from OpenAI');
      const doc2 = hasher.hash('GPT-3 was released in 2020');

      const sim1 = hasher.cosineSimilarity(query, doc1);
      const sim2 = hasher.cosineSimilarity(query, doc2);

      expect(sim1).toBeGreaterThan(sim2);
    });
  });

  // ============================================================================
  // Formula/Metric Matching Tests
  // ============================================================================

  describe('Formula and Metric Matching', () => {
    it('should match formula keywords', () => {
      const hasher = new NgramHasher();

      const query = hasher.hash('softmax');
      const doc1 = hasher.hash('We apply softmax to compute attention weights');
      const doc2 = hasher.hash('The activation function is ReLU');

      expect(hasher.cosineSimilarity(query, doc1))
        .toBeGreaterThan(hasher.cosineSimilarity(query, doc2));
    });

    it('should match metric names', () => {
      const hasher = new NgramHasher();

      const query = hasher.hash('accuracy');
      const doc1 = hasher.hash('The model achieves 95% accuracy on the test set');
      const doc2 = hasher.hash('The model has 10 million parameters');

      expect(hasher.cosineSimilarity(query, doc1))
        .toBeGreaterThan(hasher.cosineSimilarity(query, doc2));
    });
  });

  // ============================================================================
  // Configuration Tests
  // ============================================================================

  describe('Configuration', () => {
    it('should use default weights', () => {
      const hasher = new NgramHasher();
      const weights = hasher.getWeights();

      expect(weights.gram3).toBe(1.0);
      expect(weights.gram4).toBe(5.0);
      expect(weights.gram5).toBe(10.0);
    });

    it('should support custom weights', () => {
      const hasher = new NgramHasher({
        weights: { gram3: 2.0, gram4: 4.0, gram5: 8.0 },
      });
      const weights = hasher.getWeights();

      expect(weights.gram3).toBe(2.0);
      expect(weights.gram4).toBe(4.0);
      expect(weights.gram5).toBe(8.0);
    });

    it('should support custom dimension', () => {
      const hasher = new NgramHasher({ dimension: 4096 });
      expect(hasher.getDimension()).toBe(4096);
    });
  });
});

// ============================================================================
// Convenience Function Tests
// ============================================================================

describe('Convenience Functions', () => {
  it('hashNgrams should work', () => {
    const result = hashNgrams('test text');
    expect(result.dimension).toBe(8192); // default
    expect(result.vector).toHaveLength(8192);
  });

  it('ngramSimilarity should compute similarity directly', () => {
    const sim = ngramSimilarity('BERT model', 'BERT model');
    // Use toBeCloseTo for floating-point comparison
    expect(sim).toBeCloseTo(1.0, 5);
  });

  it('computeHybridScore should combine scores correctly', () => {
    const dense = 0.8;
    const sparse = 0.6;

    // Default: 0.7 dense + 0.3 sparse
    const hybrid = computeHybridScore(dense, sparse);
    expect(hybrid).toBeCloseTo(0.7 * 0.8 + 0.3 * 0.6);
  });

  it('computeHybridScore should support custom weights', () => {
    const dense = 0.8;
    const sparse = 0.6;

    const hybrid = computeHybridScore(dense, sparse, 0.5);
    expect(hybrid).toBeCloseTo(0.5 * 0.8 + 0.5 * 0.6);
  });
});

// ============================================================================
// Query Analysis Tests
// ============================================================================

describe('shouldUseNgramMatching', () => {
  it('should return true for queries with technical terms', () => {
    expect(shouldUseNgramMatching('What is BERT?')).toBe(true);
    expect(shouldUseNgramMatching('ResNet architecture')).toBe(true);
    expect(shouldUseNgramMatching('GPT-4 capabilities')).toBe(true);
  });

  it('should return true for queries with formulas', () => {
    expect(shouldUseNgramMatching('Eq.5 in the paper')).toBe(true);
    expect(shouldUseNgramMatching('accuracy=0.95')).toBe(true);
    expect(shouldUseNgramMatching('O(n^2) complexity')).toBe(true);
  });

  it('should return true for metric queries', () => {
    expect(shouldUseNgramMatching('highest accuracy model')).toBe(true);
    expect(shouldUseNgramMatching('best performance on ImageNet')).toBe(true);
  });

  it('should return false for simple queries', () => {
    expect(shouldUseNgramMatching('what is machine learning')).toBe(false);
    expect(shouldUseNgramMatching('how does attention work')).toBe(false);
  });
});

// ============================================================================
// Integration Test
// ============================================================================

describe('Integration Test', () => {
  it('should rank documents by term relevance', () => {
    const hasher = new NgramHasher();

    const query = hasher.hash('BERT model ImageNet accuracy');

    const docs = [
      { id: 'a', text: 'BERT achieves state-of-the-art accuracy on NLP tasks' },
      { id: 'b', text: 'ResNet is a popular model for ImageNet classification' },
      { id: 'c', text: 'The weather today is sunny and warm' },
      { id: 'd', text: 'BERT and ImageNet are both important in deep learning' },
    ];

    const scored = docs.map(doc => ({
      id: doc.id,
      score: hasher.cosineSimilarity(query, hasher.hash(doc.text)),
    }));

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    console.log('Ranking:', scored.map(s => `${s.id}:${s.score.toFixed(3)}`).join(', '));

    // Doc 'd' mentions both BERT and ImageNet, should rank high
    // Doc 'c' is irrelevant, should rank lowest
    expect(scored[scored.length - 1]!.id).toBe('c');
  });
});
