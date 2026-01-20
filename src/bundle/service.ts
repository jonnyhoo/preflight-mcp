import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { type PreflightConfig } from '../config.js';
import { logger } from '../logging/logger.js';
import {
  getRemoteHeadSha,
  getLocalHeadSha,
  parseOwnerRepo,
  toCloneUrl,
} from './github.js';
import { type IngestedFile, classifyIngestedFileKind } from './ingest.js';
import { ingestDocument, isParseableDocument } from './document-ingest.js';
import { type RepoInput, type BundleManifestV1, type SkippedFileEntry, writeManifest, readManifest, invalidateManifestCache } from './manifest.js';
import { getBundlePaths } from './paths.js';
import { writeAgentsMd, writeStartHereMd } from './guides.js';
import { generateOverviewMarkdown, writeOverviewFile } from './overview.js';
import { rebuildIndex, incrementalIndexUpdate, supportsIncrementalIndex } from '../search/sqliteFts.js';
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
  runAdvancedAnalyzersBestEffort,
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

// Web module imports are dynamic to avoid loading jsdom in non-web contexts
// This fixes Jest ESM compatibility issues
type WebIngestModule = typeof import('./web-ingest.js');
type WebIndexModule = typeof import('../web/index.js');
let _webIngestModule: WebIngestModule | null = null;
let _webIndexModule: WebIndexModule | null = null;

async function getWebIngestModule(): Promise<WebIngestModule> {
  if (!_webIngestModule) {
    _webIngestModule = await import('./web-ingest.js');
  }
  return _webIngestModule;
}

async function getWebIndexModule(): Promise<WebIndexModule> {
  if (!_webIndexModule) {
    _webIndexModule = await import('../web/index.js');
  }
  return _webIndexModule;
}
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
    kind: 'github' | 'local' | 'web';
    id: string;
    source?: 'git' | 'archive' | 'local' | 'crawl';
    headSha?: string;
    notes?: string[];
    // Web-specific fields
    baseUrl?: string;
    pageCount?: number;
    usedLlmsTxt?: boolean;
  }>;
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
      baseUrl: r.baseUrl,
      pageCount: r.pageCount,
      usedLlmsTxt: r.usedLlmsTxt,
    })),
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
  // Extract IDs for display - for web sources, use the URL
  const repoIds = input.repos.map((r) => {
    if (r.kind === 'web') {
      return `web:${r.url}`;
    }
    return r.repo;
  });
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
      } else if (repoInput.kind === 'local') {
        // Local repository
        const { owner, repo } = parseOwnerRepo(repoInput.repo);
        reportProgress('ingesting', repoProgress, `[${repoIndex}/${totalRepos}] Ingesting local ${owner}/${repo}...`);
        tracker.updateProgress(taskId, 'ingesting', repoProgress, `Ingesting local ${owner}/${repo}...`);
        
        const { files, skipped, headSha } = await ingestLocalRepo({
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
        reposSummary.push({ kind: 'local', id: repoId, source: 'local', headSha, notes: skipped.slice(0, 50) });
      } else if (repoInput.kind === 'web') {
        // Web source - crawl documentation site
        reportProgress('crawling', repoProgress, `[${repoIndex}/${totalRepos}] Crawling ${repoInput.url}...`);
        tracker.updateProgress(taskId, 'crawling', repoProgress, `Crawling ${repoInput.url}...`);

        const { ingestWebSource } = await getWebIngestModule();
        const webResult = await ingestWebSource({
          cfg,
          bundleRoot: tmpPaths.rootDir,
          url: repoInput.url,
          config: repoInput.config,
          onProgress: (msg) => {
            reportProgress('crawling', repoProgress, `[${repoIndex}/${totalRepos}] ${msg}`);
          },
        });

        allIngestedFiles.push(...webResult.files);
        allSkippedFiles.push(...webResult.skipped);
        allWarnings.push(...webResult.warnings);

        reposSummary.push({
          kind: 'web',
          id: webResult.repoId,
          source: 'crawl',
          headSha: webResult.contentHash,
          notes: webResult.notes.slice(0, 50),
          baseUrl: webResult.baseUrl,
          pageCount: webResult.pageCount,
          usedLlmsTxt: webResult.usedLlmsTxt,
        });
      }
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
        // Web-specific fields (only included for web sources)
        ...(r.kind === 'web' ? {
          baseUrl: r.baseUrl,
          pageCount: r.pageCount,
          usedLlmsTxt: r.usedLlmsTxt,
        } : {}),
      })),
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
  });
  await writeStartHereMd({
    targetPath: tmpPaths.startHerePath,
    bundleId,
    bundleRootDir: tmpPaths.rootDir,
    repos: reposSummary.map((r) => ({ id: r.id, headSha: r.headSha })),
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

  // Run advanced analyzers (GoF patterns, architectural patterns, etc.) AFTER FACTS.json
  reportProgress('analyzing', 75, 'Running advanced analyzers...');
  tracker.updateProgress(taskId, 'analyzing', 75, 'Running advanced analyzers (patterns, config, tests)...');

  await runAdvancedAnalyzersBestEffort({
    bundleId,
    bundleRoot: tmpPaths.rootDir,
    files: allIngestedFiles,
    manifest,
    mode: cfg.analysisMode,
  });

  // Overview (S2: factual-only with evidence pointers) - generated AFTER FACTS.json
  reportProgress('generating', 80, 'Generating overview...');
  tracker.updateProgress(taskId, 'generating', 80, 'Generating overview...');
  
  const perRepoOverviews = reposSummary
    .filter((r) => r.kind === 'github' || r.kind === 'local' || r.kind === 'web')
    .map((r) => {
      const repoId = r.id;
      const repoFiles = allIngestedFiles.filter((f) => f.repoId === repoId);
      return { repoId, headSha: r.headSha, files: repoFiles };
    });

  const overviewMd = await generateOverviewMarkdown({
    bundleId,
    bundleRootDir: tmpPaths.rootDir,
    repos: perRepoOverviews,
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
    } else if (repoInput.kind === 'local') {
      // Local: if this is a git repo, we can compare HEAD sha to avoid unnecessary updates.
      const { owner, repo } = parseOwnerRepo(repoInput.repo);
      const repoId = `${owner}/${repo}`;
      const prev = manifest.repos.find((r) => r.id === repoId);

      let localSha: string | undefined;
      try {
        localSha = await getLocalHeadSha(path.resolve(repoInput.path));
      } catch {
        // Not a git repo (or git not available) - fall back to "changed".
      }

      const changed = !localSha || !prev?.headSha || localSha !== prev.headSha;
      if (changed) hasUpdates = true;

      details.push({ repoId, currentSha: prev?.headSha, remoteSha: localSha, changed });
    } else if (repoInput.kind === 'web') {
      // Web: use quickCheckForChanges for efficient detection
      const { generateSafeId, quickCheckForChanges, loadPageState } = await getWebIndexModule();
      const safeId = generateSafeId(repoInput.url);
      const repoId = `web/${safeId}`;
      const prev = manifest.repos.find((r) => r.id === repoId);

      // Load page state and check for changes
      const stateFile = path.join(paths.rootDir, 'repos', 'web', safeId, 'page-state.json');
      const { state: previousState } = await loadPageState(stateFile);

      let changed = true; // Default to changed (conservative)
      if (previousState.size > 0) {
        try {
          const checkResult = await quickCheckForChanges(repoInput.url, previousState, {
            timeout: 30000,
            userAgent: 'Preflight-Web-Crawler/1.0',
          });
          changed = checkResult.hasChanges;
          logger.debug(`Web source ${repoInput.url} quick check: ${checkResult.reason}`);
        } catch (err) {
          // On error, assume changed (conservative)
          logger.debug(`Web source ${repoInput.url} quick check failed, assuming changed`, err instanceof Error ? err : undefined);
        }
      }

      if (changed) hasUpdates = true;

      details.push({ repoId, currentSha: prev?.headSha, remoteSha: undefined, changed });
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
    });
    actionsTaken.push('writeAgentsMd');
  }

  if (rebuildGuidesOpt && needsStartHere) {
    await writeStartHereMd({
      targetPath: paths.startHerePath,
      bundleId,
      bundleRootDir: paths.rootDir,
      repos: (manifest.repos ?? []).map((r) => ({ id: r.id, headSha: r.headSha })),
    });
    actionsTaken.push('writeStartHereMd');
  }

  if (rebuildOverviewOpt && needsOverview) {
    const allFiles = scanned?.files ?? [];
    const perRepoOverviews = (manifest.repos ?? [])
      .filter((r) => r.kind === 'github' || r.kind === 'local' || r.kind === 'web')
      .map((r) => {
        const repoId = r.id;
        const repoFiles = allFiles.filter((f) => f.repoId === repoId);
        return { repoId, headSha: r.headSha, files: repoFiles };
      });

    const md = await generateOverviewMarkdown({
      bundleId,
      bundleRootDir: paths.rootDir,
      repos: perRepoOverviews,
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
    } else if (repoInput.kind === 'local') {
      // Local repository
      const { owner, repo } = parseOwnerRepo(repoInput.repo);
      const repoId = `${owner}/${repo}`;
      const prev = manifest.repos.find((r) => r.id === repoId);

      let localSha: string | undefined;
      try {
        localSha = await getLocalHeadSha(path.resolve(repoInput.path));
      } catch {
        // Not a git repo (or git not available) - treat as changed.
      }

      const unchanged = !options?.force && !!localSha && !!prev?.headSha && localSha === prev.headSha;

      if (unchanged) {
        // Skip re-ingest; keep existing snapshot.
        reposSummary.push({
          kind: 'local',
          id: repoId,
          source: 'local',
          headSha: prev?.headSha,
          notes: prev?.notes,
        });
      } else {
        const { skipped, headSha } = await ingestLocalRepo({
          cfg,
          bundleId,
          storageDir: effectiveStorageDir,
          owner,
          repo,
          localPath: repoInput.path,
          ref: repoInput.ref,
        });

        reposSummary.push({ kind: 'local', id: repoId, source: 'local', headSha, notes: skipped.slice(0, 50) });
        changed = true;
      }
    } else if (repoInput.kind === 'web') {
      // Web source - use incremental crawl when possible
      reportProgress('crawling', calcPercent(repoIndex - 1, totalRepos), `Updating ${repoInput.url}...`, totalRepos);

      const { ingestWebSource, ingestWebSourceIncremental } = await getWebIngestModule();
      const prev = manifest.repos.find((r) => r.id.startsWith('web/'));

      // Use incremental if not forced and previous state exists
      const useIncremental = !options?.force;

      let webResult;
      if (useIncremental) {
        // Try incremental update
        webResult = await ingestWebSourceIncremental({
          cfg,
          bundleRoot: paths.rootDir,
          url: repoInput.url,
          config: repoInput.config,
          onProgress: (msg) => {
            reportProgress('crawling', calcPercent(repoIndex - 1, totalRepos), msg, totalRepos);
          },
        });

        // Check if content actually changed
        const stats = webResult.incrementalStats;
        if (stats.added > 0 || stats.updated > 0 || stats.removed > 0) {
          changed = true;
        }
      } else {
        // Force full crawl
        webResult = await ingestWebSource({
          cfg,
          bundleRoot: paths.rootDir,
          url: repoInput.url,
          config: repoInput.config,
          onProgress: (msg) => {
            reportProgress('crawling', calcPercent(repoIndex - 1, totalRepos), msg, totalRepos);
          },
        });

        if (!prev || prev.headSha !== webResult.contentHash) {
          changed = true;
        }
      }

      allIngestedFiles.push(...webResult.files);

      reposSummary.push({
        kind: 'web',
        id: webResult.repoId,
        source: 'crawl',
        headSha: webResult.contentHash,
        notes: webResult.notes.slice(0, 50),
        baseUrl: webResult.baseUrl,
        pageCount: webResult.pageCount,
        usedLlmsTxt: webResult.usedLlmsTxt,
      });
    }
  }

  // Re-scan the bundle so indexing reflects the actual on-disk snapshot (important when local repos are skipped).
  {
    const scanned = await scanBundleIndexableFilesHelper({
      cfg,
      bundleRootDir: paths.rootDir,
      reposDir: paths.reposDir,
      librariesDir: paths.librariesDir,
    });
    allIngestedFiles.length = 0;
    allIngestedFiles.push(...scanned.files);
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
      // Web-specific fields (only included for web sources)
      ...(r.kind === 'web' ? {
        baseUrl: r.baseUrl,
        pageCount: r.pageCount,
        usedLlmsTxt: r.usedLlmsTxt,
      } : {}),
    })),
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
  });
  await writeStartHereMd({
    targetPath: paths.startHerePath,
    bundleId,
    bundleRootDir: paths.rootDir,
    repos: reposSummary.map((r) => ({ id: r.id, headSha: r.headSha })),
  });

  const perRepoOverviews = reposSummary
    .filter((r) => r.kind === 'github' || r.kind === 'local' || r.kind === 'web')
    .map((r) => {
      const repoId = r.id;
      const repoFiles = allIngestedFiles.filter((f) => f.repoId === repoId);
      return { repoId, headSha: r.headSha, files: repoFiles };
    });

  const overviewMd = await generateOverviewMarkdown({
    bundleId,
    bundleRootDir: paths.rootDir,
    repos: perRepoOverviews,
  });
  await writeOverviewFile(paths.overviewPath, overviewMd);

  // Refresh static facts (FACTS.json) after update.
  reportProgress('analyzing', 92, 'Analyzing bundle...');
  await generateFactsBestEffort({
    bundleId,
    bundleRoot: paths.rootDir,
    files: allIngestedFiles,
    mode: cfg.analysisMode,
  });

  // Run advanced analyzers (GoF patterns, architectural, test examples, config)
  // This updates analysis/*.json files
  reportProgress('analyzing', 95, 'Running advanced analyzers...');
  await runAdvancedAnalyzersBestEffort({
    bundleId,
    bundleRoot: paths.rootDir,
    files: allIngestedFiles,
    manifest: newManifest,
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
  };

  return { summary, changed };
}

// ============================================================================
// Document Bundle Creation
// ============================================================================

export type CreateDocumentBundleResult = {
  bundleId: string;
  created: boolean;
  parsed: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
};

export type CreateDocumentBundleOptions = {
  maxPages?: number;
  ifExists?: 'returnExisting' | 'error' | 'update';
};

/**
 * Compute a stable bundle ID from document paths.
 * Ensures idempotency: same set of documents → same bundleId.
 */
function computeDocumentBundleFingerprint(docPaths: string[]): string {
  const normalized = docPaths
    .map((p) => path.resolve(p).replace(/\\/g, '/').toLowerCase())
    .sort();
  const input = JSON.stringify({ schemaVersion: 1, type: 'document', paths: normalized });
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Create a document-only bundle directly from document files (PDF, Office, etc.).
 * 
 * This is a simplified flow that bypasses the intermediate docs_repo layer:
 * PDF → parse → bundle/docs/*.md → FTS index
 * 
 * @param cfg - Preflight configuration
 * @param docPaths - Array of document file paths to ingest
 * @param options - Optional configuration
 * @returns Bundle creation result with bundleId and statistics
 */
export async function createDocumentBundle(
  cfg: PreflightConfig,
  docPaths: string[],
  options?: CreateDocumentBundleOptions
): Promise<CreateDocumentBundleResult> {
  // Apply concurrency limiting
  return await bundleCreationLimiter.run(async () => {
    return await createDocumentBundleInternal(cfg, docPaths, options);
  });
}

async function createDocumentBundleInternal(
  cfg: PreflightConfig,
  docPaths: string[],
  options?: CreateDocumentBundleOptions
): Promise<CreateDocumentBundleResult> {
  const fingerprint = computeDocumentBundleFingerprint(docPaths);
  const ifExists = options?.ifExists ?? 'returnExisting';

  // Check for existing bundle with same fingerprint
  const existing = await findExistingBundleByFingerprint(cfg, fingerprint);
  if (existing) {
    if (ifExists === 'returnExisting') {
      return {
        bundleId: existing,
        created: false,
        parsed: 0,
        skipped: 0,
        errors: [],
      };
    }
    if (ifExists === 'error') {
      throw new Error(`Document bundle already exists: ${existing}`);
    }
    // ifExists === 'update': fall through to update the bundle
  }

  // Generate stable bundleId from fingerprint (first 16 chars + 'doc-' prefix)
  const bundleId = `doc-${fingerprint.slice(0, 32)}`;
  const createdAt = nowIso();

  // Use effective storage dir
  const effectiveStorageDir = await getEffectiveStorageDirForWrite(cfg);
  
  // Create in temporary directory for atomic creation
  const tmpBundlesDir = path.join(cfg.tmpDir, 'bundles-wip');
  await ensureDir(tmpBundlesDir);
  
  const tmpPaths = getBundlePaths(tmpBundlesDir, bundleId);
  await ensureDir(tmpPaths.rootDir);
  
  const finalPaths = getBundlePaths(effectiveStorageDir, bundleId);

  // Create docs directory
  const docsDir = path.join(tmpPaths.rootDir, 'docs');
  await ensureDir(docsDir);
  
  // Create indexes directory
  await ensureDir(tmpPaths.indexesDir);

  const ingestedFiles: IngestedFile[] = [];
  let parsed = 0;
  let skipped = 0;
  const errors: Array<{ path: string; error: string }> = [];
  const docEntries: Array<{ sourcePath: string; docHash: string; bundleRelPath: string }> = [];

  try {
    // Process each document
    for (const docPath of docPaths) {
      const absPath = path.resolve(docPath);

      // Check if file exists and is parseable
      try {
        const st = await fs.stat(absPath);
        if (!st.isFile()) {
          skipped++;
          errors.push({ path: absPath, error: 'not a file' });
          continue;
        }
      } catch (err) {
        skipped++;
        errors.push({ path: absPath, error: `cannot access: ${(err as Error).message}` });
        continue;
      }

      if (!isParseableDocument(absPath)) {
        skipped++;
        errors.push({ path: absPath, error: 'unsupported document format' });
        continue;
      }

      // Parse the document with smart analysis and VLM if configured
      const vlmConfig = cfg.vlmEnabled && cfg.vlmApiKey && cfg.vlmApiBase ? {
        apiBase: cfg.vlmApiBase,
        apiKey: cfg.vlmApiKey,
        model: cfg.vlmModel,
      } : undefined;
      
      const parseResult = await ingestDocument(absPath, {
        extractImages: true,
        extractTables: true,
        extractEquations: true,
        maxPagesPerDocument: options?.maxPages,
        smartAnalysis: true,
        vlmConfig,
      });

      if (!parseResult.success || !parseResult.fullText) {
        skipped++;
        errors.push({ path: absPath, error: parseResult.error ?? 'failed to extract text' });
        continue;
      }

      // Build markdown content with structured elements
      const mdParts: string[] = [
        '<!-- preflight-doc -->',
        `<!-- source: ${absPath} -->`,
        `<!-- extracted_at: ${createdAt} -->`,
        '',
        parseResult.fullText.trim(),
      ];
      
      // Append extracted equations
      const rawContents = parseResult.rawContents ?? [];
      const equations = rawContents.filter(c => c.type === 'equation');
      if (equations.length > 0) {
        mdParts.push('');
        mdParts.push('## Extracted Equations');
        for (const eq of equations) {
          if (typeof eq.content === 'string') {
            mdParts.push(`$$${eq.content}$$`);
          }
        }
      }
      
      // Append extracted tables
      const tables = rawContents.filter(c => c.type === 'table');
      if (tables.length > 0) {
        mdParts.push('');
        mdParts.push('## Extracted Tables');
        for (const tbl of tables) {
          if (typeof tbl.content === 'object' && 'rows' in tbl.content) {
            const tableData = tbl.content as { headers?: string[]; rows: string[][] };
            if (tableData.headers) {
              mdParts.push('| ' + tableData.headers.join(' | ') + ' |');
              mdParts.push('| ' + tableData.headers.map(() => '---').join(' | ') + ' |');
            }
            for (const row of tableData.rows) {
              mdParts.push('| ' + row.join(' | ') + ' |');
            }
            mdParts.push('');
          }
        }
      }
      
      // Append code blocks
      const codeBlocks = rawContents.filter(c => c.type === 'code_block');
      if (codeBlocks.length > 0) {
        mdParts.push('');
        mdParts.push('## Extracted Code');
        for (const cb of codeBlocks) {
          if (typeof cb.content === 'object' && 'code' in cb.content) {
            const codeData = cb.content as { code: string; language?: string };
            mdParts.push('```' + (codeData.language || ''));
            mdParts.push(codeData.code);
            mdParts.push('```');
          }
        }
      }
      
      // Note: Images are stored as base64 in contents but not written to markdown
      // (would make files too large). Could be extracted to separate files if needed.
      const imageCount = rawContents.filter(c => c.type === 'image').length;
      if (imageCount > 0) {
        mdParts.push('');
        mdParts.push(`<!-- ${imageCount} image(s) extracted but not embedded -->`);
      }
      
      const fullMarkdown = mdParts.join('\n');
      
      // Compute content hash for deduplication and filename
      const contentHash = sha256Text(fullMarkdown);
      const docFileName = `${contentHash.slice(0, 16)}.md`;
      const bundleRelPath = `docs/${docFileName}`;
      const outPath = path.join(docsDir, docFileName);

      await fs.writeFile(outPath, fullMarkdown + '\n', 'utf8');

      // Track for indexing
      const fileStat = await fs.stat(outPath);
      ingestedFiles.push({
        repoId: 'document',
        kind: 'doc',
        repoRelativePath: docFileName,
        bundleNormRelativePath: bundleRelPath,
        bundleNormAbsPath: outPath,
        sha256: contentHash,
        bytes: fileStat.size,
      });

      docEntries.push({ sourcePath: absPath, docHash: contentHash, bundleRelPath });
      parsed++;
    }

    // Build FTS index (docs only)
    await rebuildIndex(tmpPaths.searchDbPath, ingestedFiles, {
      includeDocs: true,
      includeCode: false,
    });

    // Create manifest
    const manifest: BundleManifestV1 = {
      schemaVersion: 1,
      bundleId,
      createdAt,
      updatedAt: createdAt,
      type: 'document',
      fingerprint,
      displayName: `Documents (${parsed} files)`,
      description: `Document bundle containing ${parsed} parsed document(s)`,
      tags: ['documents'],
      inputs: {
        repos: [],
      },
      repos: [],
      index: {
        backend: 'sqlite-fts5-lines',
        includeDocs: true,
        includeCode: false,
      },
    };

    await writeManifest(tmpPaths.manifestPath, manifest);

    // Validate bundle completeness (minimal check for document bundles)
    const manifestStat = await statOrNull(tmpPaths.manifestPath);
    const indexStat = await statOrNull(tmpPaths.searchDbPath);
    if (!manifestStat || !indexStat) {
      throw new Error('Document bundle creation incomplete: missing manifest or index');
    }

    // Atomic move from temp to final location
    await ensureDir(effectiveStorageDir);
    
    try {
      await fs.rename(tmpPaths.rootDir, finalPaths.rootDir);
      logger.info(`Document bundle ${bundleId} moved atomically to ${finalPaths.rootDir}`);
    } catch (renameErr) {
      const errCode = (renameErr as NodeJS.ErrnoException).code;
      if (errCode === 'EXDEV') {
        logger.warn(`Cross-filesystem move for document bundle ${bundleId}, falling back to copy`);
        await copyDir(tmpPaths.rootDir, finalPaths.rootDir);
        await rmIfExists(tmpPaths.rootDir);
      } else {
        throw renameErr;
      }
    }

    // Update de-duplication index
    await updateDedupIndexBestEffort(cfg, fingerprint, bundleId, createdAt, 'complete');

    // Mirror to backup storage directories
    if (cfg.storageDirs.length > 1) {
      await mirrorBundleToBackups(effectiveStorageDir, cfg.storageDirs, bundleId);
    }

    return {
      bundleId,
      created: true,
      parsed,
      skipped,
      errors,
    };

  } catch (err) {
    // Clean up temp directory on failure
    logger.error(`Document bundle creation failed, cleaning up: ${bundleId}`, err instanceof Error ? err : undefined);
    await rmIfExists(tmpPaths.rootDir);
    throw new Error(`Failed to create document bundle: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // Ensure temp cleanup
    await rmIfExists(tmpPaths.rootDir).catch(() => {});
  }
}

export async function getBundleRoot(storageDir: string, bundleId: string): Promise<string> {
  const paths = getBundlePaths(storageDir, bundleId);
  return paths.rootDir;
}

export function getBundlePathsForId(storageDir: string, bundleId: string) {
  return getBundlePaths(storageDir, bundleId);
}
