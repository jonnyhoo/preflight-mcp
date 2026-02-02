# PDF RAG Roadmap — 综合版

> **目标**: 在现有系统上实现**跨 bundle 多文档检索**与**证据质量/置信度评估**，并融合 2026 年最新论文的可落地机制。

> **更新日期**: 2026-01-27 | **状态**: 已完成深度论文研究与集成方案设计

---

## 🎯 核心升级目标

1. **跨 Bundle 多文档检索** — 支持跨多个 PDF 的统一检索与来源追溯
2. **证据质量优化** — 基于信息增益的智能剪枝，减少噪声
3. **检索能力增强** — 混合密集+稀疏+图结构的多模态检索
4. **置信度评估** — 答案不确定性量化与一致性分析

---

## ✅ 已完成功能

- PDF 解析（MinerU + VLM 双引擎）
- 图片理解（VLM 描述 + 索引）
- 语义分块（层级结构 + parentChunkId）
- RAG 检索（hybrid 模式 + 层级扩展 expandToParent/expandToSiblings）
- 交叉验证（verifierLlm 独立回答对比）
- Embedding provider 自动检测（根据 embeddingApiBase 自动选择 openai/ollama）
- 多层级 chunking（level 1/2/4 全覆盖，Appendix 不再丢失）
- 孤儿 chunk 修复（所有 element chunks 都有 parentChunkId）
- 公式/表格/图片独立索引为 element chunks
- 页码定位（parseHeadingTree 追踪 pagebreak 注释，chunk metadata 包含准确页码）

---

## 📚 研究基础（Research-Backed Design）

本 roadmap 基于 4 篇 2026 年 1 月最新 arXiv 论文的**深度分析**：

| Bundle ID | 论文标题 | 核心机制 | 关键性能 | 代码资源 |
|-----------|---------|---------|---------|----------|
| `c17d42ff` | **NUMEN**: N-Gram Hashing for Dense Retrieval | 字符 3/4/5-gram CRC32 哈希 → 32k 维向量 | LIMIT Recall@100 = **93.90%** | [GitHub](https://github.com/sangeet01/limitnumen) |
| `d1b95c13` | **GraphAnchor**: Graph-Anchored Knowledge Indexing | RDF triples + 图迭代更新 `G_t = M(D_t, G_{t-1}, R_{t-1})` | HotpotQA F1: 50.93 → **66.03** | [GitHub](https://github.com/NEUIR/GraphAnchor) |
| `e2812377` | **FastInsight**: Graph RAG Fusion Operators | GRanker `H'=(1-α)H+α(PH)` + STeX `S=I_sim+β·I_struct` | ACL-OCL R@10 **+28.4%** | Anonymous (未公开) |
| `e079d861` | **Less is More**: Information Gain Pruning | `IG(d)=NU(q)-NU(q\|d)` + 动态阈值 `T_p` | F1 **+12~20%**, Token **-76~79%** | 未公开 |

> 本 roadmap 已整合所有论文的详细算法分析，开发者可直接使用。原始论文可通过 Preflight MCP Bundle ID 查询。

---

## 🧭 实施策略

### 最小可行路径（MVP）

```
🔥 Phase 1 [高优先级] — 基础能力（4-6h + 8-12h）
├── 1.1 跨Bundle基础支持
├── 1.2 IGP 剪枝（Less is More）
└── 验证: 多文档检索 + 证据质量提升

⚡ Phase 2 [中优先级] — 词法增强（10-14h）
├── 2.1 NUMEN N-Gram 哈希
└── 验证: 术语/公式精确匹配提升

📊 Phase 3 [中优先级] — 图索引（16-24h）
├── 3.1 GraphAnchor 实体图
└── 验证: 多跳问答能力

🔀 Phase 4 [低优先级] — 混合检索（12-16h）
├── 4.1 FastInsight GRanker + STeX
└── 验证: 图拓扑检索增强

🎯 Phase 5 [低优先级] — 置信度（8-12h）
└── 5.1 不确定性量化
```

### 技术栈兼容性

| 模块 | 与现有系统兼容性 | 主要成本 | 风险缓解 |
|------|----------------|---------|----------|
| **IGP** | 🟢 高 — 替换 rerank | N×LLM 调用 | batch probing + cache |
| **NUMEN** | 🟢 高 — embedding 扩展 | 存储膨胀（128KB/向量） | 量化/压缩到 8k 维 |
| **GraphAnchor** | 🟡 中 — 需新增图层 | LLM 抽取成本 | 规则回退 + 增量更新 |
| **FastInsight** | 🟡 中 — 需图结构 | 预构图开销 | 离线构图 + 异步 |

---

---

# 详细实施方案

---

## Phase 1: 跨Bundle检索 + IGP 剪枝 [高优先级]

### 1.1 跨Bundle基础支持 (4-6h)

**改动文件（最小集）**:
- `src/rag/types.ts` - QueryOptions, SourceEvidence
- `src/vectordb/chroma-client.ts` - buildWhereClause
- `src/rag/query.ts` - RAGEngine.query
- `src/server/tools/ragTools.ts` - MCP 工具接口

**类型扩展**:
```typescript path=null start=null
// src/rag/types.ts
interface QueryOptions {
  // ... existing fields
  crossBundleMode?: 'all' | 'specified';  // 新增
  bundleIds?: string[];                    // 新增
}

interface SourceEvidence {
  // ... existing fields
  bundleId: string;   // 新增
  paperId?: string;   // 新增
}
```

**过滤逻辑**:
```typescript path=null start=null
// src/vectordb/chroma-client.ts
function buildWhereClause(options: QueryOptions): Where {
  const where: Where = {};
  
  if (options.crossBundleMode === 'all') {
    // 无 bundleId 过滤
  } else if (options.crossBundleMode === 'specified' && options.bundleIds?.length) {
    where.bundleId = { $in: options.bundleIds };
  } else if (options.bundleId) {
    where.bundleId = options.bundleId;  // 默认单 bundle
  }
  
  return where;
}
```

### 1.2 IGP 剪枝 (8-12h)

> 来源: **Less is More** 论文 | Bundle `e079d861`

**核心公式** (Eq.5-7):
```
NU(q; φ,K) = (1 / (T log K)) Σ_t Ẽ H_t(q; φ,K)      # 无证据归一化不确定性
NU(q | d; φ,K) = (1 / (T^d log K)) Σ_t H̃_t(q,d; φ,K)  # 单证据条件不确定性
IG(d, q) = NU(q) - NU(q | d)                           # 信息增益
```

**算法实现** (Algorithm 1):
```python path=null start=null
# src/rag/pruning.ts 的逻辑原型
def compute_nu(prompt, llm, K, MT):
    """计算归一化不确定性"""
    entropies = []
    for t in range(MT):
        topk = llm.next_token_topk(prompt, K)  # 获取 Top-K logprobs
        probs = softmax([lp for _, lp in topk])
        Ht = -sum(p * log(p) for p in probs)   # 计算当前步的熵
        entropies.append(Ht)
        prompt += topk[0].token  # greedy token
    return sum(entropies) / (len(entropies) * log(K))

def igp_rank(q, D, llm, K, MT, T_p):
    """基于信息增益的重排与剪枝"""
    nu0 = compute_nu(prompt_for_q(q), llm, K, MT)
    scored = []
    for d in D:
        nud = compute_nu(prompt_for_qd(q, d), llm, K, MT)
        scored.append((d, nu0 - nud))  # IG = NU(q) - NU(q|d)
    ranked = sorted(scored, key=lambda x: x[1], reverse=True)
    filtered = [d for d, ig in ranked if ig >= T_p]  # 阈值剪枝
    return filtered
```

**工程优化**:
- **批处理**: 将多个 `prompt_for_qd` 组 batch，减少 LLM 往返延迟
- **缓存**: 对相同 `(q, d)` 缓存 `NU(q|d)`
- **阈值可配**: `T_p` 暴露为 QueryOptions 参数（默认小正值）
- **兼容性**: 需要 Top-K logprobs 接口（OpenAI/vLLM 支持）

**TypeScript 接口**:
```typescript path=null start=null
// src/rag/pruning.ts
export interface IGPOptions {
  enabled: boolean;
  threshold?: number;    // T_p, 默认 0.01
  topK?: number;         // K, 默认 5
  maxTokens?: number;    // MT, 默认 50
}

export class IGPPruner {
  async prune(
    query: string,
    candidates: ChunkWithScore[],
    options: IGPOptions
  ): Promise<ChunkWithScore[]>;
}
```

---

## Phase 2: NUMEN N-Gram 增强 [中优先级] (10-14h)

> 来源: **NUMEN** 论文 | Bundle `c17d42ff` | [GitHub](https://github.com/sangeet01/limitnumen)

**核心公式**:
```
v[idx] += w(g)       # idx = CRC32(g) mod d
v ← log(1 + v)       # 对数饱和
v ← v / ||v||_2      # L2 归一化
```

**权重策略** (论文消融实验结果):
| N-Gram | 权重 | 说明 |
|--------|------|------|
| 5-gram | 10.0 | 高特异性，重点捕获 |
| 4-gram | 5.0 | 中等特异性 |
| 3-gram | 1.0 | 高覆盖率，基础特征 |

**算法实现**:
```python path=null start=null
# src/embedding/ngram-hasher.ts 的逻辑原型
import zlib

def ngram_hash(text: str, dim: int = 32768) -> list[float]:
    """NUMEN 高维 n-gram 哈希向量"""
    vector = [0.0] * dim
    weights = {3: 1.0, 4: 5.0, 5: 10.0}
    
    text = text.lower()
    for n, w in weights.items():
        for i in range(len(text) - n + 1):
            gram = text[i:i+n]
            idx = zlib.crc32(gram.encode()) % dim
            vector[idx] += w
    
    # 对数饱和 + L2 归一化
    vector = [math.log(1 + v) for v in vector]
    norm = math.sqrt(sum(v*v for v in vector))
    if norm > 0:
        vector = [v / norm for v in vector]
    return vector
```

**质量影响因素** (论文分析):
| 因素 | 影响 | 建议 |
|------|------|------|
| 维度 d | d↑ → 精度↑ 存储↑ | 32k 最优, 可压缩到8k |
| 空白处理 | 空白跨越降低性能 | 保留空格，转小写 |
| CRC32 | 快速但有碎撞 | 高维补偿碎撞 |

**与现有 Embedding 融合**:
```typescript path=null start=null
// src/retrieval/hybrid-retriever.ts
interface HybridEmbedding {
  dense: number[];    // OpenAI/Ollama embedding (1536/4096 dims)
  sparse: number[];   // NUMEN n-gram (8k dims, compressed)
}

function computeHybridScore(query: HybridEmbedding, doc: HybridEmbedding, alpha: number = 0.7): number {
  const denseSim = cosineSimilarity(query.dense, doc.dense);
  const sparseSim = cosineSimilarity(query.sparse, doc.sparse);
  return alpha * denseSim + (1 - alpha) * sparseSim;
}
```

**性能预期**: LIMIT 基准 Recall@100 = **93.90%** (32k 维)

**限制条件**:
- 不支持语义同义词匹配 (car vs automobile)
- 存储开销: 32k 维 × 4 字节 = 128KB/向量

---

## Phase 3: GraphAnchor 图索引 [中优先级] (16-24h)

> 来源: **GraphAnchor** 论文 | Bundle `d1b95c13` | [GitHub](https://github.com/NEUIR/GraphAnchor)

**核心数据结构**:
```
G = (V, E)   # V=实体节点, E=RDF triples (head, relation, tail)
```

**图线性化格式** (论文原文):
```
<graph>
Entities: X(v1), X(v2), ...
Relations: X(t1), X(t2), ...
</graph>
```

**迭代更新机制** (Eq.7-8):
```
G_t = M(q0, D_t, {G_{t-1}, R_{t-1}, q_{t-1}})
ΔG_{t-1→t} = Index(D_t, {R_{t-1}, q_{t-1}})
```

**实现流程** (推测):
```python path=null start=null
# src/graph/entity-index.ts 的逻辑原型

# 1) 实体/关系抽取
def extract_triples(doc, query, prev_reason=None):
    prompt = build_prompt(doc, query, prev_reason)
    out = llm(prompt, format="json")  # {"entities": [...], "triples": [...]}
    return out["entities"], out["triples"]

# 2) 实体链接（跨文档对齐）
def link_entity(e, index):
    key = normalize(e.name)  # 大小写/标点归一
    if key in index: return index[key]
    cand = nearest_by_embedding(e, index, thresh=0.88)  # 向量相似
    return cand or new_node(e)

# 3) 图增量更新
def update_graph(G_prev, D_t, R_prev, q_prev):
    G = G_prev.copy()
    for doc in D_t:
        ents, triples = extract_triples(doc, q_prev, R_prev)
        for (h, r, t) in triples:
            h_id = link_entity(h, G.entities)
            t_id = link_entity(t, G.entities)
            G.add_edge(h_id, r, t_id, source=doc.id)
    return G

# 4) 图线性化
def linearize_graph(G, kV=50, kE=80):
    V = topk_entities(G, kV)  # 按相关性排序截断
    E = topk_relations(G, kE)
    return f"<graph>Entities: {fmt(V)}; Relations: {fmt(E)}</graph>"

# 5) 迭代检索 loop
G = init_graph(D0)
for t in range(1, T_max+1):
    prompt = compose_prompt(q0, D_t, G)
    decision, summary, next_q = llm_decompose(prompt)
    if decision == "sufficient": break
    D_t = retrieve(next_q)
    G = update_graph(G, D_t, summary, next_q)
answer = llm_answer(q0, D_all, G)
```

**LLM Prompt 模板** (论文 Figure 13):
- **初始化**: 判断 sufficiency → 提炼 summary → 生成 next_question
- **更新**: 更新 summary → 判断 sufficiency → 生成 next_question
- **回答**: 仅输出答案

**性能预期**: HotpotQA F1: 50.93 → **66.03** (Qwen2.5-7B)

**限制条件**:
- LLM 抽取质量直接影响图质量
- 图仅文本化，未使用 GNN
- 实体对齐需工程补全

### 3.1 详细执行计划

**实现模块**:

| 模块 | 文件 | 职责 |
|------|------|------|
| 类型定义 | `src/graph/types.ts` | Entity, Triple, KnowledgeGraph 接口 |
| 实体抽取 | `src/graph/entity-extractor.ts` | LLM 抽取三元组 |
| 图存储 | `src/graph/knowledge-graph.ts` | 实体/关系存储与查询 |
| 图更新 | `src/graph/graph-updater.ts` | 增量更新逻辑 |
| 迭代检索 | `src/graph/iterative-retriever.ts` | 子查询生成 + 检索循环 |
| 图线性化 | `src/graph/graph-serializer.ts` | 图转文本供 LLM 使用 |

**任务分解**:

| ID | 任务 | 工时 | 依赖 | 状态 |
|----|------|------|------|------|
| 3.1.1 | 定义图数据结构 (Entity, Triple, KnowledgeGraph) | 2h | - | 🟡 待实施 |
| 3.1.2 | 实现 LLM 三元组抽取 prompt + 解析 | 4h | 3.1.1 | 🟡 待实施 |
| 3.1.3 | 实现实体链接 (名称归一化 + embedding 相似度) | 3h | 3.1.1 | 🟡 待实施 |
| 3.1.4 | 实现图增量更新逻辑 | 3h | 3.1.2, 3.1.3 | 🟡 待实施 |
| 3.1.5 | 实现图线性化 (topK 实体/关系截断) | 2h | 3.1.1 | 🟡 待实施 |
| 3.1.6 | 实现迭代检索循环 (sufficiency 判断 + 子查询生成) | 4h | 3.1.4, 3.1.5 | 🟡 待实施 |
| 3.1.7 | 集成到 RAGEngine.query | 2h | 3.1.6 | 🟡 待实施 |
| 3.1.8 | 单元测试 + 集成测试 | 4h | 3.1.7 | 🟡 待实施 |

**接口设计**:

```typescript
// src/graph/types.ts
interface Entity {
  id: string;
  name: string;
  normalizedName: string;  // 小写+去标点
  attributes: string[];
  embedding?: number[];
  sourceChunkIds: string[];
}

interface Triple {
  head: string;      // entity id
  relation: string;
  tail: string;      // entity id
  sourceChunkId: string;
}

interface KnowledgeGraph {
  entities: Map<string, Entity>;
  triples: Triple[];
  
  addEntity(entity: Entity): string;
  addTriple(triple: Triple): void;
  linkEntity(name: string, embedding?: number[]): Entity;
  getNeighbors(entityId: string): Entity[];
  linearize(maxEntities?: number, maxTriples?: number): string;
}

// src/graph/iterative-retriever.ts
interface IterativeRetrievalOptions {
  maxIterations: number;       // 默认 3
  sufficiencyThreshold: number; // 默认 0.8
  enableGraph: boolean;        // 默认 true
  maxEntitiesInPrompt: number; // 默认 50
  maxTriplesInPrompt: number;  // 默认 80
}

interface IterativeRetrievalResult {
  answer: string;
  iterations: number;
  graph: KnowledgeGraph;
  allDocuments: ChunkWithScore[];
  reasoning: string[];
}
```

**核心算法** (基于论文 RAG 检索结果):

```
迭代检索循环:
1. G_0 = 初始化空图
2. D_0 = Retriever(q_0)  // 初始检索
3. for t = 1 to T_max:
   a. (entities, triples) = LLM_Extract(D_t, q_0, R_{t-1})
   b. G_t = UpdateGraph(G_{t-1}, entities, triples)
   c. (R_t, q_t, sufficient) = LLM_Reason(q_0, D_t, G_t)
   d. if sufficient: break
   e. D_{t+1} = Retriever(q_t)
4. answer = LLM_Answer(q_0, D_all, G_T)
```

---

## Phase 4: FastInsight 混合检索 [低优先级] (12-16h)

> 来源: **FastInsight** 论文 | Bundle `e2812377`

**依赖**: 已有 corpus graph + node embeddings (Phase 3)

**核心算子**:

### GRanker (图模型重排)

**公式** (Section 3.3):
```
H' = (1-α)H + α(PH)
P = A × D^{-1}   # 度倒数归一化传播矩阵
```

**实现**:
```python path=null start=null
def granker(q, N_ret, E_sub, alpha, encoder, mlp):
    H = [encoder(q, n) for n in N_ret]  # 节点编码
    A = build_adj(N_ret, E_sub)          # |N|×|N| 邻接矩阵
    D = degree_diag(A)                   # 度矩阵
    P = A @ inv(D)                       # 传播矩阵
    H_prime = (1 - alpha) * H + alpha * (P @ H)  # 拉普拉斯平滑
    scores = mlp(H_prime)
    return sort_by_score(N_ret, scores)
```

### STeX (向量引导图扩展)

**公式** (Algorithm 3):
```
I_struct = 1 - (r_best - 1)/(R_max - 1)           # 排名接近度
I_struct += (|A(n)| - 1)/(C_max - 1)              # 桥接奖励
I_sim = v_q · V_n                                  # 语义相似度
S_n = I_sim + β · I_struct                         # 最终评分
```

**实现**:
```python path=null start=null
def stex(v_q, V, E, N_ret, beta):
    N_stex = neighbors(N_ret, E) - set(N_ret)  # 候选扩展节点
    R_max = len(N_ret)
    scores = []
    for n in N_stex:
        A = [v for v in N_ret if (n, v) in E]  # 与已检索节点的连接
        I_struct = 0.0
        if R_max > 1 and A:
            r_best = min(rank_of(v, N_ret) for v in A)
            I_struct += 1 - (r_best - 1)/(R_max - 1)
        C_max = min(deg(E, n), R_max)
        if C_max > 1:
            I_struct += (len(A) - 1)/(C_max - 1)
        I_sim = dot(v_q, V[n])
        scores.append((n, I_sim + beta * I_struct))
    return sort_by_score([n for n,_ in scores], [s for _,s in scores])
```

### 组合流程 (Algorithm 1)
```
O_vs → GRanker → (循环) STeX 扩展 → GRanker
直到 |N_ret| = b_max
```

**默认超参数**:
- `b_max = 100`
- `BATCH = 10`
- `α = 0.2`
- `β = 1`

**性能预期**: ACL-OCL R@10 **+28.4%**, nDCG@10 **+30.5%** vs GAR

---

## Phase 5: 不确定性量化 [低优先级] (8-12h)

### 5.1 多采样置信度评估

**方案**:
- 多次采样（temperature=0.7）生成多个答案
- 计算成对相似度（embedding cosine）
- 提取关键事实点（LLM 三元组提取）
- 计算事实重叠度（Jaccard）
- 综合评分：`0.6 × avgSimilarity + 0.4 × factOverlap`

**与 IGP 协同**: 可复用 IGP 的 NU/IG 信号作为证据质量评估

**接口**:
```typescript path=null start=null
// src/rag/types.ts
interface QueryOptions {
  enableUncertaintyEstimation?: boolean;  // 默认 false
  samplingCount?: number;                  // 默认 3
}

interface QueryResult {
  confidenceScore?: number;  // 0-1
  consistencyReport?: {
    sampledAnswers: string[];
    mainAnswer: string;
    disagreements: string[];
  };
}
```

**性能优化**:
- 默认关闭（LLM 调用增加 N 倍）
- 采样用 gpt-4o-mini，主答案用 gpt-4o
- 基于 question hash 缓存采样结果

---

# 技术限制与风险

---

## 技术限制矩阵

| 方法 | 适用场景 | 不适用场景 | 规模/成本 |
|------|---------|-----------|----------|
| **NUMEN** | 精确词匹配、术语检索 | 语义同义词、跨语言 | 存储大（32k维=128KB/向量） |
| **GraphAnchor** | 多跳QA、实体关联 | 单文档简单QA | 首次图构建慢、LLM抽取成本 |
| **FastInsight** | 论文引用网络、知识图谱 | 平面文档集合 | 图稀疏时退化 |
| **IGP** | 长文档、噪声多 | 短文档、信息密集 | N×LLM调用成本 |

## 风险缓解措施

| 风险 | 缓解方案 |
|------|----------|
| **NUMEN 存储膨胀** | 量化/压缩到 8k 维，仅做候选召回 |
| **IGP 成本高** | batch probing + 缓存 + 低采样数 |
| **GraphAnchor 抽取误差** | 双模型交叉验证 + 规则回退 |
| **FastInsight 构图慢** | 离线构图 + 异步增量更新 |
| **多模块协同复杂** | 分阶段上线 + 灰度发布 |

## Plan A/B/C（资源约束）

| 方案 | 包含模块 | 预期收益 | 工作量 |
|------|---------|---------|--------|
| **Plan A**（高精度） | 跨Bundle + GraphAnchor + FastInsight + IGP | F1 +15%, R@10 +25% | 50-70h |
| **Plan B**（均衡） | 跨Bundle + NUMEN + IGP | Recall +10%, Token -70% | 25-35h |
| **Plan C**（低成本） | 跨Bundle + 轻量 IGP | 基础多文档支持 | 12-18h |

---

# 使用示例

---

## 示例 1: 跨 PDF 对比查询
```json
{
  "question": "Compare the training approaches in ResNet and Transformer papers",
  "crossBundleMode": "all"
}
```

## 示例 2: 指定多个 PDF
```json
{
  "question": "What are the common limitations?",
  "bundleIds": ["bundle-resnet", "bundle-transformer", "bundle-bert"]
}
```

## 示例 3: 高置信度查询
```json
{
  "question": "What is the exact number of parameters?",
  "bundleId": "bundle-gpt4",
  "enableUncertaintyEstimation": true,
  "samplingCount": 5
}
```

## 示例 4: 跨 PDF + IGP 剪枝
```json
{
  "question": "Which paper achieves better ImageNet accuracy?",
  "bundleIds": ["bundle-resnet", "bundle-efficientnet"],
  "igpOptions": {
    "enabled": true,
    "threshold": 0.01
  }
}
```

## 示例 5: 完整高级查询
```json
{
  "question": "How do NUMEN and GraphAnchor improve retrieval quality?",
  "crossBundleMode": "specified",
  "bundleIds": ["c17d42ff-cd90-4ec1-82e8-74be0bbfd4e5", "d1b95c13-5319-4b88-861b-243acfb748fb"],
  "igpOptions": { "enabled": true, "threshold": 0.005 },
  "enableUncertaintyEstimation": true,
  "samplingCount": 3
}
```

---

# 测试验证清单

---

## Phase 1.1 跨Bundle检索
- [ ] 索引 2+ PDF bundles（不同 paperId）
- [ ] 执行 `crossBundleMode: 'all'` 查询
- [ ] 验证 sources 包含多个 bundle
- [ ] 验证向后兼容（默认单 bundle 行为）
- [ ] 验证来源按 paperId 分组显示

## Phase 1.2 IGP 剪枝
- [ ] 验证 TopK logprobs 接口可用（OpenAI/vLLM）
- [ ] 测试不同 `T_p` 阈值的剪枝效果
- [ ] 对比 IGP 前后的 token 消耗
- [ ] 验证 IG > 0 的 chunk 确实提升答案质量

## Phase 2.1 NUMEN N-Gram
- [ ] 实现 ngram_hash 函数
- [ ] 对比纯密集 vs 混合检索的 Recall
- [ ] 测试术语/公式精确匹配场景
- [ ] 评估存储开销（8k vs 32k 维）

## Phase 3.1 GraphAnchor
- [ ] 实现 extract_triples LLM prompt
- [ ] 验证实体链接跨文档对齐
- [ ] 测试迭代检索 loop 收敛性
- [ ] 对比有图 vs 无图的多跳 QA 性能

## Phase 4.1 FastInsight
- [ ] 实现 GRanker 拉普拉斯平滑
- [ ] 实现 STeX 扩展算法
- [ ] 测试不同 `α`, `β` 参数
- [ ] 对比纯向量 vs 图混合检索

## Phase 5.1 不确定性量化
- [ ] 准备争议性问题，验证 score < 0.7
- [ ] 准备确定性问题，验证 score > 0.9
- [ ] 验证 disagreements 正确标注
- [ ] 性能测试：3 vs 5 次采样延迟

---

# 工作量与依赖

---

| 任务 | 工作量 | 依赖 | 状态 |
|------|--------|------|------|
| 1.1 跨Bundle基础支持 | 4-6h | 无 | ✅ 已完成 |
| 1.2 IGP 剪枝 | 8-12h | 无 | ✅ 已完成 |
| 2.1 NUMEN N-Gram | 10-14h | 无 | ✅ 已完成 |
| 3.1 GraphAnchor 图索引 | 16-24h | 1.1 | 🟡 待实施 |
| 4.1 FastInsight 混合检索 | 12-16h | 3.1 | 🟡 待实施 |
| 5.1 不确定性量化 | 8-12h | 1.1 | 🟡 待实施 |

**已完成**: 22-32 小时 (Phase 1 + Phase 2)
**剩余**: 36-52 小时 (Phase 3 + 4 + 5)

---

# 待补充/需要额外研究

---

- [ ] IGP 在 PDF 文档场景的 token 成本评估
- [ ] FastInsight 在 PDF chunk 图上的收益验证
- [ ] GraphAnchor 实体链接的具体实现策略
- [ ] "30% 保留率最优" 未在论文中确认
- [ ] FastInsight 官方代码待公开
- [ ] Less is More 官方代码待公开

---

# 结论

---

本综合版 roadmap 将 4 篇最新论文的**关键实现细节**嵌入到现有系统架构中：

1. **跨Bundle检索 + IGP 剪枝** 作为 MVP，最小改动、最大收益
2. **NUMEN** 增强精确匹配，与密集向量融合
3. **GraphAnchor** 提供多跳问答能力
4. **FastInsight** 进一步提升图检索性能
5. **不确定性量化** 输出置信度信号

**核心价值**:
- 开发者无需读论文，仅凭 roadmap 即可实现
- 每个技术决策可追溯到具体论文章节
- 提供 Plan A/B/C 适应不同资源约束

**原始论文查询**:
- NUMEN: Preflight Bundle `c17d42ff-cd90-4ec1-82e8-74be0bbfd4e5`
- GraphAnchor: Preflight Bundle `d1b95c13-5319-4b88-861b-243acfb748fb`
- FastInsight: Preflight Bundle `e2812377-2417-4c40-937b-be69259f3019`
- Less is More: Preflight Bundle `e079d861-8e9a-4486-b610-0210b4c83ca5`
