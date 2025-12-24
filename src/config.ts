import os from 'node:os';
import path from 'node:path';

export type AnalysisMode = 'none' | 'quick' | 'full'; // 'full' enables Phase 2 module analysis

export type AstEngine = 'wasm' | 'native';

export type PreflightConfig = {
  /** Primary storage directory (first in storageDirs, used for reading). */
  storageDir: string;
  /** All storage directories for mirror backup (writes go to all available paths). */
  storageDirs: string[];
  tmpDir: string;
  githubToken?: string;
  context7ApiKey?: string;
  context7McpUrl: string;
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

  /** Max Context7 libraries to process per bundle (default: 20). */
  maxContext7Libraries: number;
  /** Max Context7 topics per library (default: 10). */
  maxContext7Topics: number;
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
    context7ApiKey: process.env.CONTEXT7_API_KEY,
    context7McpUrl: process.env.CONTEXT7_MCP_URL ?? 'https://mcp.context7.com/mcp',
    gitCloneTimeoutMs: envNumber('PREFLIGHT_GIT_CLONE_TIMEOUT_MS', 5 * 60_000),
    maxFileBytes: envNumber('PREFLIGHT_MAX_FILE_BYTES', 512 * 1024),
    maxTotalBytes: envNumber('PREFLIGHT_MAX_TOTAL_BYTES', 50 * 1024 * 1024),
    analysisMode,

    astEngine: parseAstEngine(process.env.PREFLIGHT_AST_ENGINE),

    httpEnabled,
    httpHost,
    httpPort,

    // Tuning parameters with defaults (can be overridden via env vars)
    maxContext7Libraries: envNumber('PREFLIGHT_MAX_CONTEXT7_LIBRARIES', 20),
    maxContext7Topics: envNumber('PREFLIGHT_MAX_CONTEXT7_TOPICS', 10),
    maxFtsQueryTokens: envNumber('PREFLIGHT_MAX_FTS_QUERY_TOKENS', 12),
    maxSkippedNotes: envNumber('PREFLIGHT_MAX_SKIPPED_NOTES', 50),
    defaultMaxAgeHours: envNumber('PREFLIGHT_DEFAULT_MAX_AGE_HOURS', 24),
    maxSearchLimit: envNumber('PREFLIGHT_MAX_SEARCH_LIMIT', 200),
    defaultSearchLimit: envNumber('PREFLIGHT_DEFAULT_SEARCH_LIMIT', 30),
    inProgressLockTimeoutMs: envNumber('PREFLIGHT_IN_PROGRESS_LOCK_TIMEOUT_MS', 30 * 60_000),
  };
}
