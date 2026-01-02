import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { type PreflightConfig } from '../config.js';
import { logger } from '../logging/logger.js';
import {
  getRemoteHeadSha,
  parseOwnerRepo,
  toCloneUrl,
} from './github.js';
import { type IngestedFile, classifyIngestedFileKind } from './ingest.js';
import { type RepoInput, type BundleManifestV1, type SkippedFileEntry, writeManifest, readManifest, invalidateManifestCache } from './manifest.js';
import { getBundlePaths } from './paths.js';
import { writeAgentsMd, writeStartHereMd } from './guides.js';
import { generateOverviewMarkdown, writeOverviewFile } from './overview.js';
import { rebuildIndex, incrementalIndexUpdate, supportsIncrementalIndex } from '../search/sqliteFts.js';
import { ingestContext7Libraries, type Context7LibrarySummary } from './context7.js';
import { autoDetectTags, generateDisplayName, generateDescription } from './tagging.js';
import { bundleCreationLimiter } from '../core/concurrency-limiter.js';
import { getProgressTracker, type TaskPhase, calcPercent } from '../jobs/progressTracker.js';
import { BundleNotFoundError } from '../errors.js';

// Import from extracted modules
import { nowIso, ensureDir, rmIfExists, copyDir, statOrNull, readUtf8OrNull, sha256Text, walkFilesNoIgnore } from './utils.js';
import {
  getEffectiveStorageDir,
  getEffectiveStorageDirForWrite,
  mirrorBundleToBackups,
} from './storage.js';
import {
  validateBundleCompleteness,
  parseSkippedString,
} from './validation.js';
import {
  detectPrimaryLanguage,
  groupFilesByRepoId,
  generateFactsBestEffort,
  scanBundleIndexableFiles as scanBundleIndexableFilesHelper,
} from './analysis-helpers.js';
import {
  clearBundle,
  clearBundleMulti,
  ensureRepoDirRemoved,
} from './cleanup.js';
import {
  ingestLocalRepo,
  cloneAndIngestGitHubRepo,
} from './repo-ingest.js';
import {
  computeCreateInputFingerprint,
  updateDedupIndexBestEffort,
  setInProgressLock,
  clearInProgressLock,
  findExistingBundleByFingerprint,
  findBundleByInputs,
  checkInProgressLock,
  type CreateBundleInput,
} from './deduplicator.js';
import {
  listBundles,
  listBundlesMulti,
  bundleExists,
  findBundleStorageDir,
  bundleExistsMulti,
} from './list.js';

// Re-export from extracted modules for backward compatibility
export { assertBundleComplete } from './validation.js';
export { getEffectiveStorageDir } from './storage.js';
export { computeCreateInputFingerprint, checkInProgressLock, findBundleByInputs, type CreateBundleInput } from './deduplicator.js';
export { listBundles, listBundlesMulti, bundleExists, findBundleStorageDir, bundleExistsMulti } from './list.js';
export { clearBundle, clearBundleMulti, ensureRepoDirRemoved } from './cleanup.js';

/** Progress callback for reporting bundle creation progress */
export type BundleProgressCallback = (phase: TaskPhase, progress: number, message: string, total?: number) => void;

export type BundleSummary = {
  bundleId: string;
  createdAt: string;
  updatedAt: string;
  repos: Array<{
    kind: 'github' | 'local';
    id: string;
    source?: 'git' | 'archive' | 'local';
    headSha?: string;
    notes?: string[];
  }>;
  libraries?: Context7LibrarySummary[];
  /** User-facing warnings (e.g., git clone failed, used zip fallback) */
  warnings?: string[];
};

export type CreateIfExistsPolicy = 'error' | 'returnExisting' | 'updateExisting' | 'createNew';

export type CreateBundleOptions = {
  /**
   * What to do if a bundle with the same normalized inputs already exists.
   * - error: reject creation (default)
   * - returnExisting: return the existing bundle summary without fetching
   * - updateExisting: update the existing bundle in-place and return its updated summary
   * - createNew: bypass de-duplication (back-compat)
   */
  ifExists?: CreateIfExistsPolicy;
  /** Optional progress callback for reporting creation progress */
  onProgress?: BundleProgressCallback;
};

async function readBundleSummary(cfg: PreflightConfig, bundleId: string): Promise<BundleSummary> {
  const storageDir = (await findBundleStorageDir(cfg.storageDirs, bundleId)) ?? (await getEffectiveStorageDir(cfg));
  const paths = getBundlePaths(storageDir, bundleId);
  const manifest = await readManifest(paths.manifestPath);
  return {
    bundleId: manifest.bundleId,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    repos: manifest.repos.map((r) => ({
      kind: r.kind,
      id: r.id,
      source: r.source,
      headSha: r.headSha,
      notes: r.notes,
    })),
    libraries: manifest.libraries as Context7LibrarySummary[] | undefined,
  };
}

export async function createBundle(
  cfg: PreflightConfig,
  input: CreateBundleInput,
  options?: CreateBundleOptions
): Promise<BundleSummary> {
  // Apply concurrency limiting to prevent DoS attacks
  return await bundleCreationLimiter.run(async () => {
    return await createBundleInternal(cfg, input, options);
  });
}

async function createBundleInternal(
  cfg: PreflightConfig,
  input: CreateBundleInput,
  options?: CreateBundleOptions
): Promise<BundleSummary> {
  const fingerprint = computeCreateInputFingerprint(input);
  const repoIds = input.repos.map((r) => r.repo);
  const onProgress = options?.onProgress;
  const tracker = getProgressTracker();

  // Helper to report progress
  const reportProgress = (phase: TaskPhase, progress: number, message: string, total?: number) => {
    if (onProgress) {
      onProgress(phase, progress, message, total);
    }
  };

  const ifExists: CreateIfExistsPolicy = options?.ifExists ?? 'error';
  if (ifExists !== 'createNew') {
    const existing = await findExistingBundleByFingerprint(cfg, fingerprint);
    if (existing) {
      if (ifExists === 'returnExisting') {
        return await readBundleSummary(cfg, existing);
      }
      if (ifExists === 'updateExisting') {
        const { summary } = await updateBundle(cfg, existing);
        return summary;
      }
      throw new Error(`Bundle already exists for these inputs: ${existing}`);
    }
  }

  // Start tracking this task
  const taskId = tracker.startTask(fingerprint, repoIds);
  reportProgress('starting', 0, `Starting bundle creation for ${repoIds.join(', ')}`);

  // Try to acquire in-progress lock
  const lockResult = await setInProgressLock(cfg, fingerprint, taskId, repoIds);
  if (!lockResult.locked) {
    // Another task is already creating this bundle
    const entry = lockResult.existingEntry;
    const elapsedSec = entry.startedAt
      ? Math.round((Date.now() - new Date(entry.startedAt).getTime()) / 1000)
      : 0;
    const msg = `Bundle creation already in progress (taskId: ${entry.taskId}, started ${elapsedSec}s ago). ` +
      `Use preflight_get_task_status to check progress.`;
    
    // Throw a special error that can be caught and handled
    const err = new Error(msg);
    (err as any).code = 'BUNDLE_IN_PROGRESS';
    (err as any).taskId = entry.taskId;
    (err as any).fingerprint = fingerprint;
    (err as any).repos = entry.repos;
    (err as any).startedAt = entry.startedAt;
    throw err;
  }

  const bundleId = crypto.randomUUID();
  const createdAt = nowIso();

  // Use effective storage dir (falls back if primary unavailable)
  const effectiveStorageDir = await getEffectiveStorageDirForWrite(cfg);
  
  // Create bundle in temporary directory for atomic creation
  const tmpBundlesDir = path.join(cfg.tmpDir, 'bundles-wip');
  await ensureDir(tmpBundlesDir);
  
  const tmpPaths = getBundlePaths(tmpBundlesDir, bundleId);
  await ensureDir(tmpPaths.rootDir);
  
  const finalPaths = getBundlePaths(effectiveStorageDir, bundleId);

  const allIngestedFiles: IngestedFile[] = [];
  const allSkippedFiles: SkippedFileEntry[] = [];
  const reposSummary: BundleSummary['repos'] = [];
  const allWarnings: string[] = [];

  // Track temp checkout directory for cleanup
  const tmpCheckoutsDir = path.join(cfg.tmpDir, 'checkouts', bundleId);

  try {
    // All operations happen in tmpPaths (temporary directory)
    const totalRepos = input.repos.length;
    let repoIndex = 0;

    for (const repoInput of input.repos) {
      repoIndex++;
      const repoProgress = Math.round((repoIndex - 1) / totalRepos * 40); // 0-40% for repo fetching
      
      if (repoInput.kind === 'github') {
        const { owner, repo } = parseOwnerRepo(repoInput.repo);
        reportProgress('cloning', repoProgress, `[${repoIndex}/${totalRepos}] Fetching ${owner}/${repo}...`);
        tracker.updateProgress(taskId, 'cloning', repoProgress, `Fetching ${owner}/${repo}...`);
        
        const { headSha, files, skipped, notes, warnings, source } = await cloneAndIngestGitHubRepo({
          cfg,
          bundleId,
          storageDir: tmpBundlesDir,
          owner,
          repo,
          ref: repoInput.ref,
          onProgress: (phase, percent, msg) => {
            // Map clone/download progress to overall progress (0-40% range per repo)
            const overallProgress = repoProgress + Math.round(percent * 0.4 / totalRepos);
            reportProgress(phase as TaskPhase, overallProgress, `[${repoIndex}/${totalRepos}] ${msg}`);
            tracker.updateProgress(taskId, phase as TaskPhase, overallProgress, msg);
          },
        });

        allIngestedFiles.push(...files);
        allWarnings.push(...warnings);
        // Parse and collect skipped files
        const repoId = `${owner}/${repo}`;
        for (const s of skipped) {
          const entry = parseSkippedString(s, repoId);
          if (entry) allSkippedFiles.push(entry);
        }
        reposSummary.push({
          kind: 'github',
          id: repoId,
          source,
          headSha,
          notes: [...notes, ...skipped].slice(0, 50),
        });
      } else {
        // Local repository
        const { owner, repo } = parseOwnerRepo(repoInput.repo);
        reportProgress('ingesting', repoProgress, `[${repoIndex}/${totalRepos}] Ingesting local ${owner}/${repo}...`);
        tracker.updateProgress(taskId, 'ingesting', repoProgress, `Ingesting local ${owner}/${repo}...`);
        
        const { files, skipped } = await ingestLocalRepo({
          cfg,
          bundleId,
          storageDir: tmpBundlesDir,
          owner,
          repo,
          localPath: repoInput.path,
          ref: repoInput.ref,
        });

        allIngestedFiles.push(...files);
        // Parse and collect skipped files
        const repoId = `${owner}/${repo}`;
        for (const s of skipped) {
          const entry = parseSkippedString(s, repoId);
          if (entry) allSkippedFiles.push(entry);
        }
        reposSummary.push({ kind: 'local', id: repoId, source: 'local', notes: skipped.slice(0, 50) });
      }
    }

  // Context7 libraries (best-effort).
  let librariesSummary: Context7LibrarySummary[] | undefined;
  if (input.libraries?.length) {
    // Clean libraries dir in case something wrote here earlier.
    await rmIfExists(tmpPaths.librariesDir);
    await ensureDir(tmpPaths.librariesDir);

    const libIngest = await ingestContext7Libraries({
      cfg,
      bundlePaths: tmpPaths,
      libraries: input.libraries,
      topics: input.topics,
    });

    allIngestedFiles.push(...libIngest.files);
    librariesSummary = libIngest.libraries;
  }

  // Build index.
  reportProgress('indexing', 50, `Building search index (${allIngestedFiles.length} files)...`);
  tracker.updateProgress(taskId, 'indexing', 50, `Building search index (${allIngestedFiles.length} files)...`);
  
  await rebuildIndex(tmpPaths.searchDbPath, allIngestedFiles, {
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
      fingerprint,
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
        source: r.source,
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
      // Store skipped files for transparency (limit to 200 entries to avoid bloat)
      skippedFiles: allSkippedFiles.length > 0 ? allSkippedFiles.slice(0, 200) : undefined,
    };

  await writeManifest(tmpPaths.manifestPath, manifest);

  // Guides.
  await writeAgentsMd({
    targetPath: tmpPaths.agentsPath,
    bundleId,
    bundleRootDir: tmpPaths.rootDir,
    repos: reposSummary.map((r) => ({ id: r.id, headSha: r.headSha })),
    libraries: librariesSummary,
  });
  await writeStartHereMd({
    targetPath: tmpPaths.startHerePath,
    bundleId,
    bundleRootDir: tmpPaths.rootDir,
    repos: reposSummary.map((r) => ({ id: r.id, headSha: r.headSha })),
    libraries: librariesSummary,
  });

  // Generate static facts (FACTS.json) FIRST. This is intentionally non-LLM and safe to keep inside bundles.
  reportProgress('analyzing', 70, 'Analyzing code structure...');
  tracker.updateProgress(taskId, 'analyzing', 70, 'Analyzing code structure...');
  
  await generateFactsBestEffort({
    bundleId,
    bundleRoot: tmpPaths.rootDir,
    files: allIngestedFiles,
    mode: cfg.analysisMode,
  });

  // Overview (S2: factual-only with evidence pointers) - generated AFTER FACTS.json
  reportProgress('generating', 80, 'Generating overview...');
  tracker.updateProgress(taskId, 'generating', 80, 'Generating overview...');
  
  const perRepoOverviews = reposSummary
    .filter((r) => r.kind === 'github' || r.kind === 'local')
    .map((r) => {
      const repoId = r.id;
      const repoFiles = allIngestedFiles.filter((f) => f.repoId === repoId);
      return { repoId, headSha: r.headSha, files: repoFiles };
    });

  const overviewMd = await generateOverviewMarkdown({
    bundleId,
    bundleRootDir: tmpPaths.rootDir,
    repos: perRepoOverviews,
    libraries: librariesSummary,
  });
  await writeOverviewFile(tmpPaths.overviewPath, overviewMd);

    // CRITICAL: Validate bundle completeness BEFORE atomic move
    const validation = await validateBundleCompleteness(tmpPaths.rootDir);

    if (!validation.isValid) {
      const errorMsg = `Bundle creation incomplete. Missing: ${validation.missingComponents.join(', ')}`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    // ATOMIC OPERATION: Move from temp to final location
    // This is atomic on most filesystems - bundle becomes visible only when complete
    reportProgress('finalizing', 90, 'Finalizing bundle...');
    tracker.updateProgress(taskId, 'finalizing', 90, 'Finalizing bundle...');
    
    logger.info(`Moving bundle ${bundleId} from temp to final location (atomic)`);
    await ensureDir(effectiveStorageDir);
    
    try {
      // Try rename first (atomic, but only works on same filesystem)
      await fs.rename(tmpPaths.rootDir, finalPaths.rootDir);
      logger.info(`Bundle ${bundleId} moved atomically to ${finalPaths.rootDir}`);
    } catch (renameErr) {
      // Rename failed - likely cross-filesystem. Fall back to copy+delete
      const errCode = (renameErr as NodeJS.ErrnoException).code;
      if (errCode === 'EXDEV') {
        logger.warn(`Cross-filesystem move detected for ${bundleId}, falling back to copy`);
        await copyDir(tmpPaths.rootDir, finalPaths.rootDir);
        await rmIfExists(tmpPaths.rootDir);
        logger.info(`Bundle ${bundleId} copied to ${finalPaths.rootDir}`);
      } else {
        // Some other error, rethrow
        throw renameErr;
      }
    }

    // Mirror to backup storage directories (non-blocking on failures)
    if (cfg.storageDirs.length > 1) {
      await mirrorBundleToBackups(effectiveStorageDir, cfg.storageDirs, bundleId);
    }

    // Update de-duplication index (best-effort). This is intentionally after atomic move.
    await updateDedupIndexBestEffort(cfg, fingerprint, bundleId, createdAt, 'complete');

    // Mark task complete
    reportProgress('complete', 100, `Bundle created: ${bundleId}`);
    tracker.completeTask(taskId, bundleId);

    const summary: BundleSummary = {
      bundleId,
      createdAt,
      updatedAt: createdAt,
      repos: reposSummary,
      libraries: librariesSummary,
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
    };

    return summary;

  } catch (err) {
    // Clean up temp directory on failure
    logger.error(`Bundle creation failed, cleaning up temp: ${bundleId}`, err instanceof Error ? err : undefined);
    await rmIfExists(tmpPaths.rootDir);
    
    // Clear in-progress lock on failure
    await clearInProgressLock(cfg, fingerprint);
    
    // Mark task failed
    const errorMsg = err instanceof Error ? err.message : String(err);
    tracker.failTask(taskId, errorMsg);

    // Re-throw with enhanced message (unless it's already our BUNDLE_IN_PROGRESS error)
    if ((err as any)?.code === 'BUNDLE_IN_PROGRESS') {
      throw err;
    }
    throw new Error(`Failed to create bundle: ${errorMsg}`);
  } finally {
    // Ensure temp directory is cleaned up (double safety)
    await rmIfExists(tmpPaths.rootDir).catch((err) => {
      logger.debug('Failed to cleanup temp bundle directory in finally block (non-critical)', err instanceof Error ? err : undefined);
    });
    
    // Clean up temp checkouts directory (git clones, zip extracts)
    await rmIfExists(tmpCheckoutsDir).catch((err) => {
      logger.debug('Failed to cleanup temp checkouts directory in finally block (non-critical)', err instanceof Error ? err : undefined);
    });
  }
}

export type UpdateBundleOptions = {
  checkOnly?: boolean;
  force?: boolean;
  /** Optional progress callback for reporting update progress */
  onProgress?: BundleProgressCallback;
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
      // Local: can't reliably detect whether local files changed without scanning; assume possible update.
      const { owner, repo } = parseOwnerRepo(repoInput.repo);
      const repoId = `${owner}/${repo}`;
      const prev = manifest.repos.find((r) => r.id === repoId);
      details.push({ repoId, currentSha: prev?.headSha, changed: true });
      hasUpdates = true;
    }
  }

  return { hasUpdates, details };
}

export type RepairBundleMode = 'validate' | 'repair';

export type RepairBundleOptions = {
  mode?: RepairBundleMode;
  rebuildIndex?: boolean;
  rebuildGuides?: boolean;
  rebuildOverview?: boolean;
};

export type RepairBundleResult = {
  bundleId: string;
  mode: RepairBundleMode;
  repaired: boolean;
  actionsTaken: string[];
  /** Issues that cannot be fixed by repair (require re-download) */
  unfixableIssues?: string[];
  before: { isValid: boolean; missingComponents: string[] };
  after: { isValid: boolean; missingComponents: string[] };
  updatedAt?: string;
};

async function scanBundleIndexableFiles(params: {
  cfg: PreflightConfig;
  bundleRootDir: string;
  reposDir: string;
  librariesDir: string;
}): Promise<{ files: IngestedFile[]; totalBytes: number; skipped: string[] }> {
  const files: IngestedFile[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;

  const pushFile = async (f: {
    repoId: string;
    kind: 'doc' | 'code';
    repoRelativePath: string;
    bundleRelPosix: string;
    absPath: string;
  }) => {
    const st = await statOrNull(f.absPath);
    if (!st?.isFile()) return;

    if (st.size > params.cfg.maxFileBytes) {
      skipped.push(`${f.bundleRelPosix} (too large: ${st.size} bytes)`);
      return;
    }

    if (totalBytes + st.size > params.cfg.maxTotalBytes) {
      skipped.push(`(bundle maxTotalBytes reached) stopped before: ${f.bundleRelPosix}`);
      return;
    }

    const text = await readUtf8OrNull(f.absPath);
    if (text === null) {
      skipped.push(`${f.bundleRelPosix} (unreadable utf8)`);
      return;
    }

    const normalized = text.replace(/\r\n/g, '\n');
    const sha256 = sha256Text(normalized);

    totalBytes += st.size;

    files.push({
      repoId: f.repoId,
      kind: f.kind,
      repoRelativePath: f.repoRelativePath,
      bundleNormRelativePath: f.bundleRelPosix,
      bundleNormAbsPath: f.absPath,
      sha256,
      bytes: st.size,
    });
  };

  // 1) repos/<owner>/<repo>/norm/** (github/local)
  try {
    const owners = await fs.readdir(params.reposDir, { withFileTypes: true });
    for (const ownerEnt of owners) {
      if (!ownerEnt.isDirectory()) continue;
      const owner = ownerEnt.name;
      const ownerDir = path.join(params.reposDir, owner);

      const repos = await fs.readdir(ownerDir, { withFileTypes: true });
      for (const repoEnt of repos) {
        if (!repoEnt.isDirectory()) continue;
        const repo = repoEnt.name;
        const normDir = path.join(ownerDir, repo, 'norm');
        const normSt = await statOrNull(normDir);
        if (!normSt?.isDirectory()) continue;

        for await (const wf of walkFilesNoIgnore(normDir)) {
          const repoRel = wf.relPosix;
          const kind = classifyIngestedFileKind(repoRel);
          const bundleRel = `repos/${owner}/${repo}/norm/${repoRel}`;
          await pushFile({
            repoId: `${owner}/${repo}`,
            kind,
            repoRelativePath: repoRel,
            bundleRelPosix: bundleRel,
            absPath: wf.absPath,
          });
        }
      }
    }
  } catch {
    // ignore missing repos dir
  }

  // 2) libraries/context7/** (docs-only)
  const context7Dir = path.join(params.librariesDir, 'context7');
  const ctxSt = await statOrNull(context7Dir);
  if (ctxSt?.isDirectory()) {
    for await (const wf of walkFilesNoIgnore(context7Dir)) {
      // Match original ingestion: only .md docs are indexed from Context7.
      if (!wf.relPosix.toLowerCase().endsWith('.md')) continue;

      const relFromLibRoot = wf.relPosix; // relative to libraries/context7
      const parts = relFromLibRoot.split('/').filter(Boolean);
      const fileName = parts[parts.length - 1] ?? '';
      const dirParts = parts.slice(0, -1);

      let repoId = 'context7:unknown';
      if (dirParts[0] === '_unresolved' && dirParts[1]) {
        repoId = `context7:unresolved/${dirParts[1]}`;
      } else if (dirParts.length > 0) {
        repoId = `context7:/${dirParts.join('/')}`;
      }

      const bundleRel = `libraries/context7/${relFromLibRoot}`;

      await pushFile({
        repoId,
        kind: 'doc',
        repoRelativePath: fileName,
        bundleRelPosix: bundleRel,
        absPath: wf.absPath,
      });
    }
  }

  return { files, totalBytes, skipped };
}

export async function repairBundle(cfg: PreflightConfig, bundleId: string, options?: RepairBundleOptions): Promise<RepairBundleResult> {
  const mode: RepairBundleMode = options?.mode ?? 'repair';
  const rebuildIndexOpt = options?.rebuildIndex ?? true;
  const rebuildGuidesOpt = options?.rebuildGuides ?? true;
  const rebuildOverviewOpt = options?.rebuildOverview ?? true;

  const storageDir = await findBundleStorageDir(cfg.storageDirs, bundleId);
  if (!storageDir) {
    throw new BundleNotFoundError(bundleId);
  }

  const paths = getBundlePaths(storageDir, bundleId);

  const before = await validateBundleCompleteness(paths.rootDir);
  if (mode === 'validate') {
    return {
      bundleId,
      mode,
      repaired: false,
      actionsTaken: [],
      before,
      after: before,
    };
  }

  // Manifest is required for safe repairs (no fetching/re-ingest).
  const manifest = await readManifest(paths.manifestPath);

  const actionsTaken: string[] = [];
  const unfixableIssues: string[] = [];

  // Check for unfixable issues (require re-download, can't be repaired offline)
  const reposHasContent = before.missingComponents.every(c => !c.includes('repos/'));
  if (!reposHasContent) {
    unfixableIssues.push(
      'repos/ directory is empty or missing - this requires re-downloading the repository. ' +
      'Use preflight_delete_bundle and preflight_create_bundle to start fresh, ' +
      'or use preflight_update_bundle with force:true to re-fetch.'
    );
  }

  // Determine what needs repair.
  const stAgents = await statOrNull(paths.agentsPath);
  const stStartHere = await statOrNull(paths.startHerePath);
  const stOverview = await statOrNull(paths.overviewPath);
  const stIndex = await statOrNull(paths.searchDbPath);

  const needsAgents = !stAgents || stAgents.size === 0;
  const needsStartHere = !stStartHere || stStartHere.size === 0;
  const needsOverview = !stOverview || stOverview.size === 0;
  const needsIndex = !stIndex || stIndex.size === 0;

  // Scan bundle files once if needed for index/overview.
  let scanned: Awaited<ReturnType<typeof scanBundleIndexableFiles>> | null = null;
  const needScan = (rebuildIndexOpt && needsIndex) || (rebuildOverviewOpt && needsOverview);
  if (needScan) {
    scanned = await scanBundleIndexableFiles({
      cfg,
      bundleRootDir: paths.rootDir,
      reposDir: paths.reposDir,
      librariesDir: paths.librariesDir,
    });

    if (scanned.skipped.length) {
      actionsTaken.push(`scan: skipped ${scanned.skipped.length} file(s)`);
    }
  }

  if (rebuildIndexOpt && needsIndex) {
    const files = scanned?.files ?? [];
    await rebuildIndex(paths.searchDbPath, files, { includeDocs: true, includeCode: true });
    actionsTaken.push(`rebuildIndex: indexed ${files.length} file(s)`);
  }

  if (rebuildGuidesOpt && needsAgents) {
    await writeAgentsMd({
      targetPath: paths.agentsPath,
      bundleId,
      bundleRootDir: paths.rootDir,
      repos: (manifest.repos ?? []).map((r) => ({ id: r.id, headSha: r.headSha })),
      libraries: manifest.libraries as Context7LibrarySummary[] | undefined,
    });
    actionsTaken.push('writeAgentsMd');
  }

  if (rebuildGuidesOpt && needsStartHere) {
    await writeStartHereMd({
      targetPath: paths.startHerePath,
      bundleId,
      bundleRootDir: paths.rootDir,
      repos: (manifest.repos ?? []).map((r) => ({ id: r.id, headSha: r.headSha })),
      libraries: manifest.libraries as Context7LibrarySummary[] | undefined,
    });
    actionsTaken.push('writeStartHereMd');
  }

  if (rebuildOverviewOpt && needsOverview) {
    const allFiles = scanned?.files ?? [];
    const perRepoOverviews = (manifest.repos ?? [])
      .filter((r) => r.kind === 'github' || r.kind === 'local')
      .map((r) => {
        const repoId = r.id;
        const repoFiles = allFiles.filter((f) => f.repoId === repoId);
        return { repoId, headSha: r.headSha, files: repoFiles };
      });

    const md = await generateOverviewMarkdown({
      bundleId,
      bundleRootDir: paths.rootDir,
      repos: perRepoOverviews,
      libraries: manifest.libraries as Context7LibrarySummary[] | undefined,
    });
    await writeOverviewFile(paths.overviewPath, md);
    actionsTaken.push('writeOverviewFile');
  }

  let updatedAt: string | undefined;
  if (actionsTaken.length > 0) {
    updatedAt = nowIso();

    const fingerprint =
      manifest.fingerprint ??
      computeCreateInputFingerprint({
        repos: manifest.inputs.repos,
        libraries: manifest.inputs.libraries,
        topics: manifest.inputs.topics,
      });

    const newManifest: BundleManifestV1 = {
      ...manifest,
      updatedAt,
      fingerprint,
    };

    await writeManifest(paths.manifestPath, newManifest);

    // Keep the de-duplication index fresh (best-effort).
    await updateDedupIndexBestEffort(cfg, fingerprint, bundleId, updatedAt);

    // Mirror to backup storage directories (non-blocking on failures)
    if (cfg.storageDirs.length > 1) {
      await mirrorBundleToBackups(storageDir, cfg.storageDirs, bundleId);
    }
  }

  const after = await validateBundleCompleteness(paths.rootDir);

  return {
    bundleId,
    mode,
    repaired: actionsTaken.length > 0,
    actionsTaken,
    unfixableIssues: unfixableIssues.length > 0 ? unfixableIssues : undefined,
    before,
    after,
    updatedAt,
  };
}

export async function updateBundle(cfg: PreflightConfig, bundleId: string, options?: UpdateBundleOptions): Promise<{ summary: BundleSummary; changed: boolean }> {
  // Use effective storage dir (falls back if primary unavailable)
  const effectiveStorageDir = await getEffectiveStorageDirForWrite(cfg);
  const paths = getBundlePaths(effectiveStorageDir, bundleId);
  const manifest = await readManifest(paths.manifestPath);

  const updatedAt = nowIso();
  const onProgress = options?.onProgress;

  // Report progress helper
  const reportProgress = (phase: TaskPhase, progress: number, message: string, total?: number) => {
    if (onProgress) {
      onProgress(phase, progress, message, total);
    }
  };

  reportProgress('starting', 0, `Updating bundle ${bundleId}...`);

  let changed = false;
  const allIngestedFiles: IngestedFile[] = [];
  const reposSummary: BundleSummary['repos'] = [];

  const totalRepos = manifest.inputs.repos.length;
  let repoIndex = 0;

  // Rebuild everything obvious for now (simple + deterministic).
  for (const repoInput of manifest.inputs.repos) {
    repoIndex++;
    if (repoInput.kind === 'github') {
      const { owner, repo } = parseOwnerRepo(repoInput.repo);
      const repoId = `${owner}/${repo}`;
      const cloneUrl = toCloneUrl({ owner, repo });

      reportProgress('cloning', calcPercent(repoIndex - 1, totalRepos), `Checking ${repoId}...`, totalRepos);

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

      reportProgress('downloading', calcPercent(repoIndex - 1, totalRepos), `Fetching ${repoId}...`, totalRepos);

      const { headSha, files, skipped, notes, source } = await cloneAndIngestGitHubRepo({
        cfg,
        bundleId,
        storageDir: effectiveStorageDir,
        owner,
        repo,
        ref: repoInput.ref,
        onProgress: (phase, progress, message) => {
          reportProgress(phase as TaskPhase, progress, message);
        },
      });

      if (prev?.headSha && headSha && headSha !== prev.headSha) {
        changed = true;
      }

      // If we had to fall back to an archive, treat as changed (we don't have git metadata).
      if (source === 'archive') {
        changed = true;
      }

      allIngestedFiles.push(...files);
      reposSummary.push({ kind: 'github', id: repoId, source, headSha, notes: [...notes, ...skipped].slice(0, 50) });
    } else {
      // Local repository
      const { owner, repo } = parseOwnerRepo(repoInput.repo);
      const repoId = `${owner}/${repo}`;

      const { files, skipped } = await ingestLocalRepo({
        cfg,
        bundleId,
        storageDir: effectiveStorageDir,
        owner,
        repo,
        localPath: repoInput.path,
        ref: repoInput.ref,
      });

      allIngestedFiles.push(...files);
      reposSummary.push({ kind: 'local', id: repoId, source: 'local', notes: skipped.slice(0, 50) });
      changed = true;
    }
  }

  // Context7 libraries (best-effort).
  let librariesSummary: Context7LibrarySummary[] | undefined;
  if (manifest.inputs.libraries?.length) {
    reportProgress('downloading', 80, 'Fetching Context7 libraries...');
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

  // Rebuild or incrementally update index.
  reportProgress('indexing', 85, `Updating search index (${allIngestedFiles.length} files)...`);
  
  // Try incremental update for better performance on large bundles
  const indexOpts = {
    includeDocs: manifest.index.includeDocs,
    includeCode: manifest.index.includeCode,
  };
  
  if (supportsIncrementalIndex(paths.searchDbPath)) {
    const incrementalResult = await incrementalIndexUpdate(paths.searchDbPath, allIngestedFiles, indexOpts);
    logger.info(`Incremental index update: ${incrementalResult.added} added, ${incrementalResult.updated} updated, ${incrementalResult.removed} removed, ${incrementalResult.unchanged} unchanged`);
  } else {
    // Fall back to full rebuild if incremental update not supported
    await rebuildIndex(paths.searchDbPath, allIngestedFiles, indexOpts);
    logger.info(`Full index rebuild: ${allIngestedFiles.length} files indexed`);
  }

  const fingerprint = computeCreateInputFingerprint({
    repos: manifest.inputs.repos,
    libraries: manifest.inputs.libraries,
    topics: manifest.inputs.topics,
  });

  const newManifest: BundleManifestV1 = {
    ...manifest,
    updatedAt,
    fingerprint,
    repos: reposSummary.map((r) => ({
      kind: r.kind,
      id: r.id,
      source: r.source,
      headSha: r.headSha,
      fetchedAt: updatedAt,
      notes: r.notes,
    })),
    libraries: librariesSummary,
  };

  await writeManifest(paths.manifestPath, newManifest);

  // Invalidate manifest cache after updating
  invalidateManifestCache(paths.manifestPath);

  // Regenerate guides + overview.
  reportProgress('generating', 90, 'Regenerating guides and overview...');
  await writeAgentsMd({
    targetPath: paths.agentsPath,
    bundleId,
    bundleRootDir: paths.rootDir,
    repos: reposSummary.map((r) => ({ id: r.id, headSha: r.headSha })),
    libraries: librariesSummary,
  });
  await writeStartHereMd({
    targetPath: paths.startHerePath,
    bundleId,
    bundleRootDir: paths.rootDir,
    repos: reposSummary.map((r) => ({ id: r.id, headSha: r.headSha })),
    libraries: librariesSummary,
  });

  const perRepoOverviews = reposSummary
    .filter((r) => r.kind === 'github' || r.kind === 'local')
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
  reportProgress('analyzing', 95, 'Analyzing bundle...');
  await generateFactsBestEffort({
    bundleId,
    bundleRoot: paths.rootDir,
    files: allIngestedFiles,
    mode: cfg.analysisMode,
  });

  // Mirror to backup storage directories (non-blocking on failures)
  reportProgress('finalizing', 98, 'Finalizing update...');
  if (cfg.storageDirs.length > 1) {
    await mirrorBundleToBackups(effectiveStorageDir, cfg.storageDirs, bundleId);
  }

  // Keep the de-duplication index fresh (best-effort).
  await updateDedupIndexBestEffort(cfg, fingerprint, bundleId, updatedAt);

  reportProgress('complete', 100, `Bundle updated: ${bundleId}`);

  const summary: BundleSummary = {
    bundleId,
    createdAt: manifest.createdAt,
    updatedAt,
    repos: reposSummary,
    libraries: librariesSummary,
  };

  return { summary, changed };
}

export async function getBundleRoot(storageDir: string, bundleId: string): Promise<string> {
  const paths = getBundlePaths(storageDir, bundleId);
  return paths.rootDir;
}

export function getBundlePathsForId(storageDir: string, bundleId: string) {
  return getBundlePaths(storageDir, bundleId);
}
