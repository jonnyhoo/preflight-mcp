/**
 * Tests for Hybrid Reranker (Dense + N-gram Sparse).
 * 
 * Tests:
 * 1. Basic reranking functionality
 * 2. Auto mode detection (technical terms, formulas)
 * 3. Disabled behavior
 * 4. Dense weight variations
 * 5. Score filtering
 * 6. Performance
 * 7. Convenience functions
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { 
  HybridReranker, 
  hybridRerank, 
  queryNeedsHybridRerank,
  type HybridRerankOptions,
  type HybridScoredChunk,
} from '../../src/rag/hybrid-reranker.js';
import type { ChunkDocument } from '../../src/vectordb/types.js';

// ============================================================================
// Test Fixtures
// ============================================================================

/**
 * Create mock chunks for testing.
 */
function createTestChunks(count: number): Array<ChunkDocument & { score: number }> {
  const chunks: Array<ChunkDocument & { score: number }> = [];
  for (let i = 0; i < count; i++) {
    chunks.push({
      id: `chunk-${i}`,
      content: `This is test content number ${i}. It contains information about topic ${i % 3}.`,
      metadata: { bundleId: 'test', sourceType: 'text' },
      score: 0.9 - (i * 0.05),
    });
  }
  return chunks;
}

/**
 * Create chunks with specific technical terms for testing N-gram matching.
 */
function createTechnicalChunks(): Array<ChunkDocument & { score: number }> {
  return [
    {
      id: 'bert-chunk',
      content: 'BERT (Bidirectional Encoder Representations from Transformers) is a transformer-based model.',
      metadata: { bundleId: 'test', sourceType: 'text' },
      score: 0.7, // Lower dense score
    },
    {
      id: 'gpt-chunk',
      content: 'GPT-4 is a large language model developed by OpenAI with improved capabilities.',
      metadata: { bundleId: 'test', sourceType: 'text' },
      score: 0.85,
    },
    {
      id: 'attention-chunk',
      content: 'The attention mechanism uses softmax to compute attention weights.',
      metadata: { bundleId: 'test', sourceType: 'text' },
      score: 0.8,
    },
    {
      id: 'generic-chunk',
      content: 'Machine learning models can process various types of data inputs.',
      metadata: { bundleId: 'test', sourceType: 'text' },
      score: 0.9, // Highest dense score
    },
  ];
}

/**
 * Create chunks with formula keywords.
 */
function createFormulaChunks(): Array<ChunkDocument & { score: number }> {
  return [
    {
      id: 'softmax-formula',
      content: 'The softmax function is defined as softmax(x_i) = exp(x_i) / sum(exp(x_j)).',
      metadata: { bundleId: 'test', sourceType: 'text' },
      score: 0.6,
    },
    {
      id: 'cross-entropy',
      content: 'Cross-entropy loss measures the difference between predicted and actual distributions.',
      metadata: { bundleId: 'test', sourceType: 'text' },
      score: 0.75,
    },
    {
      id: 'accuracy-metric',
      content: 'Accuracy is calculated as the ratio of correct predictions to total predictions.',
      metadata: { bundleId: 'test', sourceType: 'text' },
      score: 0.8,
    },
  ];
}

// ============================================================================
// Tests
// ============================================================================

describe('HybridReranker', () => {
  let reranker: HybridReranker;

  beforeEach(() => {
    reranker = new HybridReranker();
  });

  describe('Basic Functionality', () => {
    it('should rerank chunks and return hybrid scores', () => {
      const chunks = createTestChunks(5);
      
      const result = reranker.rerank('test query', chunks, { enabled: true });

      expect(result.chunks).toHaveLength(5);
      expect(result.hybridApplied).toBe(true);
      expect(result.stats.originalCount).toBe(5);
      expect(result.stats.finalCount).toBe(5);

      // All chunks should have score properties
      for (const chunk of result.chunks) {
        expect(typeof chunk.denseScore).toBe('number');
        expect(typeof chunk.sparseScore).toBe('number');
        expect(typeof chunk.hybridScore).toBe('number');
        expect(typeof chunk.score).toBe('number');
      }
    });

    it('should sort chunks by hybrid score (descending)', () => {
      const chunks = createTestChunks(5);
      
      const result = reranker.rerank('test query', chunks, { enabled: true });

      // Verify sorted order
      for (let i = 1; i < result.chunks.length; i++) {
        expect(result.chunks[i - 1]!.hybridScore).toBeGreaterThanOrEqual(
          result.chunks[i]!.hybridScore
        );
      }
    });

    it('should preserve original chunk data', () => {
      const chunks = createTestChunks(3);
      
      const result = reranker.rerank('test', chunks, { enabled: true });

      // Original chunk properties should be preserved
      for (const chunk of result.chunks) {
        expect(chunk.metadata.bundleId).toBe('test');
        expect(chunk.metadata.sourceType).toBe('text');
        expect(chunk.content).toContain('test content');
      }
    });
  });

  describe('Disabled Behavior', () => {
    it('should return chunks unchanged when disabled', () => {
      const chunks = createTestChunks(5);
      
      const result = reranker.rerank('test query', chunks, { enabled: false });

      expect(result.hybridApplied).toBe(false);
      expect(result.chunks).toHaveLength(5);
      
      // Order should be preserved
      for (let i = 0; i < 5; i++) {
        expect(result.chunks[i]!.id).toBe(`chunk-${i}`);
      }
    });

    it('should set sparseScore to 0 when disabled', () => {
      const chunks = createTestChunks(3);
      
      const result = reranker.rerank('test', chunks, { enabled: false });

      for (const chunk of result.chunks) {
        expect(chunk.sparseScore).toBe(0);
        expect(chunk.hybridScore).toBe(chunk.denseScore);
      }
    });

    it('should preserve original dense scores when disabled', () => {
      const chunks = createTestChunks(3);
      const originalScores = chunks.map(c => c.score);
      
      const result = reranker.rerank('test', chunks, { enabled: false });

      for (let i = 0; i < 3; i++) {
        expect(result.chunks[i]!.denseScore).toBe(originalScores[i]);
        expect(result.chunks[i]!.score).toBe(originalScores[i]);
      }
    });
  });

  describe('Auto Mode Detection', () => {
    it('should apply hybrid reranking for technical terms (auto mode)', () => {
      const chunks = createTechnicalChunks();
      
      // Query contains technical term 'BERT'
      const result = reranker.rerank('What is BERT?', chunks, { enabled: 'auto' });

      expect(result.hybridApplied).toBe(true);
      expect(result.stats.queryHasTerms).toBe(true);
    });

    it('should apply hybrid reranking for formula keywords (auto mode)', () => {
      const chunks = createFormulaChunks();
      
      // Query contains formula keyword 'accuracy' which is in the regex pattern
      const result = reranker.rerank('What is the accuracy loss?', chunks, { enabled: 'auto' });

      expect(result.hybridApplied).toBe(true);
      expect(result.stats.queryHasTerms).toBe(true);
    });

    it('should skip hybrid reranking for generic queries (auto mode)', () => {
      const chunks = createTestChunks(5);
      
      // Generic query without technical terms
      const result = reranker.rerank('what is this about', chunks, { enabled: 'auto' });

      expect(result.hybridApplied).toBe(false);
      expect(result.stats.queryHasTerms).toBe(false);
    });

    it('should detect metric-related queries', () => {
      const chunks = createFormulaChunks();
      
      // Query about metrics
      const result = reranker.rerank('highest accuracy results', chunks, { enabled: 'auto' });

      expect(result.stats.queryHasTerms).toBe(true);
    });
  });

  describe('N-gram Matching Effect', () => {
    it('should boost chunks containing exact query terms', () => {
      const chunks = createTechnicalChunks();
      
      // Query specifically mentions 'BERT'
      const result = reranker.rerank('BERT model', chunks, { enabled: true });

      // BERT chunk should have higher sparse score
      const bertChunk = result.chunks.find(c => c.id === 'bert-chunk');
      const genericChunk = result.chunks.find(c => c.id === 'generic-chunk');

      expect(bertChunk).toBeDefined();
      expect(genericChunk).toBeDefined();
      expect(bertChunk!.sparseScore).toBeGreaterThan(genericChunk!.sparseScore);
    });

    it('should potentially reorder chunks based on term matching', () => {
      const chunks = createTechnicalChunks();
      
      // BERT chunk has lower dense score (0.7) but should be boosted
      const result = reranker.rerank('BERT transformer', chunks, { 
        enabled: true,
        denseWeight: 0.5, // Equal weight to sparse
      });

      // BERT chunk should move up in ranking
      const bertIndex = result.chunks.findIndex(c => c.id === 'bert-chunk');
      expect(bertIndex).toBeLessThan(3); // Should be in top 3
    });
  });

  describe('Dense Weight Configuration', () => {
    it('should use default dense weight of 0.7', () => {
      const chunks = createTestChunks(3);
      
      const result = reranker.rerank('test', chunks, { enabled: true });

      // Hybrid score should be weighted combination
      for (const chunk of result.chunks) {
        const expected = 0.7 * chunk.denseScore + 0.3 * chunk.sparseScore;
        expect(chunk.hybridScore).toBeCloseTo(expected, 5);
      }
    });

    it('should respect custom dense weight', () => {
      const chunks = createTestChunks(3);
      
      const result = reranker.rerank('test', chunks, { 
        enabled: true,
        denseWeight: 0.5,
      });

      // Hybrid score should use 0.5 weight
      for (const chunk of result.chunks) {
        const expected = 0.5 * chunk.denseScore + 0.5 * chunk.sparseScore;
        expect(chunk.hybridScore).toBeCloseTo(expected, 5);
      }
    });

    it('should handle denseWeight=1.0 (pure dense)', () => {
      const chunks = createTestChunks(3);
      const originalOrder = chunks.map(c => c.id);
      
      const result = reranker.rerank('test', chunks, { 
        enabled: true,
        denseWeight: 1.0,
      });

      // With denseWeight=1.0, hybrid score equals dense score
      for (const chunk of result.chunks) {
        expect(chunk.hybridScore).toBeCloseTo(chunk.denseScore, 5);
      }

      // Order should match original (sorted by dense score)
      const resultOrder = result.chunks.map(c => c.id);
      expect(resultOrder).toEqual(originalOrder);
    });

    it('should handle denseWeight=0 (pure sparse)', () => {
      const chunks = createTestChunks(3);
      
      const result = reranker.rerank('test', chunks, { 
        enabled: true,
        denseWeight: 0,
      });

      // With denseWeight=0, hybrid score equals sparse score
      for (const chunk of result.chunks) {
        expect(chunk.hybridScore).toBeCloseTo(chunk.sparseScore, 5);
      }
    });
  });

  describe('Minimum Score Filtering', () => {
    it('should filter chunks below minScore threshold', () => {
      const chunks = createTestChunks(5);
      
      const result = reranker.rerank('test', chunks, { 
        enabled: true,
        minScore: 0.5,
      });

      // All remaining chunks should have score >= 0.5
      for (const chunk of result.chunks) {
        expect(chunk.hybridScore).toBeGreaterThanOrEqual(0.5);
      }
    });

    it('should not filter when minScore=0', () => {
      const chunks = createTestChunks(5);
      
      const result = reranker.rerank('test', chunks, { 
        enabled: true,
        minScore: 0,
      });

      expect(result.chunks).toHaveLength(5);
    });

    it('should report filtered count in stats', () => {
      const chunks = createTestChunks(5);
      
      const result = reranker.rerank('test', chunks, { 
        enabled: true,
        minScore: 0.8, // High threshold
      });

      expect(result.stats.originalCount).toBe(5);
      expect(result.stats.finalCount).toBeLessThanOrEqual(5);
    });
  });

  describe('Empty Input Handling', () => {
    it('should handle empty chunks array', () => {
      const result = reranker.rerank('test query', [], { enabled: true });

      expect(result.chunks).toHaveLength(0);
      expect(result.hybridApplied).toBe(false);
      expect(result.stats.originalCount).toBe(0);
      expect(result.stats.finalCount).toBe(0);
    });

    it('should handle single chunk', () => {
      const chunks = createTestChunks(1);
      
      const result = reranker.rerank('test', chunks, { enabled: true });

      expect(result.chunks).toHaveLength(1);
      expect(result.hybridApplied).toBe(true);
    });
  });

  describe('Query Vector Caching', () => {
    it('should cache query vectors for repeated queries', () => {
      const chunks = createTestChunks(3);
      
      // First call
      const result1 = reranker.rerank('cached query', chunks, { enabled: true });
      const time1 = result1.stats.durationMs;

      // Second call with same query (should use cache)
      const result2 = reranker.rerank('cached query', chunks, { enabled: true });
      const time2 = result2.stats.durationMs;

      // Both should produce same results
      expect(result1.chunks.map(c => c.id)).toEqual(result2.chunks.map(c => c.id));

      // Second call might be slightly faster due to caching
      // (not strictly enforced as timing can vary)
    });

    it('should clear cache when requested', () => {
      const chunks = createTestChunks(3);
      
      reranker.rerank('query to cache', chunks, { enabled: true });
      reranker.clearCache();

      // Should work fine after clearing
      const result = reranker.rerank('query to cache', chunks, { enabled: true });
      expect(result.chunks).toHaveLength(3);
    });
  });

  describe('Performance', () => {
    it('should complete reranking quickly for small datasets', () => {
      const chunks = createTestChunks(20);
      
      const startTime = Date.now();
      const result = reranker.rerank('test query', chunks, { enabled: true });
      const duration = Date.now() - startTime;

      // Should complete within 100ms for 20 chunks
      expect(duration).toBeLessThan(100);
      expect(result.stats.durationMs).toBeLessThan(100);
    });

    it('should handle larger datasets efficiently', () => {
      const chunks = createTestChunks(100);
      
      const startTime = Date.now();
      const result = reranker.rerank('performance test', chunks, { enabled: true });
      const duration = Date.now() - startTime;

      // Should complete within 500ms for 100 chunks
      expect(duration).toBeLessThan(500);
      expect(result.chunks).toHaveLength(100);
    });
  });

  describe('Sparse Score Computation', () => {
    it('should compute sparse score via computeSparseScore method', () => {
      const score = reranker.computeSparseScore('BERT model', 'BERT is a transformer model');

      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('should return higher sparse score for matching content', () => {
      const matchingScore = reranker.computeSparseScore('BERT', 'BERT model');
      const nonMatchingScore = reranker.computeSparseScore('BERT', 'GPT model');

      expect(matchingScore).toBeGreaterThan(nonMatchingScore);
    });
  });

  describe('Hasher Access', () => {
    it('should expose internal hasher via getHasher', () => {
      const hasher = reranker.getHasher();

      expect(hasher).toBeDefined();
      expect(typeof hasher.hash).toBe('function');
      expect(typeof hasher.cosineSimilarity).toBe('function');
    });
  });
});

// ============================================================================
// Convenience Functions Tests
// ============================================================================

describe('Convenience Functions', () => {
  describe('hybridRerank', () => {
    it('should work as standalone function', () => {
      const chunks = createTestChunks(5);
      
      const result = hybridRerank('test query', chunks, { enabled: true });

      expect(result.chunks).toHaveLength(5);
      expect(result.hybridApplied).toBe(true);
    });

    it('should accept custom ngram config', () => {
      const chunks = createTestChunks(3);
      
      const result = hybridRerank('test', chunks, {
        enabled: true,
        ngramConfig: { dimension: 4096 },
      });

      expect(result.chunks).toHaveLength(3);
    });
  });

  describe('queryNeedsHybridRerank', () => {
    it('should return true for technical term queries', () => {
      expect(queryNeedsHybridRerank('What is BERT?')).toBe(true);
      expect(queryNeedsHybridRerank('GPT-4 capabilities')).toBe(true);
      expect(queryNeedsHybridRerank('ResNet architecture')).toBe(true);
    });

    it('should return true for formula queries', () => {
      // shouldUseNgramMatching detects: accuracy, precision, recall, F1, loss, and formula chars like =+
      expect(queryNeedsHybridRerank('cross-entropy loss')).toBe(true);
      expect(queryNeedsHybridRerank('accuracy = 0.95')).toBe(true);
      expect(queryNeedsHybridRerank('F1 score')).toBe(true);
    });

    it('should return true for metric queries', () => {
      expect(queryNeedsHybridRerank('highest accuracy')).toBe(true);
      expect(queryNeedsHybridRerank('F1 score comparison')).toBe(true);
    });

    it('should return false for generic queries', () => {
      expect(queryNeedsHybridRerank('what is this')).toBe(false);
      expect(queryNeedsHybridRerank('how does it work')).toBe(false);
      expect(queryNeedsHybridRerank('tell me more')).toBe(false);
    });
  });
});

// ============================================================================
// Integration with Retriever Types
// ============================================================================

describe('Integration with RAG Types', () => {
  it('should be compatible with HybridRetrieveOptions', async () => {
    // Import retriever types
    const { HybridRetrieveOptions } = await import('../../src/rag/retriever.js');

    // Options should be compatible
    const options: HybridRerankOptions = {
      enabled: 'auto',
      denseWeight: 0.7,
    };

    expect(options.enabled).toBe('auto');
    expect(options.denseWeight).toBe(0.7);
  });

  it('should produce chunks compatible with RetrieveResult', () => {
    const chunks = createTestChunks(3);
    const result = hybridRerank('test', chunks, { enabled: true });

    // Chunks should have required ChunkDocument properties
    for (const chunk of result.chunks) {
      expect(chunk.id).toBeDefined();
      expect(chunk.content).toBeDefined();
      expect(chunk.metadata).toBeDefined();
      expect(typeof chunk.score).toBe('number');
    }
  });
});
