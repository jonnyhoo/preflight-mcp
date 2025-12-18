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
import { autoDetectTags, generateDisplayName, generateDescription } from './tagging.js';

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

/**
 * Validate bundle completeness after creation.
 * Ensures all critical files exist and have meaningful content.
 */
async function validateBundleCompleteness(bundleRoot: string): Promise<{
  isValid: boolean;
  missingComponents: string[];
}> {
  const requiredFiles = [
    'manifest.json',
    'START_HERE.md',
    'AGENTS.md',
    'OVERVIEW.md',
  ];

  const missingComponents: string[] = [];

  // Check required files
  for (const file of requiredFiles) {
    const filePath = path.join(bundleRoot, file);
    try {
      const stats = await fs.stat(filePath);
      // Check if file has meaningful content (not empty)
      if (stats.size === 0) {
        missingComponents.push(`${file} (empty)`);
      } else if (file === 'manifest.json' && stats.size < 50) {
        // Manifest should be at least 50 bytes
        missingComponents.push(`${file} (too small, likely incomplete)`);
      }
    } catch {
      missingComponents.push(`${file} (missing)`);
    }
  }

  // Check if search index exists
  const indexPath = path.join(bundleRoot, 'indexes', 'search.sqlite3');
  try {
    const stats = await fs.stat(indexPath);
    if (stats.size === 0) {
      missingComponents.push('indexes/search.sqlite3 (empty)');
    }
  } catch {
    missingComponents.push('indexes/search.sqlite3 (missing)');
  }

  // Check if at least one repo was ingested
  const reposDir = path.join(bundleRoot, 'repos');
  try {
    const repoEntries = await fs.readdir(reposDir);
    const hasRepos = repoEntries.length > 0;
    if (!hasRepos) {
      missingComponents.push('repos/ (empty - no repositories ingested)');
    } else {
      // Check if repos have actual content
      let hasContent = false;
      for (const entry of repoEntries) {
        const entryPath = path.join(reposDir, entry);
        const stat = await fs.stat(entryPath);
        if (stat.isDirectory()) {
          const subEntries = await fs.readdir(entryPath);
          if (subEntries.length > 0) {
            hasContent = true;
            break;
          }
        }
      }
      if (!hasContent) {
        missingComponents.push('repos/ (no actual content)');
      }
    }
  } catch {
    missingComponents.push('repos/ (missing)');
  }

  return {
    isValid: missingComponents.length === 0,
    missingComponents,
  };
}

/**
 * Detect primary language from ingested files
 */
function detectPrimaryLanguage(files: IngestedFile[]): string | undefined {
  const extToLang: Record<string, string> = {
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript',
    '.py': 'Python',
    '.go': 'Go',
    '.rs': 'Rust',
    '.java': 'Java',
    '.rb': 'Ruby',
    '.php': 'PHP',
  };

  const langCounts = new Map<string, number>();
  for (const file of files) {
    if (file.kind !== 'code') continue;
    const ext = path.extname(file.repoRelativePath).toLowerCase();
    const lang = extToLang[ext];
    if (lang) {
      langCounts.set(lang, (langCounts.get(lang) || 0) + 1);
    }
  }

  if (langCounts.size === 0) return undefined;

  // Return the most common language
  let maxLang: string | undefined;
  let maxCount = 0;
  for (const [lang, count] of langCounts) {
    if (count > maxCount) {
      maxCount = count;
      maxLang = lang;
    }
  }
  return maxLang;
}

/**
 * Clean up failed bundle creation from all storage directories.
 */
async function cleanupFailedBundle(cfg: PreflightConfig, bundleId: string): Promise<void> {
  logger.warn(`Cleaning up failed bundle: ${bundleId}`);

  // Clean from all storage directories
  for (const storageDir of cfg.storageDirs) {
    const bundlePath = path.join(storageDir, bundleId);
    try {
      const exists = await isPathAvailable(bundlePath);
      if (exists) {
        await rmIfExists(bundlePath);
        logger.info(`Removed failed bundle from: ${storageDir}`);
      }
    } catch (err) {
      logger.error(`Failed to cleanup bundle from ${storageDir}`, err instanceof Error ? err : undefined);
    }
  }

  // Also clean up temp directory
  const tmpCheckout = path.join(cfg.tmpDir, 'checkouts', bundleId);
  try {
    await rmIfExists(tmpCheckout);
  } catch {
    // Ignore cleanup errors
  }
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

function groupFilesByRepoId(files: IngestedFile[]): Array<{ repoId: string; files: IngestedFile[] }> {
  const byRepo = new Map<string, IngestedFile[]>();
  for (const f of files) {
    const arr = byRepo.get(f.repoId);
    if (arr) {
      arr.push(f);
    } else {
      byRepo.set(f.repoId, [f]);
    }
  }
  return Array.from(byRepo.entries()).map(([repoId, repoFiles]) => ({ repoId, files: repoFiles }));
}

async function generateFactsBestEffort(params: {
  bundleId: string;
  bundleRoot: string;
  files: IngestedFile[];
  mode: AnalysisMode;
}): Promise<void> {
  if (params.mode === 'none') return;

  try {
    const repos = groupFilesByRepoId(params.files);
    const result = await analyzeBundleStatic({
      bundleId: params.bundleId,
      bundleRoot: params.bundleRoot,
      repos,
      mode: params.mode,
    });

    if (result.error) {
      logger.warn('Static analysis error', { error: result.error });
    }
  } catch (err) {
    logger.error('Static analysis exception', err instanceof Error ? err : undefined);
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

  let bundleCreated = false;

  const allIngestedFiles: IngestedFile[] = [];
  const reposSummary: BundleSummary['repos'] = [];

  try {
    bundleCreated = true; // Mark that bundle directory was created

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

    // Auto-generate metadata (displayName, tags, description)
    const repoIds = reposSummary.map((r) => r.id);
    const displayName = generateDisplayName(repoIds);
    const tags = autoDetectTags({
      repoIds,
      files: allIngestedFiles,
      facts: undefined, // Will be populated later if analysis runs
    });
    const description = generateDescription({
      repoIds,
      tags,
      facts: undefined,
    });
    const primaryLanguage = allIngestedFiles.length > 0 ? detectPrimaryLanguage(allIngestedFiles) : undefined;

    const manifest: BundleManifestV1 = {
      schemaVersion: 1,
      bundleId,
      createdAt,
      updatedAt: createdAt,
      displayName,
      description,
      tags,
      primaryLanguage,
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

    // Generate static facts (FACTS.json). This is intentionally non-LLM and safe to keep inside bundles.
    await generateFactsBestEffort({
      bundleId,
      bundleRoot: paths.rootDir,
      files: allIngestedFiles,
      mode: cfg.analysisMode,
    });

  // Mirror to backup storage directories (non-blocking on failures)
  if (cfg.storageDirs.length > 1) {
    await mirrorBundleToBackups(effectiveStorageDir, cfg.storageDirs, bundleId);
  }

    // CRITICAL: Validate bundle completeness before finalizing
    const validation = await validateBundleCompleteness(paths.rootDir);

    if (!validation.isValid) {
      const errorMsg = `Bundle creation incomplete. Missing: ${validation.missingComponents.join(', ')}`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    const summary = {
      bundleId,
      createdAt,
      updatedAt: createdAt,
      repos: reposSummary,
      libraries: librariesSummary,
    };

    return summary;

  } catch (err) {
    // If bundle directory was created, clean it up
    if (bundleCreated) {
      logger.error(`Bundle creation failed, cleaning up: ${bundleId}`, err instanceof Error ? err : undefined);
      await cleanupFailedBundle(cfg, bundleId);
    }

    // Enhance error message
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create bundle: ${errorMsg}`);
  }
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

  // Refresh static facts (FACTS.json) after update.
  await generateFactsBestEffort({
    bundleId,
    bundleRoot: paths.rootDir,
    files: allIngestedFiles,
    mode: cfg.analysisMode,
  });

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
