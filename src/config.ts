import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ============================================================================
// Config File Support
// ============================================================================

interface ConfigFile {
  vlmApiBase?: string;
  vlmApiKey?: string;
  vlmModel?: string;
  vlmEnabled?: boolean;
  llmApiBase?: string;
  llmApiKey?: string;
  llmModel?: string;
  llmEnabled?: boolean;
  // Verifier LLM for cross-validation (optional, separate from main LLM)
  verifierLlmApiBase?: string;
  verifierLlmApiKey?: string;
  verifierLlmModel?: string;
  storageDir?: string;
  storageDirs?: string[];
  githubToken?: string;
  // Embedding configuration
  embeddingEnabled?: boolean;
  embeddingProvider?: 'ollama' | 'openai';
  embeddingApiBase?: string;
  embeddingApiKey?: string;
  embeddingModel?: string;
  openaiEmbeddingsUrl?: string;
  openaiAuthMode?: 'auto' | 'bearer' | 'api-key';
  // MinerU PDF parsing configuration
  mineruApiBase?: string;
  mineruApiKey?: string;
  mineruEnabled?: boolean;
  // ChromaDB for RAG
  chromaUrl?: string;
  // PDF Chunking configuration
  pdfChunkingStrategy?: 'semantic' | 'token-based' | 'hybrid';
  pdfChunkLevel?: 1 | 2 | 3 | 4;
}

let cachedConfigFile: ConfigFile | null = null;

/** Config loading warnings/errors that LLM should be aware of */
const configWarnings: string[] = [];

/**
 * Get any warnings that occurred during config loading.
 * These should be exposed to LLM via MCP tools.
 */
export function getConfigWarnings(): string[] {
  // Trigger config load if not already done
  loadConfigFile();
  return [...configWarnings];
}

/**
 * Load config from ~/.preflight/config.json (or PREFLIGHT_CONFIG_PATH)
 */
function loadConfigFile(): ConfigFile {
  if (cachedConfigFile !== null) return cachedConfigFile;
  
  const configPaths = [
    process.env.PREFLIGHT_CONFIG_PATH,
    path.join(os.homedir(), '.preflight', 'config.json'),
    path.join(os.homedir(), '.preflight-mcp', 'config.json'),
  ].filter(Boolean) as string[];
  
  for (const configPath of configPaths) {
    try {
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf8');
        cachedConfigFile = JSON.parse(content) as ConfigFile;
        console.error(`[preflight] Loaded config from ${configPath}`);
        return cachedConfigFile;
      }
    } catch (err) {
      // Store warning for LLM visibility
      const errMsg = err instanceof Error ? err.message : String(err);
      const warning = `Config file error (${configPath}): ${errMsg}. Using defaults - some features (MinerU, VLM, LLM, Embedding) may not work.`;
      configWarnings.push(warning);
      console.error(`[preflight] ${warning}`);
    }
  }
  
  cachedConfigFile = {};
  return cachedConfigFile;
}

export type AnalysisMode = 'none' | 'quick' | 'full'; // 'full' enables Phase 2 module analysis

export type AstEngine = 'wasm' | 'native';

export type EmbeddingProviderType = 'ollama' | 'openai';


export type OpenAIAuthMode = 'auto' | 'bearer' | 'api-key';

export type LspConfig = {
  enabled: boolean;
  pythonCommand: string;
  pythonArgs: string;
  goCommand: string;
  goArgs: string;
  rustCommand: string;
  rustArgs: string;
  timeoutMs: number;
  idleMs: number;
  maxConcurrency: number;
};

export type PreflightConfig = {
  /** Primary storage directory (first in storageDirs, used for reading). */
  storageDir: string;
  /** All storage directories for mirror backup (writes go to all available paths). */
  storageDirs: string[];
  /** Directory for downloaded files (PDFs, etc.). */
  downloadsDir: string;
  tmpDir: string;

  /** LSP integration configuration. */
  lsp: LspConfig;

  githubToken?: string;
  /** Max time to allow git clone to run before failing (ms). */
  gitCloneTimeoutMs: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  /** Static analysis mode (controls whether analysis/FACTS.json is generated). */
  analysisMode: AnalysisMode;

  /** AST engine for deterministic parsing (default: wasm). */
  astEngine: AstEngine;

  /** Enable built-in REST API server (default: true). */
  httpEnabled: boolean;
  /** REST server host (default: 127.0.0.1). */
  httpHost: string;
  /** REST server port (default: 37123). */
  httpPort: number;

  // --- Limits and tuning parameters (previously hardcoded) ---

  /** Max tokens to extract for FTS query (default: 12). */
  maxFtsQueryTokens: number;
  /** Max skipped file notes to include in manifest (default: 50). */
  maxSkippedNotes: number;
  /** Default max age in hours before auto-update (default: 24). */
  defaultMaxAgeHours: number;
  /** Max search results limit (default: 200). */
  maxSearchLimit: number;
  /** Default search results limit (default: 30). */
  defaultSearchLimit: number;
  /** In-progress lock timeout in ms (default: 30 minutes). */
  inProgressLockTimeoutMs: number;

  // --- Error Handling ---

  /**
   * Enable strict error mode (default: false).
   * When true, analysis errors are thrown instead of being silently logged.
   * Useful for debugging and CI environments.
   */
  strictMode: boolean;

  // --- Analysis & Deep Analyze ---

  /** Max characters for overview summary in deep analysis (default: 800). */
  deepAnalysisMaxOverviewChars: number;
  /** Default context lines for search excerpts (default: 30). */
  defaultSearchContextLines: number;
  /** Task cleanup delay in ms after completion (default: 60000 = 1 minute). */
  taskCleanupDelayMs: number;
  /** Manifest cache TTL in ms (default: 300000 = 5 minutes). */
  manifestCacheTtlMs: number;
  /** Max manifest cache entries (default: 100). */
  manifestCacheMaxSize: number;

  // --- Semantic Search (Optional Feature) ---

  /** Enable semantic search (default: false). Requires embedding provider. */
  semanticSearchEnabled: boolean;
  /** Embedding provider: 'ollama' (local) or 'openai' (cloud). */
  embeddingProvider: EmbeddingProviderType;
  /** Ollama server host (default: http://localhost:11434). */
  ollamaHost: string;
  /** Ollama embedding model (default: nomic-embed-text). */
  ollamaModel: string;
  /** OpenAI API key (required if provider is 'openai'). */
  openaiApiKey?: string;
  /** OpenAI embedding model (default: text-embedding-3-small). */
  openaiModel: string;
  /** OpenAI API base URL (optional, for compatible endpoints). */
  openaiBaseUrl?: string;
  /** OpenAI-compatible full embeddings endpoint URL (optional, useful for Azure deployments). */
  openaiEmbeddingsUrl?: string;
  /** Auth header mode for OpenAI-compatible endpoints (auto/bearer/api-key). */
  openaiAuthMode: OpenAIAuthMode;

  // --- VLM (Vision-Language Model) for PDF analysis ---

  /** VLM API base URL (e.g., https://apis.iflow.cn/v1). */
  vlmApiBase?: string;
  /** VLM API key. */
  vlmApiKey?: string;
  /** VLM model name (default: qwen3-vl-plus). */
  vlmModel: string;
  /** Enable VLM for PDF analysis (default: false, auto-enabled if API key set). */
  vlmEnabled: boolean;

  // --- LLM (for Repo Card Distillation) ---

  /** LLM API base URL (fallback to openaiBaseUrl). */
  llmApiBase?: string;
  /** LLM API key (fallback to openaiApiKey). */
  llmApiKey?: string;
  /** LLM model name (default: gpt-4o-mini). */
  llmModel: string;
  /** Enable LLM for card generation (auto-enabled if API key set). */
  llmEnabled: boolean;

  // --- Verifier LLM (for RAG cross-validation) ---

  /** Verifier LLM API base URL (optional, falls back to llmApiBase). */
  verifierLlmApiBase?: string;
  /** Verifier LLM API key (optional, falls back to llmApiKey). */
  verifierLlmApiKey?: string;
  /** Verifier LLM model name (optional, falls back to llmModel). */
  verifierLlmModel?: string;
  /** Enable verifier LLM (auto-enabled if verifierLlmApiKey or verifierLlmModel set). */
  verifierLlmEnabled: boolean;

  // --- MinerU (PDF parsing via MinerU API) ---

  /** MinerU API base URL (default: https://mineru.net). */
  mineruApiBase: string;
  /** MinerU API key (required for MinerU parsing). */
  mineruApiKey?: string;
  /** Enable MinerU for PDF parsing (auto-enabled if API key set). */
  mineruEnabled: boolean;
  /** Timeout for MinerU API polling in milliseconds (default: 5 minutes). */
  mineruTimeoutMs: number;
  /** Polling interval for MinerU task status in milliseconds (default: 3 seconds). */
  mineruPollIntervalMs: number;

  // --- ChromaDB (RAG Vector Database) ---

  /** ChromaDB server URL for RAG (default: http://localhost:8000). */
  chromaUrl: string;
  
  // --- PDF Chunking Strategy ---
  
  /** PDF chunking strategy: 'semantic' (by headings), 'token-based' (legacy), 'hybrid' (default: semantic) */
  pdfChunkingStrategy: 'semantic' | 'token-based' | 'hybrid';
  /** Heading level to chunk at: 1=章, 2=节, 3=小节, 4=段 (default: 2) */
  pdfChunkLevel: 1 | 2 | 3 | 4;
};

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'n' || v === 'off') return false;
  return fallback;
}

function parseAstEngine(raw: string | undefined): AstEngine {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'native') return 'native';
  return 'wasm';
}

function parseAnalysisMode(raw: string | undefined): AnalysisMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'none') return 'none';
  if (v === 'quick') return 'quick';
  if (v === 'full') return 'full'; // Phase 2 module analysis
  // Back-compat: deep used to exist; treat it as full (for better analysis).
  if (v === 'deep') return 'full';
  return 'full'; // Default to full for better analysis
}

function parseEmbeddingProvider(raw: string | undefined, embeddingApiBase?: string): EmbeddingProviderType {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'openai') return 'openai';
  if (v === 'ollama') return 'ollama';
  
  // Auto-detect: if embeddingApiBase is set and not localhost, use openai provider
  if (embeddingApiBase) {
    const base = embeddingApiBase.toLowerCase();
    if (!base.includes('localhost') && !base.includes('127.0.0.1') && !base.includes('11434')) {
      return 'openai';
    }
  }
  
  return 'ollama'; // Default to local Ollama
}

function parseOpenAIAuthMode(raw: string | undefined): OpenAIAuthMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'api-key') return 'api-key';
  if (v === 'bearer') return 'bearer';
  return 'auto';
}

/**
 * Parse storage directories from environment.
 * Supports:
 * - PREFLIGHT_STORAGE_DIRS (semicolon-separated, e.g. "D:\path1;E:\path2")
 * - PREFLIGHT_STORAGE_DIR (single path, for backward compatibility)
 */
function parseStorageDirs(): string[] {
  // Multi-path takes precedence
  const multiPath = process.env.PREFLIGHT_STORAGE_DIRS;
  if (multiPath) {
    return multiPath.split(';').map((p) => p.trim()).filter((p) => p.length > 0);
  }

  // Fallback to single path
  const singlePath = process.env.PREFLIGHT_STORAGE_DIR;
  if (singlePath) {
    return [singlePath];
  }

  // Default
  return [path.join(os.homedir(), '.preflight-mcp', 'bundles')];
}

export function getConfig(): PreflightConfig {
  const storageDirs = parseStorageDirs();
  const storageDir = storageDirs[0]!; // Primary for new bundles (always at least one from default)

  // Downloads directory (for remote PDFs, etc.) - inside bundle storage area
  const downloadsDir = process.env.PREFLIGHT_DOWNLOADS_DIR ?? path.join(storageDir, 'downloads');

  const tmpDir = process.env.PREFLIGHT_TMP_DIR ?? path.join(os.tmpdir(), 'preflight-mcp');

  const analysisMode = parseAnalysisMode(process.env.PREFLIGHT_ANALYSIS_MODE);

  const httpEnabled = envBoolean('PREFLIGHT_HTTP_ENABLED', true);
  const httpHost = (process.env.PREFLIGHT_HTTP_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  const httpPort = envNumber('PREFLIGHT_HTTP_PORT', 37123);

  return {
    storageDir,
    storageDirs,
    downloadsDir,
    tmpDir,

    githubToken: process.env.GITHUB_TOKEN,
    gitCloneTimeoutMs: envNumber('PREFLIGHT_GIT_CLONE_TIMEOUT_MS', 5 * 60_000),
    maxFileBytes: envNumber('PREFLIGHT_MAX_FILE_BYTES', 512 * 1024),
    maxTotalBytes: envNumber('PREFLIGHT_MAX_TOTAL_BYTES', 50 * 1024 * 1024),
    analysisMode,

    astEngine: parseAstEngine(process.env.PREFLIGHT_AST_ENGINE),

    httpEnabled,
    httpHost,
    httpPort,

    // Tuning parameters with defaults (can be overridden via env vars)
    maxFtsQueryTokens: envNumber('PREFLIGHT_MAX_FTS_QUERY_TOKENS', 12),
    maxSkippedNotes: envNumber('PREFLIGHT_MAX_SKIPPED_NOTES', 50),
    defaultMaxAgeHours: envNumber('PREFLIGHT_DEFAULT_MAX_AGE_HOURS', 24),
    maxSearchLimit: envNumber('PREFLIGHT_MAX_SEARCH_LIMIT', 200),
    defaultSearchLimit: envNumber('PREFLIGHT_DEFAULT_SEARCH_LIMIT', 30),
    inProgressLockTimeoutMs: envNumber('PREFLIGHT_IN_PROGRESS_LOCK_TIMEOUT_MS', 30 * 60_000),

    // Error handling
    strictMode: envBoolean('PREFLIGHT_STRICT_MODE', false),

    // Analysis & Deep Analyze
    deepAnalysisMaxOverviewChars: envNumber('PREFLIGHT_DEEP_ANALYSIS_MAX_OVERVIEW_CHARS', 800),
    defaultSearchContextLines: envNumber('PREFLIGHT_DEFAULT_SEARCH_CONTEXT_LINES', 30),
    taskCleanupDelayMs: envNumber('PREFLIGHT_TASK_CLEANUP_DELAY_MS', 60_000),
    manifestCacheTtlMs: envNumber('PREFLIGHT_MANIFEST_CACHE_TTL_MS', 5 * 60_000),
    manifestCacheMaxSize: envNumber('PREFLIGHT_MANIFEST_CACHE_MAX_SIZE', 100),

    // Semantic search (optional, disabled by default)
    // Priority: config file > env > default
    semanticSearchEnabled: loadConfigFile().embeddingEnabled || Boolean(loadConfigFile().embeddingApiKey) || envBoolean('PREFLIGHT_SEMANTIC_SEARCH', false),
    embeddingProvider: parseEmbeddingProvider(loadConfigFile().embeddingProvider ?? process.env.PREFLIGHT_EMBEDDING_PROVIDER, loadConfigFile().embeddingApiBase ?? process.env.PREFLIGHT_OLLAMA_HOST),
    ollamaHost: (loadConfigFile().embeddingApiBase ?? process.env.PREFLIGHT_OLLAMA_HOST ?? 'http://localhost:11434').trim(),
    ollamaModel: (loadConfigFile().embeddingModel ?? process.env.PREFLIGHT_OLLAMA_MODEL ?? 'nomic-embed-text').trim(),

    // OpenAI-compatible (incl Azure) embedding config
    // Priority: config file > env > default
    openaiApiKey: loadConfigFile().embeddingApiKey ?? process.env.PREFLIGHT_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
    openaiModel: (loadConfigFile().embeddingModel ?? process.env.PREFLIGHT_OPENAI_MODEL ?? 'text-embedding-3-small').trim(),
    openaiBaseUrl: loadConfigFile().embeddingApiBase ?? process.env.PREFLIGHT_OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL,
    openaiEmbeddingsUrl: loadConfigFile().openaiEmbeddingsUrl ?? process.env.PREFLIGHT_OPENAI_EMBEDDINGS_URL,
    openaiAuthMode: parseOpenAIAuthMode(loadConfigFile().openaiAuthMode ?? process.env.PREFLIGHT_OPENAI_AUTH_MODE),

    // VLM for PDF smart analysis (optional)
    // Priority: config file > env > default
    vlmApiBase: loadConfigFile().vlmApiBase ?? process.env.VLM_API_BASE ?? process.env.PREFLIGHT_VLM_API_BASE,
    vlmApiKey: loadConfigFile().vlmApiKey ?? process.env.VLM_API_KEY ?? process.env.PREFLIGHT_VLM_API_KEY,
    vlmModel: (loadConfigFile().vlmModel ?? process.env.VLM_MODEL ?? process.env.PREFLIGHT_VLM_MODEL ?? 'qwen3-vl-plus').trim(),
    vlmEnabled: loadConfigFile().vlmEnabled || Boolean(loadConfigFile().vlmApiKey) || envBoolean('PREFLIGHT_VLM_ENABLED', false) || Boolean(process.env.VLM_API_KEY),

    // LSP integration (optional, disabled by default)
    lsp: {
      enabled: envBoolean('PREFLIGHT_LSP_ENABLED', false),
      pythonCommand: (process.env.PREFLIGHT_LSP_PYTHON_COMMAND ?? 'pyright-langserver').trim(),
      pythonArgs: (process.env.PREFLIGHT_LSP_PYTHON_ARGS ?? '--stdio').trim(),
      goCommand: (process.env.PREFLIGHT_LSP_GO_COMMAND ?? 'gopls').trim(),
      goArgs: (process.env.PREFLIGHT_LSP_GO_ARGS ?? 'serve').trim(),
      rustCommand: (process.env.PREFLIGHT_LSP_RUST_COMMAND ?? 'rust-analyzer').trim(),
      rustArgs: (process.env.PREFLIGHT_LSP_RUST_ARGS ?? '').trim(),
      timeoutMs: envNumber('PREFLIGHT_LSP_TIMEOUT_MS', 8000),
      idleMs: envNumber('PREFLIGHT_LSP_IDLE_MS', 300000),
      maxConcurrency: envNumber('PREFLIGHT_LSP_MAX_CONCURRENCY', 6),
    },

    // LLM for Repo Card Distillation (fallback to OpenAI config)
    // Priority: config file > env > default
    llmApiBase: loadConfigFile().llmApiBase ?? process.env.PREFLIGHT_LLM_API_BASE ?? process.env.PREFLIGHT_OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL,
    llmApiKey: loadConfigFile().llmApiKey ?? process.env.PREFLIGHT_LLM_API_KEY ?? process.env.PREFLIGHT_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
    llmModel: (loadConfigFile().llmModel ?? process.env.PREFLIGHT_LLM_MODEL ?? 'gpt-4o-mini').trim(),
    llmEnabled: loadConfigFile().llmEnabled || Boolean(loadConfigFile().llmApiKey) || envBoolean('PREFLIGHT_LLM_ENABLED', false) || Boolean(process.env.PREFLIGHT_LLM_API_KEY) || Boolean(process.env.PREFLIGHT_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY),

    // Verifier LLM for RAG cross-validation (optional, falls back to main LLM)
    // Priority: config file > env > fallback to main LLM
    verifierLlmApiBase: loadConfigFile().verifierLlmApiBase ?? process.env.PREFLIGHT_VERIFIER_LLM_API_BASE,
    verifierLlmApiKey: loadConfigFile().verifierLlmApiKey ?? process.env.PREFLIGHT_VERIFIER_LLM_API_KEY,
    verifierLlmModel: loadConfigFile().verifierLlmModel ?? process.env.PREFLIGHT_VERIFIER_LLM_MODEL,
    verifierLlmEnabled: Boolean(loadConfigFile().verifierLlmApiKey) || Boolean(loadConfigFile().verifierLlmModel) || Boolean(process.env.PREFLIGHT_VERIFIER_LLM_API_KEY) || Boolean(process.env.PREFLIGHT_VERIFIER_LLM_MODEL),

    // MinerU for PDF parsing (high-quality extraction)
    // Priority: config file > env > default
    mineruApiBase: (loadConfigFile().mineruApiBase ?? process.env.PREFLIGHT_MINERU_API_BASE ?? process.env.MINERU_API_BASE ?? 'https://mineru.net').trim(),
    mineruApiKey: loadConfigFile().mineruApiKey ?? process.env.PREFLIGHT_MINERU_API_KEY ?? process.env.MINERU_API_KEY,
    mineruEnabled: loadConfigFile().mineruEnabled || Boolean(loadConfigFile().mineruApiKey) || envBoolean('PREFLIGHT_MINERU_ENABLED', false) || Boolean(process.env.PREFLIGHT_MINERU_API_KEY ?? process.env.MINERU_API_KEY),
    mineruTimeoutMs: envNumber('PREFLIGHT_MINERU_TIMEOUT_MS', 5 * 60_000),
    mineruPollIntervalMs: envNumber('PREFLIGHT_MINERU_POLL_INTERVAL_MS', 3000),

    // ChromaDB for RAG
    // Priority: config file > env > default
    chromaUrl: (loadConfigFile().chromaUrl ?? process.env.PREFLIGHT_CHROMA_URL ?? 'http://localhost:8000').trim(),
    
    // PDF Chunking Strategy
    // Priority: config file > env > default
    pdfChunkingStrategy: loadConfigFile().pdfChunkingStrategy ?? (process.env.PREFLIGHT_PDF_CHUNK_STRATEGY as 'semantic' | 'token-based' | 'hybrid' | undefined) ?? 'semantic',
    pdfChunkLevel: loadConfigFile().pdfChunkLevel ?? (parseInt(process.env.PREFLIGHT_PDF_CHUNK_LEVEL ?? '2', 10) as 1 | 2 | 3 | 4),
  };
}
