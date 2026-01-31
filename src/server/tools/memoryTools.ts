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

export function registerMemoryTools({ server, cfg }: ToolDependencies): void {
  server.registerTool(
    'preflight_memory',
    {
      title: 'Memory Management Tool',
      description: 'Manage 3-layer long-term memory system (episodic, semantic, procedural)',
      inputSchema: MemoryToolInputSchema,
      outputSchema: {
        ok: z.boolean(),
        meta: z.object({
          tool: z.string(),
          schemaVersion: z.string(),
          requestId: z.string(),
          timeMs: z.number(),
        }),
        data: z.object({
          action: z.string(),
          result: z.record(z.string(), z.unknown()).optional(),
        }).optional(),
        error: z.object({
          code: z.string(),
          message: z.string(),
          hint: z.string().optional(),
        }).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { action, ...rest } = args;
      let memoryStore: MemoryStore | null = null;

      try {
        // Create memory store instance with configuration
        const memoryStoreConfig: MemoryStoreConfig = {
          chromaUrl: cfg.chromaUrl,
          userId: process.env.PREFLIGHT_USER_ID,
          embeddingModelId: 'unknown', // Would be updated based on actual embedding model used
        };
        memoryStore = new MemoryStore(memoryStoreConfig);
        await memoryStore.ensureCollections();

        let result: any;
        switch (action) {
          case 'add': {
            const { layer = 'episodic', content, metadata, batch } = rest;
            if (batch && batch.length > 0) {
              // Handle batch add
              const results: any[] = [];
              for (const item of batch) {
                if (layer === 'episodic') {
                  results.push(await memoryStore.addEpisodic({
                    content: item.content,
                    type: item.metadata?.type as 'conversation' | 'event' | 'summary' || 'conversation',
                    participants: item.metadata?.tags,
                    tags: item.metadata?.tags,
                  }));
                } else if (layer === 'semantic') {
                  results.push(await memoryStore.addSemantic({
                    content: item.content,
                    type: item.metadata?.type as 'fact' | 'relation' | 'entity' || 'fact',
                    subject: item.metadata?.subject,
                    predicate: item.metadata?.predicate,
                    object: item.metadata?.object,
                    confidence: item.metadata?.confidence || 0.7,
                    sourceEpisodeIds: item.metadata?.tags,
                  }));
                } else if (layer === 'procedural') {
                  results.push(await memoryStore.addProcedural({
                    content: item.content,
                    type: item.metadata?.type as 'preference' | 'habit' | 'pattern' || 'preference',
                    category: item.metadata?.category || 'general',
                    strength: item.metadata?.confidence,
                    occurrenceCount: 1,
                    sourceMemoryIds: item.metadata?.tags,
                  }));
                }
              }
              result = results;
            } else if (content) {
              // Handle single add
              if (layer === 'episodic') {
                result = await memoryStore.addEpisodic({
                  content,
                  type: metadata?.type as 'conversation' | 'event' | 'summary' || 'conversation',
                  participants: metadata?.tags,
                  tags: metadata?.tags,
                  sessionId: metadata?.category, // Using category as sessionId for episodic
                });
                              } else if (layer === 'semantic') {
                                result = await memoryStore.addSemantic({
                                  content,
                                  type: (metadata?.type as 'fact' | 'relation' | 'entity') || 'fact',
                                  subject: metadata?.subject,
                                  predicate: metadata?.predicate,
                                  object: metadata?.object,
                                  confidence: metadata?.confidence || 0.7,
                                  sourceEpisodeIds: metadata?.tags,
                                });              } else if (layer === 'procedural') {
                result = await memoryStore.addProcedural({
                  content,
                  type: metadata?.type as 'preference' | 'habit' | 'pattern' || 'preference',
                  category: metadata?.category || 'general',
                  strength: metadata?.confidence,
                  occurrenceCount: 1,
                  sourceMemoryIds: metadata?.tags,
                });
              }
            } else {
              throw new Error('Either content or batch must be provided for add action');
            }
            break;
          }

          case 'search': {
            const { query, layers, topK, limit, offset, filters } = rest;
            result = await memoryStore.search({
              query: query || '',
              layers,
              topK,
              limit,
              offset,
              filters,
            });
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

        return {
          content: [{ type: 'text', text: `Memory ${action} operation completed successfully` }],
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