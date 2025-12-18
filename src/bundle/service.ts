import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { type PreflightConfig } from '../config.js';
import { logger } from '../logging/logger.js';
import {
  getLocalHeadSha,
  getRemoteHeadSha,
  parseOwnerRepo,
  shallowClone,
  toCloneUrl,
} from './github.js';
import { ingestRepoToBundle, type IngestedFile } from './ingest.js';
import { type RepoInput, type BundleManifestV1, writeManifest, readManifest } from './manifest.js';
import { getBundlePaths, repoMetaPath, repoNormDir, repoRawDir, repoRootDir } from './paths.js';
import { writeAgentsMd, writeStartHereMd } from './guides.js';
import { generateOverviewMarkdown, writeOverviewFile } from './overview.js';
import { rebuildIndex } from '../search/sqliteFts.js';
import { ingestContext7Libraries, type Context7LibrarySummary } from './context7.js';
import { ingestDeepWikiRepo, type DeepWikiSummary } from './deepwiki.js';
import { analyzeBundleStatic, type AnalysisMode } from './analysis.js';

export type CreateBundleInput = {
  repos: RepoInput[];
  libraries?: string[];
  topics?: string[];
};

export type BundleSummary = {
  bundleId: string;
  createdAt: string;
  updatedAt: string;
  repos: Array<{
    kind: 'github' | 'deepwiki';
    id: string;
    headSha?: string;
    notes?: string[];
  }>;
  libraries?: Context7LibrarySummary[];
};

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

async function writeRepoMeta(params: {
  metaPath: string;
  repoId: string;
  cloneUrl: string;
  headSha: string;
  fetchedAt: string;
  ingestedFiles: number;
  skipped: string[];
}): Promise<void> {
  await ensureDir(path.dirname(params.metaPath));
  const obj = {
    repoId: params.repoId,
    cloneUrl: params.cloneUrl,
    headSha: params.headSha,
    fetchedAt: params.fetchedAt,
    ingestedFiles: params.ingestedFiles,
    skipped: params.skipped,
  };
  await fs.writeFile(params.metaPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

async function rmIfExists(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

/** Check if a path is accessible (mount exists). */
async function isPathAvailable(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Check if a path's parent directory is accessible. */
async function isParentAvailable(p: string): Promise<boolean> {
  const parent = path.dirname(p);
  return isPathAvailable(parent);
}

/** Copy directory recursively. */
async function copyDir(src: string, dest: string): Promise<void> {
  await fs.cp(src, dest, { recursive: true, force: true });
}

/**
 * Mirror a bundle to all backup storage directories.
 * Skips unavailable paths (mount disappeared) without blocking.
 * Returns list of successful/failed mirror targets.
 */
async function mirrorBundleToBackups(
  primaryDir: string,
  backupDirs: string[],
  bundleId: string
): Promise<{ mirrored: string[]; failed: Array<{ path: string; error: string }> }> {
  const srcPath = path.join(primaryDir, bundleId);
  const mirrored: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];

  for (const backupDir of backupDirs) {
    if (backupDir === primaryDir) continue; // Skip primary

    const destPath = path.join(backupDir, bundleId);

    try {
      // Check if backup location is available
      const parentAvailable = await isParentAvailable(destPath);
      if (!parentAvailable) {
        failed.push({ path: backupDir, error: 'Mount not available' });
        continue;
      }

      // Ensure backup dir exists
      await ensureDir(backupDir);

      // Remove old and copy new
      await rmIfExists(destPath);
      await copyDir(srcPath, destPath);
      mirrored.push(backupDir);
    } catch (err) {
      failed.push({ path: backupDir, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { mirrored, failed };
}

/**
 * Find the first available storage directory from the list.
 * Returns null if none are available.
 */
async function findFirstAvailableStorageDir(storageDirs: string[]): Promise<string | null> {
  for (const dir of storageDirs) {
    if (await isPathAvailable(dir)) {
      return dir;
    }
    // Also check if parent is available (mount point exists but dir not created yet)
    const parent = path.dirname(dir);
    if (await isPathAvailable(parent)) {
      return dir;
    }
  }
  return null;
}

/**
 * Get the effective storage directory for reading.
 * Falls back to first available if primary is unavailable.
 */
export async function getEffectiveStorageDir(cfg: PreflightConfig): Promise<string> {
  // Try primary first
  if (await isPathAvailable(cfg.storageDir)) {
    return cfg.storageDir;
  }

  // Fallback to first available
  const available = await findFirstAvailableStorageDir(cfg.storageDirs);
  if (available) {
    return available;
  }

  // No storage available - return primary and let caller handle the error
  return cfg.storageDir;
}

/**
 * Get the effective storage directory for writing.
 * Falls back to first available if primary is unavailable.
 * Also ensures the directory exists.
 */
export async function getEffectiveStorageDirForWrite(cfg: PreflightConfig): Promise<string> {
  // Try primary first
  const primaryParent = path.dirname(cfg.storageDir);
  if (await isPathAvailable(primaryParent)) {
    await ensureDir(cfg.storageDir);
    return cfg.storageDir;
  }

  // Fallback to first available
  for (const dir of cfg.storageDirs) {
    const parent = path.dirname(dir);
    if (await isPathAvailable(parent)) {
      await ensureDir(dir);
      return dir;
    }
  }

  // No storage available - throw error
  throw new Error('No storage directory available. All mount points are inaccessible.');
}

/**
 * Sync stale backups: copy from source to any backup that has older data.
 * Called after reading from a backup (means primary was unavailable).
 */
async function syncStaleBackups(
  sourceDir: string,
  allDirs: string[],
  bundleId: string
): Promise<void> {
  const srcManifestPath = path.join(sourceDir, bundleId, 'manifest.json');
  let srcUpdatedAt: string;
  try {
    const srcManifest = await readManifest(srcManifestPath);
    srcUpdatedAt = srcManifest.updatedAt;
  } catch {
    return; // Can't read source, skip sync
  }

  for (const dir of allDirs) {
    if (dir === sourceDir) continue;

    try {
      if (!(await isPathAvailable(dir))) continue;

      const destManifestPath = path.join(dir, bundleId, 'manifest.json');
      let needsSync = false;

      try {
        const destManifest = await readManifest(destManifestPath);
        // Sync if destination is older
        needsSync = new Date(destManifest.updatedAt) < new Date(srcUpdatedAt);
      } catch {
        // Destination doesn't exist or can't read - needs sync
        needsSync = true;
      }

      if (needsSync) {
        await ensureDir(dir);
        const srcPath = path.join(sourceDir, bundleId);
        const destPath = path.join(dir, bundleId);
        await rmIfExists(destPath);
        await copyDir(srcPath, destPath);
      }
    } catch {
      // Skip failed syncs silently
    }
  }
}

async function cloneAndIngestGitHubRepo(params: {
  cfg: PreflightConfig;
  bundleId: string;
  storageDir: string;
  owner: string;
  repo: string;
  ref?: string;
}): Promise<{ headSha: string; files: IngestedFile[]; skipped: string[] }> {
  const repoId = `${params.owner}/${params.repo}`;
  const cloneUrl = toCloneUrl({ owner: params.owner, repo: params.repo });

  const tmpCheckout = path.join(params.cfg.tmpDir, 'checkouts', params.bundleId, `${params.owner}__${params.repo}`);
  await rmIfExists(tmpCheckout);

  await shallowClone(cloneUrl, tmpCheckout, { ref: params.ref });
  const headSha = await getLocalHeadSha(tmpCheckout);

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
    repoRoot: tmpCheckout,
    rawDestRoot: rawDest,
    normDestRoot: normDest,
    bundleNormPrefixPosix,
    options: {
      maxFileBytes: params.cfg.maxFileBytes,
      maxTotalBytes: params.cfg.maxTotalBytes,
    },
  });

  const fetchedAt = nowIso();

  await writeRepoMeta({
    metaPath: repoMetaPath(bundlePaths, params.owner, params.repo),
    repoId,
    cloneUrl,
    headSha,
    fetchedAt,
    ingestedFiles: ingested.files.length,
    skipped: ingested.skipped,
  });

  await rmIfExists(tmpCheckout);

  return { headSha, files: ingested.files, skipped: ingested.skipped };
}

/**
 * Trigger bundle analysis asynchronously (non-blocking)
 */
async function triggerBundleAnalysis(params: {
  bundleId: string;
  bundleRoot: string;
  repos: Array<{ repoId: string; files: IngestedFile[] }>;
  mode: AnalysisMode;
  cfg: PreflightConfig;
}): Promise<void> {
  try {
    const result = await analyzeBundleStatic(params);
    if (result.error) {
      logger.warn('Analysis error', { error: result.error });
    }
  } catch (err) {
    logger.error('Analysis exception', err instanceof Error ? err : undefined);
  }
}

export async function createBundle(cfg: PreflightConfig, input: CreateBundleInput): Promise<BundleSummary> {
  const bundleId = crypto.randomUUID();
  const createdAt = nowIso();

  // Use effective storage dir (falls back if primary unavailable)
  const effectiveStorageDir = await getEffectiveStorageDirForWrite(cfg);
  await ensureDir(cfg.tmpDir);

  const paths = getBundlePaths(effectiveStorageDir, bundleId);
  await ensureDir(paths.rootDir);

  const allIngestedFiles: IngestedFile[] = [];
  const reposSummary: BundleSummary['repos'] = [];

  for (const repoInput of input.repos) {
    if (repoInput.kind === 'github') {
      const { owner, repo } = parseOwnerRepo(repoInput.repo);
      const { headSha, files, skipped } = await cloneAndIngestGitHubRepo({
        cfg,
        bundleId,
        storageDir: effectiveStorageDir,
        owner,
        repo,
        ref: repoInput.ref,
      });

      allIngestedFiles.push(...files);
      reposSummary.push({ kind: 'github', id: `${owner}/${repo}`, headSha, notes: skipped.slice(0, 50) });
    } else {
      // DeepWiki integration: fetch and convert to Markdown.
      const deepwikiResult = await ingestDeepWikiRepo({
        cfg,
        bundlePaths: paths,
        url: repoInput.url,
      });
      allIngestedFiles.push(...deepwikiResult.files);
      reposSummary.push({
        kind: 'deepwiki',
        id: deepwikiResult.summary.repoId,
        notes: deepwikiResult.summary.notes,
      });
    }
  }

  // Context7 libraries (best-effort).
  let librariesSummary: Context7LibrarySummary[] | undefined;
  if (input.libraries?.length) {
    // Clean libraries dir in case something wrote here earlier.
    await rmIfExists(paths.librariesDir);
    await ensureDir(paths.librariesDir);

    const libIngest = await ingestContext7Libraries({
      cfg,
      bundlePaths: paths,
      libraries: input.libraries,
      topics: input.topics,
    });

    allIngestedFiles.push(...libIngest.files);
    librariesSummary = libIngest.libraries;
  }

  // Build index.
  await rebuildIndex(paths.searchDbPath, allIngestedFiles, {
    includeDocs: true,
    includeCode: true,
  });

  const manifest: BundleManifestV1 = {
    schemaVersion: 1,
    bundleId,
    createdAt,
    updatedAt: createdAt,
    inputs: {
      repos: input.repos,
      libraries: input.libraries,
      topics: input.topics,
    },
    repos: reposSummary.map((r) => ({
      kind: r.kind,
      id: r.id,
      headSha: r.headSha,
      fetchedAt: createdAt,
      notes: r.notes,
    })),
    libraries: librariesSummary,
    index: {
      backend: 'sqlite-fts5-lines',
      includeDocs: true,
      includeCode: true,
    },
  };

  await writeManifest(paths.manifestPath, manifest);

  // Guides.
  await writeAgentsMd(paths.agentsPath);
  await writeStartHereMd({
    targetPath: paths.startHerePath,
    bundleId,
    repos: reposSummary.map((r) => ({ id: r.id, headSha: r.headSha })),
    libraries: librariesSummary,
  });

  // Overview (S2: factual-only with evidence pointers).
  const perRepoOverviews = reposSummary
    .filter((r) => r.kind === 'github')
    .map((r) => {
      const repoId = r.id;
      const repoFiles = allIngestedFiles.filter((f) => f.repoId === repoId);
      return { repoId, headSha: r.headSha, files: repoFiles };
    });

  const overviewMd = await generateOverviewMarkdown({
    bundleId,
    bundleRootDir: paths.rootDir,
    repos: perRepoOverviews,
    libraries: librariesSummary,
  });
  await writeOverviewFile(paths.overviewPath, overviewMd);

  // Mirror to backup storage directories (non-blocking on failures)
  if (cfg.storageDirs.length > 1) {
    await mirrorBundleToBackups(effectiveStorageDir, cfg.storageDirs, bundleId);
  }

  const summary = {
    bundleId,
    createdAt,
    updatedAt: createdAt,
    repos: reposSummary,
    libraries: librariesSummary,
  };

  // Trigger async analysis (non-blocking)
  const analysisMode = cfg.analysisMode;
  if (analysisMode !== 'none') {
    triggerBundleAnalysis({
      bundleId,
      bundleRoot: paths.rootDir,
      repos: perRepoOverviews,
      mode: analysisMode,
      cfg,
    }).catch((err) => {
      logger.error(`Analysis failed for bundle ${bundleId}`, err instanceof Error ? err : undefined);
    });
  }

  return summary;
}

export type UpdateBundleOptions = {
  checkOnly?: boolean;
  force?: boolean;
};

/** Check if a bundle has upstream changes without applying updates. */
export async function checkForUpdates(cfg: PreflightConfig, bundleId: string): Promise<{ hasUpdates: boolean; details: Array<{ repoId: string; currentSha?: string; remoteSha?: string; changed: boolean }> }> {
  const effectiveStorageDir = await getEffectiveStorageDir(cfg);
  const paths = getBundlePaths(effectiveStorageDir, bundleId);
  const manifest = await readManifest(paths.manifestPath);

  const details: Array<{ repoId: string; currentSha?: string; remoteSha?: string; changed: boolean }> = [];
  let hasUpdates = false;

  for (const repoInput of manifest.inputs.repos) {
    if (repoInput.kind === 'github') {
      const { owner, repo } = parseOwnerRepo(repoInput.repo);
      const repoId = `${owner}/${repo}`;
      const cloneUrl = toCloneUrl({ owner, repo });

      const prev = manifest.repos.find((r) => r.kind === 'github' && r.id === repoId);
      let remoteSha: string | undefined;
      try {
        remoteSha = await getRemoteHeadSha(cloneUrl);
      } catch {
        // ignore
      }

      const changed = !!(remoteSha && prev?.headSha && remoteSha !== prev.headSha);
      if (changed) hasUpdates = true;

      details.push({ repoId, currentSha: prev?.headSha, remoteSha, changed });
    } else {
      // DeepWiki: can't easily detect changes, assume possible update
      details.push({ repoId: repoInput.url, changed: true });
      hasUpdates = true;
    }
  }

  return { hasUpdates, details };
}

export async function updateBundle(cfg: PreflightConfig, bundleId: string, options?: UpdateBundleOptions): Promise<{ summary: BundleSummary; changed: boolean }> {
  // Use effective storage dir (falls back if primary unavailable)
  const effectiveStorageDir = await getEffectiveStorageDirForWrite(cfg);
  const paths = getBundlePaths(effectiveStorageDir, bundleId);
  const manifest = await readManifest(paths.manifestPath);

  const updatedAt = nowIso();

  let changed = false;
  const allIngestedFiles: IngestedFile[] = [];
  const reposSummary: BundleSummary['repos'] = [];

  // Rebuild everything obvious for now (simple + deterministic).
  for (const repoInput of manifest.inputs.repos) {
    if (repoInput.kind === 'github') {
      const { owner, repo } = parseOwnerRepo(repoInput.repo);
      const repoId = `${owner}/${repo}`;
      const cloneUrl = toCloneUrl({ owner, repo });

      let remoteSha: string | undefined;
      try {
        remoteSha = await getRemoteHeadSha(cloneUrl);
      } catch {
        // ignore remote check errors; proceed to clone anyway.
      }

      const prev = manifest.repos.find((r) => r.kind === 'github' && r.id === repoId);
      if (remoteSha && prev?.headSha && remoteSha !== prev.headSha) {
        changed = true;
      }

      const { headSha, files, skipped } = await cloneAndIngestGitHubRepo({
        cfg,
        bundleId,
        storageDir: effectiveStorageDir,
        owner,
        repo,
        ref: repoInput.ref,
      });

      if (prev?.headSha && headSha !== prev.headSha) {
        changed = true;
      }

      allIngestedFiles.push(...files);
      reposSummary.push({ kind: 'github', id: repoId, headSha, notes: skipped.slice(0, 50) });
    } else {
      // DeepWiki integration: fetch and convert to Markdown.
      const deepwikiResult = await ingestDeepWikiRepo({
        cfg,
        bundlePaths: paths,
        url: repoInput.url,
      });
      allIngestedFiles.push(...deepwikiResult.files);
      reposSummary.push({
        kind: 'deepwiki',
        id: deepwikiResult.summary.repoId,
        notes: deepwikiResult.summary.notes,
      });
      // Always mark as changed for DeepWiki since we can't easily detect content changes.
      changed = true;
    }
  }

  // Context7 libraries (best-effort).
  let librariesSummary: Context7LibrarySummary[] | undefined;
  if (manifest.inputs.libraries?.length) {
    await rmIfExists(paths.librariesDir);
    await ensureDir(paths.librariesDir);

    const libIngest = await ingestContext7Libraries({
      cfg,
      bundlePaths: paths,
      libraries: manifest.inputs.libraries,
      topics: manifest.inputs.topics,
    });

    allIngestedFiles.push(...libIngest.files);
    librariesSummary = libIngest.libraries;
  }

  // Rebuild index.
  await rebuildIndex(paths.searchDbPath, allIngestedFiles, {
    includeDocs: manifest.index.includeDocs,
    includeCode: manifest.index.includeCode,
  });

  const newManifest: BundleManifestV1 = {
    ...manifest,
    updatedAt,
    repos: reposSummary.map((r) => ({
      kind: r.kind,
      id: r.id,
      headSha: r.headSha,
      fetchedAt: updatedAt,
      notes: r.notes,
    })),
    libraries: librariesSummary,
  };

  await writeManifest(paths.manifestPath, newManifest);

  // Regenerate guides + overview.
  await writeAgentsMd(paths.agentsPath);
  await writeStartHereMd({
    targetPath: paths.startHerePath,
    bundleId,
    repos: reposSummary.map((r) => ({ id: r.id, headSha: r.headSha })),
    libraries: librariesSummary,
  });

  const perRepoOverviews = reposSummary
    .filter((r) => r.kind === 'github')
    .map((r) => {
      const repoId = r.id;
      const repoFiles = allIngestedFiles.filter((f) => f.repoId === repoId);
      return { repoId, headSha: r.headSha, files: repoFiles };
    });

  const overviewMd = await generateOverviewMarkdown({
    bundleId,
    bundleRootDir: paths.rootDir,
    repos: perRepoOverviews,
    libraries: librariesSummary,
  });
  await writeOverviewFile(paths.overviewPath, overviewMd);

  // Mirror to backup storage directories (non-blocking on failures)
  if (cfg.storageDirs.length > 1) {
    await mirrorBundleToBackups(effectiveStorageDir, cfg.storageDirs, bundleId);
  }

  const summary: BundleSummary = {
    bundleId,
    createdAt: manifest.createdAt,
    updatedAt,
    repos: reposSummary,
    libraries: librariesSummary,
  };

  return { summary, changed };
}

/** List bundles from a single storage directory. */
export async function listBundles(storageDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(storageDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** List bundles from multiple storage directories (deduped). */
export async function listBundlesMulti(storageDirs: string[]): Promise<string[]> {
  const all = await Promise.all(storageDirs.map((d) => listBundles(d)));
  return [...new Set(all.flat())];
}

/** Check if bundle exists in a single storage directory. */
export async function bundleExists(storageDir: string, bundleId: string): Promise<boolean> {
  const paths = getBundlePaths(storageDir, bundleId);
  try {
    await fs.stat(paths.manifestPath);
    return true;
  } catch {
    return false;
  }
}

/** Find which storage directory contains the bundle (returns null if not found). */
export async function findBundleStorageDir(storageDirs: string[], bundleId: string): Promise<string | null> {
  for (const dir of storageDirs) {
    if (await bundleExists(dir, bundleId)) {
      return dir;
    }
  }
  return null;
}

/** Check if bundle exists in any of the storage directories. */
export async function bundleExistsMulti(storageDirs: string[], bundleId: string): Promise<boolean> {
  return (await findBundleStorageDir(storageDirs, bundleId)) !== null;
}

export async function getBundleRoot(storageDir: string, bundleId: string): Promise<string> {
  const paths = getBundlePaths(storageDir, bundleId);
  return paths.rootDir;
}

export function getBundlePathsForId(storageDir: string, bundleId: string) {
  return getBundlePaths(storageDir, bundleId);
}

export async function clearBundle(storageDir: string, bundleId: string): Promise<void> {
  const p = getBundlePaths(storageDir, bundleId);
  await rmIfExists(p.rootDir);
}

/** Clear bundle from ALL storage directories (mirror delete). */
export async function clearBundleMulti(storageDirs: string[], bundleId: string): Promise<boolean> {
  let deleted = false;
  for (const dir of storageDirs) {
    try {
      if (await bundleExists(dir, bundleId)) {
        await clearBundle(dir, bundleId);
        deleted = true;
      }
    } catch {
      // Skip unavailable paths
    }
  }
  return deleted;
}

export async function ensureRepoDirRemoved(storageDir: string, bundleId: string, owner: string, repo: string): Promise<void> {
  const p = getBundlePaths(storageDir, bundleId);
  await rmIfExists(repoRootDir(p, owner, repo));
}
