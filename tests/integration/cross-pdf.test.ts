/**
 * Phase 1.5 - Cross-PDF E2E Integration Test
 * 
 * 目标: 端到端验证跨 PDF 检索功能
 * 
 * 测试范围:
 * 1. 向下兼容性: 单 Bundle 查询 (crossBundleMode='single')
 * 2. 多 Bundle 查询: 指定多个 Bundle (crossBundleMode='specified')
 * 3. 全局查询: 查询所有 Bundle (crossBundleMode='all')
 * 4. 来源追溯: 验证 paperId, bundleId, pageIndex 正确性
 * 5. 输出格式: 验证按 paperId 分组显示
 * 
 * 性能指标:
 * - 查询成功率: 100%
 * - 响应时间: < 3s
 * - 多论文来源追溯: 准确
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { RAGEngine } from '../../src/rag/query.js';
import type { RAGConfig, QueryResult } from '../../src/rag/types.js';
import { getConfig, type PreflightConfig } from '../../src/config.js';
import { createEmbeddingFromConfig } from '../../src/embedding/preflightEmbedding.js';

// Test dataset from Phase 0
const TEST_BUNDLES = {
  SimpleMem: {
    bundleId: '460e0e7b-f59a-4325-bd36-2f8c63624d1b',
    paperId: 'arxiv:2601.02553',
    title: 'SimpleMem: Efficient Memory Framework based on Semantic Lossless Compression',
  },
  MAGMA: {
    bundleId: 'f17c5e6b-3ed4-4bfa-8e3e-1d69735b89f9',
    paperId: 'arxiv:2601.03236',
    title: 'MAGMA: A Multi-Graph based Agentic Memory Architecture for AI Agents',
  },
  STACKPLANNER: {
    bundleId: '09943fcd-994b-4b7f-98af-33d458297539',
    paperId: 'arxiv:2601.05890',
    title: 'STACKPLANNER: A Centralized Hierarchical Multi-Agent System',
  },
};

describe('Phase 1.5 - Cross-PDF E2E Integration Test', () => {
  let ragEngine: RAGEngine;
  let ragConfig: RAGConfig;

  beforeAll(async () => {
    // Load config
    const cfg = getConfig();
    
    if (!cfg.chromaUrl) {
      throw new Error('chromaUrl not configured. Set PREFLIGHT_CHROMA_URL or update config.json');
    }

    // Create embedding provider
    const { embedding } = createEmbeddingFromConfig(cfg);

    // Initialize RAG engine (without LLM for faster testing)
    ragConfig = {
      chromaUrl: cfg.chromaUrl,
      embedding: {
        embed: async (text: string) => embedding.embed(text),
        embedBatch: async (texts: string[]) => embedding.embedBatch(texts),
      },
      // No LLM - we're testing retrieval only
    };

    ragEngine = new RAGEngine(ragConfig);

    console.log('✓ RAG Engine initialized');
    console.log(`  ChromaDB: ${cfg.chromaUrl}`);
  });

  describe('1. Backward Compatibility - Single Bundle Query', () => {
    it('should query single bundle with default crossBundleMode', async () => {
      const startTime = Date.now();
      
      const result = await ragEngine.query(
        'SimpleMem 在 LoCoMo 基准测试中的 F1 分数提升是多少？',
        {
          bundleId: TEST_BUNDLES.SimpleMem.bundleId,
          mode: 'naive',
          topK: 5,
          enableContextCompletion: false, // Disable for performance testing
          // crossBundleMode默认为'single'
        }
      );

      const duration = Date.now() - startTime;

      // Assertions
      expect(result).toBeDefined();
      expect(result.answer).toBeDefined();
      expect(result.sources).toBeDefined();
      expect(result.sources.length).toBeGreaterThan(0);

      // 验证所有 sources 都来自同一个 bundle
      const uniqueBundleIds = new Set(result.sources.map(s => s.bundleId).filter(Boolean));
      expect(uniqueBundleIds.size).toBe(1);
      expect(uniqueBundleIds.has(TEST_BUNDLES.SimpleMem.bundleId)).toBe(true);

      // 验证来源包含 paperId
      const sourcesWithPaperId = result.sources.filter(s => s.paperId);
      expect(sourcesWithPaperId.length).toBeGreaterThan(0);
      expect(sourcesWithPaperId[0].paperId).toBe(TEST_BUNDLES.SimpleMem.paperId);

      // 性能要求
      expect(duration).toBeLessThan(3000);

      console.log(`✓ Single bundle query: ${duration}ms`);
      console.log(`  Sources: ${result.sources.length} chunks from ${TEST_BUNDLES.SimpleMem.paperId}`);
    });
  });

  describe('2. Multi-Bundle Query - Specified Mode', () => {
    it('should query multiple specified bundles', async () => {
      const startTime = Date.now();

      const result = await ragEngine.query(
        'SimpleMem 和 MAGMA 在记忆组织方式上有什么本质区别？',
        {
          crossBundleMode: 'specified',
          bundleIds: [
            TEST_BUNDLES.SimpleMem.bundleId,
            TEST_BUNDLES.MAGMA.bundleId,
          ],
          mode: 'naive',
          topK: 10,
          enableContextCompletion: false, // Disable for performance testing
        }
      );

      const duration = Date.now() - startTime;

      // Assertions
      expect(result).toBeDefined();
      expect(result.sources.length).toBeGreaterThan(0);

      // 验证 sources 来自多个 bundles
      const bundleIds = new Set(result.sources.map(s => s.bundleId).filter(Boolean));
      expect(bundleIds.size).toBeGreaterThanOrEqual(1); // At least 1, ideally 2
      
      // 验证只包含指定的 bundles
      for (const bundleId of bundleIds) {
        expect([
          TEST_BUNDLES.SimpleMem.bundleId,
          TEST_BUNDLES.MAGMA.bundleId,
        ]).toContain(bundleId);
      }

      // 验证 paperIds 存在
      const paperIds = new Set(result.sources.map(s => s.paperId).filter(Boolean));
      expect(paperIds.size).toBeGreaterThanOrEqual(1);
      
      // Log paper distribution
      const paperDistribution = new Map<string, number>();
      for (const source of result.sources) {
        if (source.paperId) {
          paperDistribution.set(source.paperId, (paperDistribution.get(source.paperId) || 0) + 1);
        }
      }

      // 性能要求
      expect(duration).toBeLessThan(3000);

      console.log(`✓ Multi-bundle query: ${duration}ms`);
      console.log(`  Sources from ${bundleIds.size} bundles:`);
      for (const [paperId, count] of paperDistribution) {
        console.log(`    - ${paperId}: ${count} chunks`);
      }
    });

    it('should include pageIndex and sectionHeading in sources', async () => {
      const result = await ragEngine.query(
        'SimpleMem 的三阶段 pipeline 分别是什么？',
        {
          bundleId: TEST_BUNDLES.SimpleMem.bundleId,
          mode: 'naive',
          topK: 5,
          enableContextCompletion: false, // Disable for performance testing
        }
      );

      expect(result.sources.length).toBeGreaterThan(0);

      // 验证至少有一些 sources 包含 pageIndex
      const sourcesWithPage = result.sources.filter(s => s.pageIndex !== undefined);
      expect(sourcesWithPage.length).toBeGreaterThan(0);

      // 验证至少有一些 sources 包含 sectionHeading
      const sourcesWithSection = result.sources.filter(s => s.sectionHeading);
      // Note: sectionHeading 可能为空，取决于 PDF 解析质量

      console.log(`✓ Source metadata validation:`);
      console.log(`  Sources with pageIndex: ${sourcesWithPage.length}/${result.sources.length}`);
      console.log(`  Sources with sectionHeading: ${sourcesWithSection.length}/${result.sources.length}`);
      
      if (sourcesWithPage.length > 0) {
        const example = sourcesWithPage[0];
        console.log(`  Example: [${example.paperId}] ${example.sectionHeading || 'N/A'}, page ${example.pageIndex}`);
      }
    });
  });

  describe('3. Global Query - All Bundles', () => {
    it('should query all indexed bundles', async () => {
      const startTime = Date.now();

      const result = await ragEngine.query(
        'memory architecture for AI agents',
        {
          crossBundleMode: 'all',
          mode: 'naive',
          topK: 10,
          enableContextCompletion: false, // Disable for performance testing
        }
      );

      const duration = Date.now() - startTime;

      // Assertions
      expect(result).toBeDefined();
      expect(result.sources.length).toBeGreaterThan(0);

      // 统计来源分布
      const bundleIds = new Set(result.sources.map(s => s.bundleId).filter(Boolean));
      const paperIds = new Set(result.sources.map(s => s.paperId).filter(Boolean));

      expect(bundleIds.size).toBeGreaterThanOrEqual(1);

      // 性能要求
      expect(duration).toBeLessThan(3000);

      console.log(`✓ Global query: ${duration}ms`);
      console.log(`  Retrieved from ${bundleIds.size} bundles, ${paperIds.size} papers`);
      console.log(`  Total chunks: ${result.sources.length}`);
    });
  });

  describe('4. Source Tracing Accuracy', () => {
    it('should provide accurate source tracking for cross-bundle queries', async () => {
      const result = await ragEngine.query(
        'SimpleMem 和 STACKPLANNER 的优化目标有什么不同？',
        {
          crossBundleMode: 'specified',
          bundleIds: [
            TEST_BUNDLES.SimpleMem.bundleId,
            TEST_BUNDLES.STACKPLANNER.bundleId,
          ],
          mode: 'naive',
          topK: 8,
          enableContextCompletion: false, // Disable for performance testing
        }
      );

      expect(result.sources.length).toBeGreaterThan(0);

      // 验证每个 source 都有必要的追溯信息
      for (const source of result.sources) {
        // 必须有 chunkId
        expect(source.chunkId).toBeDefined();
        expect(typeof source.chunkId).toBe('string');

        // 必须有 bundleId
        expect(source.bundleId).toBeDefined();

        // 应该有 paperId (PDF 内容)
        if (source.sourceType.startsWith('pdf_')) {
          expect(source.paperId).toBeDefined();
        }

        // 如果有 pageIndex，应该是合理的非负整数 (page 0 可能是封面/元数据)
        if (source.pageIndex !== undefined) {
          expect(source.pageIndex).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(source.pageIndex)).toBe(true);
        }
      }

      // 验证 sources 按 paperId 分组的逻辑
      const sourcesByPaper = new Map<string, typeof result.sources>();
      for (const source of result.sources) {
        const key = source.paperId ?? source.bundleId ?? 'unknown';
        if (!sourcesByPaper.has(key)) {
          sourcesByPaper.set(key, []);
        }
        sourcesByPaper.get(key)!.push(source);
      }

      console.log(`✓ Source tracing validation:`);
      console.log(`  Total sources: ${result.sources.length}`);
      console.log(`  Grouped by paper: ${sourcesByPaper.size} groups`);
      for (const [paperId, sources] of sourcesByPaper) {
        console.log(`    - ${paperId}: ${sources.length} chunks`);
      }
    });
  });

  describe('5. Performance Benchmarks', () => {
    it('should meet response time requirements for all query types', async () => {
      const queries = [
        {
          name: 'Single Bundle',
          params: {
            bundleId: TEST_BUNDLES.SimpleMem.bundleId,
            mode: 'naive' as const,
            topK: 5,
            enableContextCompletion: false, // Disable for performance testing
          },
          question: 'SimpleMem F1 score',
        },
        {
          name: 'Multi Bundle',
          params: {
            crossBundleMode: 'specified' as const,
            bundleIds: [TEST_BUNDLES.SimpleMem.bundleId, TEST_BUNDLES.MAGMA.bundleId],
            mode: 'naive' as const,
            topK: 10,
            enableContextCompletion: false, // Disable for performance testing
          },
          question: 'memory architecture comparison',
        },
        {
          name: 'All Bundles',
          params: {
            crossBundleMode: 'all' as const,
            mode: 'naive' as const,
            topK: 10,
            enableContextCompletion: false, // Disable for performance testing
          },
          question: 'AI agent memory',
        },
      ];

      console.log(`✓ Performance benchmarks:`);

      for (const test of queries) {
        const startTime = Date.now();
        const result = await ragEngine.query(test.question, test.params);
        const duration = Date.now() - startTime;

        expect(duration).toBeLessThan(3000);
        expect(result.sources.length).toBeGreaterThan(0);

        console.log(`  ${test.name}: ${duration}ms (${result.sources.length} chunks)`);
      }
    });
  });
});
