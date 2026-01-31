Preflight 3层 LTM (长期记忆) 系统实现方案
背景
用户希望 preflight 拥有类似 EverMemOS 的多层记忆功能，能够记住用户偏好、对话历史、提取的事实等，形成长期记忆。
现有基础设施
ChromaDB: 已有完整的向量数据库客户端 (src/vectordb/chroma-client.ts)，支持多 collection 管理、向量存储 + metadata、分层检索
MCP Tools: 已有工具注册模式 (src/server/tools/)
Embedding: 已有 embedding provider (ragCommon.ts)
全局设计决策
userId 获取机制
默认: 机器指纹 crypto.createHash('sha256').update(os.hostname() + os.userInfo().username).digest('hex').slice(0, 16)
Override: 环境变量 PREFLIGHT_USER_ID 或配置项 memory.userId
输出回显: 所有返回结构包含 effectiveUserId 便于排查
风险提示: 换机器会"变成新用户"，共享机器会"多人共用记忆"
Collection 命名
preflight_mem_episodic / preflight_mem_semantic / preflight_mem_procedural
使用 preflight_mem_ 前缀区分于 RAG 的 preflight_rag_
Schema 版本
当前版本: schemaVersion: "1.0.0"
所有记忆条目 metadata 包含 schemaVersion 字段，用于未来迁移
normalize() 函数定义
用于 ID 生成时的内容规范化：
function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')  // collapse whitespace
    .replace(/[^a-z0-9\u4e00-\u9fa5 ]/g, '');  // 保留字母数字中文空格
}
与 RAG l1_memory 的边界澄清
RAG l1_memory: 可检索的摘要文档层，用于压缩会话总结后作为检索源
Memory System: 用户画像/偏好/事实的长期记忆，跨会话持久化
3层 LTM 架构设计
> Working Memory (L0) 留给 Agent/客户端管理，MCP server 无法感知会话边界。
L1: Episodic Memory (情景记忆)
存储: ChromaDB collection preflight_mem_episodic
内容: 对话片段、事件记录、会话摘要
上限: 每用户最多 1000 条，超出时自动删除最旧的
ID 生成: hash(userId + sessionId + createdAtMs + contentHash) 保留时间序列
sessionId: 可选，不传时使用 "default"
Metadata:
userId, sessionId, createdAtMs, lastAccessedAtMs, accessCount
type: conversation | event | summary
participantsJoined, tagsJoined (逗号分隔)
embeddingModelId, schemaVersion
相似度阈值: 0.65
L2: Semantic Memory (语义记忆)
存储: ChromaDB collection preflight_mem_semantic
内容: 提取的事实、实体、关系
ID 生成 (按 type 分流):
relation: hash(userId + 'relation' + normalized(subject, predicate, object))
entity: hash(userId + 'entity' + normalized(subject))
fact: hash(userId + 'fact' + normalized(content))
Metadata:
userId, type, subject, predicate, object, confidence
sourceEpisodeIdsJoined, createdAtMs, lastAccessedAtMs, accessCount
status: active | deprecated | disputed
相似度阈值: 0.70
置信度门控: confidence < 0.6 不写入
L3: Procedural Memory (程序记忆)
存储: ChromaDB collection preflight_mem_procedural
内容: 用户偏好、习惯模式、行为规律
ID 生成: hash(userId + category + normalized(content))
写入条件: 同类偏好出现 ≥2 次且 confidence ≥0.8
Metadata:
userId, type, category, strength, occurrenceCount
createdAtMs, lastUpdatedAtMs, sourceMemoryIdsJoined
abstractionLevel: shallow | intermediate | deep
status: active | deprecated
相似度阈值: 0.60
MCP Tool: preflight_memory
统一的记忆管理工具，参考 AgeMem (arXiv:2601.01885) 的 tool-based actions 理念。
Tool 参数设计
{
  action: "add" | "update" | "search" | "reflect" | "stats" | "list" | "delete" | "gc",
  // === add 参数 ===
  layer?: "episodic" | "semantic" | "procedural",  // 默认 episodic
  content?: string,         // 单条记忆内容
  batch?: Array<{           // 批量添加 (与 content 二选一)
    content: string;
    metadata?: {...};
  }>,
  metadata?: {
    type?: string,          // conversation/event/fact/relation/preference
    subject?: string,
    predicate?: string,
    object?: string,
    category?: string,
    tags?: string[],
    confidence?: number,
  },
  // === update 参数 ===
  memoryId?: string,
  mergeMode?: "replace" | "append",  // replace: 全替换; append: 合并后重新 embed
  // **约束**: 只允许改 metadata，改 canonical 内容走"新建 + supersedes"
  // === search 参数 ===
  query?: string,
  layers?: ("episodic" | "semantic" | "procedural")[],
  topK?: number,            // 默认 5
  limit?: number,           // 默认 20, 最大 100
  offset?: number,
  filters?: {
    type?: string,
    category?: string,
    subject?: string,
    status?: "active" | "deprecated" | "disputed",
    timeRangeMs?: { startMs?: number, endMs?: number },
  },
  // === reflect 参数 ===
  reflectType?: "extract_facts" | "extract_patterns" | "compress",
  sourceIds?: string[],     // compress 方式1: 显式指定
  compressStrategy?: {      // compress 方式2: 自动选择
    layer: "episodic" | "semantic",
    minSimilarity: number,  // 默认 0.85
    maxCount: number,       // 默认 10
  },
  patternSourceStrategy?: "recent" | "topic" | "all",
  topicQuery?: string,      // topic 模式必填
  // === delete 参数 ===
  memoryId?: string,
  // === gc 参数 ===
  gcOptions?: {
    layers?: ("episodic" | "semantic" | "procedural")[],  // 默认只清 episodic
    maxAgeDays?: number,    // 默认 90
    minAccessCount?: number, // 默认 1
    dryRun?: boolean,
    // 删除条件: OR 逻辑
    // **默认只清 episodic**，清 semantic/procedural 返回 _dangerWarning
  },
  // === list 参数 ===
  layer?: "episodic" | "semantic" | "procedural",  // 可选，默认全部
  // 复用 limit/offset 作为分页参数
  sortBy?: "createdAt" | "lastAccessed" | "accessCount",  // 默认 lastAccessed
  order?: "asc" | "desc",  // 默认 desc
}
使用示例
- Add: {"action": "add", "content": "User prefers TypeScript"}
- Search: {"action": "search", "query": "coding preferences"}
- Extract facts: {"action": "reflect", "reflectType": "extract_facts"}
- Stats: {"action": "stats"}
- Delete: {"action": "delete", "memoryId": "mem_abc123"}
- GC: {"action": "gc", "gcOptions": {"maxAgeDays": 90, "dryRun": true}}
返回结构定义
SearchResult
interface SearchResult {
  memories: Array<{
    id: string;
    layer: 'episodic' | 'semantic' | 'procedural';
    content: string;
    metadata: Record<string, unknown>;
    score: number;
    scoreBreakdown: { similarity: number; recency: number; frequency: number; };
  }>;
  byLayer: { procedural: Memory[]; semantic: Memory[]; episodic: Memory[]; };
  totalFound: number;
  coldStart: boolean;
  suggestion?: string;
  _conflictWarning?: string;
  conflictingIds?: string[];
}
StatsResult
interface StatsResult {
  effectiveUserId: string;
  episodicCount: number;
  semanticCount: number;
  proceduralCount: number;
  healthCheck: {
    lastReflectAtMs: number | null;
    episodicSinceReflect: number;
    shouldReflect: boolean;  // episodicSinceReflect >= 10
    oldestUnreflectedAtMs: number | null;
  };
  embeddingInfo: {
    currentModelId: string;
    mixedModelsWarning?: string;
  };
}
ListResult
interface ListResult {
  memories: Memory[];
  total: number;
  hasMore: boolean;
}
ReflectOutput
interface ReflectOutput {
  facts: Array<{
    content: string;
    type: 'fact' | 'relation' | 'preference';
    confidence: number;
    evidenceEpisodeIds: string[];
    shouldStore: boolean;
    sensitive: boolean;
    subject?: string;
    predicate?: string;
    object?: string;
    category?: string;
  }>;
  source: 'llm' | 'fallback';
  llmError?: string;
}
算法与策略
时间衰减算法
Ebbinghaus 遗忘曲线变体：
score_final = sim_score * recency_weight * frequency_boost
recency_weight = Math.exp(-0.1 * days_since_last_access)
frequency_boost = 1 + Math.log(1 + accessCount) * 0.2
sim_score = Math.max(0, 1 - distance)  // 确保 ∈ [0, 1]
topK 跨层分配
const weights = { procedural: 3, semantic: 2, episodic: 1 };
// topK=5: procedural ~3, semantic ~2, episodic ~1 → 取后截断
跨层检索优先级
procedural (最高) - 用户偏好/规则
semantic - 事实/关系
episodic (最低) - 对话记录
lastAccessed/accessCount 写放大优化
内存队列累积 Map<memoryId, {accessDelta, lastAccessedAtMs}>
每 60 秒或累积 100 次访问后批量 flush 到 Chroma
质量控制 (QA 层)
所有 add 操作写入前检查：
PII/Secret 检测: 正则匹配 API key / token / 私钥 → 拒存或脱敏
const PII_PATTERNS = [
  /sk-[a-zA-Z0-9]{32,}/,           // OpenAI API key
  /ghp_[a-zA-Z0-9]{36}/,           // GitHub token
  /-----BEGIN.*PRIVATE KEY-----/,  // Private key
  /[a-zA-Z0-9+/]{40,}={0,2}/,      // Base64 secrets (heuristic)
];
重复检测: 相似度 > 0.9 → 转 compress 或 strength++
置信度门控: semantic < 0.6 不写入，procedural < 0.8 不写入
冲突检测: semantic 同 subject/predicate 的 object 不一致 → status=disputed
Disputed 数据处理
search 默认返回所有状态（包括 disputed），并增加警告：
{
  _conflictWarning: "Conflicting facts: [subject] has multiple values for [predicate]",
  conflictingIds: ["id1", "id2"],
}
Agent 可据此主动询问用户澄清。
删除操作不级联
删除 Episodic Memory 时，从该 episode 提取的 Semantic Memory 不会 自动删除
事实一旦习得，应脱离上下文独立存在，符合人类记忆逻辑
如果用户显式要求“忘掉这件事及学到的所有东西”，需要手动调用多次 delete
反思触发策略
按量触发: 每累计 10 条 episodic 触发 extract_facts
按时触发: 每 24 小时触发 extract_patterns (可选)
手动触发: Agent 显式调用
healthCheck 持久化
存储在 ~/.preflight/memory_meta_{userId}.json，不存 Chroma。
Embedding 模型检查
const codeOnlyModels = ['voyage-code-2', 'code-embed-*'];
if (codeOnlyModels.some(m => currentModel.includes(m))) {
  logger.warn('Memory system requires general-purpose embedding');
}
// 推荐: nomic-embed-text, text-embedding-3-small, bge-m3
LLM 降级策略
try {
  const facts = await llm.extract(prompt);
  return { facts, source: 'llm' };
} catch (err) {
  logger.warn('LLM failed, using rule-based fallback');
  return { facts: ruleBasedExtract(content), source: 'fallback', llmError: err.message };
}
Prompt 模板
extract_facts
export const EXTRACT_FACTS_PROMPT = `
You are an information extraction assistant. Extract structured facts from the conversation.
<conversation>
{content}
</conversation>
Extract:
1. Entities: person names, organizations, products, concepts
2. Relations: (subject, predicate, object) triples
3. User preferences: explicit likes/dislikes
Output JSON:
{
  "facts": [
    {"type": "entity", "content": "...", "confidence": 0.9},
    {"type": "relation", "subject": "...", "predicate": "...", "object": "...", "confidence": 0.85},
    {"type": "preference", "content": "...", "category": "coding_style", "confidence": 0.8}
  ]
}
Rules:
- confidence: 0.0-1.0
- Only extract explicitly stated facts
- Set sensitive: true if contains API keys/passwords
- Set shouldStore: false if uncertain
`;
extract_patterns
export const EXTRACT_PATTERNS_PROMPT = `
You are a behavioral pattern analyst. Analyze semantic memories to identify user habits.
<memories>
{semantic_memories}
</memories>
Identify patterns in categories:
- coding_style: language preferences, naming conventions
- communication: tone, verbosity, response format
- tool_usage: preferred tools/commands
- workflow: problem-solving approach
Output JSON:
{
  "patterns": [
    {
      "type": "preference" | "habit" | "pattern",
      "content": "User prefers...",
      "category": "coding_style",
      "confidence": 0.85,
      "occurrenceCount": 3,
      "evidenceIds": ["sem_xxx", "sem_yyy"],
      "abstractionLevel": "shallow" | "intermediate"
    }
  ]
}
Rules:
- Only extract patterns appearing in 2+ memories
- confidence = occurrenceCount / totalMemoriesAnalyzed
`;
compress
export const COMPRESS_PROMPT = `
You are a memory consolidation assistant. Merge similar memories into a concise summary.
<memories>
{memories_to_compress}
</memories>
Requirements:
1. Preserve ALL unique factual information
2. Merge redundant descriptions
3. Keep the most recent timestamp
Output JSON:
{
  "compressed": {
    "content": "Merged content...",
    "preservedFacts": ["fact1", "fact2"],
    "droppedRedundant": ["redundant1"],
    "sourceIds": ["id1", "id2", "id3"]
  }
}
`;
Metadata 序列化约定
ChromaDB 不支持嵌套，数组字段序列化为逗号分隔字符串：
sourceMemoryIds[] → sourceMemoryIdsJoined: "id1,id2,id3"
tags[] → tagsJoined: "tag1,tag2"
读取时 field.split(',').filter(Boolean) 还原
Collection Lazy Create
async ensureCollections(): Promise<void> {
  for (const layer of ['episodic', 'semantic', 'procedural']) {
    await this.chromaDB.ensureMemoryCollection(layer);
  }
}
文件结构
src/
├── memory/
│   ├── index.ts
│   ├── types.ts
│   ├── memory-store.ts
│   ├── extractors/
│   │   ├── fact-extractor.ts
│   │   └── pattern-extractor.ts
│   └── prompts/
│       ├── extract-facts.ts
│       ├── extract-patterns.ts
│       └── compress.ts
├── server/tools/
│   └── memoryTools.ts
实现步骤
Phase 1: 基础存储层
src/memory/types.ts - 类型定义
src/memory/memory-store.ts - ChromaDB 封装
src/memory/index.ts - 导出
Phase 2: MCP 工具
src/server/tools/memoryTools.ts - 注册工具
实现 add/update/search/stats/list/delete/gc
在 src/server/tools/index.ts 注册
Phase 3: 记忆反思
src/memory/extractors/fact-extractor.ts
实现 reflect extract_facts
Phase 4: Experience 抽象 (可选)
src/memory/extractors/pattern-extractor.ts
实现 reflect extract_patterns / compress
参考研究
AgeMem (arXiv:2601.01885)
Tool-based actions: ADD, UPDATE, DELETE, RETRIEVE, SUMMARY, FILTER
记忆结构: m = (content, embedding, metadata)
检索: cosine similarity, top-k=3-5
性能: 比 Mem0 提升 13%
From Storage to Experience 综述
Storage → Reflection → Experience 三阶段演化
时间衰减 + 访问频率加权
抽象粒度: shallow / intermediate / deep