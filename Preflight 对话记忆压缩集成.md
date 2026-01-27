# Preflight 对话记忆压缩集成
## 项目目标
在 Preflight MCP 中实现对话记忆功能，支持跨会话的长尾任务协作。核心需求是让 Agent 能够记住之前的对话历史，即使在上下文被压缩或切换窗口后，也能无缝继续工作。
## 核心约束
1. **多模型兼容**：从 GPT-4/Claude 到 Qwen2.5-3B 都能使用
2. **MCP 标准**：作为通用 MCP 工具，不依赖特定客户端
3. **ChromaDB 集成**：复用 Preflight 现有的向量存储
4. **分层实现**：根据模型能力自动降级
## 技术方案
### 论文算法基础
#### SimpleMem (压缩效率)
* **熵过滤公式**: H(window) = α × (新实体数/窗口长度) + (1-α) × (1 - cos_sim(new, history))
* **参数**: α=0.3, 阈值=0.35, 窗口=10轮
* **效果**: Token 减少 30×, F1 +26.4%
* **操作**: 指代消解("他" → "Bob") + 时间标准化("明天" → ISO8601)
#### STACKPLANNER (双重记忆)
* **任务记忆**: 短期，当前会话上下文，compression_level=0-3
* **经验记忆**: 长期，用户偏好和成功的推理模式(SOP)
* **REVISE 操作**:
    * 浓缩: 5-10条 → 1条摘要, level=1
    * 剪枝: 删除无效分支，保留失败原因
    * 触发: 会话结束后 60 秒异步执行
#### MAGMA (多视图检索)
* **混合得分**: Score = λ₁×语义相似度 + λ₂×BM25关键词 + γ×元数据匹配
* **自适应深度**: k ∈ [3, 20]，根据查询复杂度动态调整
* **时间衰减**: 权重 = exp(-λ × 时间差), λ=0.1
### Preflight 架构集成点
#### 现有架构
* **存储**: ChromaDB (3个 collections: chunks/entities/astgraph)
* **Embedding**: 支持 OpenAI/Ollama，通过 `createEmbeddingFromConfig(cfg)`
* **RAG**: `RAGEngine` 类，支持 naive/local/hybrid 模式
* **工具**: `preflight_rag` (index + query)
* **批次大小**: chunks=5, entities=50
#### 关键文件位置
* ChromaDB API: `src/vectordb/chroma-client.ts` (L169-229 upsertChunks)
* Embedding 集成: `src/embedding/preflightEmbedding.ts`
* RAG 工具: `src/server/tools/ragTools.ts` (L49-103 engine cache)
* 类型定义: `src/rag/types.ts`
#### 集成要点
* ChromaDB metadata 必须是 flat values (数组需 `join(',')` )
* Collection 命名: `${prefix}_type` 格式
* Batch 操作避免 413 错误
* 支持 deduplication (contentHash)
## 实施方案
### Phase 1: 基础记忆服务 (所有模型可用)
**目标**: 实现最简单的 save/recall 功能，不依赖高级推理
#### 1.1 创建核心文件
* `src/memory/types.ts`: 类型定义
* `src/memory/basic.ts`: BasicMemory 实现
* `src/memory/index.ts`: 导出接口
#### 1.2 BasicMemory 实现
**存储策略**: 简单长度过滤
```typescript
class BasicMemory {
  // 过滤: 长度 > 10 字符 = 重要
  async save(content: string): Promise<void>
  
  // 检索: 语义相似度 top-5
  async recall(query: string, topK=5): Promise<Memory[]>
}
```
**ChromaDB Collection**:
* 名称: `preflight_conversation`
* Metadata 字段:
    * `content`: string (对话内容)
    * `timestamp`: string (ISO8601)
    * `important`: boolean
    * `type`: 'conversation'
#### 1.3 MCP 工具注册
文件: `src/server/tools/memoryTools.ts`
**工具接口**:
```typescript
preflight_memory({
  action: 'save' | 'recall',
  content?: string,  // save 时必需
  query?: string,    // recall 时必需
  topK?: number      // 默认 5
})
```
**返回值**:
```typescript
// save
{ saved: boolean, id: string }
// recall
{ memories: Array<{ content, timestamp, score }> }
```
#### 1.4 集成到 MCP Server
修改 `src/index.ts`:
* 导入 `registerMemoryTools`
* 在 `registerAllTools` 中注册
### Phase 2: 增强记忆服务 (中高级模型)
**目标**: 添加熵过滤、时间衰减、自适应深度
#### 2.1 熵过滤实现
文件: `src/memory/enhanced.ts`
**EnhancedMemory 类**:
```typescript
class EnhancedMemory extends BasicMemory {
  // 熵计算
  async computeEntropy(
    content: string, 
    history: string[]
  ): Promise<number>
  
  // 指代消解 (可选，需 LLM)
  async normalize(
    content: string, 
    history: string[]
  ): Promise<string>
  
  // 覆盖 save，加熵过滤
  async save(content: string, context?: {
    history?: string[],
    sessionId?: string,
    stage?: string
  }): Promise<void>
}
```
**熵计算步骤**:
1. 提取新实体 (简单方法: 正则提取大写开头的词)
2. 计算语义相似度 (用 embedding)
3. 加权融合: `H = 0.3 × entity_novelty + 0.7 × semantic_novelty`
4. 阈值判断: H < 0.35 则丢弃
#### 2.2 时间衰减检索
**增强 recall**:
```typescript
async recall(query: string, options?: {
  topK?: number,
  currentTime?: Date,
  sessionId?: string
}): Promise<Memory[]>
```
**排序策略**:
1. 语义检索 top-k×2 候选
2. 时间衰减权重: `weight = exp(-0.1 × days_ago)`
3. 综合得分: `score = semantic_sim × time_weight`
4. 返回 top-k
#### 2.3 自适应检索深度
**复杂度估计**:
* 简单查询 (关键词匹配): k=3
* 复杂查询 (多跳推理): k=10
* 估计方法: 查询长度 + 疑问词数量
#### 2.4 扩展 Metadata
新增字段:
* `sessionId`: string
* `stage`: 'proposal' | 'refine' | 'impl' | 'test'
* `entropy`: number
* `entities`: string (逗号分隔)
### Phase 3: 完整记忆系统 (顶级模型)
**目标**: 双重记忆、异步压缩、经验提取
#### 3.1 双重记忆 Collections
**任务记忆** (`preflight_task_memory`):
* 短期，单个任务的会话历史
* 支持 compression_level: 0(原始) / 1(摘要) / 2(归档)
* Metadata: taskId, sessionId, stage, level
**经验记忆** (`preflight_experience`):
* 长期，跨任务的知识和模式
* Metadata: patternType (user_preference | decision_sop | domain_knowledge)
* 用于冷启动新任务
#### 3.2 异步压缩服务
文件: `src/memory/consolidator.ts`
**Consolidator 类**:
```typescript
class MemoryConsolidator {
  // 会话结束后触发
  async consolidateSession(sessionId: string): Promise<void>
  
  // 任务完成后提取经验
  async extractExperience(taskId: string): Promise<void>
}
```
**压缩逻辑**:
1. 获取 sessionId 的所有 level=0 记录
2. 按 stage 分组
3. 每组 ≥3 条记录 → LLM 生成摘要
4. 存储摘要 (level=1)，删除原始记录
5. 保留 originalCount 用于追溯
#### 3.3 经验提取逻辑
**输入**: 任务的完整历史
**LLM Prompt**:
```warp-runnable-command
分析该任务历史，提取:
1. 用户偏好模式
2. 成功的决策流程 (SOP)
3. 可复用的知识片段
输出 JSON 列表，每项包含:
- type: 类型
- content: 内容
- context: 适用场景
```
#### 3.4 跨会话恢复
文件: `src/memory/recovery.ts`
**功能**:
```typescript
async recoverTaskContext(
  taskId: string, 
  currentQuery: string
): Promise<{
  taskSummaries: Memory[],
  relatedExperiences: Memory[],
  context: string  // 组装好的提示词
}>
```
**恢复策略**:
1. 检索任务记忆 (优先 level≥1 的摘要)
2. 检索经验记忆 (相似任务的模式)
3. 组装上下文提示
#### 3.5 MCP 工具扩展
**新增 action**:
* `consolidate`: 触发会话压缩
* `extract`: 提取任务经验
* `recover`: 恢复任务上下文
### Phase 4: 模型能力自动检测
**目标**: 根据客户端/模型信息选择合适的实现层级
#### 4.1 能力检测逻辑
文件: `src/memory/detector.ts`
```typescript
function detectModelCapability(): 'basic' | 'enhanced' | 'full' {
  // 1. 检查 MCP client info (如果支持)
  // 2. 检查配置文件中的模型名称
  // 3. 保守默认: 'basic'
}
```
**检测规则**:
* GPT-4, Claude Sonnet → full
* GPT-3.5, Qwen3-8B, Gemini Pro → enhanced
* Qwen2.5-3B, 本地小模型 → basic
#### 4.2 服务工厂
```typescript
export function createMemoryService(
  cfg: ToolDependencies['cfg'],
  level?: 'basic' | 'enhanced' | 'full'
): MemoryService {
  const capability = level ?? detectModelCapability();
  
  switch (capability) {
    case 'basic': return new BasicMemory(cfg);
    case 'enhanced': return new EnhancedMemory(cfg);
    case 'full': return new FullMemory(cfg);
  }
}
```
#### 4.3 降级测试
创建测试用例验证:
* BasicMemory 在所有场景都能工作
* EnhancedMemory 在 LLM 不可用时降级到 BasicMemory
* FullMemory 的异步操作不阻塞主流程
## 测试计划
### 单元测试
1. **BasicMemory**: 存储/检索基础功能
2. **熵计算**: 各种对话内容的熵值
3. **时间衰减**: 不同时间间隔的权重计算
4. **压缩逻辑**: 摘要生成和原始记录删除
### 集成测试
1. **跨会话场景**: 
    * 窗口 1: 讨论方案
    * 窗口 2: 细化设计
    * 窗口 3: 实施代码
    * 验证: 窗口 3 能访问窗口 1 的决策
2. **多模型兼容**:
    * GPT-4: 使用 FullMemory
    * Qwen3-8B: 使用 EnhancedMemory
    * Qwen2.5-3B: 使用 BasicMemory
    * 验证: 所有模型都能完成基本任务
3. **压缩效果**:
    * 输入: 50 轮对话 (~5000 tokens)
    * 期望: 压缩到 ~500 tokens (10×)
    * 验证: F1 准确率 > 基线
### 性能测试
1. **存储延迟**: save 操作 < 100ms
2. **检索延迟**: recall 操作 < 500ms
3. **压缩延迟**: consolidate 异步，不阻塞
## 文件清单
### 新增文件
```warp-runnable-command
src/memory/
├── types.ts              # 类型定义
├── basic.ts              # BasicMemory 实现
├── enhanced.ts           # EnhancedMemory 实现
├── full.ts               # FullMemory 实现
├── consolidator.ts       # 异步压缩服务
├── recovery.ts           # 跨会话恢复
├── detector.ts           # 模型能力检测
└── index.ts              # 导出接口
src/server/tools/
└── memoryTools.ts        # MCP 工具注册
tests/memory/
├── basic.test.ts
├── enhanced.test.ts
├── consolidator.test.ts
└── integration.test.ts
```
### 修改文件
```warp-runnable-command
src/index.ts              # 注册 memoryTools
src/vectordb/types.ts     # 扩展 ChunkMetadata
README.md                 # 添加 preflight_memory 文档
```
## 风险和缓解
### 风险 1: 小模型无法理解复杂指令
**缓解**: BasicMemory 只用简单规则，不依赖推理
### 风险 2: 异步压缩失败导致内存泄漏
**缓解**: 
* 添加错误日志
* 设置压缩任务超时 (5分钟)
* 失败后保留原始记录
### 风险 3: ChromaDB 性能瓶颈
**缓解**: 
* 使用批次操作 (batch_size=5)
* 添加内存缓存 (LRU)
* 定期清理过期记录
### 风险 4: 跨客户端兼容性问题
**缓解**: 
* 严格遵循 MCP 规范
* 不依赖客户端特定功能
* 提供降级方案
## 成功指标
1. **功能完整性**
    * ✅ 所有 MCP 客户端都能调用 preflight_memory
    * ✅ BasicMemory 在 3B 模型上可用
    * ✅ FullMemory 在 GPT-4 上实现全部功能
2. **性能指标**
    * ✅ Token 压缩率 > 10×
    * ✅ 检索准确率 (F1) > 70%
    * ✅ 检索延迟 < 500ms
3. **用户体验**
    * ✅ 跨窗口继承无需重复提问
    * ✅ 关键决策能被正确回忆
    * ✅ 小模型也能完成基本任务
## 下一步行动
1. ✅ 创建 plan (当前)
2. ⬜ 实现 BasicMemory + types.ts
3. ⬜ 注册 MCP 工具 memoryTools.ts
4. ⬜ 集成测试 (保存/检索)
5. ⬜ 实现 EnhancedMemory (熵过滤)
6. ⬜ 实现 FullMemory (双重记忆)
7. ⬜ 异步压缩服务
8. ⬜ 文档和示例
