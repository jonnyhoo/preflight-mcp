# Phase 0.2 手动基准测试指南

## 测试目标
记录当前系统性能作为 Phase 1 的对比基线

## 测试准备
1. 确认 3 个 Bundle 已索引:
   - SimpleMem: `460e0e7b-f59a-4325-bd36-2f8c63624d1b`
   - STACKPLANNER: `09943fcd-994b-4b7f-98af-33d458297539`
   - MAGMA: `f17c5e6b-3ed4-4bfa-8e3e-1d69735b89f9`

2. 打开 `tests/fixtures/pdf-rag-test-dataset.json`

3. 准备记录表格 (可复制到 Excel/Google Sheets)

## 测试流程

对于每个问题 (Q01-Q10):

1. **执行查询**
   ```bash
   # 单 PDF 问题示例 (Q01)
   preflight rag query --bundleId 460e0e7b-f59a-4325-bd36-2f8c63624d1b \
     --question "SimpleMem 在 LoCoMo 基准测试中，相比 Mem0 的 F1 分数提升了多少百分比？"
   
   # 跨 PDF 问题示例 (Q05) - 当前系统不支持，记录为失败
   # 需要手动分别查询两个 bundle 然后人工整合答案
   ```

2. **记录数据**
   - 问题 ID
   - 实际答案 (复制完整输出)
   - 响应时间 (Stats 行显示的 ms 数)
   - Chunks 数量 (Stats 行显示)
   - Token 使用量 (如果显示)

3. **评分** (根据评估标准)
   - **得分 (0-1)**:
     - 1.0 = 完全正确
     - 0.5 = 部分正确
     - 0.0 = 错误或无法回答
   - **质量评分 (1-5)**:
     - 5 = 精确、完整
     - 4 = 准确但略有冗余
     - 3 = 基本正确但不完整
     - 2 = 包含部分正确信息
     - 1 = 完全错误或无法回答

## 测试问题清单

### 单 PDF 问题 (Q01-Q04b)

#### Q01: SimpleMem F1 提升百分比
- **Bundle**: SimpleMem
- **期望答案**: 26.4%
- **评估标准**: 必须包含 "26.4"
- **Content Type**: pdf_text

---

#### Q02: SimpleMem Token 减少倍数
- **Bundle**: SimpleMem
- **期望答案**: 30x
- **评估标准**: 必须包含 "30"
- **Content Type**: pdf_text

---

#### Q03: Recursive Consolidation 公式因素
- **Bundle**: SimpleMem
- **期望答案**: 语义相似度和时间接近度
- **评估标准**: 必须同时包含 "semantic" 和 "temporal"
- **Content Type**: pdf_formula

---

#### Q04: SimpleMem 三阶段 Pipeline
- **Bundle**: SimpleMem
- **期望答案**: Semantic Structured Compression, Recursive Consolidation, Adaptive Retrieval
- **评估标准**: 至少提到 Compression, Consolidation, Retrieval 中的两个
- **Content Type**: pdf_text

---

#### Q04a: SimpleMem Average F1 (表格)
- **Bundle**: SimpleMem
- **期望答案**: 43.24
- **评估标准**: 必须包含 "43.24"
- **Content Type**: pdf_table

---

#### Q04b: SimpleMem 架构图组件 (图片)
- **Bundle**: SimpleMem
- **期望答案**: 三阶段架构组件
- **评估标准**: 提到压缩/合并/检索或三阶段
- **Content Type**: pdf_image

---

### 跨 PDF 问题 (Q05-Q08)

⚠️ **当前系统不支持跨 Bundle 检索，这些问题预期失败**

#### Q05: SimpleMem vs MAGMA 记忆架构对比
- **Bundles**: SimpleMem + MAGMA
- **期望**: 提到压缩 vs 图结构的区别
- **预期结果**: 无法回答 (需要手动分别查询)

---

#### Q06: SimpleMem vs STACKPLANNER 优化目标
- **Bundles**: SimpleMem + STACKPLANNER
- **期望**: Token 效率 vs 多智能体协作
- **预期结果**: 无法回答

---

#### Q07: SimpleMem vs MAGMA 评估数据集
- **Bundles**: SimpleMem + MAGMA
- **期望**: LoCoMo vs MAGMA 的数据集
- **预期结果**: 无法回答

---

#### Q08: 三论文核心问题对比
- **Bundles**: 全部三个
- **期望**: 每个论文的核心问题
- **预期结果**: 无法回答

---

### 多跳推理 (Q09-Q10)

#### Q09: SimpleMem 对话存储判断流程
- **Bundle**: SimpleMem
- **期望答案**: information score 计算 → 阈值判断 → segmentation 处理
- **评估标准**: 提到 score/threshold + segmentation
- **Content Type**: pdf_text

---

#### Q10: SimpleMem 消融实验影响
- **Bundle**: SimpleMem
- **期望答案**: 移除 Semantic Structured Compression 影响最大
- **评估标准**: 提到 Compression 组件 + Temporal F1
- **Content Type**: pdf_text

---

## 记录模板

| ID | 问题 | 实际答案 | 得分 | 质量 | 时间(ms) | Chunks | Notes |
|----|------|---------|------|------|---------|--------|-------|
| Q01 | SimpleMem F1 提升 | | /1.0 | /5 | | | |
| Q02 | Token 减少倍数 | | /1.0 | /5 | | | |
| Q03 | 公式因素 | | /1.0 | /5 | | | |
| Q04 | 三阶段 | | /1.0 | /5 | | | |
| Q04a | Average F1 表格 | | /1.0 | /5 | | | |
| Q04b | 架构图组件 | | /1.0 | /5 | | | |
| Q05 | 跨PDF架构对比 | N/A | 0 | 1 | - | - | 不支持 |
| Q06 | 跨PDF优化目标 | N/A | 0 | 1 | - | - | 不支持 |
| Q07 | 跨PDF数据集 | N/A | 0 | 1 | - | - | 不支持 |
| Q08 | 跨PDF核心问题 | N/A | 0 | 1 | - | - | 不支持 |
| Q09 | 多跳存储流程 | | /1.0 | /5 | | | |
| Q10 | 多跳消融实验 | | /1.0 | /5 | | | |

## 统计计算

### 总体统计
- **总问题数**: 12
- **平均得分**: (所有得分总和) / 12
- **平均质量**: (所有质量分总和) / 12
- **平均响应时间**: (所有响应时间总和) / 有效问题数
- **P95 响应时间**: 排序后取第 95 百分位

### 分类统计
- **单 PDF 准确率**: (Q01-Q04b 得分总和) / 6
- **跨 PDF 准确率**: 0% (预期)
- **多跳推理准确率**: (Q09-Q10 得分总和) / 2

### Content Type 统计
- **pdf_text**: Q01, Q02, Q04, Q05-Q10
- **pdf_formula**: Q03
- **pdf_table**: Q04a
- **pdf_image**: Q04b

### Difficulty 统计
- **Easy** (Q01, Q02, Q04, Q04a): 得分均值
- **Medium** (Q03, Q04b, Q05-Q07): 得分均值
- **Hard** (Q08-Q10): 得分均值

## 输出结果

将记录的数据填入 `baseline-results-manual.json`:

```json
{
  "metadata": {
    "testDate": "2026-01-27",
    "systemVersion": "phase0-current",
    "datasetVersion": "1.1",
    "phase": "Phase 0.2 - Baseline",
    "description": "手动基准性能测试",
    "tester": "Your Name"
  },
  "results": [
    {
      "questionId": "Q01",
      "category": "single-pdf",
      "contentType": "pdf_text",
      "difficulty": "easy",
      "question": "...",
      "expectedAnswer": "26.4%",
      "actualAnswer": "...",
      "score": 0.0,
      "qualityRating": 1,
      "responseTimeMs": 0,
      "chunksRetrieved": 0,
      "notes": ""
    }
    // ... 其他问题
  ],
  "statistics": {
    "overall": {
      "totalQuestions": 12,
      "averageScore": 0.0,
      "averageQuality": 0.0,
      "averageResponseTimeMs": 0,
      "p95ResponseTimeMs": 0
    },
    "byCategory": {
      "single-pdf": {
        "count": 6,
        "averageScore": 0.0,
        "averageQuality": 0.0,
        "successRate": 0.0
      },
      "cross-pdf": {
        "count": 4,
        "averageScore": 0.0,
        "averageQuality": 0.0,
        "successRate": 0.0
      },
      "multi-hop": {
        "count": 2,
        "averageScore": 0.0,
        "averageQuality": 0.0,
        "successRate": 0.0
      }
    }
  },
  "comparisonToBaseline": {
    "singlePdfAccuracy": 0.0,
    "crossPdfAccuracy": 0.0,
    "meetsSinglePdfTarget": false,
    "meetsCrossPdfTarget": false,
    "notes": []
  }
}
```

## 验证指标

✅ **测试完成标准**:
- [ ] 所有 12 个问题已测试
- [ ] 单 PDF 问题 (Q01-Q04b) 有完整答案
- [ ] 跨 PDF 问题 (Q05-Q08) 记录为"不支持"
- [ ] 多跳问题 (Q09-Q10) 有完整答案
- [ ] 平均响应时间已记录
- [ ] P95 响应时间已计算
- [ ] baseline-results-manual.json 已生成

## 预期结果 (Phase 0)
- 单 PDF 准确率: **≥70%** 
- 跨 PDF 准确率: **0%** (不支持)
- 多跳推理: 取决于单 PDF 检索质量

## 下一步
完成测试后，这些数据将作为 Phase 1 实施后的对比基线。
