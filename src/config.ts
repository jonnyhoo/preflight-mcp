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
  storageDir?: string;
  storageDirs?: string[];
  githubToken?: string;
  // Add more as needed
}

let cachedConfigFile: ConfigFile | null = null;

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
      console.error(`[preflight] Failed to load config from ${configPath}:`, err);
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

function parseEmbeddingProvider(raw: string | undefined): EmbeddingProviderType {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'openai') return 'openai';
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

  const tmpDir = process.env.PREFLIGHT_TMP_DIR ?? path.join(os.tmpdir(), 'preflight-mcp');

  const analysisMode = parseAnalysisMode(process.env.PREFLIGHT_ANALYSIS_MODE);

  const httpEnabled = envBoolean('PREFLIGHT_HTTP_ENABLED', true);
  const httpHost = (process.env.PREFLIGHT_HTTP_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  const httpPort = envNumber('PREFLIGHT_HTTP_PORT', 37123);

  return {
    storageDir,
    storageDirs,
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
    semanticSearchEnabled: envBoolean('PREFLIGHT_SEMANTIC_SEARCH', false),
    embeddingProvider: parseEmbeddingProvider(process.env.PREFLIGHT_EMBEDDING_PROVIDER),
    ollamaHost: (process.env.PREFLIGHT_OLLAMA_HOST ?? 'http://localhost:11434').trim(),
    ollamaModel: (process.env.PREFLIGHT_OLLAMA_MODEL ?? 'nomic-embed-text').trim(),

    // OpenAI-compatible (incl Azure) embedding config
    openaiApiKey: process.env.PREFLIGHT_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
    openaiModel: (process.env.PREFLIGHT_OPENAI_MODEL ?? 'text-embedding-3-small').trim(),
    openaiBaseUrl: process.env.PREFLIGHT_OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL,
    openaiEmbeddingsUrl: process.env.PREFLIGHT_OPENAI_EMBEDDINGS_URL,
    openaiAuthMode: parseOpenAIAuthMode(process.env.PREFLIGHT_OPENAI_AUTH_MODE),

    // VLM for PDF smart analysis (optional)
    // Priority: env > config file > default
    vlmApiBase: process.env.VLM_API_BASE ?? process.env.PREFLIGHT_VLM_API_BASE ?? loadConfigFile().vlmApiBase,
    vlmApiKey: process.env.VLM_API_KEY ?? process.env.PREFLIGHT_VLM_API_KEY ?? loadConfigFile().vlmApiKey,
    vlmModel: (process.env.VLM_MODEL ?? process.env.PREFLIGHT_VLM_MODEL ?? loadConfigFile().vlmModel ?? 'qwen3-vl-plus').trim(),
    vlmEnabled: envBoolean('PREFLIGHT_VLM_ENABLED', false) || Boolean(process.env.VLM_API_KEY) || loadConfigFile().vlmEnabled || Boolean(loadConfigFile().vlmApiKey),

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
  };
}
