# Phase 2 IGP 剪枝 - 交接文档

**Date**: 2026-01-27  
**Phase**: Phase 2 - IGP (Iterative Graph Pruning) for PDF RAG  
**Estimated Time**: 10-14 hours  
**Previous Phase**: Phase 1 Cross-Bundle Retrieval ✅ Completed  

---

## 项目背景

### 已完成 (Phase 1)
✅ **跨 Bundle PDF 检索功能已实现并通过测试**
- 支持单 Bundle、多 Bundle (specified)、全局 (all) 三种查询模式
- 来源追溯包含 `bundleId`, `paperId`, `pageIndex`, `sectionHeading`
- MCP 工具接口完整，LLM 可用
- 性能: 1.6-2.3s/query (retrieval only)

### 当前问题
❌ **跨 PDF 检索质量不足**
- 检索 topK=10 chunks，但可能来自多篇论文
- 不同论文的 chunks 相关性参差不齐
- LLM 生成答案时无法有效过滤低质量 chunks
- 导致跨 PDF 查询准确率偏低

### Phase 2 目标
🎯 **实现 IGP (Iterative Graph Pruning) 剪枝**
- 基于 LLM logprobs 或 embedding 相似度迭代剪枝低相关 chunks
- 提升跨 PDF 查询准确率至 ≥60%
- 保持单 PDF 查询准确率 ≥75%

---

## Phase 2 路线图

参考 `E:\VIBE_CODING_WORK\preflight-mcp\PDF_RAG_ROADMAP.md` Phase 2 部分。

### 2.1 LLM Logprobs 接口验证 (1-2h)
**目标**: 验证 LLM 是否支持 Top-K logprobs

**任务**:
1. 测试 OpenAI API 是否支持 `logprobs=true` 参数
2. 测试 Ollama 是否支持 logprobs (大部分模型不支持)
3. 记录支持的模型列表
4. 设计降级方案: 不支持时使用 embedding 相似度

**验证标准**:
- 至少 1 个 LLM 配置支持 logprobs
- 记录不支持时的降级方案

**输出**: `docs/llm-logprobs-support.md`

### 2.2 Logprobs 数据提取 (1-2h)
**目标**: 实现 LLM logprobs 提取功能

**改动文件**: `src/distill/llm-client.ts`

**改动内容**:
- 扩展 `callLLM` 支持 `logprobs: true`
- 解析 response.choices[0].logprobs
- 提取每个 token 的 top-5 logprobs
- 返回格式: `{ content: string, logprobs?: TokenLogprob[] }`

**验证**:
- 调用 LLM 生成 10 个 token
- 每个 token 有 top-5 logprobs
- logprobs 总和接近 1.0

**回滚**: 仅扩展返回类型，不影响现有调用

### 2.3 相关性评分器 (2-3h)
**目标**: 实现 chunk-query 相关性评分

**新文件**: `src/rag/relevance-scorer.ts`

**功能**:
- `scoreWithLogprobs(chunk, query, logprobs)`: 基于 logprobs 计算相关性
- `scoreWithEmbedding(chunk, query, embedding)`: 基于 cosine 相似度计算相关性
- 自动降级: logprobs 不支持时 fallback 到 embedding

**公式** (参考 MiRAGE 论文):
```
logprobs_score = -mean(cross_entropy(chunk_tokens, logprobs))
embedding_score = cosine_similarity(embed(chunk), embed(query))
```

**验证**:
- 高相关 chunk 得分 > 0.7
- 低相关 chunk 得分 < 0.3
- 降级方案正常工作

### 2.4 IGP 迭代剪枝 (2-3h)
**目标**: 实现迭代图剪枝核心算法

**新文件**: `src/rag/igp-pruner.ts`

**算法** (MiRAGE 论文):
```typescript
function iterativeGraphPruning(
  chunks: Chunk[],
  query: string,
  scorer: RelevanceScorer,
  threshold: number = 0.5,
  maxIterations: number = 3
): Chunk[] {
  let currentChunks = chunks;
  for (let i = 0; i < maxIterations; i++) {
    // 1. 为每个 chunk 打分
    const scores = currentChunks.map(c => scorer.score(c, query));
    
    // 2. 剪枝低分 chunks
    const pruned = currentChunks.filter((c, idx) => scores[idx] >= threshold);
    
    // 3. 如果没有 chunk 被剪掉，停止迭代
    if (pruned.length === currentChunks.length) break;
    
    // 4. 更新 chunk 集合
    currentChunks = pruned;
  }
  return currentChunks;
}
```

**参数**:
- `threshold`: 剪枝阈值 (default: 0.5)
- `maxIterations`: 最大迭代次数 (default: 3)

**验证**:
- 10 个 chunks → 3-5 个高质量 chunks
- 剪枝率 50-70%
- 迭代次数 1-3 次

### 2.5 集成到 RAG Engine (1-2h)
**目标**: 将 IGP 集成到查询流程

**改动文件**: `src/rag/query.ts`

**改动位置**: `RAGEngine.query()` 中 retrieve 之后、generate 之前

**改动内容**:
```typescript
// Retrieve
const retrieved = await this.retriever.retrieve(question, ...);

// IGP Pruning (Phase 2 - 仅对跨 PDF 查询启用)
let finalChunks = retrieved.chunks;
if (options?.enableIGP && (options?.crossBundleMode !== 'single')) {
  const pruner = new IGPPruner(this.llm, this.embedding);
  finalChunks = await pruner.prune(retrieved.chunks, question, {
    threshold: options.igpThreshold ?? 0.5,
    maxIterations: options.igpMaxIterations ?? 3,
  });
  logger.info(`IGP pruned ${retrieved.chunks.length} → ${finalChunks.length} chunks`);
}

// Generate with pruned chunks
const generated = await this.generator.generate(question, { ...retrieved, chunks: finalChunks });
```

**验证**:
- IGP 仅在跨 PDF 查询时启用
- 单 PDF 查询不受影响
- Pruned chunks 质量提升

### 2.6 MCP 工具参数扩展 (1h)
**目标**: 暴露 IGP 参数给 LLM

**改动文件**: `src/server/tools/ragTools.ts`

**改动内容**:
```typescript
inputSchema: {
  ...
  enableIGP: z.boolean().optional().describe('Enable IGP pruning for cross-bundle queries (default: false)'),
  igpThreshold: z.number().optional().describe('IGP pruning threshold 0-1 (default: 0.5)'),
  igpMaxIterations: z.number().optional().describe('IGP max iterations (default: 3)'),
}
```

**工具描述更新**:
```
**IGP Pruning (for cross-bundle queries):**
- `enableIGP: true` → Enable iterative graph pruning for better cross-PDF accuracy
- `igpThreshold: 0.5` → Prune chunks with relevance score < 0.5
- Only affects crossBundleMode='specified' or 'all' queries
```

### 2.7 E2E 对比测试 (2-3h)
**目标**: 验证 IGP 对跨 PDF 查询的提升

**测试文件**: 
- 复用 `tests/fixtures/pdf-rag-test-dataset.json`
- 新建 `tests/integration/igp-comparison.test.ts`

**测试对比**:
```typescript
describe('IGP Pruning Effectiveness', () => {
  it('should improve cross-PDF query accuracy', async () => {
    const question = "SimpleMem 和 MAGMA 在记忆组织方式上有什么本质区别？";
    
    // Baseline: 无 IGP
    const baseline = await ragEngine.query(question, {
      crossBundleMode: 'specified',
      bundleIds: [bundleA, bundleB],
      enableIGP: false,
    });
    
    // With IGP
    const withIGP = await ragEngine.query(question, {
      crossBundleMode: 'specified',
      bundleIds: [bundleA, bundleB],
      enableIGP: true,
      igpThreshold: 0.5,
    });
    
    // 验证 IGP 剪枝效果
    expect(withIGP.sources.length).toBeLessThan(baseline.sources.length);
    
    // 验证答案质量 (需人工评估或 LLM verifier)
    const baselineScore = await evaluateAnswer(baseline.answer, question);
    const igpScore = await evaluateAnswer(withIGP.answer, question);
    expect(igpScore).toBeGreaterThanOrEqual(baselineScore);
  });
});
```

**性能要求**:
- IGP overhead < 2s
- 跨 PDF 查询准确率 ≥60% (vs baseline ~30%)
- 单 PDF 查询准确率保持 ≥75%

**输出**: `tests/integration/IGP-COMPARISON-RESULTS.md`

---

## 代码风格要求

### 继承现有风格
参考 `src/rag/` 目录下的现有代码风格:

1. **TypeScript 严格模式**
   - 所有函数参数和返回值都要明确类型
   - 避免 `any`，使用 `unknown` 或具体类型
   - 优先使用 interface over type (除非需要 union)

2. **模块化设计**
   - 单一职责原则：每个文件只负责一个功能
   - 导出清晰：使用 named exports，避免 default export
   - 依赖注入：通过构造函数传入依赖 (如 `llm`, `embedding`)

3. **错误处理**
   - 使用 try-catch 捕获异常
   - 记录错误日志：`logger.error()`
   - 提供降级方案 (如 logprobs → embedding)

4. **日志规范**
   ```typescript
   import { createModuleLogger } from '../logging/logger.js';
   const logger = createModuleLogger('igp-pruner');
   
   logger.info(`IGP pruned ${before} → ${after} chunks`);
   logger.warn(`Logprobs not supported, falling back to embedding`);
   logger.error(`IGP failed: ${err}`);
   ```

5. **注释规范**
   - JSDoc 注释所有 public 函数/类
   - 算法注释参考论文 (如 "MiRAGE Eq. 3")
   - 复杂逻辑加 inline 注释

6. **测试规范**
   - 使用 Jest + @jest/globals
   - 每个功能至少 3 个测试用例 (正常、边界、异常)
   - 性能测试加 timeout: `expect(duration).toBeLessThan(3000)`

### 示例代码结构

```typescript
/**
 * IGP Pruner - Iterative Graph Pruning for RAG chunk filtering
 * 
 * Based on MiRAGE paper: https://arxiv.org/abs/2410.12163
 * 
 * @module rag/igp-pruner
 */

import type { ChunkDocument } from '../vectordb/types.js';
import type { BaseEmbedding } from '../embedding/base.js';
import { RelevanceScorer } from './relevance-scorer.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('igp-pruner');

export interface IGPOptions {
  /** Pruning threshold (0-1, default: 0.5) */
  threshold?: number;
  /** Max iterations (default: 3) */
  maxIterations?: number;
  /** Use logprobs if available (default: true) */
  useLogprobs?: boolean;
}

export class IGPPruner {
  private scorer: RelevanceScorer;

  constructor(
    llm?: { complete: (prompt: string) => Promise<string> },
    embedding?: BaseEmbedding
  ) {
    this.scorer = new RelevanceScorer(llm, embedding);
  }

  /**
   * Iteratively prune low-relevance chunks.
   * 
   * @param chunks - Retrieved chunks
   * @param query - User query
   * @param options - Pruning options
   * @returns Pruned chunks
   */
  async prune(
    chunks: Array<ChunkDocument & { score: number }>,
    query: string,
    options?: IGPOptions
  ): Promise<Array<ChunkDocument & { score: number }>> {
    const threshold = options?.threshold ?? 0.5;
    const maxIterations = options?.maxIterations ?? 3;

    logger.info(`Starting IGP: ${chunks.length} chunks, threshold=${threshold}`);

    let currentChunks = chunks;
    for (let iter = 0; iter < maxIterations; iter++) {
      // Score each chunk
      const scores = await Promise.all(
        currentChunks.map(chunk => this.scorer.score(chunk, query, options))
      );

      // Prune low-score chunks
      const pruned = currentChunks.filter((_, idx) => scores[idx] >= threshold);

      logger.info(`Iteration ${iter + 1}: ${currentChunks.length} → ${pruned.length} chunks`);

      // Stop if no pruning occurred
      if (pruned.length === currentChunks.length) {
        logger.info(`IGP converged after ${iter + 1} iterations`);
        break;
      }

      currentChunks = pruned;
    }

    return currentChunks;
  }
}
```

---

## 环境配置

### ChromaDB
- URL: 配置在 `~/.preflight/config.json` 的 `chromaUrl`
- 或环境变量: `PREFLIGHT_CHROMA_URL`

### LLM 配置
- API Base: `config.json` 的 `llmApiBase`
- API Key: `llmApiKey`
- Model: `llmModel`

### Embedding 配置
- Provider: `embeddingProvider` (ollama | openai)
- Ollama: `ollamaHost`, `ollamaModel`
- OpenAI: `openaiApiKey`, `openaiModel`

### 测试数据
- Bundles: 已索引到 ChromaDB
  - SimpleMem: `460e0e7b-f59a-4325-bd36-2f8c63624d1b`
  - MAGMA: `f17c5e6b-3ed4-4bfa-8e3e-1d69735b89f9`
  - STACKPLANNER: `09943fcd-994b-4b7f-98af-33d458297539`

---

## 文件清单

### Phase 1 完成的文件 (可参考)
- `src/rag/types.ts` - 类型定义
- `src/rag/query.ts` - RAG Engine 主逻辑
- `src/rag/generator.ts` - 答案生成
- `src/vectordb/chroma-client.ts` - ChromaDB 客户端
- `src/server/tools/ragTools.ts` - MCP 工具接口
- `tests/integration/cross-pdf.test.ts` - E2E 测试

### Phase 2 需要新建的文件
- `docs/llm-logprobs-support.md` (2.1)
- `src/rag/relevance-scorer.ts` (2.3)
- `src/rag/igp-pruner.ts` (2.4)
- `tests/integration/igp-comparison.test.ts` (2.7)
- `tests/integration/IGP-COMPARISON-RESULTS.md` (2.7 输出)

### Phase 2 需要修改的文件
- `src/distill/llm-client.ts` (2.2 - 扩展 logprobs)
- `src/rag/query.ts` (2.5 - 集成 IGP)
- `src/server/tools/ragTools.ts` (2.6 - MCP 参数)

---

## 验收标准

### 功能验证
✅ LLM logprobs 接口已验证 (或降级方案已记录)  
✅ Logprobs 数据可正确提取  
✅ 相关性评分器返回合理分数 (0-1)  
✅ IGP 可迭代剪枝 chunks (剪枝率 50-70%)  
✅ RAG Engine 正确集成 IGP  
✅ MCP 工具暴露 `enableIGP` 参数  

### 性能验证
✅ IGP overhead < 2s  
✅ 跨 PDF 查询准确率 ≥60%  
✅ 单 PDF 查询准确率 ≥75% (不降低)  
✅ 总响应时间 < 5s (retrieval + IGP + generation)  

### 代码质量
✅ TypeScript 编译通过 (`npm run build`)  
✅ 所有测试通过 (`npm test`)  
✅ 代码风格一致 (参考现有代码)  
✅ 充分的注释和文档  

---

## 参考资料

### 论文
- **MiRAGE** (IGP 算法来源): https://arxiv.org/abs/2410.12163
  - Section 3.2: Iterative Graph Pruning
  - Equation 3: Relevance scoring with logprobs

### 代码库
- **preflight-mcp**: `E:\VIBE_CODING_WORK\preflight-mcp\`
  - Roadmap: `PDF_RAG_ROADMAP.md`
  - Phase 1 结果: `tests/integration/PHASE-1-TEST-RESULTS.md`

### 配置文件
- User config: `~/.preflight/config.json`
- Example: `config.example.json`

---

## 下一步行动

**立即开始 Phase 2.1**:
1. 阅读本文档和 `PDF_RAG_ROADMAP.md` Phase 2 部分
2. 测试 LLM logprobs 接口 (OpenAI / Ollama)
3. 记录支持情况到 `docs/llm-logprobs-support.md`
4. 设计降级方案 (不支持时用 embedding)

**预计完成时间**: 10-14 小时

**联系方式**: 如有问题，参考 Phase 1 实现或查阅论文

---

## Commit 规范

遵循 Phase 1 的 commit message 格式:

```
feat(rag): Phase 2.X - <Feature Name>

<Description>

Co-Authored-By: Warp <agent@warp.dev>

## Changes
- <Change 1>
- <Change 2>

## Verification
- <Verification 1>
- <Verification 2>

## Performance
- <Metric 1>
- <Metric 2>
```

---

**Good luck with Phase 2! 🚀**
