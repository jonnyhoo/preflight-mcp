/**
 * preflight_rag - Index bundle to vector DB and perform RAG queries.
 * @module server/tools/ragTools
 */

import * as z from 'zod';

import type { ToolDependencies } from './types.js';
import { RAGEngine } from '../../rag/query.js';
import type { RAGConfig, QueryMode } from '../../rag/types.js';
import { createEmbeddingFromConfig, describeEmbeddingEndpoint } from '../../embedding/preflightEmbedding.js';
import { findBundleStorageDir } from '../../bundle/service.js';
import { getBundlePaths } from '../../bundle/paths.js';
import { wrapPreflightError } from '../../mcp/errorKinds.js';
import { createModuleLogger } from '../../logging/logger.js';

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
  cfg: ToolDependencies['cfg']
): Promise<{ engine: RAGEngine; embeddingEndpoint: string }> {
  // Create embedding provider using unified config
  const { embedding, embeddingConfig } = createEmbeddingFromConfig(cfg);
  const embeddingEndpoint = describeEmbeddingEndpoint(embeddingConfig) ?? cfg.ollamaHost ?? 'ollama';

  // Check cache
  let engine = engineCache.get(bundleId);
  if (engine) {
    return { engine, embeddingEndpoint };
  }

  // Create RAG config using config.chromaUrl
  const ragConfig: RAGConfig = {
    chromaUrl: cfg.chromaUrl,
    embedding: {
      embed: async (text: string) => embedding.embed(text),
      embedBatch: async (texts: string[]) => embedding.embedBatch(texts),
    },
  };

  // Create engine
  engine = new RAGEngine(ragConfig);

  // Cache it
  engineCache.set(bundleId, engine);
  return { engine, embeddingEndpoint };
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
        '- Query: `{"bundleId": "<id>", "question": "这个项目怎么用？"}`\n' +
        '- Both: `{"bundleId": "<id>", "index": true, "question": "..."}`\n\n' +
        '**Query modes:** `naive` (vector only), `local` (vector + neighbor), `hybrid` (vector + AST graph, default)\n' +
        '**Config:** Requires `chromaUrl` and `embeddingEnabled` in `~/.preflight/config.json`\n' +
        'Use when: "RAG问答", "知识检索", "语义搜索", "index bundle", "向量查询".',
      inputSchema: {
        bundleId: z.string().describe('Bundle ID to index or query'),
        index: z.boolean().optional().describe('Index bundle to vector DB (default: false)'),
        question: z.string().optional().describe('Question to ask about the bundle'),
        mode: z.enum(['naive', 'local', 'hybrid']).optional().describe('Query mode (default: hybrid)'),
        topK: z.number().optional().describe('Number of chunks to retrieve (default: 10)'),
        repoId: z.string().optional().describe('Filter by repo ID'),
      },
      outputSchema: {
        // Config info
        chromaUrl: z.string().optional().describe('ChromaDB server URL used'),
        embeddingEndpoint: z.string().optional().describe('Embedding API endpoint used'),
        // Index result
        indexed: z.boolean().optional(),
        chunksWritten: z.number().optional(),
        entitiesCount: z.number().optional(),
        relationsCount: z.number().optional(),
        indexDurationMs: z.number().optional(),
        indexErrors: z.array(z.string()).optional(),
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
        const { bundleId, index, question, mode, topK, repoId } = args;

        // Validate: at least one action
        if (!index && !question) {
          throw new Error(
            'Must specify `index: true` or `question`. ' +
            'Example: {"bundleId": "xxx", "index": true} or {"bundleId": "xxx", "question": "How to use?"}'
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

        // Find bundle path
        const storageDir = await findBundleStorageDir(cfg.storageDirs, bundleId);
        if (!storageDir) {
          throw new Error(`Bundle not found: ${bundleId}`);
        }
        const paths = getBundlePaths(storageDir, bundleId);
        const bundlePath = paths.rootDir;

        // Get RAG engine
        const { engine, embeddingEndpoint } = await getOrCreateEngine(bundleId, cfg);

        let indexResult: {
          chunksWritten: number;
          entitiesCount?: number;
          relationsCount?: number;
          durationMs: number;
          errors: string[];
        } | null = null;

        let queryResult: {
          answer: string;
          sources: Array<{
            chunkId: string;
            content: string;
            sourceType: string;
            filePath?: string;
            repoId?: string;
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
          logger.info(`Indexing bundle: ${bundleId}`);
          const result = await engine.indexBundle(bundlePath, bundleId);
          indexResult = {
            chunksWritten: result.chunksWritten,
            entitiesCount: result.entitiesCount,
            relationsCount: result.relationsCount,
            durationMs: result.durationMs,
            errors: result.errors,
          };
          logger.info(
            `Indexed ${result.chunksWritten} chunks, ${result.entitiesCount ?? 0} entities in ${result.durationMs}ms`
          );
        }

        // Query if requested
        if (question) {
          logger.info(`Querying: "${question}" (mode: ${mode ?? 'hybrid'})`);

          // Try to load AST graph if not indexing in same call
          if (!index) {
            await engine.loadAstGraph(bundleId);
          }

          const result = await engine.query(question, {
            mode: (mode as QueryMode) ?? 'hybrid',
            topK: topK ?? 10,
            bundleId,
            repoId,
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
        textResponse += `🔧 Config: ChromaDB=${cfg.chromaUrl} | Embedding=${embeddingEndpoint}\n\n`;

        if (indexResult) {
          textResponse += `✅ Indexed bundle: ${bundleId}\n`;
          textResponse += `   Chunks: ${indexResult.chunksWritten}\n`;
          textResponse += `   Entities: ${indexResult.entitiesCount ?? 0}\n`;
          textResponse += `   Relations: ${indexResult.relationsCount ?? 0}\n`;
          textResponse += `   Duration: ${indexResult.durationMs}ms\n`;
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
            queryResult.sources.slice(0, 5).forEach((s, i) => {
              textResponse += `   ${i + 1}. [${s.sourceType}] ${s.repoId ?? s.filePath ?? s.chunkId}\n`;
            });
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
          structuredContent.indexed = true;
          structuredContent.chunksWritten = indexResult.chunksWritten;
          structuredContent.entitiesCount = indexResult.entitiesCount;
          structuredContent.relationsCount = indexResult.relationsCount;
          structuredContent.indexDurationMs = indexResult.durationMs;
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
}
