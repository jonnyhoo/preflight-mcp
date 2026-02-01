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

// ============================================================================
// N-Gram Hash Types (NUMEN)
// ============================================================================

/**
 * N-Gram weight configuration.
 * Based on NUMEN paper ablation study results.
 */
export type NgramWeights = {
  /** Weight for 3-gram features (default: 1.0) */
  gram3: number;
  /** Weight for 4-gram features (default: 5.0) */
  gram4: number;
  /** Weight for 5-gram features (default: 10.0) */
  gram5: number;
};

/**
 * Configuration for N-Gram hasher.
 * 
 * Based on NUMEN paper (arXiv:2601.XXXXX).
 * Generates high-dimensional sparse vectors for exact term matching.
 */
export type NgramHashConfig = {
  /** Vector dimension (default: 8192, paper uses 32768) */
  dimension?: number;
  /** N-gram weights (default: 3-gram=1, 4-gram=5, 5-gram=10) */
  weights?: Partial<NgramWeights>;
  /** Convert text to lowercase before hashing (default: true) */
  lowercase?: boolean;
  /** Preserve whitespace in n-grams (default: true per paper) */
  preserveWhitespace?: boolean;
};

/**
 * N-Gram hash vector result.
 */
export type NgramVector = {
  /** The sparse hash vector (L2 normalized) */
  vector: number[];
  /** Vector dimension */
  dimension: number;
  /** Number of non-zero elements */
  nonZeroCount: number;
  /** Sparsity ratio (nonZeroCount / dimension) */
  sparsity: number;
};

/**
 * Hybrid embedding combining dense and sparse vectors.
 */
export type HybridEmbedding = {
  /** Dense semantic embedding (e.g., OpenAI 1536-dim) */
  dense: EmbeddingVector;
  /** Sparse n-gram hash vector (e.g., 8k-dim) */
  sparse: NgramVector;
};

/**
 * Configuration for hybrid retrieval scoring.
 */
export type HybridScoringConfig = {
  /** Weight for dense similarity (default: 0.7) */
  denseWeight?: number;
  /** Weight for sparse similarity (default: 0.3) */
  sparseWeight?: number;
};
