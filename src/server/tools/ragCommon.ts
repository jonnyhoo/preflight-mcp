/**
 * Shared utilities for RAG tools.
 * @module server/tools/ragCommon
 */

import type { ToolDependencies } from './types.js';
import { RAGEngine } from '../../rag/query.js';
import type { RAGConfig } from '../../rag/types.js';
import { createEmbeddingFromConfig, describeEmbeddingEndpoint } from '../../embedding/preflightEmbedding.js';
import { createModuleLogger } from '../../logging/logger.js';
import { callLLM, getLLMConfig, getVerifierLLMConfig, type LLMConfig } from '../../distill/llm-client.js';

const logger = createModuleLogger('rag-tool');

// ============================================================================
// ChromaDB Availability Check
// ============================================================================

/**
 * Check ChromaDB availability.
 */
export async function checkChromaAvailability(chromaUrl: string): Promise<{ available: boolean; error?: string }> {
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

export async function getOrCreateEngine(
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

export function getEmbeddingProvider(cfg: ToolDependencies['cfg']) {
  const { embedding } = createEmbeddingFromConfig(cfg);
  return embedding;
}

// Re-export logger for use in tool modules
export { logger };
