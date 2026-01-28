/**
 * preflight_rag - Index bundle to vector DB and perform RAG queries.
 * @module server/tools/ragTools
 */

import * as z from 'zod';

import type { ToolDependencies } from './types.js';
import { RAGEngine } from '../../rag/query.js';
import { ChromaVectorDB } from '../../vectordb/chroma-client.js';
import type { RAGConfig, QueryMode } from '../../rag/types.js';
import { createEmbeddingFromConfig, describeEmbeddingEndpoint } from '../../embedding/preflightEmbedding.js';
import { findBundleStorageDir } from '../../bundle/service.js';
import { getBundlePaths } from '../../bundle/paths.js';
import { wrapPreflightError } from '../../mcp/errorKinds.js';
import { createModuleLogger } from '../../logging/logger.js';
import { callLLM, getLLMConfig, getVerifierLLMConfig, type LLMConfig } from '../../distill/llm-client.js';

const logger = createModuleLogger('rag-tool');

// ============================================================================
// ChromaDB Availability Check
// ============================================================================

/**
 * Check ChromaDB availability.
 */
async function checkChromaAvailability(chromaUrl: string): Promise<{ available: boolean; error?: string }> {
  try {
    const response = await fetch(`${chromaUrl}/api/v2/heartbeat`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      return { available: true };
    }
    return { available: false, error: `ChromaDB returned ${response.status}` };
  } catch (err) {
    return { available: false, error: `Cannot connect: ${err}` };
  }
}

// ============================================================================
// RAG Engine Cache (per bundleId)
// ============================================================================

const engineCache = new Map<string, RAGEngine>();

async function getOrCreateEngine(
  bundleId: string,
  cfg: ToolDependencies['cfg'],
  options?: { useVerifierLlm?: boolean }
): Promise<{ engine: RAGEngine; embeddingEndpoint: string; llmEnabled: boolean; llmModel: string }> {
  // Create embedding provider using unified config
  const { embedding, embeddingConfig } = createEmbeddingFromConfig(cfg);
  const embeddingEndpoint = describeEmbeddingEndpoint(embeddingConfig) ?? cfg.ollamaHost ?? 'ollama';

  // Check LLM availability - use verifier LLM if requested
  const llmConfig: LLMConfig = options?.useVerifierLlm ? getVerifierLLMConfig() : getLLMConfig();
  const llmEnabled = llmConfig.enabled && !!llmConfig.apiKey;
  const llmModel = llmConfig.model;

  // Check cache - use a combined key since LLM state can affect engine behavior
  const llmKey = options?.useVerifierLlm ? 'verifier' : 'main';
  const cacheKey = `${bundleId}_${llmKey}_llm${llmEnabled ? '1' : '0'}`;
  let engine = engineCache.get(cacheKey);
  if (engine) {
    return { engine, embeddingEndpoint, llmEnabled, llmModel };
  }

  // Create RAG config using config.chromaUrl
  // Inject LLM if enabled (reuses llmApiBase/llmApiKey/llmModel from config.json)
  const ragConfig: RAGConfig = {
    chromaUrl: cfg.chromaUrl,
    embedding: {
      embed: async (text: string) => embedding.embed(text),
      embedBatch: async (texts: string[]) => embedding.embedBatch(texts),
    },
    // Inject LLM for RAG generation (not just retrieval snippet concatenation)
    llm: llmEnabled
      ? {
          complete: async (prompt: string) => {
            const response = await callLLM(prompt, undefined, llmConfig);
            return response.content;
          },
        }
      : undefined,
  };

  if (llmEnabled) {
    const llmType = options?.useVerifierLlm ? 'verifier' : 'main';
    logger.info(`RAG engine initialized with ${llmType} LLM (${llmModel})`);
  } else {
    logger.warn('RAG engine running without LLM - answers will be retrieval snippets only');
  }

  // Create engine
  engine = new RAGEngine(ragConfig);

  // Cache it
  engineCache.set(cacheKey, engine);
  return { engine, embeddingEndpoint, llmEnabled, llmModel };
}

// ============================================================================
// Helper: Get Embedding Provider
// ============================================================================

function getEmbeddingProvider(cfg: ToolDependencies['cfg']) {
  const { embedding } = createEmbeddingFromConfig(cfg);
  return embedding;
}

// ============================================================================
// Helper: Inspect Chunks (for debugging)
// ============================================================================

async function inspectChunks(
  chromaDB: ChromaVectorDB,
  cfg: ToolDependencies['cfg'],
  bundleId?: string,
  limit: number = 5
): Promise<{ chunks: Array<{ id: string; content: string; metadata: Record<string, unknown> }> }> {
  // Use a generic query to fetch some chunks
  // We need an embedding to query, so use a simple text
  const embedding = getEmbeddingProvider(cfg);
  const queryEmbedding = await embedding.embed('document content');
  
  const filter = bundleId ? { bundleId } : undefined;
  const results = await chromaDB.queryChunks(queryEmbedding.vector, limit, filter);
  
  return {
    chunks: results.chunks.map(c => ({
      id: c.id,
      content: c.content,
      metadata: c.metadata as unknown as Record<string, unknown>,
    })),
  };
}

// ============================================================================
// preflight_rag Tool
// ============================================================================

export function registerRagTools({ server, cfg }: ToolDependencies): void {
  server.registerTool(
    'preflight_rag',
    {
      title: 'RAG index and query',
      description:
        'Index bundle to ChromaDB for RAG queries, or ask knowledge questions about indexed content.\n\n' +
        '**Usage:**\n' +
        '- Index: `{"bundleId": "<id>", "index": true}`\n' +
        '- Query single bundle: `{"bundleId": "<id>", "question": "这个项目怎么用？"}`\n' +
        '- Query multiple bundles: `{"crossBundleMode": "specified", "bundleIds": ["id1", "id2"], "question": "比较两篇论文的方法"}`\n' +
        '- Query all bundles: `{"crossBundleMode": "all", "question": "哪篇论文讨论了transformer？"}`\n' +
        '- Both: `{"bundleId": "<id>", "index": true, "question": "..."}`\n\n' +
        '**Cross-bundle retrieval:**\n' +
        '- `crossBundleMode: "single"` (default): Query single bundle (specify `bundleId`)\n' +
        '- `crossBundleMode: "specified"`: Query specific bundles (specify `bundleIds` array)\n' +
        '- `crossBundleMode: "all"`: Query all indexed bundles (no bundleId needed)\n' +
        'Note: AST graph expansion (hybrid mode) only works in single-bundle mode.\n\n' +
        '**Deduplication:** Same PDF won\'t be indexed twice. If skipped, use `force: true` to replace:\n' +
        '- Replace: `{"bundleId": "<id>", "index": true, "force": true}`\n\n' +
        '**Query modes:** `naive` (vector only), `local` (vector + neighbor), `hybrid` (vector + AST graph, default)\n\n' +
        '**Cross-validation (recommended for important queries):**\n' +
        'For higher answer reliability, call this tool twice with `useVerifierLlm: true` on the second call. ' +
        'This uses a different LLM (configured as `verifierLlm*` in config.json) to independently answer the same question. ' +
        'Compare both answers to verify correctness.\n' +
        '- First call: `{"bundleId": "<id>", "question": "..."}` (uses default LLM)\n' +
        '- Second call: `{"bundleId": "<id>", "question": "...", "useVerifierLlm": true}` (uses verifier LLM)\n\n' +
        '**Config:** Requires `chromaUrl` and `embeddingEnabled` in `~/.preflight/config.json`\n' +
        'Optional: `verifierLlmApiBase`, `verifierLlmApiKey`, `verifierLlmModel` for cross-validation.\n' +
        'Use when: "RAG问答", "知识检索", "语义搜索", "跨文档检索", "对比论文", "index bundle", "向量查询", "重新索引", "覆盖旧版本".',
      inputSchema: {
        bundleId: z.string().optional().describe('Bundle ID to index or query (single mode, backward compatible)'),
        bundleIds: z.array(z.string()).optional().describe('Multiple bundle IDs to query (Phase 1: cross-bundle retrieval)'),
        crossBundleMode: z.enum(['single', 'specified', 'all']).optional().describe('Cross-bundle mode: single (default), specified (use bundleIds), all (query everything)'),
        index: z.boolean().optional().describe('Index bundle to vector DB (default: false). Skips if content already indexed.'),
        force: z.boolean().optional().describe('Force replace existing content with same hash. Use when: switching parser (MinerU→VLM), updating paper version, or re-indexing after bundle changes. Deletes old chunks before indexing new ones.'),
        question: z.string().optional().describe('Question to ask about the bundle'),
        mode: z.enum(['naive', 'local', 'hybrid']).optional().describe('Query mode (default: hybrid)'),
        topK: z.number().optional().describe('Number of chunks to retrieve (default: 10)'),
        repoId: z.string().optional().describe('Filter by repo ID'),
        expandToParent: z.boolean().optional().describe('Expand to parent chunks for more context (default: true)'),
        expandToSiblings: z.boolean().optional().describe('Expand to sibling chunks at same level (default: true)'),
        useVerifierLlm: z.boolean().optional().describe('Use verifier LLM instead of default LLM for cross-validation. Configure verifierLlm* in config.json. Call twice (once without, once with this flag) and compare answers for reliability.'),
      },
      outputSchema: {
        // Config info
        chromaUrl: z.string().optional().describe('ChromaDB server URL used'),
        embeddingEndpoint: z.string().optional().describe('Embedding API endpoint used'),
        // Index result
        indexed: z.boolean().optional(),
        skipped: z.boolean().optional().describe('Whether indexing was skipped due to duplicate content'),
        chunksWritten: z.number().optional(),
        entitiesCount: z.number().optional(),
        relationsCount: z.number().optional(),
        indexDurationMs: z.number().optional(),
        indexErrors: z.array(z.string()).optional(),
        // Deduplication info
        contentHash: z.string().optional().describe('Source file SHA256 hash'),
        paperId: z.string().optional().describe('Paper identifier (e.g., arxiv:2601.14287)'),
        paperVersion: z.string().optional().describe('Paper version (e.g., v1)'),
        existingChunks: z.number().optional().describe('Number of existing chunks (when skipped)'),
        deletedChunks: z.number().optional().describe('Number of chunks deleted (when force=true)'),
        // Query result
        answer: z.string().optional(),
        sources: z
          .array(
            z.object({
              chunkId: z.string(),
              content: z.string(),
              sourceType: z.string(),
              filePath: z.string().optional(),
              repoId: z.string().optional(),
              pageIndex: z.number().optional().describe('Page number (1-indexed) in PDF'),
              sectionHeading: z.string().optional().describe('Section heading (e.g., "3.2 Method", "Abstract")'),
              bundleId: z.string().optional().describe('Bundle ID this evidence came from'),
              paperId: z.string().optional().describe('Paper identifier (e.g., arXiv:2601.02553)'),
            })
          )
          .optional(),
        relatedEntities: z.array(z.string()).optional(),
        stats: z
          .object({
            chunksRetrieved: z.number(),
            graphExpansion: z.number().optional(),
            durationMs: z.number(),
          })
          .optional(),
      },
      annotations: { openWorldHint: true },
    },
    async (args) => {
      try {
        const { bundleId, bundleIds, crossBundleMode, index, force, question, mode, topK, repoId, expandToParent, expandToSiblings, useVerifierLlm } = args;

        // Validate: at least one action
        if (!index && !question) {
          throw new Error(
            'Must specify `index: true` or `question`. ' +
            'Example: {"bundleId": "xxx", "index": true} or {"bundleId": "xxx", "question": "How to use?"}'
          );
        }

        // Validate cross-bundle parameters
        if (crossBundleMode === 'specified' && (!bundleIds || bundleIds.length === 0)) {
          throw new Error(
            'crossBundleMode="specified" requires bundleIds array. ' +
            'Example: {"crossBundleMode": "specified", "bundleIds": ["id1", "id2"], "question": "..."}'
          );
        }

        // Check embedding configuration
        if (!cfg.semanticSearchEnabled && !cfg.openaiApiKey && cfg.embeddingProvider !== 'ollama') {
          throw new Error(
            'Embedding not configured. Set `embeddingEnabled: true` and `embeddingApiKey` in ~/.preflight/config.json'
          );
        }

        // Check ChromaDB availability
        const chromaCheck = await checkChromaAvailability(cfg.chromaUrl);
        if (!chromaCheck.available) {
          throw new Error(
            `ChromaDB not available at ${cfg.chromaUrl}. ${chromaCheck.error}\n` +
            'Set `chromaUrl` in ~/.preflight/config.json or PREFLIGHT_CHROMA_URL env var.'
          );
        }

        // Find bundle path (only needed for indexing)
        let bundlePath: string | undefined;
        if (index) {
          if (!bundleId) {
            throw new Error('bundleId is required for indexing');
          }
          const storageDir = await findBundleStorageDir(cfg.storageDirs, bundleId);
          if (!storageDir) {
            throw new Error(`Bundle not found: ${bundleId}`);
          }
          const paths = getBundlePaths(storageDir, bundleId);
          bundlePath = paths.rootDir;
        }

        // Get RAG engine (use verifier LLM if requested for cross-validation)
        // For cross-bundle queries, use first bundleId or a placeholder
        const engineKey = bundleId ?? bundleIds?.[0] ?? 'shared';
        const { engine, embeddingEndpoint, llmEnabled, llmModel } = await getOrCreateEngine(engineKey, cfg, { useVerifierLlm });

        let indexResult: {
          chunksWritten: number;
          entitiesCount?: number;
          relationsCount?: number;
          durationMs: number;
          errors: string[];
          skipped?: boolean;
          contentHash?: string;
          paperId?: string;
          paperVersion?: string;
          existingChunks?: number;
          deletedChunks?: number;
        } | null = null;

        let queryResult: {
          answer: string;
          sources: Array<{
            chunkId: string;
            content: string;
            sourceType: string;
            filePath?: string;
            repoId?: string;
            pageIndex?: number;
            sectionHeading?: string;
            bundleId?: string;
            paperId?: string;
          }>;
          relatedEntities?: string[];
          stats: {
            chunksRetrieved: number;
            graphExpansion?: number;
            durationMs: number;
          };
        } | null = null;

        // Index if requested
        if (index) {
          if (!bundleId || !bundlePath) {
            throw new Error('bundleId and bundlePath required for indexing');
          }
          logger.info(`Indexing bundle: ${bundleId}${force ? ' (force)' : ''}`);
          const result = await engine.indexBundle(bundlePath, bundleId, { force });
          indexResult = {
            chunksWritten: result.chunksWritten,
            entitiesCount: result.entitiesCount,
            relationsCount: result.relationsCount,
            durationMs: result.durationMs,
            errors: result.errors,
            skipped: result.skipped,
            contentHash: result.contentHash,
            paperId: result.paperId,
            paperVersion: result.paperVersion,
            existingChunks: result.existingChunks,
            deletedChunks: result.deletedChunks,
          };
          if (result.skipped) {
            logger.info(`Skipped indexing: content already exists (${result.existingChunks} chunks)`);
          } else {
            logger.info(
              `Indexed ${result.chunksWritten} chunks, ${result.entitiesCount ?? 0} entities in ${result.durationMs}ms`
            );
          }
        }

        // Query if requested
        if (question) {
          const llmType = useVerifierLlm ? 'verifier' : 'main';
          logger.info(`Querying: "${question}" (mode: ${mode ?? 'hybrid'}, llm: ${llmType}/${llmModel})`);

          // Try to load AST graph if not indexing in same call (only for single bundle mode)
          if (!index && bundleId) {
            await engine.loadAstGraph(bundleId);
          }

          // High-quality defaults (as per plan - don't add new config items, just use best quality)
          const result = await engine.query(question, {
            mode: (mode as QueryMode) ?? 'hybrid',
            topK: topK ?? 10,
            // Phase 1: Cross-bundle parameters
            bundleId,
            bundleIds,
            crossBundleMode: crossBundleMode as 'single' | 'specified' | 'all' | undefined,
            repoId,
            // Ultra quality: always enable verification and retry when LLM is available
            enableVerification: llmEnabled,
            retryOnLowFaithfulness: llmEnabled,
            enableContextCompletion: true,
            maxHops: 3, // Multi-hop for complete context
            // Hierarchical expansion (default: true)
            expandToParent: expandToParent ?? true,
            expandToSiblings: expandToSiblings ?? true,
          });

          queryResult = {
            answer: result.answer,
            sources: result.sources,
            relatedEntities: result.relatedEntities,
            stats: result.stats,
          };
          logger.info(
            `Retrieved ${result.stats.chunksRetrieved} chunks, expanded ${result.stats.graphExpansion ?? 0} types`
          );
        }

        // Build response text
        let textResponse = '';

        // Show config info
        const llmInfo = useVerifierLlm ? `VerifierLLM=${llmModel}` : `LLM=${llmModel}`;
        textResponse += `🔧 Config: ChromaDB=${cfg.chromaUrl} | Embedding=${embeddingEndpoint} | ${llmInfo}\n\n`;

        if (indexResult) {
          if (indexResult.skipped) {
            textResponse += `⚠️ Skipped: content already indexed\n`;
            textResponse += `   contentHash: ${indexResult.contentHash?.slice(0, 12)}...\n`;
            if (indexResult.paperId) {
              textResponse += `   paperId: ${indexResult.paperId}${indexResult.paperVersion ? ` (${indexResult.paperVersion})` : ''}\n`;
            }
            textResponse += `   existingChunks: ${indexResult.existingChunks}\n`;
            textResponse += `   Hint: Use force=true to replace.\n`;
          } else {
            if (indexResult.deletedChunks) {
              textResponse += `🔄 Replaced: ${indexResult.contentHash?.slice(0, 12)}...\n`;
              textResponse += `   Deleted: ${indexResult.deletedChunks} chunks\n`;
            } else {
              textResponse += `✅ Indexed bundle: ${bundleId}\n`;
            }
            textResponse += `   Chunks: ${indexResult.chunksWritten}\n`;
            textResponse += `   Entities: ${indexResult.entitiesCount ?? 0}\n`;
            textResponse += `   Relations: ${indexResult.relationsCount ?? 0}\n`;
            if (indexResult.contentHash) {
              textResponse += `   contentHash: ${indexResult.contentHash.slice(0, 12)}...\n`;
            }
            if (indexResult.paperId) {
              textResponse += `   paperId: ${indexResult.paperId}${indexResult.paperVersion ? ` (${indexResult.paperVersion})` : ''}\n`;
            }
            textResponse += `   Duration: ${indexResult.durationMs}ms\n`;
          }
          if (indexResult.errors.length > 0) {
            textResponse += `   ⚠️ Errors: ${indexResult.errors.length}\n`;
            indexResult.errors.slice(0, 3).forEach((e) => {
              textResponse += `      - ${e}\n`;
            });
          }
        }

        if (queryResult) {
          if (indexResult) textResponse += '\n---\n\n';
          textResponse += `📝 Question: ${question}\n\n`;
          textResponse += `💬 Answer:\n${queryResult.answer}\n`;

          if (queryResult.sources.length > 0) {
            textResponse += '\n📚 Sources:\n';
            
            // Phase 1.4: Group sources by paperId for cross-bundle queries
            const sourcesByPaper = new Map<string, typeof queryResult.sources>();
            for (const source of queryResult.sources) {
              const key = source.paperId ?? source.bundleId ?? 'unknown';
              if (!sourcesByPaper.has(key)) {
                sourcesByPaper.set(key, []);
              }
              sourcesByPaper.get(key)!.push(source);
            }

            // Display sources grouped by paper
            let globalIndex = 1;
            for (const [paperId, sources] of sourcesByPaper) {
              // Paper header (show only if multiple papers)
              if (sourcesByPaper.size > 1) {
                textResponse += `   📄 ${paperId}:\n`;
              }
              
              // Format each source with enhanced metadata
              for (const s of sources.slice(0, 5)) {
                // Build source label: [paperId] Section X.Y, page N
                let sourceLabel = '';
                
                // Add paperId prefix if available
                if (s.paperId) {
                  sourceLabel += `[${s.paperId}]`;
                }
                
                // Add section/heading info from metadata
                if (s.sectionHeading) {
                  sourceLabel += ` ${s.sectionHeading}`;
                }
                
                // Add page number
                if (s.pageIndex) {
                  sourceLabel += `, page ${s.pageIndex}`;
                }
                
                // Fallback: use sourceType and repoId if no paperId
                if (!sourceLabel) {
                  sourceLabel = `[${s.sourceType}] ${s.repoId ?? s.filePath ?? s.chunkId}`;
                  if (s.pageIndex) {
                    sourceLabel += ` (p.${s.pageIndex})`;
                  }
                }
                
                const indent = sourcesByPaper.size > 1 ? '      ' : '   ';
                textResponse += `${indent}${globalIndex}. ${sourceLabel}\n`;
                globalIndex++;
              }
            }
          }

          if (queryResult.relatedEntities && queryResult.relatedEntities.length > 0) {
            textResponse += `\n🔗 Related: ${queryResult.relatedEntities.slice(0, 5).join(', ')}\n`;
          }

          textResponse += `\n⏱️ Stats: ${queryResult.stats.chunksRetrieved} chunks, `;
          textResponse += `${queryResult.stats.graphExpansion ?? 0} graph expansion, `;
          textResponse += `${queryResult.stats.durationMs}ms\n`;
        }

        // Build structured output
        const structuredContent: Record<string, unknown> = {
          chromaUrl: cfg.chromaUrl,
          embeddingEndpoint,
        };

        if (indexResult) {
          structuredContent.indexed = !indexResult.skipped;
          structuredContent.skipped = indexResult.skipped;
          structuredContent.chunksWritten = indexResult.chunksWritten;
          structuredContent.entitiesCount = indexResult.entitiesCount;
          structuredContent.relationsCount = indexResult.relationsCount;
          structuredContent.indexDurationMs = indexResult.durationMs;
          structuredContent.contentHash = indexResult.contentHash;
          structuredContent.paperId = indexResult.paperId;
          structuredContent.paperVersion = indexResult.paperVersion;
          structuredContent.existingChunks = indexResult.existingChunks;
          structuredContent.deletedChunks = indexResult.deletedChunks;
          if (indexResult.errors.length > 0) {
            structuredContent.indexErrors = indexResult.errors;
          }
        }

        if (queryResult) {
          structuredContent.answer = queryResult.answer;
          structuredContent.sources = queryResult.sources;
          structuredContent.relatedEntities = queryResult.relatedEntities;
          structuredContent.stats = queryResult.stats;
        }

        return {
          content: [{ type: 'text', text: textResponse }],
          structuredContent,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );

  // ============================================================================
  // preflight_rag_manage Tool
  // ============================================================================

  server.registerTool(
    'preflight_rag_manage',
    {
      title: 'RAG content management',
      description:
        'Debug and manage ChromaDB vector database. Use this tool to inspect index structure, debug retrieval issues, and manage content.\n\n' +
        '## Quick Reference\n' +
        '| Action | Purpose | Example |\n' +
        '|--------|---------|---------|\n' +
        '| `collections` | View all collections (L1/L2/L3 hierarchy) | `{"action": "collections"}` |\n' +
        '| `stats` | Total chunks, unique docs, by paperId | `{"action": "stats"}` |\n' +
        '| `list` | List indexed content with contentHash | `{"action": "list"}` |\n' +
        '| `sample` | Sample chunks from specific collection | `{"action": "sample", "collection": "preflight_rag_l1_pdf", "limit": 3}` |\n' +
        '| `inspect` | View chunk content and ALL metadata | `{"action": "inspect", "limit": 5}` |\n' +
        '| `search_raw` | Raw vector search (no LLM) | `{"action": "search_raw", "query": "transformer", "limit": 5}` |\n' +
        '| `delete` | Delete by contentHash | `{"action": "delete", "contentHash": "abc123..."}` |\n' +
        '| `delete_all` | ⚠️ Delete everything | `{"action": "delete_all"}` |\n' +
        '| `drop_collection` | ⚠️ Drop entire collection | `{"action": "drop_collection", "collection": "preflight_chunks"}` |\n\n' +
        '## When to Use\n' +
        '- **"检查分层索引"** → `collections` (see L1_pdf/L1_repo/L2_section/L3_chunk counts)\n' +
        '- **"查看哪些论文已索引"** → `list` (shows paperId and chunk counts)\n' +
        '- **"为什么搜不到xxx"** → `search_raw` with the query (test retrieval without LLM)\n' +
        '- **"检查chunk内容/metadata"** → `inspect` (see pageIndex, sectionHeading, etc.)\n' +
        '- **"查看L1层有什么"** → `sample` with collection="preflight_rag_l1_pdf"\n' +
        '- **"清空数据库"** → `delete_all`\n' +
        '- **"删除某个collection"** → `drop_collection` with collection name\n\n' +
        '## Hierarchical Structure\n' +
        '```\n' +
        'L1 (coarse): l1_pdf, l1_repo, l1_doc, l1_memory, l1_web\n' +
        'L2 (section): l2_section\n' +
        'L3 (chunk): l3_chunk\n' +
        '```',
      inputSchema: {
        action: z.enum(['list', 'stats', 'collections', 'sample', 'delete', 'delete_all', 'drop_collection', 'inspect', 'search_raw']).describe('Action to perform'),
        contentHash: z.string().optional().describe('Content hash to delete (required for delete action)'),
        bundleId: z.string().optional().describe('Filter by bundle ID (for inspect and search_raw)'),
        collection: z.string().optional().describe('Collection name (for sample or drop_collection, e.g., "preflight_rag_l1_pdf")'),
        query: z.string().optional().describe('Search query text (required for search_raw)'),
        limit: z.number().optional().describe('Max number of results (default 5)'),
      },
      outputSchema: {
        // List result
        items: z.array(z.object({
          contentHash: z.string(),
          paperId: z.string().optional(),
          paperVersion: z.string().optional(),
          bundleId: z.string(),
          chunkCount: z.number(),
        })).optional(),
        // Stats result
        stats: z.object({
          totalChunks: z.number(),
          uniqueContentHashes: z.number(),
          byPaperId: z.array(z.object({
            paperId: z.string(),
            chunkCount: z.number(),
          })),
        }).optional(),
        // Delete result
        deleted: z.boolean().optional(),
        deletedChunks: z.number().optional(),
      },
      annotations: { openWorldHint: true },
    },
    async (args) => {
      try {
        const { action, contentHash, bundleId, collection, query, limit } = args;

        // Check ChromaDB availability
        const chromaCheck = await checkChromaAvailability(cfg.chromaUrl);
        if (!chromaCheck.available) {
          throw new Error(
            `ChromaDB not available at ${cfg.chromaUrl}. ${chromaCheck.error}`
          );
        }

        const chromaDB = new ChromaVectorDB({ url: cfg.chromaUrl });
        let textResponse = '';
        const structuredContent: Record<string, unknown> = {};

        switch (action) {
          case 'list': {
            const items = await chromaDB.listIndexedContent();
            structuredContent.items = items;

            textResponse += `📋 Indexed Content (${items.length} items)\n\n`;
            if (items.length === 0) {
              textResponse += 'No content indexed yet.\n';
            } else {
              for (const item of items) {
                textResponse += `• ${item.contentHash}\n`;
                if (item.paperId) {
                  textResponse += `  paperId: ${item.paperId}${item.paperVersion ? ` (${item.paperVersion})` : ''}\n`;
                }
                textResponse += `  chunks: ${item.chunkCount}\n`;
              }
            }
            break;
          }

          case 'stats': {
            const stats = await chromaDB.getCollectionStats();
            structuredContent.stats = stats;

            textResponse += `📊 RAG Statistics\n\n`;
            textResponse += `Total chunks: ${stats.totalChunks}\n`;
            textResponse += `Unique content hashes: ${stats.uniqueContentHashes}\n`;
            if (stats.byPaperId.length > 0) {
              textResponse += `\nBy Paper ID:\n`;
              for (const item of stats.byPaperId) {
                textResponse += `  • ${item.paperId}: ${item.chunkCount} chunks\n`;
              }
            }
            break;
          }

          case 'collections': {
            // List all collections with document counts
            const collections = await chromaDB.listAllCollections();
            const collectionStats: Array<{ name: string; count: number; metadata?: Record<string, unknown> }> = [];
            
            for (const col of collections) {
              const count = await chromaDB.getCollectionCount(col.name);
              collectionStats.push({ name: col.name, count, metadata: col.metadata });
            }
            
            // Sort by name for better display
            collectionStats.sort((a, b) => a.name.localeCompare(b.name));
            
            structuredContent.collections = collectionStats;

            textResponse += `📦 ChromaDB Collections (${collections.length} total)\n\n`;
            
            // Group by type for display
            const hierarchical = collectionStats.filter(c => c.name.includes('_rag_l'));
            const legacy = collectionStats.filter(c => !c.name.includes('_rag_l'));
            
            if (hierarchical.length > 0) {
              textResponse += `**Hierarchical (Phase 3):**\n`;
              for (const col of hierarchical) {
                const level = col.name.match(/_rag_(l[0-9]_[a-z]+)/)?.[1] ?? 'unknown';
                textResponse += `  • ${col.name}: ${col.count} docs (${level})\n`;
              }
              textResponse += `\n`;
            }
            
            if (legacy.length > 0) {
              textResponse += `**Legacy/Other:**\n`;
              for (const col of legacy) {
                textResponse += `  • ${col.name}: ${col.count} docs\n`;
              }
            }
            
            // Summary
            const totalDocs = collectionStats.reduce((sum, c) => sum + c.count, 0);
            textResponse += `\n**Total:** ${totalDocs} documents across ${collections.length} collections\n`;
            break;
          }

          case 'sample': {
            // Sample chunks from a specific collection
            if (!collection) {
              throw new Error('collection is required for sample action. Example: "preflight_rag_l1_pdf"');
            }

            const maxSamples = limit ?? 5;
            
            // Get collection count first
            const count = await chromaDB.getCollectionCount(collection);
            if (count === 0) {
              textResponse += `⚠️ Collection "${collection}" is empty or does not exist.\n`;
              break;
            }

            // For sampling, we need to use a dummy query to get random-ish results
            // Use a very generic embedding query
            if (!cfg.semanticSearchEnabled && !cfg.openaiApiKey && cfg.embeddingProvider !== 'ollama') {
              throw new Error('Embedding not configured. Cannot sample.');
            }

            const embedding = await getEmbeddingProvider(cfg);
            // Use a generic query to get diverse samples
            const sampleEmbedding = await embedding.embed('document content text');
            
            // Query the specific collection directly
            const basePath = `/api/v2/tenants/default_tenant/databases/default_database`;
            const collectionsResponse = await fetch(
              `${cfg.chromaUrl}${basePath}/collections`
            );
            const collections = await collectionsResponse.json() as Array<{ name: string; id: string }>;
            const targetCol = collections.find((c: { name: string }) => c.name === collection);
            
            if (!targetCol) {
              textResponse += `⚠️ Collection "${collection}" not found.\n`;
              break;
            }

            const queryResponse = await fetch(
              `${cfg.chromaUrl}${basePath}/collections/${targetCol.id}/query`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  query_embeddings: [sampleEmbedding.vector],
                  n_results: maxSamples,
                  include: ['documents', 'metadatas'],
                }),
              }
            );
            const queryResult = await queryResponse.json() as {
              ids: string[][];
              documents?: (string | null)[][];
              metadatas?: (Record<string, unknown> | null)[][];
            };

            textResponse += `📋 Sample from "${collection}" (${count} total, showing ${maxSamples})\n\n`;
            
            if (queryResult.ids[0]) {
              for (let i = 0; i < queryResult.ids[0].length; i++) {
                const id = queryResult.ids[0][i];
                const doc = queryResult.documents?.[0]?.[i] ?? '';
                const meta = queryResult.metadatas?.[0]?.[i] ?? {};
                
                textResponse += `--- Sample ${i + 1} ---\n`;
                textResponse += `ID: ${id}\n`;
                if (meta.paperId) textResponse += `Paper: ${meta.paperId}\n`;
                if (meta.sourceType) textResponse += `Source: ${meta.sourceType}\n`;
                if (meta.sectionHeading) textResponse += `Section: ${meta.sectionHeading}\n`;
                if (meta.pageIndex) textResponse += `Page: ${meta.pageIndex}\n`;
                if (meta.collectionLevel) textResponse += `Level: ${meta.collectionLevel}\n`;
                
                const preview = doc.length > 200 ? doc.slice(0, 200) + '...' : doc;
                textResponse += `Content: ${preview}\n\n`;
              }
            }
            
            structuredContent.collection = collection;
            structuredContent.totalCount = count;
            structuredContent.sampleCount = queryResult.ids[0]?.length ?? 0;
            break;
          }

          case 'delete': {
            if (!contentHash) {
              throw new Error('contentHash is required for delete action');
            }

            const deletedCount = await chromaDB.deleteByContentHash(contentHash);
            structuredContent.deleted = deletedCount > 0;
            structuredContent.deletedChunks = deletedCount;

            if (deletedCount > 0) {
              textResponse += `🗑️ Deleted ${deletedCount} chunks\n`;
              textResponse += `   contentHash: ${contentHash.slice(0, 12)}...\n`;
            } else {
              textResponse += `⚠️ No chunks found with contentHash: ${contentHash.slice(0, 12)}...\n`;
            }
            break;
          }

          case 'delete_all': {
            const items = await chromaDB.listIndexedContent();
            if (items.length === 0) {
              textResponse += '⚠️ No content to delete.\n';
              structuredContent.deleted = false;
              structuredContent.deletedChunks = 0;
            } else {
              let totalDeleted = 0;
              for (const item of items) {
                const count = await chromaDB.deleteByContentHash(item.contentHash);
                totalDeleted += count;
              }
              textResponse += `🗑️ Deleted all content: ${totalDeleted} chunks from ${items.length} documents\n`;
              structuredContent.deleted = true;
              structuredContent.deletedChunks = totalDeleted;
              structuredContent.deletedDocuments = items.length;
            }
            break;
          }

          case 'drop_collection': {
            if (!collection) {
              throw new Error('collection is required for drop_collection action. Example: "preflight_chunks"');
            }

            // Check if collection exists
            const basePath = `/api/v2/tenants/default_tenant/databases/default_database`;
            const collectionsResponse = await fetch(`${cfg.chromaUrl}${basePath}/collections`);
            const allCollections = await collectionsResponse.json() as Array<{ name: string; id: string }>;
            const targetCol = allCollections.find((c: { name: string }) => c.name === collection);
            
            if (!targetCol) {
              textResponse += `⚠️ Collection "${collection}" not found.\n`;
              structuredContent.dropped = false;
              break;
            }

            // Get count before dropping
            const countBefore = await chromaDB.getCollectionCount(collection);

            // Drop the collection
            const deleteResponse = await fetch(`${cfg.chromaUrl}${basePath}/collections/${collection}`, {
              method: 'DELETE',
            });

            if (deleteResponse.ok) {
              textResponse += `🗑️ Dropped collection "${collection}" (${countBefore} documents)\n`;
              structuredContent.dropped = true;
              structuredContent.collection = collection;
              structuredContent.documentsDropped = countBefore;
            } else {
              const error = await deleteResponse.text();
              textResponse += `❌ Failed to drop collection "${collection}": ${error}\n`;
              structuredContent.dropped = false;
              structuredContent.error = error;
            }
            break;
          }

          case 'inspect': {
            // Fetch chunks with full metadata for debugging
            const maxChunks = limit ?? 5;
            const filter = bundleId ? { bundleId } : undefined;
            
            // Use a simple embedding to get some chunks (we just want to inspect, not search)
            // For inspect, we'll use the getChunks method with a filter workaround
            const allIndexed = await chromaDB.listIndexedContent();
            const targetBundles = bundleId 
              ? allIndexed.filter(i => i.bundleId === bundleId)
              : allIndexed;
            
            if (targetBundles.length === 0) {
              textResponse += `⚠️ No chunks found${bundleId ? ` for bundleId: ${bundleId}` : ''}.\n`;
              break;
            }

            // Get chunks by fetching with a dummy query (we need embedding for this)
            // For now, use a workaround: fetch all and filter
            const inspection = await inspectChunks(chromaDB, cfg, bundleId, maxChunks);
            structuredContent.chunks = inspection.chunks;

            textResponse += `🔍 Inspecting ${inspection.chunks.length} chunks${bundleId ? ` (bundleId: ${bundleId})` : ''}\n\n`;
            
            for (let i = 0; i < inspection.chunks.length; i++) {
              const chunk = inspection.chunks[i]!;
              textResponse += `--- Chunk ${i + 1} ---\n`;
              textResponse += `ID: ${chunk.id}\n`;
              textResponse += `Type: ${chunk.metadata.chunkType} | Source: ${chunk.metadata.sourceType}\n`;
              if (chunk.metadata.pageIndex) {
                textResponse += `Page: ${chunk.metadata.pageIndex}\n`;
              }
              if (chunk.metadata.sectionHeading) {
                textResponse += `Section: ${chunk.metadata.sectionHeading}\n`;
              }
              if (chunk.metadata.headingPath) {
                textResponse += `Path: ${chunk.metadata.headingPath}\n`;
              }
              if (chunk.metadata.granularity) {
                textResponse += `Granularity: ${chunk.metadata.granularity}\n`;
              }
              // Truncate content for display
              const contentPreview = chunk.content.length > 300 
                ? chunk.content.slice(0, 300) + '...' 
                : chunk.content;
              textResponse += `Content: ${contentPreview}\n\n`;
            }
            break;
          }

          case 'search_raw': {
            if (!query) {
              throw new Error('query is required for search_raw action');
            }

            // Check embedding configuration
            if (!cfg.semanticSearchEnabled && !cfg.openaiApiKey && cfg.embeddingProvider !== 'ollama') {
              throw new Error('Embedding not configured. Cannot perform search_raw.');
            }

            const maxResults = limit ?? 5;
            const filter = bundleId ? { bundleId } : undefined;

            // Get embedding for query
            const embedding = await getEmbeddingProvider(cfg);
            const queryEmbedding = await embedding.embed(query);

            // Raw vector search
            const results = await chromaDB.queryChunks(queryEmbedding.vector, maxResults, filter);
            structuredContent.results = results.chunks;

            textResponse += `🔎 Raw Search Results for: "${query}"\n`;
            textResponse += `Found ${results.chunks.length} chunks${bundleId ? ` (bundleId: ${bundleId})` : ''}\n\n`;

            for (let i = 0; i < results.chunks.length; i++) {
              const chunk = results.chunks[i]!;
              textResponse += `--- Result ${i + 1} (score: ${chunk.score.toFixed(3)}) ---\n`;
              textResponse += `ID: ${chunk.id}\n`;
              textResponse += `Type: ${chunk.metadata.chunkType} | Source: ${chunk.metadata.sourceType}\n`;
              if (chunk.metadata.pageIndex) {
                textResponse += `Page: ${chunk.metadata.pageIndex}\n`;
              }
              if (chunk.metadata.sectionHeading) {
                textResponse += `Section: ${chunk.metadata.sectionHeading}\n`;
              }
              // Truncate content for display
              const contentPreview = chunk.content.length > 300 
                ? chunk.content.slice(0, 300) + '...' 
                : chunk.content;
              textResponse += `Content: ${contentPreview}\n\n`;
            }
            break;
          }
        }

        return {
          content: [{ type: 'text', text: textResponse }],
          structuredContent,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );
}
