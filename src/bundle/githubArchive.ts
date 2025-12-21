import fs from 'node:fs/promises';
import path from 'node:path';

import AdmZip from 'adm-zip';

import { type PreflightConfig } from '../config.js';
import { logger } from '../logging/logger.js';

function nowIso(): string {
  return new Date().toISOString();
}

function githubHeaders(cfg: PreflightConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'preflight-mcp/0.1.1',
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

async function fetchJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}: ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function downloadToFile(url: string, headers: Record<string, string>, destPath: string): Promise<void> {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Download error ${res.status}: ${res.statusText}`);
  }

  // Use streaming if possible; otherwise fallback to arrayBuffer.
  const anyRes = res as any;
  const body = anyRes.body;

  await ensureDir(path.dirname(destPath));

  if (body && typeof body.pipe === 'function') {
    // Node.js stream
    const ws = (await import('node:fs')).createWriteStream(destPath);
    await new Promise<void>((resolve, reject) => {
      body.pipe(ws);
      body.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', () => resolve());
    });
    return;
  }

  // Web stream or no stream support.
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buf);
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
  await downloadToFile(zipballUrl, headers, zipPath);

  const extractDir = path.join(params.destDir, `extracted-${Date.now()}`);
  await extractZip(zipPath, extractDir);

  const repoRoot = await findSingleTopLevelDir(extractDir);

  // Best-effort cleanup: remove zip file (keep extracted for caller to consume).
  await fs.rm(zipPath, { force: true }).catch((err) => {
    logger.debug(`Failed to cleanup zip file ${zipPath} (non-critical)`, err instanceof Error ? err : undefined);
  });

  return { repoRoot, refUsed, fetchedAt: nowIso() };
}
