/**
 * Repository Ingestion Module
 *
 * Handles cloning and ingesting repositories (GitHub and local).
 *
 * This module was extracted from service.ts to follow Single Responsibility Principle.
 *
 * @module bundle/repo-ingest
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { PreflightConfig } from '../config.js';
import {
  shallowClone,
  getLocalHeadSha,
  toCloneUrl,
} from './github.js';
import { downloadAndExtractGitHubArchive } from './githubArchive.js';
import { ingestRepoToBundle, type IngestedFile } from './ingest.js';
import { getBundlePaths, repoMetaPath, repoNormDir, repoRawDir } from './paths.js';
import { ensureDir, rmIfExists, statOrNull, nowIso } from './utils.js';

// ============================================================================
// Types
// ============================================================================

export type RepoIngestResult = {
  files: IngestedFile[];
  skipped: string[];
  /** Optional git HEAD sha for local repositories (if localPath is a git repo) */
  headSha?: string;
};

export type GitHubRepoIngestResult = RepoIngestResult & {
  headSha?: string;
  notes: string[];
  warnings: string[];
  source: 'git' | 'archive';
};

// ============================================================================
// Repo Metadata Writing
// ============================================================================

/**
 * Write metadata for a GitHub repository.
 */
export async function writeRepoMeta(params: {
  metaPath: string;
  repoId: string;
  cloneUrl: string;
  headSha?: string;
  fetchedAt: string;
  ingestedFiles: number;
  skipped: string[];
  source?: 'git' | 'archive';
  ref?: string;
}): Promise<void> {
  await ensureDir(path.dirname(params.metaPath));

  const obj: Record<string, unknown> = {
    repoId: params.repoId,
    cloneUrl: params.cloneUrl,
    fetchedAt: params.fetchedAt,
    ingestedFiles: params.ingestedFiles,
    skipped: params.skipped,
  };

  if (params.headSha) obj.headSha = params.headSha;
  if (params.source) obj.source = params.source;
  if (params.ref) obj.ref = params.ref;

  await fs.writeFile(params.metaPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/**
 * Write metadata for a local repository.
 */
export async function writeLocalRepoMeta(params: {
  metaPath: string;
  repoId: string;
  localPath: string;
  fetchedAt: string;
  ingestedFiles: number;
  skipped: string[];
  headSha?: string;
  ref?: string;
}): Promise<void> {
  await ensureDir(path.dirname(params.metaPath));
  const obj: Record<string, unknown> = {
    repoId: params.repoId,
    source: 'local',
    localPath: params.localPath,
    ref: params.ref,
    fetchedAt: params.fetchedAt,
    ingestedFiles: params.ingestedFiles,
    skipped: params.skipped,
  };

  if (params.headSha) obj.headSha = params.headSha;
  await fs.writeFile(params.metaPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// ============================================================================
// Local Repository Ingestion
// ============================================================================

/**
 * Ingest a local repository into a bundle.
 */
export async function ingestLocalRepo(params: {
  cfg: PreflightConfig;
  bundleId: string;
  storageDir: string;
  owner: string;
  repo: string;
  localPath: string;
  ref?: string;
}): Promise<RepoIngestResult> {
  const repoId = `${params.owner}/${params.repo}`;
  const repoRoot = path.resolve(params.localPath);

  let headSha: string | undefined;
  try {
    headSha = await getLocalHeadSha(repoRoot);
  } catch {
    // Not a git repo (or git not available) - skip sha.
  }

  const st = await fs.stat(repoRoot);
  if (!st.isDirectory()) {
    throw new Error(`Local repo path is not a directory: ${repoRoot}`);
  }

  const bundlePaths = getBundlePaths(params.storageDir, params.bundleId);
  const rawDest = repoRawDir(bundlePaths, params.owner, params.repo);
  const normDest = repoNormDir(bundlePaths, params.owner, params.repo);

  await rmIfExists(rawDest);
  await rmIfExists(normDest);
  await ensureDir(rawDest);
  await ensureDir(normDest);

  const bundleNormPrefixPosix = `repos/${params.owner}/${params.repo}/norm`;

  const ingested = await ingestRepoToBundle({
    repoId,
    repoRoot,
    rawDestRoot: rawDest,
    normDestRoot: normDest,
    bundleNormPrefixPosix,
    options: {
      maxFileBytes: params.cfg.maxFileBytes,
      maxTotalBytes: params.cfg.maxTotalBytes,
    },
  });

  const fetchedAt = nowIso();

  await writeLocalRepoMeta({
    metaPath: repoMetaPath(bundlePaths, params.owner, params.repo),
    repoId,
    localPath: repoRoot,
    ref: params.ref,
    fetchedAt,
    ingestedFiles: ingested.files.length,
    skipped: ingested.skipped,
    headSha,
  });

  return { files: ingested.files, skipped: ingested.skipped, headSha };
}

// ============================================================================
// GitHub Repository Ingestion
// ============================================================================

/**
 * Clone (or download archive) and ingest a GitHub repository.
 */
export async function cloneAndIngestGitHubRepo(params: {
  cfg: PreflightConfig;
  bundleId: string;
  storageDir: string;
  owner: string;
  repo: string;
  ref?: string;
  onProgress?: (phase: string, progress: number, message: string) => void;
}): Promise<GitHubRepoIngestResult> {
  const repoId = `${params.owner}/${params.repo}`;
  const cloneUrl = toCloneUrl({ owner: params.owner, repo: params.repo });

  const tmpBase = path.join(params.cfg.tmpDir, 'checkouts', params.bundleId, `${params.owner}__${params.repo}`);
  const tmpCheckoutGit = tmpBase;
  const tmpArchiveDir = `${tmpBase}__archive`;

  await rmIfExists(tmpCheckoutGit);
  await rmIfExists(tmpArchiveDir);

  let repoRootForIngest = tmpCheckoutGit;
  let headSha: string | undefined;
  const notes: string[] = [];
  const warnings: string[] = [];
  let source: 'git' | 'archive' = 'git';
  let fetchedAt = nowIso();
  let refUsed: string | undefined = params.ref;

  try {
    params.onProgress?.('cloning', 0, `Cloning ${repoId}...`);
    await shallowClone(cloneUrl, tmpCheckoutGit, {
      ref: params.ref,
      timeoutMs: params.cfg.gitCloneTimeoutMs,
      onProgress: (phase, percent, msg) => {
        params.onProgress?.('cloning', percent, `${repoId}: ${msg}`);
      },
    });
    headSha = await getLocalHeadSha(tmpCheckoutGit);
  } catch (err) {
    // Fallback: GitHub archive download (zipball) + extract.
    source = 'archive';
    const errMsg = err instanceof Error ? err.message : String(err);
    notes.push(`git clone failed; used GitHub archive fallback: ${errMsg}`);

    // User-facing warning: communicate the network issue clearly
    warnings.push(
      `⚠️ [${repoId}] Git clone failed (network issue), switched to ZIP download.\n` +
      `   Reason: ${errMsg.slice(0, 200)}${errMsg.length > 200 ? '...' : ''}`
    );

    params.onProgress?.('downloading', 0, `Downloading ${repoId} archive...`);

    try {
      const archive = await downloadAndExtractGitHubArchive({
        cfg: params.cfg,
        owner: params.owner,
        repo: params.repo,
        ref: params.ref,
        destDir: tmpArchiveDir,
        onProgress: (downloaded, total, msg) => {
          const percent = total ? Math.round((downloaded / total) * 100) : 0;
          params.onProgress?.('downloading', percent, `${repoId}: ${msg}`);
        },
      });

      repoRootForIngest = archive.repoRoot;
      fetchedAt = archive.fetchedAt;
      refUsed = archive.refUsed;

      // Success: ZIP download completed
      warnings.push(`✅ [${repoId}] ZIP download completed successfully as fallback.`);
    } catch (zipErr) {
      // ZIP download also failed - provide helpful error with temp path
      const zipErrMsg = zipErr instanceof Error ? zipErr.message : String(zipErr);

      // Check if partial file exists
      const partialExists = await statOrNull(tmpArchiveDir);
      const tempPathMsg = partialExists
        ? `\n   Partial files may exist in: ${tmpArchiveDir}`
        : '';

      throw new Error(
        `Both git clone and ZIP download failed for ${repoId}.\n\n` +
        `Git error: ${errMsg.slice(0, 150)}\n` +
        `ZIP error: ${zipErrMsg.slice(0, 150)}${tempPathMsg}\n\n` +
        `Suggestions:\n` +
        `1. Check your network connection\n` +
        `2. Verify the repository exists: https://github.com/${repoId}\n` +
        `3. If you have the repo locally, use 'kind: local' with 'path: /your/local/path'\n` +
        `4. If behind a proxy, configure GITHUB_TOKEN environment variable`
      );
    }
  }

  const bundlePaths = getBundlePaths(params.storageDir, params.bundleId);
  const rawDest = repoRawDir(bundlePaths, params.owner, params.repo);
  const normDest = repoNormDir(bundlePaths, params.owner, params.repo);

  await rmIfExists(rawDest);
  await rmIfExists(normDest);
  await ensureDir(rawDest);
  await ensureDir(normDest);

  const bundleNormPrefixPosix = `repos/${params.owner}/${params.repo}/norm`;

  const ingested = await ingestRepoToBundle({
    repoId,
    repoRoot: repoRootForIngest,
    rawDestRoot: rawDest,
    normDestRoot: normDest,
    bundleNormPrefixPosix,
    options: {
      maxFileBytes: params.cfg.maxFileBytes,
      maxTotalBytes: params.cfg.maxTotalBytes,
    },
  });

  await writeRepoMeta({
    metaPath: repoMetaPath(bundlePaths, params.owner, params.repo),
    repoId,
    cloneUrl,
    headSha,
    fetchedAt,
    ingestedFiles: ingested.files.length,
    skipped: ingested.skipped,
    source,
    ref: refUsed,
  });

  await rmIfExists(tmpCheckoutGit);
  await rmIfExists(tmpArchiveDir);

  return { headSha, files: ingested.files, skipped: ingested.skipped, notes, warnings, source };
}
