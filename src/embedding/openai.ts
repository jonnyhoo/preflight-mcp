/**
 * OpenAI embedding implementation for semantic search (optional feature).
 *
 * Supports OpenAI-compatible endpoints, including Azure OpenAI deployments.
 */

import type { EmbeddingVector, OpenAIEmbeddingConfig, OpenAIAuthMode } from './types.js';
import { BaseEmbedding } from './base.js';

// Known OpenAI embedding model dimensions
const MODEL_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

function trimTrailingSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

function looksLikeEmbeddingsUrl(u: string): boolean {
  return /\/embeddings(\?|$)/i.test(u);
}

function isAzureHost(u: string): boolean {
  try {
    const host = new URL(u).host;
    return /\.openai\.azure\.com$/i.test(host);
  } catch {
    return false;
  }
}

function isAzureDeploymentUrl(u: string): boolean {
  return /\/openai\/deployments\//i.test(u);
}

function resolveEmbeddingsUrl(cfg: OpenAIEmbeddingConfig): string {
  const url = (cfg.url ?? '').trim();
  const embeddingsUrl = (cfg.embeddingsUrl ?? '').trim();

  if (embeddingsUrl) return embeddingsUrl;

  if (url) {
    if (looksLikeEmbeddingsUrl(url)) return url;
    return `${trimTrailingSlash(url)}/embeddings`;
  }

  const baseUrl = (cfg.baseUrl ?? 'https://api.openai.com/v1').trim();
  return `${trimTrailingSlash(baseUrl)}/embeddings`;
}

function isOpenRouterHost(u: string): boolean {
  try {
    const host = new URL(u).host;
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

function buildAuthHeaders(params: { apiKey: string; authMode: OpenAIAuthMode; url: string }): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const azure = isAzureHost(params.url) || isAzureDeploymentUrl(params.url);

  if (params.authMode === 'api-key' || (params.authMode === 'auto' && azure)) {
    headers['api-key'] = params.apiKey;
  } else {
    headers['Authorization'] = `Bearer ${params.apiKey}`;
  }

  // OpenRouter-specific headers (required for embeddings)
  if (isOpenRouterHost(params.url)) {
    headers['HTTP-Referer'] = 'https://github.com/jonnyhoo/preflight-mcp';
    headers['X-Title'] = 'preflight-mcp';
  }

  return headers;
}

async function postEmbeddings(params: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}): Promise<{ vectors: number[][] }> {
  // Build a sequence of fallback request bodies to maximize provider compatibility.
  const tryBodies: Array<Record<string, unknown>> = [];

  const original = params.body as Record<string, unknown>;
  const withoutEncoding = (() => { const { encoding_format: _enc, ...rest } = original as any; return rest; })();
  const withoutTruncate = (() => { const { truncate: _tr, ...rest } = original as any; return rest; })();
  const withoutBoth = (() => { const { encoding_format: _enc, truncate: _tr, ...rest } = original as any; return rest; })();

  // Preferred order: original -> no encoding_format -> no truncate -> no both
  tryBodies.push(original);
  // Avoid pushing duplicates
  const pushUnique = (b: Record<string, unknown>) => {
    if (JSON.stringify(b) !== JSON.stringify(tryBodies[tryBodies.length - 1])) {
      tryBodies.push(b);
    }
  };
  pushUnique(withoutEncoding);
  pushUnique(withoutTruncate);
  pushUnique(withoutBoth);

  let lastErr: Error | null = null;
  for (const body of tryBodies) {
    try {
      const response = await fetch(params.url, {
        method: 'POST',
        headers: params.headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        lastErr = new Error(`Embeddings request failed: ${response.status} ${errorText}`);
        continue;
      }

      const data = (await response.json()) as {
        data?: Array<{ embedding?: number[]; index?: number }>;
      };

      const rows = Array.isArray(data.data) ? data.data : [];
      if (rows.length === 0) {
        // Treat empty data as a non-fatal attempt; try next fallback body.
        lastErr = new Error('Embeddings response missing data');
        continue;
      }

      // Sort by index to ensure stable order.
      const sorted = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const vectors: number[][] = [];
      for (const r of sorted) {
        if (!r.embedding || !Array.isArray(r.embedding)) {
          lastErr = new Error('Embeddings response missing embedding vector');
          // Try next fallback
          continue;
        }
        vectors.push(r.embedding);
      }

      if (vectors.length === 0) {
        lastErr = new Error('Embeddings response contained no vectors');
        continue;
      }

      return { vectors };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastErr ?? new Error('Embeddings request failed');
}

/**
 * OpenAI embedding provider.
 */
export class OpenAIEmbedding extends BaseEmbedding {
  private dimension: number;
  private apiKey: string;
  private model: string;
  private embeddingsUrl: string;
  private authMode: OpenAIAuthMode;
  private omitModelByDefault: boolean;

  constructor(config: OpenAIEmbeddingConfig) {
    super(config);

    this.apiKey = config.apiKey;
    this.model = config.model || 'text-embedding-3-small';

    this.embeddingsUrl = resolveEmbeddingsUrl(config);
    this.authMode = config.authMode ?? 'auto';

    // Azure deployment endpoints usually encode the model/deployment in the URL.
    this.omitModelByDefault = isAzureDeploymentUrl(this.embeddingsUrl);

    this.dimension = MODEL_DIMENSIONS[this.model] || 1536;
  }

  /**
   * Generate embedding for single text.
   */
  async embed(text: string): Promise<EmbeddingVector> {
    const processedText = this.preprocessText(text);

    const headers = buildAuthHeaders({ apiKey: this.apiKey, authMode: this.authMode, url: this.embeddingsUrl });

    const baseBody: Record<string, unknown> = {
      input: processedText,
      encoding_format: 'float',
      // NVIDIA NIM requires truncate parameter
      truncate: 'NONE',
    };

    const withModelBody = { ...baseBody, model: this.model };
    const body = this.omitModelByDefault ? baseBody : withModelBody;

    // Try default body first; if Azure endpoint requires model, retry with model.
    try {
      const { vectors } = await postEmbeddings({ url: this.embeddingsUrl, headers, body });
      const v = vectors[0] ?? [];
      this.dimension = v.length;
      return { vector: v, dimension: v.length };
    } catch (err) {
      if (this.omitModelByDefault) {
        const { vectors } = await postEmbeddings({ url: this.embeddingsUrl, headers, body: withModelBody });
        const v = vectors[0] ?? [];
        this.dimension = v.length;
        return { vector: v, dimension: v.length };
      }
      throw err;
    }
  }

  /**
   * Generate embeddings for multiple texts in batch.
   * Falls back to sequential processing if batch fails (some providers like NVIDIA don't support batch input).
   */
  async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
    if (texts.length === 0) return [];

    const processedTexts = this.preprocessTexts(texts);

    const headers = buildAuthHeaders({ apiKey: this.apiKey, authMode: this.authMode, url: this.embeddingsUrl });

    const baseBody: Record<string, unknown> = {
      input: processedTexts,
      encoding_format: 'float',
      // NVIDIA NIM requires truncate parameter
      truncate: 'NONE',
    };

    const withModelBody = { ...baseBody, model: this.model };
    const body = this.omitModelByDefault ? baseBody : withModelBody;

    const run = async (b: Record<string, unknown>) => {
      const { vectors } = await postEmbeddings({ url: this.embeddingsUrl, headers, body: b });
      if (vectors.length > 0) this.dimension = vectors[0]!.length;
      return vectors.map((v) => ({ vector: v, dimension: v.length }));
    };

    // Try batch first
    try {
      return await run(body);
    } catch (err) {
      if (this.omitModelByDefault) {
        try {
          return await run(withModelBody);
        } catch { /* fall through to sequential */ }
      }
      // Fallback to sequential processing (for providers like NVIDIA that don't support batch)
      console.log('[embedBatch] Batch failed, falling back to sequential processing...');
      const results: EmbeddingVector[] = [];
      for (const text of texts) {
        const result = await this.embed(text);
        results.push(result);
      }
      return results;
    }
  }

  getDimension(): number {
    return this.dimension;
  }

  getProvider(): string {
    return 'openai';
  }

  getModel(): string {
    return this.model;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.embed('ping');
      return true;
    } catch {
      return false;
    }
  }

  static getSupportedModels(): string[] {
    return Object.keys(MODEL_DIMENSIONS);
  }
}
