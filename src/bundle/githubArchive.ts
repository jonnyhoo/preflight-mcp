import fs from 'node:fs/promises';
import path from 'node:path';

import AdmZip from 'adm-zip';

import { type PreflightConfig } from '../config.js';
import { logger } from '../logging/logger.js';

/** Progress callback for download operations */
export type DownloadProgressCallback = (downloadedBytes: number, totalBytes: number | undefined, message: string) => void;

function nowIso(): string {
  return new Date().toISOString();
}

function githubHeaders(cfg: PreflightConfig): Record<string, string> {
  const headers: Record<string, string> = {
'User-Agent': 'preflight-mcp/0.1.8',
    Accept: 'application/vnd.github+json',
  };
  if (cfg.githubToken) {
    headers.Authorization = `Bearer ${cfg.githubToken}`;
  }
  return headers;
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

/** Default timeout for GitHub API requests (30 seconds). */
const DEFAULT_API_TIMEOUT_MS = 30_000;

/** Default timeout for file downloads (5 minutes). */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

async function fetchJson<T>(url: string, headers: Record<string, string>, timeoutMs = DEFAULT_API_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status}: ${res.statusText}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function downloadToFile(
  url: string,
  headers: Record<string, string>,
  destPath: string,
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  onProgress?: DownloadProgressCallback
): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Download error ${res.status}: ${res.statusText}`);
    }

    // Get content length for progress reporting
    const contentLengthHeader = res.headers.get('content-length');
    const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : undefined;

    await ensureDir(path.dirname(destPath));

    // Use streaming to report progress
    const anyRes = res as any;
    const body = anyRes.body;

    if (body && typeof body[Symbol.asyncIterator] === 'function') {
      // Async iterator for progress tracking
      const fsModule = await import('node:fs');
      const ws = fsModule.createWriteStream(destPath);
      let downloadedBytes = 0;
      let lastReportTime = Date.now();
      const reportIntervalMs = 500; // Report at most every 500ms

      try {
        for await (const chunk of body) {
          ws.write(chunk);
          downloadedBytes += chunk.length;
          
          // Throttle progress reports
          const now = Date.now();
          if (onProgress && (now - lastReportTime > reportIntervalMs)) {
            lastReportTime = now;
            const percent = totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
            const msg = totalBytes
              ? `Downloaded ${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)} (${percent}%)`
              : `Downloaded ${formatBytes(downloadedBytes)}`;
            onProgress(downloadedBytes, totalBytes, msg);
          }
        }
      } finally {
        ws.end();
        await new Promise<void>((resolve) => ws.on('finish', () => resolve()));
      }
      
      // Final progress report
      if (onProgress) {
        const msg = totalBytes
          ? `Downloaded ${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)} (100%)`
          : `Downloaded ${formatBytes(downloadedBytes)}`;
        onProgress(downloadedBytes, totalBytes, msg);
      }
      return;
    }

    if (body && typeof body.pipe === 'function') {
      // Node.js stream (fallback without progress)
      const ws = (await import('node:fs')).createWriteStream(destPath);
      await new Promise<void>((resolve, reject) => {
        body.pipe(ws);
        body.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', () => resolve());
      });
      return;
    }

    // Web stream or no stream support (fallback without progress)
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(destPath, buf);
    
    if (onProgress) {
      onProgress(buf.length, buf.length, `Downloaded ${formatBytes(buf.length)}`);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Format bytes for display */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  await ensureDir(destDir);
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(destDir, true);
}

async function findSingleTopLevelDir(root: string): Promise<string> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
  if (dirs.length === 1) return dirs[0]!;
  return root;
}

export async function downloadAndExtractGitHubArchive(params: {
  cfg: PreflightConfig;
  owner: string;
  repo: string;
  ref?: string;
  destDir: string;
  onProgress?: DownloadProgressCallback;
}): Promise<{ repoRoot: string; refUsed: string; fetchedAt: string }> {
  const headers = githubHeaders(params.cfg);

  // Resolve ref if not provided.
  let refUsed = (params.ref ?? '').trim();
  if (!refUsed) {
    const repoInfo = await fetchJson<{ default_branch?: string }>(
      `https://api.github.com/repos/${params.owner}/${params.repo}`,
      headers
    );
    refUsed = repoInfo.default_branch || 'HEAD';
  }

  const zipPath = path.join(params.destDir, `github-zipball-${params.owner}-${params.repo}-${Date.now()}.zip`);

  // Use the API zipball endpoint so ref can be branch/tag/SHA (including slashes via URL-encoding).
  const zipballUrl = `https://api.github.com/repos/${params.owner}/${params.repo}/zipball/${encodeURIComponent(refUsed)}`;

  await ensureDir(params.destDir);
  await downloadToFile(zipballUrl, headers, zipPath, DEFAULT_DOWNLOAD_TIMEOUT_MS, params.onProgress);

  const extractDir = path.join(params.destDir, `extracted-${Date.now()}`);
  await extractZip(zipPath, extractDir);

  const repoRoot = await findSingleTopLevelDir(extractDir);

  // Best-effort cleanup: remove zip file (keep extracted for caller to consume).
  await fs.rm(zipPath, { force: true }).catch((err) => {
    logger.debug(`Failed to cleanup zip file ${zipPath} (non-critical)`, err instanceof Error ? err : undefined);
  });

  return { repoRoot, refUsed, fetchedAt: nowIso() };
}
