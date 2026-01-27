# PDF RAG 测试套件

## Phase 0: 基础设施准备 ✅

### 0.1 测试数据集 ✅
**文件**: `fixtures/pdf-rag-test-dataset.json`

**内容**:
- 3 个已索引 PDF Bundles (SimpleMem, STACKPLANNER, MAGMA)
- 12 个测试问题
  - 6 个单 PDF 问题 (Q01-Q04b)
  - 4 个跨 PDF 对比问题 (Q05-Q08)
  - 2 个多跳推理问题 (Q09-Q10)

**Content Type 覆盖**:
- ✅ pdf_text (7 个问题)
- ✅ pdf_formula (1 个问题)
- ✅ pdf_table (1 个问题)
- ✅ pdf_image (1 个问题)

**难度分布**:
- Easy: 4 个 (Q01, Q02, Q04, Q04a)
- Medium: 5 个 (Q03, Q04b, Q05, Q06, Q07)
- Hard: 3 个 (Q08, Q09, Q10)

---

### 0.2 基准性能测试 ⏳
**目标**: 记录当前系统性能作为 Phase 1 对比基线

**文件**:
- `benchmarks/run-baseline.ts` - 自动化测试脚本 (需实现 MCP 调用)
- `benchmarks/MANUAL_TEST_GUIDE.md` - 手动测试指南
- `benchmarks/baseline-results.json` - 测试结果 (待生成)

**测试流程**:
1. 对 12 个测试问题执行当前 RAG 系统
2. 记录: 答案质量 (1-5分)、响应时间、Token 消耗
3. 计算统计: 平均准确率、P95 响应时间、分类统计
4. 对比 baseline 目标

**预期 Baseline (Phase 0)**:
- 单 PDF 准确率: **≥70%**
- 跨 PDF 准确率: **0%** (不支持，符合预期)
- 平均响应时间: < 60 秒
- P95 响应时间: < 120 秒

---

## 使用方法

### 运行手动测试 (推荐)
```bash
# 1. 阅读测试指南
cat tests/benchmarks/MANUAL_TEST_GUIDE.md

# 2. 对每个问题执行查询 (示例)
# 使用 Warp AI 的 preflight_rag MCP tool
preflight_rag --bundleId 460e0e7b-f59a-4325-bd36-2f8c63624d1b \
  --question "SimpleMem 在 LoCoMo 基准测试中，相比 Mem0 的 F1 分数提升了多少百分比？"

# 3. 记录结果到 baseline-results-manual.json
```

### 运行自动化测试 (需实现)
```bash
# 需要先实现 MCP 调用逻辑
tsx tests/benchmarks/run-baseline.ts
```

---

## 目录结构
```
tests/
├── README.md                          # 本文件
├── fixtures/
│   └── pdf-rag-test-dataset.json     # 测试数据集
└── benchmarks/
    ├── run-baseline.ts                # 自动化测试脚本
    ├── MANUAL_TEST_GUIDE.md           # 手动测试指南
    ├── baseline-results.json          # Phase 0 测试结果 (待生成)
    └── phase1-results.json            # Phase 1 测试结果 (待生成)
```

---

## 下一步: Phase 1 实施

完成 Phase 0 基准测试后，参考 `PDF_RAG_ROADMAP.md` 进行 Phase 1 实施:

1. **跨 Bundle 基础支持** (4-6h)
   - 扩展 QueryOptions: `crossBundleMode`, `bundleIds[]`
   - 修改 buildWhereClause 过滤逻辑
   - 更新 MCP 工具接口

2. **IGP 剪枝** (8-12h)
   - 实现 Information Gain Pruning
   - 减少噪声 chunks
   - 提升证据质量

3. **Phase 1 验证测试**
   - 重新运行 12 个测试问题
   - 对比 Phase 0 baseline
   - 验证: 单PDF ≥75%, 跨PDF ≥50%

---

## Bundle 信息

| Bundle Name | Bundle ID | Paper ID | Chunks | Content Types |
|-------------|-----------|----------|--------|---------------|
| SimpleMem | `460e0e7b-f59a-4325-bd36-2f8c63624d1b` | arxiv:2601.02553 | 31 | text, table, image, formula |
| STACKPLANNER | `09943fcd-994b-4b7f-98af-33d458297539` | arxiv:2601.05890 | 22 | text, table, image, formula |
| MAGMA | `f17c5e6b-3ed4-4bfa-8e3e-1d69735b89f9` | arxiv:2601.03236 | 29 | text, table, image, formula |

---

## 评分标准

### 答案得分 (0-1)
- **1.0**: 完全正确，包含所有必需信息
- **0.5**: 部分正确，包含部分关键信息
- **0.0**: 错误或无法回答

### 质量评分 (1-5)
- **5**: 精确、完整、无冗余
- **4**: 准确但略有冗余
- **3**: 基本正确但不完整
- **2**: 包含部分正确信息
- **1**: 完全错误或无法回答

### 评估类型
- **exact-match**: 必须包含精确关键词
- **all-elements**: 必须包含所有列出元素
- **semantic-coverage**: 语义覆盖度评分
- **reasoning-quality**: 推理质量 (需人工评估)

---

## 维护日志

- **2026-01-27**: Phase 0.1 测试数据集创建 (12 个问题)
- **2026-01-27**: Phase 0.2 测试工具和指南创建
- **待完成**: Phase 0 基准测试执行
- **待完成**: Phase 1 实施与验证
