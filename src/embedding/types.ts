/**
 * Embedding types for semantic search (optional feature).
 * 
 * This module is part of the optional semantic search capability.
 * Enable via PREFLIGHT_SEMANTIC_SEARCH=true
 */

/**
 * Embedding vector result.
 */
export type EmbeddingVector = {
  /** The embedding vector as float array */
  vector: number[];
  /** Dimension of the vector */
  dimension: number;
};

/**
 * Embedding provider types.
 */
export type EmbeddingProvider = 'ollama' | 'openai';

export type OpenAIAuthMode = 'auto' | 'bearer' | 'api-key';

/**
 * Ollama-specific configuration.
 */
export type OllamaEmbeddingConfig = {
  provider: 'ollama';
  /** Ollama server host (default: http://localhost:11434) */
  host: string;
  /** Embedding model name (default: nomic-embed-text) */
  model: string;
  /** Keep model loaded in memory (optional) */
  keepAlive?: string;
};

/**
 * OpenAI-specific configuration.
 */
export type OpenAIEmbeddingConfig = {
  provider: 'openai';
  /** OpenAI API key (or Azure OpenAI key) */
  apiKey: string;
  /** Embedding model name (OpenAI) or deployment name (Azure) */
  model: string;
  /** API base URL (optional, for compatible endpoints) */
  baseUrl?: string;
  /** Full embeddings endpoint URL (useful for Azure deployments) */
  embeddingsUrl?: string;
  /** Convenience URL: if it contains /embeddings it's treated as embeddingsUrl, else as baseUrl */
  url?: string;
  /** Auth header mode. auto detects Azure vs standard */
  authMode?: OpenAIAuthMode;
};

/**
 * Union type for embedding configurations.
 */
export type EmbeddingConfig = OllamaEmbeddingConfig | OpenAIEmbeddingConfig;

/**
 * Document to be embedded.
 */
export type EmbeddingDocument = {
  /** Unique identifier */
  id: string;
  /** Text content to embed */
  content: string;
  /** Bundle-relative path */
  path: string;
  /** Start line (1-indexed) */
  startLine: number;
  /** End line (1-indexed, inclusive) */
  endLine: number;
  /** Document kind */
  kind: 'doc' | 'code';
  /** Repository identifier */
  repo: string;
};

/**
 * Semantic search result.
 */
export type SemanticSearchHit = {
  /** Bundle-relative path */
  path: string;
  /** Repository identifier */
  repo: string;
  /** Document kind */
  kind: 'doc' | 'code';
  /** Start line (1-indexed) */
  startLine: number;
  /** End line (1-indexed, inclusive) */
  endLine: number;
  /** Text content */
  content: string;
  /** Cosine similarity score (0-1, higher is more similar) */
  score: number;
};
