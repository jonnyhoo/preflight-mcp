/**
 * Memory tools - preflight_memory
 */

import * as z from 'zod';

import { MemoryStore, type MemoryStoreConfig } from '../../memory/memory-store.js';
import { wrapPreflightError } from '../../mcp/errorKinds.js';
import type { ToolDependencies } from './types.js';
import { extractFacts, type ExtractFactsOptions } from '../../memory/extractors/fact-extractor.js';
import { extractPatterns } from '../../memory/extractors/pattern-extractor.js';
import { compressMemories } from '../../memory/extractors/compress-extractor.js';
import { getEmbeddingProvider } from './ragCommon.js';

// Define Zod schemas based on the documentation
const AddMetadataSchema = z.object({
  type: z.string().optional(),
  subject: z.string().optional(),
  predicate: z.string().optional(),
  object: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  confidence: z.number().optional(),
}).optional();

const FiltersSchema = z.object({
  type: z.string().optional(),
  category: z.string().optional(),
  subject: z.string().optional(),
  status: z.enum(['active', 'deprecated', 'disputed']).optional(),
  timeRangeMs: z.object({
    startMs: z.number().optional(),
    endMs: z.number().optional(),
  }).optional(),
}).optional();

const CompressStrategySchema = z.object({
  layer: z.enum(['episodic', 'semantic']),
  minSimilarity: z.number().optional(),
  maxCount: z.number().optional(),
}).optional();

const GcOptionsSchema = z.object({
  layers: z.array(z.enum(['episodic', 'semantic', 'procedural'])).optional(),
  maxAgeDays: z.number().optional(),
  minAccessCount: z.number().optional(),
  dryRun: z.boolean().optional(),
}).optional();

const ReflectArgsSchema = z.object({
  reflectType: z.enum(['extract_facts', 'extract_patterns', 'compress']),
  sourceIds: z.array(z.string()).optional(),
  compressStrategy: CompressStrategySchema.optional(),
  patternSourceStrategy: z.enum(['recent', 'topic', 'all']).optional(),
  topicQuery: z.string().optional(),
}).optional();

const MemoryToolInputSchema = z.object({
  action: z.enum(['add', 'update', 'search', 'reflect', 'stats', 'list', 'delete', 'gc']),
  // Add parameters
  layer: z.enum(['episodic', 'semantic', 'procedural']).optional(),
  content: z.string().optional(),
  batch: z.array(z.object({
    content: z.string(),
    metadata: AddMetadataSchema,
  })).optional(),
  metadata: AddMetadataSchema,
  // Update parameters
  memoryId: z.string().optional(),
  mergeMode: z.enum(['replace', 'append']).optional(),
  // Search parameters
  query: z.string().optional(),
  layers: z.array(z.enum(['episodic', 'semantic', 'procedural'])).optional(),
  topK: z.number().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  filters: FiltersSchema,
  // Reflect parameters
  reflectType: z.enum(['extract_facts', 'extract_patterns', 'compress']).optional(),
  sourceIds: z.array(z.string()).optional(),
  compressStrategy: CompressStrategySchema.optional(),
  patternSourceStrategy: z.enum(['recent', 'topic', 'all']).optional(),
  topicQuery: z.string().optional(),
  // Delete parameters (memoryId already defined)
  // GC parameters
  gcOptions: GcOptionsSchema,
  // List parameters
  sortBy: z.enum(['createdAt', 'lastAccessed', 'accessCount']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

const MemoryOutputSchema = z.object({
  action: z.string(),
  result: z.unknown(),
});

type MemoryOutput = z.infer<typeof MemoryOutputSchema>;


export function registerMemoryTools({ server, cfg }: ToolDependencies): void {
  server.registerTool(
    'preflight_memory',
    {
      title: 'Memory Management Tool',
      description:
        '3-layer long-term memory system for persistent user context (ChromaDB).\n' +
        '**Layers:**\n' +
        '  • episodic: 上下文快速注入 - 当前会话/项目的临时信息，会过期\n' +
        '  • semantic: 踩过的坑 - 知识库、经验总结、技术细节、代码片段（长期保留）\n' +
        '  • procedural: 全局规则 - 用户偏好、行为准则、风格设定（类似 agents.md/CLAUDE.md）\n' +
        '**Actions:** add, search, list, update, delete, reflect, stats, gc.\n' +
        'Examples:\n' +
        '  • 存经验: `{"action": "add", "layer": "semantic", "content": "ChromaDB v2 用 hnsw 不是 hnsw_configuration"}`\n' +
        '  • 存偏好: `{"action": "add", "layer": "procedural", "content": "用户偏好 TypeScript，代码注释用中文"}`\n' +
        '  • 搜索: `{"action": "search", "query": "ChromaDB 配置"}`\n' +
        'Use when: "记忆", "remember", "recall", "用户偏好", "preferences", "习惯", "上次", "之前说过", "踩坑", "经验", "记住".',
      inputSchema: MemoryToolInputSchema,
      outputSchema: MemoryOutputSchema,
      annotations: { readOnlyHint: false },
    },
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: MemoryOutput }> => {
      const { action, ...rest } = args;
      let memoryStore: MemoryStore | null = null;

      try {
        // Initialize embedding provider
        const embeddingProvider = getEmbeddingProvider(cfg);
        const embeddingModelId = cfg.embeddingProvider ?? 'unknown';

        // Create memory store instance with configuration
        const memoryStoreConfig: MemoryStoreConfig = {
          chromaUrl: cfg.chromaUrl,
          userId: process.env.PREFLIGHT_USER_ID,
          embeddingModelId,
        };
        memoryStore = new MemoryStore(memoryStoreConfig);
        await memoryStore.ensureCollections();

        let result: any;
        switch (action) {
          case 'add': {
            const { layer = 'episodic', content, metadata, batch } = rest;
            if (batch && batch.length > 0) {
              // Handle batch add
              const texts = batch.map(item => item.content);
              const embeddings = await embeddingProvider.embedBatch(texts);

              const results: any[] = [];
              for (let i = 0; i < batch.length; i++) {
                const item = batch[i]!;
                const embedding = embeddings[i]?.vector;

                if (layer === 'episodic') {
                  results.push(await memoryStore.addEpisodic({
                    content: item.content,
                    type: item.metadata?.type as 'conversation' | 'event' | 'summary' || 'conversation',
                    participants: item.metadata?.tags,
                    tags: item.metadata?.tags,
                  }, embedding));
                } else if (layer === 'semantic') {
                  results.push(await memoryStore.addSemantic({
                    content: item.content,
                    type: item.metadata?.type as 'fact' | 'relation' | 'entity' || 'fact',
                    subject: item.metadata?.subject,
                    predicate: item.metadata?.predicate,
                    object: item.metadata?.object,
                    confidence: item.metadata?.confidence || 0.7,
                    sourceEpisodeIds: item.metadata?.tags,
                  }, embedding));
                } else if (layer === 'procedural') {
                  const procResult = await memoryStore.addProcedural({
                    content: item.content,
                    type: item.metadata?.type as 'preference' | 'habit' | 'pattern' || 'preference',
                    category: item.metadata?.category || 'general',
                    strength: item.metadata?.confidence ?? 0.9,
                    occurrenceCount: 2,  // Meet minimum threshold (>= 2)
                    sourceMemoryIds: item.metadata?.tags,
                  }, embedding);
                  if (procResult === null) {
                    results.push({ error: 'Procedural memory rejected: check strength >= 0.8' });
                  } else {
                    results.push(procResult);
                  }
                }
              }
              result = results;
            } else if (content) {
              // Handle single add
              const embeddingResult = await embeddingProvider.embed(content);
              const embedding = embeddingResult.vector;

              if (layer === 'episodic') {
                result = await memoryStore.addEpisodic({
                  content,
                  type: metadata?.type as 'conversation' | 'event' | 'summary' || 'conversation',
                  participants: metadata?.tags,
                  tags: metadata?.tags,
                  sessionId: metadata?.category, // Using category as sessionId for episodic
                }, embedding);
                              } else if (layer === 'semantic') {
                                result = await memoryStore.addSemantic({
                                  content,
                                  type: (metadata?.type as 'fact' | 'relation' | 'entity') || 'fact',
                                  subject: metadata?.subject,
                                  predicate: metadata?.predicate,
                                  object: metadata?.object,
                                  confidence: metadata?.confidence || 0.7,
                                  sourceEpisodeIds: metadata?.tags,
                                }, embedding);              } else if (layer === 'procedural') {
                result = await memoryStore.addProcedural({
                  content,
                  type: metadata?.type as 'preference' | 'habit' | 'pattern' || 'preference',
                  category: metadata?.category || 'general',
                  strength: metadata?.confidence ?? 0.9,
                  occurrenceCount: 2,  // Meet minimum threshold (>= 2)
                  sourceMemoryIds: metadata?.tags,
                }, embedding);
                if (result === null) {
                  throw new Error('Procedural memory rejected: check strength >= 0.8');
                }
              }
            } else {
              throw new Error('Either content or batch must be provided for add action');
            }
            break;
          }

          case 'search': {
            const { query, layers, topK, limit, offset, filters } = rest;
            
            let queryEmbedding: number[] | undefined;
            if (query) {
              const embeddingResult = await embeddingProvider.embed(query);
              queryEmbedding = embeddingResult.vector;
            }

            result = await memoryStore.search({
              query: query || '',
              layers,
              topK,
              limit,
              offset,
              filters,
            }, queryEmbedding);
            break;
          }

          case 'stats': {
            result = await memoryStore.stats();
            break;
          }

          case 'list': {
            const { layer, limit, offset, sortBy, order } = rest;
            result = await memoryStore.list({
              layer,
              limit,
              offset,
              sortBy,
              order,
            });
            break;
          }

          case 'delete': {
            const { memoryId } = rest;
            if (!memoryId) {
              throw new Error('memoryId is required for delete action');
            }
            result = await memoryStore.delete(memoryId);
            break;
          }

          case 'gc': {
            const { gcOptions } = rest;
            result = await memoryStore.gc(gcOptions);
            break;
          }

          case 'update': {
            const { memoryId, mergeMode = 'replace' } = rest;
            if (!memoryId) {
              throw new Error('memoryId is required for update action');
            }

            // We'll pass the metadata directly - the store method will handle type conversion
            const { metadata } = rest;
            result = await memoryStore.update(memoryId, metadata as any || {}, mergeMode);
            break;
          }

          case 'reflect': {
            const { reflectType, sourceIds, compressStrategy, patternSourceStrategy, topicQuery } = args;
            
            switch (reflectType) {
              case 'extract_facts': {
                // Extract facts from specified source IDs or all memories if none specified
                let sourceMemories: any[] = [];
                if (sourceIds && sourceIds.length > 0) {
                  // Get specific memories by ID
                  for (const id of sourceIds) {
                    const memory = await memoryStore.getById(id);
                    if (memory) sourceMemories.push(memory);
                  }
                } else {
                  // Get recent episodic memories for fact extraction
                  const episodicMemories = await memoryStore.list({ layer: 'episodic', limit: 50 });
                  sourceMemories = episodicMemories.memories;
                }

                const extractOptions: ExtractFactsOptions = { sourceMemories };
                result = await extractFacts(extractOptions);
                break;
              }

              case 'extract_patterns': {
                // Extract patterns from semantic memories
                let semanticMemories: any[] = [];
                if (sourceIds && sourceIds.length > 0) {
                  // Get specific memories by ID
                  for (const id of sourceIds) {
                    const memory = await memoryStore.getById(id);
                    if (memory && memory.layer === 'semantic') semanticMemories.push(memory);
                  }
                } else {
                  // Get semantic memories for pattern extraction
                  const semanticMemoryList = await memoryStore.list({ layer: 'semantic', limit: 100 });
                  semanticMemories = semanticMemoryList.memories;
                }

                const extractPatternOptions = {
                  semanticMemories,
                };
                result = await extractPatterns(extractPatternOptions);
                break;
              }

              case 'compress': {
                // Compress memories based on strategy or provided IDs
                let memoriesToCompress: any[] = [];
                if (sourceIds && sourceIds.length > 0) {
                  // Get specific memories by ID
                  for (const id of sourceIds) {
                    const memory = await memoryStore.getById(id);
                    if (memory) memoriesToCompress.push(memory);
                  }
                } else if (compressStrategy) {
                  // Get memories based on strategy
                  const layerMemories = await memoryStore.list({ 
                    layer: compressStrategy.layer, 
                    limit: compressStrategy.maxCount || 10 
                  });
                  memoriesToCompress = layerMemories.memories;
                } else {
                  // Default: get episodic memories
                  const episodicMemories = await memoryStore.list({ layer: 'episodic', limit: 10 });
                  memoriesToCompress = episodicMemories.memories;
                }

                const compressOptions = {
                  memoriesToCompress,
                };
                const compressResult = await compressMemories(compressOptions);
                
                // Convert CompressResult to ReflectOutput format
                result = {
                  facts: compressResult.compressed.map(comp => ({
                    content: comp.content,
                    type: 'fact', // Map compressed content as a fact
                    confidence: comp.confidence,
                    evidenceEpisodeIds: comp.sourceIds,
                    shouldStore: true, // Compressed memories are typically worth storing
                    sensitive: false, // Compression shouldn't introduce sensitive info
                    category: comp.category || 'compressed',
                  })),
                  source: compressResult.source,
                  llmError: compressResult.llmError,
                };
                break;
              }

              default:
                throw new Error(`Unknown reflect type: ${reflectType}`);
            }
            break;
          }

          default:
            throw new Error(`Unknown action: ${action}`);
        }

        // Format result as readable text
        let textOutput = `Memory ${action} operation completed successfully`;
        if (result) {
          if (action === 'list' && result.memories) {
            textOutput += `\n\nFound ${result.total} memories (showing ${result.memories.length}):\n`;
            for (const mem of result.memories) {
              textOutput += `\n[${mem.layer}] ${mem.id}\n  ${mem.content.slice(0, 200)}${mem.content.length > 200 ? '...' : ''}\n`;
            }
          } else if (action === 'search' && result.memories) {
            textOutput += `\n\nFound ${result.totalFound} results:\n`;
            for (const mem of result.memories) {
              textOutput += `\n[${mem.layer}] score=${mem.score.toFixed(3)}\n  ${mem.content.slice(0, 200)}${mem.content.length > 200 ? '...' : ''}\n`;
            }
          } else if (action === 'stats') {
            textOutput += `\n\n${JSON.stringify(result, null, 2)}`;
          } else if (action === 'add' && result.id) {
            textOutput += `\n\nCreated: ${result.id}`;
          }
        }

        return {
          content: [{ type: 'text', text: textOutput }],
          structuredContent: { action, result },
        };
      } catch (err) {
        throw wrapPreflightError(err);
      } finally {
        if (memoryStore) {
          await memoryStore.close();
        }
      }
    }
  );
}