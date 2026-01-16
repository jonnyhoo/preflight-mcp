/**
 * Helpers to create embeddings from PreflightConfig.
 */

import type { PreflightConfig } from '../config.js';

import { createEmbedding, type EmbeddingConfig } from './index.js';
import type { BaseEmbedding } from './base.js';
import type { OpenAIEmbeddingConfig } from './types.js';

export type EmbeddingOverride = Partial<EmbeddingConfig> & { provider?: EmbeddingConfig['provider'] };

function normalizeOpenAIOverride(cfg: PreflightConfig, override: Partial<OpenAIEmbeddingConfig>): OpenAIEmbeddingConfig {
  const url = override.url;

  // Allow a single convenience URL: if it contains /embeddings treat it as the full embeddings endpoint.
  const inferredEmbeddingsUrl = url && /\/embeddings(\?|$)/i.test(url) ? url : undefined;
  const inferredBaseUrl = url && !inferredEmbeddingsUrl ? url : undefined;

  return {
    provider: 'openai',
    apiKey: override.apiKey ?? cfg.openaiApiKey ?? '',
    model: override.model ?? cfg.openaiModel,
    baseUrl: override.baseUrl ?? inferredBaseUrl ?? cfg.openaiBaseUrl,
    embeddingsUrl: override.embeddingsUrl ?? inferredEmbeddingsUrl ?? cfg.openaiEmbeddingsUrl,
    authMode: override.authMode ?? cfg.openaiAuthMode,
  };
}

function resolveEmbeddingConfig(cfg: PreflightConfig, override?: EmbeddingOverride): EmbeddingConfig {
  const provider = (override?.provider ?? cfg.embeddingProvider) as EmbeddingConfig['provider'];

  if (provider === 'openai') {
    return normalizeOpenAIOverride(cfg, (override ?? {}) as Partial<OpenAIEmbeddingConfig>);
  }

  // ollama (default)
  return {
    provider: 'ollama',
    host: (override as any)?.host ?? cfg.ollamaHost,
    model: (override as any)?.model ?? cfg.ollamaModel,
    keepAlive: (override as any)?.keepAlive,
  };
}

/**
 * Create an embedding provider using defaults from PreflightConfig, optionally overridden.
 */
export function createEmbeddingFromConfig(cfg: PreflightConfig, override?: EmbeddingOverride): {
  embedding: BaseEmbedding;
  embeddingConfig: EmbeddingConfig;
} {
  const embeddingConfig = resolveEmbeddingConfig(cfg, override);
  const embedding = createEmbedding(embeddingConfig);
  return { embedding, embeddingConfig };
}

export function describeEmbeddingEndpoint(embeddingConfig: EmbeddingConfig): string | undefined {
  if (embeddingConfig.provider === 'openai') {
    // If a full endpoint is provided, prefer it.
    if (embeddingConfig.embeddingsUrl) return embeddingConfig.embeddingsUrl;
    if (embeddingConfig.url) return embeddingConfig.url;
    if (embeddingConfig.baseUrl) {
      // Best-effort; OpenAIEmbedding also normalizes this internally.
      return embeddingConfig.baseUrl.replace(/\/+$/, '') + '/embeddings';
    }
  }
  return undefined;
}
