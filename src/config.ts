import os from 'node:os';
import path from 'node:path';

export type PreflightConfig = {
  /** Primary storage directory (first in storageDirs, used for reading). */
  storageDir: string;
  /** All storage directories for mirror backup (writes go to all available paths). */
  storageDirs: string[];
  tmpDir: string;
  githubToken?: string;
  context7ApiKey?: string;
  context7McpUrl: string;
  maxFileBytes: number;
  maxTotalBytes: number;
};

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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

  const tmpDir =
    process.env.PREFLIGHT_TMP_DIR ?? path.join(os.tmpdir(), 'preflight-mcp');

  return {
    storageDir,
    storageDirs,
    tmpDir,
    githubToken: process.env.GITHUB_TOKEN,
    context7ApiKey: process.env.CONTEXT7_API_KEY,
    context7McpUrl: process.env.CONTEXT7_MCP_URL ?? 'https://mcp.context7.com/mcp',
    maxFileBytes: envNumber('PREFLIGHT_MAX_FILE_BYTES', 512 * 1024),
    maxTotalBytes: envNumber('PREFLIGHT_MAX_TOTAL_BYTES', 50 * 1024 * 1024),
  };
}
