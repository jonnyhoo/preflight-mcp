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
  /** OpenAI API key */
  apiKey: string;
  /** Embedding model name (default: text-embedding-3-small) */
  model: string;
  /** API base URL (optional, for compatible endpoints) */
  baseUrl?: string;
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
  /** Line number in the file */
  lineNo: number;
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
  /** Line number */
  lineNo: number;
  /** Text content */
  content: string;
  /** Cosine similarity score (0-1, higher is more similar) */
  score: number;
};
