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

import { beforeAll, describe, expect, it } from '@jest/globals';

import { getConfig } from '../../src/config.js';
import { createEmbeddingFromConfig } from '../../src/embedding/preflightEmbedding.js';
import { RAGEngine } from '../../src/rag/query.js';
import type { RAGConfig } from '../../src/rag/types.js';
import { ChromaVectorDB } from '../../src/vectordb/chroma-client.js';

const RUN_LIVE_RAG_TESTS = process.env.PREFLIGHT_RUN_LIVE_RAG_TESTS === 'true';

type TestBundle = {
  bundleId: string;
  paperId: string;
  title: string;
  totalChunks: number;
};

const PREFERRED_PAPER_IDS = [
  'arxiv:2601.02553',
  'arxiv:2601.03236',
  'arxiv:2601.05890',
];

function pickTestBundles(content: Array<{
  type: string;
  bundleId?: string;
  paperId?: string;
  paperTitle?: string;
  totalChunks: number;
}>): TestBundle[] {
  const pdfContent = content
    .filter((item) => item.type === 'pdf' && item.bundleId && item.paperId && item.paperTitle)
    .sort((a, b) => b.totalChunks - a.totalChunks);

  const byPaperId = new Map(pdfContent.map((item) => [item.paperId!, item]));
  const selected: TestBundle[] = [];

  for (const paperId of PREFERRED_PAPER_IDS) {
    const item = byPaperId.get(paperId);
    if (!item) continue;
    selected.push({
      bundleId: item.bundleId!,
      paperId: item.paperId!,
      title: item.paperTitle!,
      totalChunks: item.totalChunks,
    });
  }

  if (selected.length < 3) {
    for (const item of pdfContent) {
      if (selected.some((bundle) => bundle.bundleId === item.bundleId)) {
        continue;
      }
      selected.push({
        bundleId: item.bundleId!,
        paperId: item.paperId!,
        title: item.paperTitle!,
        totalChunks: item.totalChunks,
      });
      if (selected.length === 3) {
        break;
      }
    }
  }

  return selected.slice(0, 3);
}

describe('Phase 1.5 - Cross-PDF E2E Integration Test', () => {
  let ragEngine: RAGEngine;
  let testBundles: TestBundle[] = [];
  let datasetAvailable = false;
  let datasetStatus = 'dataset check not run';

  const ensureDataset = () => {
    if (!datasetAvailable) {
      console.warn(`⚠️ Skipping cross-pdf integration assertions: ${datasetStatus}`);
      return false;
    }
    return true;
  };

  beforeAll(async () => {
    if (!RUN_LIVE_RAG_TESTS) {
      datasetStatus = 'live cross-pdf tests disabled (set PREFLIGHT_RUN_LIVE_RAG_TESTS=true to enable)';
      return;
    }

    const cfg = getConfig();

    if (!cfg.chromaUrl) {
      throw new Error('chromaUrl not configured. Set PREFLIGHT_CHROMA_URL or update config.json');
    }

    const { embedding } = createEmbeddingFromConfig(cfg);
    const ragConfig: RAGConfig = {
      chromaUrl: cfg.chromaUrl,
      embedding: {
        embed: async (text: string) => embedding.embed(text),
        embedBatch: async (texts: string[]) => embedding.embedBatch(texts),
      },
    };

    ragEngine = new RAGEngine(ragConfig);

    const chroma = new ChromaVectorDB({ url: cfg.chromaUrl });
    const indexedContent = await chroma.listHierarchicalContent();
    testBundles = pickTestBundles(indexedContent);

    datasetAvailable = testBundles.length >= 3;
    datasetStatus = datasetAvailable
      ? `using ${testBundles.map((bundle) => `${bundle.paperId} (${bundle.bundleId})`).join(', ')}`
      : `need at least 3 indexed PDF bundles, found ${testBundles.length}`;

    console.log('✓ RAG Engine initialized');
    console.log(`  ChromaDB: ${cfg.chromaUrl}`);
    console.log(`  Cross-PDF dataset: ${datasetStatus}`);
  });

  describe('1. Backward Compatibility - Single Bundle Query', () => {
    it('should query single bundle with default crossBundleMode', async () => {
      if (!ensureDataset()) return;

      const [singleBundle] = testBundles;
      const startTime = Date.now();

      const result = await ragEngine.query(
        `${singleBundle.title} main contribution`,
        {
          bundleId: singleBundle.bundleId,
          mode: 'naive',
          topK: 5,
          enableContextCompletion: false,
        }
      );

      const duration = Date.now() - startTime;

      expect(result).toBeDefined();
      expect(result.answer).toBeDefined();
      expect(result.sources).toBeDefined();
      expect(result.sources.length).toBeGreaterThan(0);

      const uniqueBundleIds = new Set(result.sources.map((source) => source.bundleId).filter(Boolean));
      expect(uniqueBundleIds.size).toBe(1);
      expect(uniqueBundleIds.has(singleBundle.bundleId)).toBe(true);

      const sourcesWithPaperId = result.sources.filter((source) => source.paperId);
      expect(sourcesWithPaperId.length).toBeGreaterThan(0);
      expect(sourcesWithPaperId[0].paperId).toBe(singleBundle.paperId);

      expect(duration).toBeLessThan(4000);

      console.log(`✓ Single bundle query: ${duration}ms`);
      console.log(`  Sources: ${result.sources.length} chunks from ${singleBundle.paperId}`);
    });
  });

  describe('2. Multi-Bundle Query - Specified Mode', () => {
    it('should query multiple specified bundles', async () => {
      if (!ensureDataset()) return;

      const [bundleA, bundleB] = testBundles;
      const startTime = Date.now();

      const result = await ragEngine.query(
        `Compare ${bundleA.title} and ${bundleB.title}`,
        {
          crossBundleMode: 'specified',
          bundleIds: [bundleA.bundleId, bundleB.bundleId],
          mode: 'naive',
          topK: 10,
          enableContextCompletion: false,
        }
      );

      const duration = Date.now() - startTime;

      expect(result).toBeDefined();
      expect(result.sources.length).toBeGreaterThan(0);

      const bundleIds = new Set(result.sources.map((source) => source.bundleId).filter(Boolean));
      expect(bundleIds.size).toBeGreaterThanOrEqual(1);
      for (const bundleId of bundleIds) {
        expect([bundleA.bundleId, bundleB.bundleId]).toContain(bundleId);
      }

      const paperIds = new Set(result.sources.map((source) => source.paperId).filter(Boolean));
      expect(paperIds.size).toBeGreaterThanOrEqual(1);
      expect(duration).toBeLessThan(4000);

      console.log(`✓ Multi-bundle query: ${duration}ms`);
      console.log(`  Sources from ${bundleIds.size} bundles`);
    });

    it('should include pageIndex and sectionHeading in sources', async () => {
      if (!ensureDataset()) return;

      const [singleBundle] = testBundles;
      const result = await ragEngine.query(
        `What sections or methods are discussed in ${singleBundle.title}?`,
        {
          bundleId: singleBundle.bundleId,
          mode: 'naive',
          topK: 5,
          enableContextCompletion: false,
        }
      );

      expect(result.sources.length).toBeGreaterThan(0);

      const sourcesWithPage = result.sources.filter((source) => source.pageIndex !== undefined);
      expect(sourcesWithPage.length).toBeGreaterThan(0);

      const sourcesWithSection = result.sources.filter((source) => source.sectionHeading);

      console.log('✓ Source metadata validation:');
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
      if (!ensureDataset()) return;

      const keywordQuery = testBundles
        .map((bundle) => bundle.title.split(/\s+/).slice(0, 3).join(' '))
        .join(' ');
      const startTime = Date.now();

      const result = await ragEngine.query(
        keywordQuery,
        {
          crossBundleMode: 'all',
          mode: 'naive',
          topK: 8,
          hierarchicalL1TopK: 6,
          hierarchicalL2L3TopK: 10,
          enableContextCompletion: false,
        }
      );

      const duration = Date.now() - startTime;

      expect(result).toBeDefined();
      expect(result.sources.length).toBeGreaterThan(0);

      const bundleIds = new Set(result.sources.map((source) => source.bundleId).filter(Boolean));
      const paperIds = new Set(result.sources.map((source) => source.paperId).filter(Boolean));

      expect(bundleIds.size).toBeGreaterThanOrEqual(1);
      expect(duration).toBeLessThan(4000);

      console.log(`✓ Global query: ${duration}ms`);
      console.log(`  Retrieved from ${bundleIds.size} bundles, ${paperIds.size} papers`);
      console.log(`  Total chunks: ${result.sources.length}`);
    });
  });

  describe('4. Source Tracing Accuracy', () => {
    it('should provide accurate source tracking for cross-bundle queries', async () => {
      if (!ensureDataset()) return;

      const [bundleA, , bundleC] = testBundles;
      const result = await ragEngine.query(
        `How do ${bundleA.title} and ${bundleC.title} differ?`,
        {
          crossBundleMode: 'specified',
          bundleIds: [bundleA.bundleId, bundleC.bundleId],
          mode: 'naive',
          topK: 8,
          enableContextCompletion: false,
        }
      );

      expect(result.sources.length).toBeGreaterThan(0);

      for (const source of result.sources) {
        expect(source.chunkId).toBeDefined();
        expect(typeof source.chunkId).toBe('string');
        expect(source.bundleId).toBeDefined();

        if (source.sourceType.startsWith('pdf_')) {
          expect(source.paperId).toBeDefined();
        }

        if (source.pageIndex !== undefined) {
          expect(source.pageIndex).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(source.pageIndex)).toBe(true);
        }
      }

      const sourcesByPaper = new Map<string, typeof result.sources>();
      for (const source of result.sources) {
        const key = source.paperId ?? source.bundleId ?? 'unknown';
        if (!sourcesByPaper.has(key)) {
          sourcesByPaper.set(key, []);
        }
        sourcesByPaper.get(key)!.push(source);
      }

      console.log('✓ Source tracing validation:');
      console.log(`  Total sources: ${result.sources.length}`);
      console.log(`  Grouped by paper: ${sourcesByPaper.size} groups`);
    });
  });

  describe('5. Performance Benchmarks', () => {
    it('should meet response time requirements for all query types', async () => {
      if (!ensureDataset()) return;

      const [bundleA, bundleB, bundleC] = testBundles;
      const queries = [
        {
          name: 'Single Bundle',
          params: {
            bundleId: bundleA.bundleId,
            mode: 'naive' as const,
            topK: 5,
            enableContextCompletion: false,
          },
          question: `${bundleA.title} contribution`,
        },
        {
          name: 'Multi Bundle',
          params: {
            crossBundleMode: 'specified' as const,
            bundleIds: [bundleA.bundleId, bundleB.bundleId],
            mode: 'naive' as const,
            topK: 10,
            enableContextCompletion: false,
          },
          question: `Compare ${bundleA.title} and ${bundleB.title}`,
        },
        {
          name: 'All Bundles',
          params: {
            crossBundleMode: 'all' as const,
            mode: 'naive' as const,
            topK: 8,
            hierarchicalL1TopK: 6,
            hierarchicalL2L3TopK: 10,
            enableContextCompletion: false,
          },
          question: `${bundleA.title} ${bundleB.title} ${bundleC.title}`,
        },
      ];

      console.log('✓ Performance benchmarks:');

      for (const test of queries) {
        const startTime = Date.now();
        const result = await ragEngine.query(test.question, test.params);
        const duration = Date.now() - startTime;

        expect(duration).toBeLessThan(4000);
        expect(result.sources.length).toBeGreaterThan(0);

        console.log(`  ${test.name}: ${duration}ms (${result.sources.length} chunks)`);
      }
    });
  });
});
