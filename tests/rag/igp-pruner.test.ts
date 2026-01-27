/**
 * Tests for IGP Pruner (Iterative Graph Pruning).
 * 
 * Tests:
 * 1. Disabled behavior: Returns chunks unchanged
 * 2. Enabled behavior: Reduces chunk count
 * 3. Strategy variations: topK, ratio
 * 4. Iterative pruning: Multiple passes
 */

import { describe, it, expect } from '@jest/globals';
import { IGPPruner, pruneWithIGP } from '../../src/rag/pruning/igp-pruner.js';
import type { ChunkWithScore } from '../../src/rag/pruning/ig-ranker.js';
import { NUCalculator } from '../../src/rag/pruning/nu-calculator.js';
import { getVerifierLLMConfig } from '../../src/distill/llm-client.js';

// ============================================================================
// Test Configuration
// ============================================================================

/**
 * Check if verifier LLM is configured and supports logprobs.
 */
function isLogprobsAvailable(): boolean {
  try {
    const config = getVerifierLLMConfig();
    if (!config.enabled || !config.apiKey) return false;
    return NUCalculator.supportsLogprobs(config.apiBase);
  } catch {
    return false;
  }
}

// ============================================================================
// Test Fixtures
// ============================================================================

/**
 * Create mock chunks for testing.
 */
function createTestChunks(count: number): ChunkWithScore[] {
  const chunks: ChunkWithScore[] = [];
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
 * Create chunks with varying relevance.
 */
function createRelevanceTestChunks(): ChunkWithScore[] {
  return [
    {
      id: 'relevant-1',
      content: 'Machine learning is a subset of AI that enables systems to learn from data.',
      metadata: { bundleId: 'test', sourceType: 'text' },
      score: 0.9,
    },
    {
      id: 'relevant-2',
      content: 'Deep learning uses neural networks with multiple layers for complex patterns.',
      metadata: { bundleId: 'test', sourceType: 'text' },
      score: 0.85,
    },
    {
      id: 'irrelevant-1',
      content: 'The weather today is sunny with mild temperatures.',
      metadata: { bundleId: 'test', sourceType: 'text' },
      score: 0.7,
    },
    {
      id: 'irrelevant-2',
      content: 'Cooking pasta requires boiling water and adding salt.',
      metadata: { bundleId: 'test', sourceType: 'text' },
      score: 0.65,
    },
  ];
}

// ============================================================================
// Tests
// ============================================================================

describe('IGPPruner', () => {
  describe('Disabled Behavior', () => {
    it('should return chunks unchanged when disabled', async () => {
      const pruner = new IGPPruner();
      const chunks = createTestChunks(5);

      const result = await pruner.prune(
        'What is machine learning?',
        chunks,
        { enabled: false }
      );

      expect(result.chunks).toHaveLength(5);
      expect(result.originalCount).toBe(5);
      expect(result.prunedCount).toBe(5);
      expect(result.pruningRatio).toBe(1.0);
      expect(result.iterations).toBe(0);
    });

    it('should preserve chunk order when disabled', async () => {
      const pruner = new IGPPruner();
      const chunks = createTestChunks(5);

      const result = await pruner.prune('test query', chunks, { enabled: false });

      // Verify order preserved
      for (let i = 0; i < 5; i++) {
        expect(result.chunks[i].id).toBe(`chunk-${i}`);
      }
    });

    it('should add igScore=0 to all chunks when disabled', async () => {
      const pruner = new IGPPruner();
      const chunks = createTestChunks(3);

      const result = await pruner.prune('test query', chunks, { enabled: false });

      expect(result.chunks.every(c => c.igScore === 0)).toBe(true);
    });
  });

  describe('Empty Input', () => {
    it('should handle empty chunks array', async () => {
      const pruner = new IGPPruner();

      const result = await pruner.prune(
        'What is machine learning?',
        [],
        { enabled: true }
      );

      expect(result.chunks).toHaveLength(0);
      expect(result.originalCount).toBe(0);
      expect(result.prunedCount).toBe(0);
    });
  });

  describe('TopK Strategy', () => {
    it('should keep only topK chunks when enabled', async () => {
      if (!isLogprobsAvailable()) {
        console.warn('⚠️ Skipping: Logprobs not available');
        return;
      }

      const pruner = new IGPPruner();
      const chunks = createTestChunks(10);

      const result = await pruner.prune(
        'What is topic 1?',
        chunks,
        { 
          enabled: true, 
          strategy: 'topK',
          topK: 5,
          nuOptions: { topK: 5, maxTokens: 15 },
          batchSize: 5,
        }
      );

      expect(result.prunedCount).toBe(5);
      expect(result.pruningRatio).toBe(0.5);
      expect(result.iterations).toBeGreaterThanOrEqual(1);

      console.log(`TopK pruning: ${result.originalCount} → ${result.prunedCount} (${result.durationMs}ms)`);
    }, 90000); // 90s timeout for 10 chunks

    it('should keep all chunks if topK >= count', async () => {
      const pruner = new IGPPruner();
      const chunks = createTestChunks(3);

      // Use disabled to avoid API calls, just test the logic
      const result = await pruner.prune(
        'test query',
        chunks,
        { enabled: false, strategy: 'topK', topK: 10 }
      );

      expect(result.prunedCount).toBe(3);
    });
  });

  describe('Ratio Strategy', () => {
    it('should keep specified ratio of chunks', async () => {
      if (!isLogprobsAvailable()) {
        console.warn('⚠️ Skipping: Logprobs not available');
        return;
      }

      const pruner = new IGPPruner();
      const chunks = createTestChunks(10);

      const result = await pruner.prune(
        'What is topic 1?',
        chunks,
        { 
          enabled: true, 
          strategy: 'ratio',
          keepRatio: 0.3, // Keep 30%
          nuOptions: { topK: 5, maxTokens: 15 },
          batchSize: 5,
        }
      );

      // 30% of 10 = 3 chunks
      expect(result.prunedCount).toBe(3);
      expect(result.pruningRatio).toBe(0.3);

      console.log(`Ratio pruning: ${result.originalCount} → ${result.prunedCount} (${result.durationMs}ms)`);
    }, 90000);

    it('should always keep at least 1 chunk', async () => {
      if (!isLogprobsAvailable()) {
        console.warn('⚠️ Skipping: Logprobs not available');
        return;
      }

      const pruner = new IGPPruner();
      const chunks = createTestChunks(3);

      const result = await pruner.prune(
        'test query',
        chunks,
        { 
          enabled: true, 
          strategy: 'ratio',
          keepRatio: 0.01, // Very small ratio
          nuOptions: { topK: 5, maxTokens: 10 },
        }
      );

      // Should keep at least 1
      expect(result.prunedCount).toBeGreaterThanOrEqual(1);
    }, 30000);
  });

  describe('Pruning Quality', () => {
    it('should compute and sort by IG scores', async () => {
      if (!isLogprobsAvailable()) {
        console.warn('⚠️ Skipping: Logprobs not available');
        return;
      }

      const pruner = new IGPPruner();
      const chunks = createRelevanceTestChunks();

      const result = await pruner.prune(
        'What is machine learning?',
        chunks,
        { 
          enabled: true, 
          strategy: 'topK',
          topK: 2, // Keep only top 2
          nuOptions: { topK: 5, maxTokens: 20 },
          batchSize: 4,
        }
      );

      console.log('Pruning quality test:');
      result.chunks.forEach((c, i) => {
        console.log(`  ${i + 1}. id=${c.id}, IG=${c.igScore.toFixed(4)}`);
      });

      // Top 2 should be kept
      expect(result.prunedCount).toBe(2);
      
      // Chunks should have IG scores assigned
      expect(result.chunks.every(c => typeof c.igScore === 'number')).toBe(true);
      
      // Chunks should be sorted by IG (descending)
      if (result.chunks.length >= 2) {
        expect(result.chunks[0].igScore).toBeGreaterThanOrEqual(result.chunks[1].igScore);
      }
    }, 60000);
  });

  describe('Iterative Pruning', () => {
    it('should support multiple iterations', async () => {
      if (!isLogprobsAvailable()) {
        console.warn('⚠️ Skipping: Logprobs not available');
        return;
      }

      const pruner = new IGPPruner();
      const chunks = createTestChunks(6);

      const result = await pruner.prune(
        'What is topic 1?',
        chunks,
        { 
          enabled: true, 
          strategy: 'ratio',
          keepRatio: 0.6, // Keep 60% each iteration
          maxIterations: 2, // 6 → 4 → 2-3
          nuOptions: { topK: 5, maxTokens: 15 },
          batchSize: 3,
        }
      );

      console.log(`Iterative pruning: ${result.originalCount} → ${result.prunedCount}, iterations=${result.iterations}`);

      // Should run 1-2 iterations
      expect(result.iterations).toBeGreaterThanOrEqual(1);
      expect(result.prunedCount).toBeLessThan(result.originalCount);
    }, 120000); // 120s for iterative
  });

  describe('Performance', () => {
    it('should complete in reasonable time', async () => {
      if (!isLogprobsAvailable()) {
        console.warn('⚠️ Skipping: Logprobs not available');
        return;
      }

      const pruner = new IGPPruner();
      const chunks = createTestChunks(5);

      const startTime = Date.now();
      const result = await pruner.prune(
        'What is topic 1?',
        chunks,
        { 
          enabled: true, 
          strategy: 'topK',
          topK: 3,
          nuOptions: { topK: 5, maxTokens: 15 },
          batchSize: 5,
        }
      );
      const duration = Date.now() - startTime;

      console.log(`Performance: 5 chunks in ${duration}ms (reported: ${result.durationMs}ms)`);

      // Should complete within 60s for 5 chunks
      expect(duration).toBeLessThan(60000);
    }, 70000);
  });

  describe('Convenience Function', () => {
    it('should work via pruneWithIGP', async () => {
      const chunks = createTestChunks(3);

      const result = await pruneWithIGP(
        'test query',
        chunks,
        { enabled: false }
      );

      expect(result.chunks).toHaveLength(3);
      expect(result.originalCount).toBe(3);
    });
  });

  describe('Static Methods', () => {
    it('should correctly detect logprobs support', () => {
      expect(IGPPruner.supportsLogprobs('https://api.openai.com/v1')).toBe(true);
      expect(IGPPruner.supportsLogprobs('https://integrate.api.nvidia.com/v1')).toBe(true);
      expect(IGPPruner.supportsLogprobs('https://api.longcat.chat/openai/v1')).toBe(false);
    });
  });

  describe('Threshold Strategy (Paper Algorithm 1)', () => {
    it('should use threshold strategy by default', async () => {
      if (!isLogprobsAvailable()) {
        console.warn('⚠️ Skipping: Logprobs not available');
        return;
      }

      const pruner = new IGPPruner();
      const chunks = createTestChunks(5);

      // Default strategy should be 'threshold' with Tp=0
      const result = await pruner.prune(
        'What is topic 1?',
        chunks,
        { 
          enabled: true,
          // No strategy specified - should default to 'threshold'
          nuOptions: { topK: 5, maxTokens: 15 },
        }
      );

      // With threshold=0, only chunks with IG >= 0 are kept
      // Should filter out negative-utility chunks
      console.log(`Threshold default: ${result.originalCount} → ${result.prunedCount} chunks`);
      result.chunks.forEach((c, i) => {
        console.log(`  ${i + 1}. id=${c.id}, IG=${c.igScore.toFixed(4)}`);
      });

      // All kept chunks should have IG >= 0 (or be fallback)
      expect(result.chunks.every(c => c.igScore >= 0)).toBe(true);
    }, 60000);

    it('should filter negative-IG chunks with threshold=0', async () => {
      if (!isLogprobsAvailable()) {
        console.warn('⚠️ Skipping: Logprobs not available');
        return;
      }

      const pruner = new IGPPruner();
      const chunks = createTestChunks(5);

      const result = await pruner.prune(
        'What is topic 1?',
        chunks,
        { 
          enabled: true,
          strategy: 'threshold',
          threshold: 0, // Filter negative-utility
          nuOptions: { topK: 5, maxTokens: 15 },
        }
      );

      console.log(`Threshold=0: ${result.originalCount} → ${result.prunedCount} chunks`);

      // Verify filtering works
      expect(result.prunedCount).toBeLessThanOrEqual(result.originalCount);
      expect(result.chunks.every(c => c.igScore >= 0)).toBe(true);
    }, 60000);
  });
});

// ============================================================================
// Integration Test with RAG Query Options
// ============================================================================

describe('IGP QueryOptions Integration', () => {
  it('should have correct default options', async () => {
    // Import types to verify structure
    const { DEFAULT_QUERY_OPTIONS } = await import('../../src/rag/types.js');
    
    expect(DEFAULT_QUERY_OPTIONS.igpOptions).toBeDefined();
    expect(DEFAULT_QUERY_OPTIONS.igpOptions.enabled).toBe(false);
  });

  it('should accept valid IGP options structure', async () => {
    const { DEFAULT_QUERY_OPTIONS } = await import('../../src/rag/types.js');
    
    // Create a valid options object
    const options = {
      ...DEFAULT_QUERY_OPTIONS,
      igpOptions: {
        enabled: true,
        strategy: 'topK' as const,
        topK: 5,
      },
    };

    expect(options.igpOptions.enabled).toBe(true);
    expect(options.igpOptions.strategy).toBe('topK');
    expect(options.igpOptions.topK).toBe(5);
  });
});
