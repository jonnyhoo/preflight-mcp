# PDF RAG Roadmap

## 已完成 ✅

- PDF 解析（MinerU + VLM 双引擎）
- 图片理解（VLM 描述 + 索引）
- 语义分块（层级结构 + parentChunkId）
- RAG 检索（hybrid 模式 + 层级扩展 expandToParent/expandToSiblings）
- 交叉验证（verifierLlm 独立回答对比）
- Embedding provider 自动检测（根据 embeddingApiBase 自动选择 openai/ollama）
- 多层级 chunking（level 1/2/4 全覆盖，Appendix 不再丢失）
- 孤儿 chunk 修复（所有 element chunks 都有 parentChunkId）
- 公式/表格/图片独立索引为 element chunks

## 待实现

### 1. 页码定位
- **方案**: chunk metadata 加 `pageNumber` 字段
- **效果**: sources 返回具体页码，用户可直接跳转验证

### 2. 多 PDF 关联查询
- **方案**: 去掉 bundleId 强制过滤，支持跨 bundle 检索
- **效果**: 跨多个论文的知识问答

### 3. 不确定性量化
- **方案**: 多次采样 + 答案一致性评估
- **效果**: 返回答案置信度分数
