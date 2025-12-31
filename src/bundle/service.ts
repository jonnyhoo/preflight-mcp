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
import { downloadAndExtractGitHubArchive } from './githubArchive.js';
import { classifyIngestedFileKind, ingestRepoToBundle, type IngestedFile } from './ingest.js';
import { type RepoInput, type BundleManifestV1, type SkippedFileEntry, writeManifest, readManifest } from './manifest.js';
import { getBundlePaths, repoMetaPath, repoNormDir, repoRawDir, repoRootDir } from './paths.js';
import { writeAgentsMd, writeStartHereMd } from './guides.js';
import { generateOverviewMarkdown, writeOverviewFile } from './overview.js';
import { rebuildIndex } from '../search/sqliteFts.js';
import { ingestContext7Libraries, type Context7LibrarySummary } from './context7.js';
import { analyzeBundleStatic, type AnalysisMode } from './analysis.js';
import { autoDetectTags, generateDisplayName, generateDescription } from './tagging.js';
import { bundleCreationLimiter } from '../core/concurrency-limiter.js';
import { getProgressTracker, type TaskPhase, formatBytes, calcPercent } from '../jobs/progressTracker.js';
import { BundleNotFoundError } from '../errors.js';

/** Progress callback for reporting bundle creation progress */
export type BundleProgressCallback = (phase: TaskPhase, progress: number, message: string, total?: number) => void;

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

const DEDUP_INDEX_FILE = '.preflight-dedup-index.json';

type DedupEntryStatus = 'complete' | 'in-progress';

type DedupEntry = {
  bundleId: string;
  bundleUpdatedAt: string;
  /** Status of the bundle creation. 'complete' means done, 'in-progress' means still creating. */
  status?: DedupEntryStatus;
  /** Start time of in-progress creation (ISO string) */
  startedAt?: string;
  /** Task ID for in-progress creation */
  taskId?: string;
  /** Repos being processed (for display) */
  repos?: string[];
};

type DedupIndexV1 = {
  schemaVersion: 1;
  updatedAt: string;
  byFingerprint: Record<string, DedupEntry>;
};

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Parse a skipped file string (from ingest) into structured SkippedFileEntry.
 * Formats:
 * - "path/to/file (too large: 12345 bytes)"
 * - "path/to/file (binary)"
 * - "path/to/file (non-utf8)"
 * - "(bundle maxTotalBytes reached) stopped before: path/to/file"
 */
function parseSkippedString(s: string, repoId: string): SkippedFileEntry | null {
  // Pattern: "path (too large: 12345 bytes)"
  const tooLargeMatch = s.match(/^(.+?) \(too large: (\d+) bytes\)$/);
  if (tooLargeMatch) {
    return {
      path: `${repoId}/${tooLargeMatch[1]}`,
      reason: 'too_large',
      size: parseInt(tooLargeMatch[2]!, 10),
    };
  }

  // Pattern: "path (binary)"
  const binaryMatch = s.match(/^(.+?) \(binary\)$/);
  if (binaryMatch) {
    return {
      path: `${repoId}/${binaryMatch[1]}`,
      reason: 'binary',
    };
  }

  // Pattern: "path (non-utf8)"
  const nonUtf8Match = s.match(/^(.+?) \(non-utf8\)$/);
  if (nonUtf8Match) {
    return {
      path: `${repoId}/${nonUtf8Match[1]}`,
      reason: 'non_utf8',
    };
  }

  // Pattern: "(bundle maxTotalBytes reached) stopped before: path"
  const maxTotalMatch = s.match(/^\(bundle maxTotalBytes reached\) stopped before: (.+)$/);
  if (maxTotalMatch) {
    return {
      path: `${repoId}/${maxTotalMatch[1]}`,
      reason: 'max_total_reached',
    };
  }

  return null;
}

function normalizeList(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toLowerCase())
    .sort();
}

function canonicalizeCreateInput(input: CreateBundleInput): {
  schemaVersion: 1;
  repos: Array<{ kind: 'github'; repo: string; ref?: string }>;
  libraries: string[];
  topics: string[];
} {
  const repos = input.repos
    .map((r) => {
      // For de-duplication, treat local imports as equivalent to github imports of the same logical repo/ref.
      const { owner, repo } = parseOwnerRepo(r.repo);
      return {
        kind: 'github' as const,
        repo: `${owner.toLowerCase()}/${repo.toLowerCase()}`,
        ref: (r.ref ?? '').trim() || undefined,
      };
    })
    .sort((a, b) => {
      const ka = `github:${a.repo}:${a.ref ?? ''}`;
      const kb = `github:${b.repo}:${b.ref ?? ''}`;
      return ka.localeCompare(kb);
    });

  return {
    schemaVersion: 1,
    repos,
    libraries: normalizeList(input.libraries),
    topics: normalizeList(input.topics),
  };
}

export function computeCreateInputFingerprint(input: CreateBundleInput): string {
  const canonical = canonicalizeCreateInput(input);
  return sha256Hex(JSON.stringify(canonical));
}

function dedupIndexPath(storageDir: string): string {
  return path.join(storageDir, DEDUP_INDEX_FILE);
}

async function readDedupIndex(storageDir: string): Promise<DedupIndexV1> {
  const p = dedupIndexPath(storageDir);
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as DedupIndexV1;
    if (parsed.schemaVersion !== 1 || typeof parsed.byFingerprint !== 'object' || !parsed.byFingerprint) {
      return { schemaVersion: 1, updatedAt: nowIso(), byFingerprint: {} };
    }
    return parsed;
  } catch {
    return { schemaVersion: 1, updatedAt: nowIso(), byFingerprint: {} };
  }
}

async function writeDedupIndex(storageDir: string, idx: DedupIndexV1): Promise<void> {
  const p = dedupIndexPath(storageDir);
  await ensureDir(path.dirname(p));
  
  // Use atomic write (write to temp file, then rename) to prevent corruption
  const tmpPath = `${p}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(idx, null, 2) + '\n', 'utf8');
    // Atomic rename on POSIX; near-atomic on Windows
    await fs.rename(tmpPath, p);
  } catch (err) {
    // Clean up temp file on error
    try {
      await fs.unlink(tmpPath);
    } catch (cleanupErr) {
      logger.debug('Failed to cleanup temp dedup index file (non-critical)', cleanupErr instanceof Error ? cleanupErr : undefined);
    }
    throw err;
  }
}

async function updateDedupIndexBestEffort(
  cfg: PreflightConfig,
  fingerprint: string,
  bundleId: string,
  bundleUpdatedAt: string,
  status: DedupEntryStatus = 'complete'
): Promise<void> {
  for (const storageDir of cfg.storageDirs) {
    try {
      const parentAvailable = await isParentAvailable(storageDir);
      if (!parentAvailable) continue;
      await ensureDir(storageDir);

      const idx = await readDedupIndex(storageDir);
      idx.byFingerprint[fingerprint] = { bundleId, bundleUpdatedAt, status };
      idx.updatedAt = nowIso();
      await writeDedupIndex(storageDir, idx);
    } catch (err) {
      logger.debug(`Failed to update dedup index in ${storageDir} (best-effort)`, err instanceof Error ? err : undefined);
    }
  }
}

/**
 * Set in-progress lock for a fingerprint. Returns false if already locked (not timed out).
 */
async function setInProgressLock(
  cfg: PreflightConfig,
  fingerprint: string,
  taskId: string,
  repos: string[]
): Promise<{ locked: true } | { locked: false; existingEntry: DedupEntry }> {
  const now = nowIso();
  const nowMs = Date.now();

  for (const storageDir of cfg.storageDirs) {
    try {
      if (!(await isPathAvailable(storageDir))) continue;
      await ensureDir(storageDir);

      const idx = await readDedupIndex(storageDir);
      const existing = idx.byFingerprint[fingerprint];

      // Check if there's an existing in-progress lock
      if (existing?.status === 'in-progress' && existing.startedAt) {
        const startedMs = new Date(existing.startedAt).getTime();
        const elapsed = nowMs - startedMs;
        
        // If lock hasn't timed out, return the existing entry
        if (elapsed < cfg.inProgressLockTimeoutMs) {
          return { locked: false, existingEntry: existing };
        }
        // Lock timed out - will be overwritten
        logger.warn(`In-progress lock timed out for fingerprint ${fingerprint.slice(0, 8)}...`);
      }

      // Set new in-progress lock
      idx.byFingerprint[fingerprint] = {
        bundleId: '', // Will be set on completion
        bundleUpdatedAt: now,
        status: 'in-progress',
        startedAt: now,
        taskId,
        repos,
      };
      idx.updatedAt = now;
      await writeDedupIndex(storageDir, idx);
      
      return { locked: true };
    } catch (err) {
      logger.debug(`Failed to set in-progress lock in ${storageDir}`, err instanceof Error ? err : undefined);
    }
  }

  // If we couldn't write to any storage, assume we can proceed (best-effort)
  return { locked: true };
}

/**
 * Clear in-progress lock (on failure or completion with status='complete').
 */
async function clearInProgressLock(cfg: PreflightConfig, fingerprint: string): Promise<void> {
  for (const storageDir of cfg.storageDirs) {
    try {
      if (!(await isPathAvailable(storageDir))) continue;

      const idx = await readDedupIndex(storageDir);
      const existing = idx.byFingerprint[fingerprint];
      
      // Only clear if it's in-progress
      if (existing?.status === 'in-progress') {
        delete idx.byFingerprint[fingerprint];
        idx.updatedAt = nowIso();
        await writeDedupIndex(storageDir, idx);
      }
    } catch (err) {
      logger.debug(`Failed to clear in-progress lock in ${storageDir}`, err instanceof Error ? err : undefined);
    }
  }
}

/**
 * Check if a fingerprint has an in-progress lock (not timed out).
 */
export async function checkInProgressLock(cfg: PreflightConfig, fingerprint: string): Promise<DedupEntry | null> {
  const nowMs = Date.now();

  for (const storageDir of cfg.storageDirs) {
    try {
      if (!(await isPathAvailable(storageDir))) continue;

      const idx = await readDedupIndex(storageDir);
      const existing = idx.byFingerprint[fingerprint];
      
      if (existing?.status === 'in-progress' && existing.startedAt) {
        const startedMs = new Date(existing.startedAt).getTime();
        const elapsed = nowMs - startedMs;
        
        if (elapsed < cfg.inProgressLockTimeoutMs) {
          return existing;
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

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

export async function findBundleByInputs(cfg: PreflightConfig, input: CreateBundleInput): Promise<string | null> {
  const fingerprint = computeCreateInputFingerprint(input);
  return findExistingBundleByFingerprint(cfg, fingerprint);
}

async function findExistingBundleByFingerprint(cfg: PreflightConfig, fingerprint: string): Promise<string | null> {
  // Fast path: consult any available dedup index.
  for (const storageDir of cfg.storageDirs) {
    try {
      if (!(await isPathAvailable(storageDir))) continue;
      const idx = await readDedupIndex(storageDir);
      const hit = idx.byFingerprint[fingerprint];
      // Skip in-progress entries - they don't have a completed bundle yet
      if (hit?.status === 'in-progress') continue;
      if (hit?.bundleId && (await bundleExistsMulti(cfg.storageDirs, hit.bundleId))) {
        return hit.bundleId;
      }
    } catch {
      // ignore
    }
  }

  // Slow path: scan manifests (works even for bundles created before fingerprints existed).
  let best: { bundleId: string; updatedAt: string } | null = null;

  for (const storageDir of cfg.storageDirs) {
    if (!(await isPathAvailable(storageDir))) continue;

    const ids = await listBundles(storageDir);
    for (const id of ids) {
      try {
        const paths = getBundlePaths(storageDir, id);
        const manifest = await readManifest(paths.manifestPath);
        const fp = computeCreateInputFingerprint({
          repos: manifest.inputs.repos,
          libraries: manifest.inputs.libraries,
          topics: manifest.inputs.topics,
        });

        if (fp === fingerprint) {
          const updatedAt = manifest.updatedAt;
          if (!best || new Date(updatedAt) > new Date(best.updatedAt)) {
            best = { bundleId: manifest.bundleId, updatedAt };
          }
        }
      } catch {
        // ignore corrupt bundles
      }
    }
  }

  if (best) {
    // Seed index for next time (best-effort).
    await updateDedupIndexBestEffort(cfg, fingerprint, best.bundleId, best.updatedAt);
    return best.bundleId;
  }

  return null;
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

async function statOrNull(p: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function readUtf8OrNull(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

async function* walkFilesNoIgnore(rootDir: string): AsyncGenerator<{ absPath: string; relPosix: string }> {
  const stack: string[] = [rootDir];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = toPosix(path.relative(rootDir, abs));
      if (ent.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      yield { absPath: abs, relPosix: rel };
    }
  }
}

async function writeRepoMeta(params: {
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
 * Assert that a bundle is complete and ready for operations.
 * Throws an error with helpful guidance if the bundle is incomplete.
 * Should be called at the entry point of tools that require a complete bundle
 * (e.g., dependency graph, trace links, search).
 */
export async function assertBundleComplete(
  cfg: PreflightConfig,
  bundleId: string
): Promise<void> {
  const storageDir = await findBundleStorageDir(cfg.storageDirs, bundleId);
  if (!storageDir) {
    throw new BundleNotFoundError(bundleId);
  }

  const bundleRoot = getBundlePaths(storageDir, bundleId).rootDir;
  const { isValid, missingComponents } = await validateBundleCompleteness(bundleRoot);

  if (!isValid) {
    const issues = missingComponents.join('\n  - ');
    throw new Error(
      `Bundle is incomplete and cannot be used for this operation.\n\n` +
      `Bundle ID: ${bundleId}\n` +
      `Missing components:\n  - ${issues}\n\n` +
      `This usually happens when:\n` +
      `1. Bundle creation was interrupted (timeout, network error, etc.)\n` +
      `2. Bundle download is still in progress\n\n` +
      `Suggested actions:\n` +
      `- Use preflight_update_bundle with force:true to re-download the repository\n` +
      `- Or use preflight_delete_bundle and preflight_create_bundle to start fresh\n` +
      `- Check preflight_get_task_status if creation might still be in progress`
    );
  }
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

  // Mirror to all backup dirs in parallel for better performance
  const mirrorPromises = backupDirs
    .filter(dir => dir !== primaryDir) // Skip primary
    .map(async (backupDir) => {
      const destPath = path.join(backupDir, bundleId);

      try {
        // Check if backup location is available
        const parentAvailable = await isParentAvailable(destPath);
        if (!parentAvailable) {
          return { success: false, path: backupDir, error: 'Mount not available' };
        }

        // Ensure backup dir exists
        await ensureDir(backupDir);

        // Remove old and copy new
        await rmIfExists(destPath);
        await copyDir(srcPath, destPath);
        return { success: true, path: backupDir };
      } catch (err) {
        return { 
          success: false, 
          path: backupDir, 
          error: err instanceof Error ? err.message : String(err) 
        };
      }
    });

  // Wait for all mirror operations to complete
  const results = await Promise.allSettled(mirrorPromises);
  
  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { success, path: backupPath, error } = result.value;
      if (success) {
        mirrored.push(backupPath);
      } else {
        failed.push({ path: backupPath, error: error ?? 'Unknown error' });
      }
    } else {
      // Promise rejection (shouldn't happen with try-catch, but handle it)
      failed.push({ path: 'unknown', error: result.reason?.message ?? String(result.reason) });
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

async function writeLocalRepoMeta(params: {
  metaPath: string;
  repoId: string;
  localPath: string;
  fetchedAt: string;
  ingestedFiles: number;
  skipped: string[];
  ref?: string;
}): Promise<void> {
  await ensureDir(path.dirname(params.metaPath));
  const obj = {
    repoId: params.repoId,
    source: 'local',
    localPath: params.localPath,
    ref: params.ref,
    fetchedAt: params.fetchedAt,
    ingestedFiles: params.ingestedFiles,
    skipped: params.skipped,
  };
  await fs.writeFile(params.metaPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

async function ingestLocalRepo(params: {
  cfg: PreflightConfig;
  bundleId: string;
  storageDir: string;
  owner: string;
  repo: string;
  localPath: string;
  ref?: string;
}): Promise<{ files: IngestedFile[]; skipped: string[] }> {
  const repoId = `${params.owner}/${params.repo}`;
  const repoRoot = path.resolve(params.localPath);

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
  });

  return { files: ingested.files, skipped: ingested.skipped };
}

async function cloneAndIngestGitHubRepo(params: {
  cfg: PreflightConfig;
  bundleId: string;
  storageDir: string;
  owner: string;
  repo: string;
  ref?: string;
  onProgress?: (phase: string, progress: number, message: string) => void;
}): Promise<{
  headSha?: string;
  files: IngestedFile[];
  skipped: string[];
  notes: string[];
  /** User-facing warnings for communication (e.g., git failed, used zip fallback) */
  warnings: string[];
  source: 'git' | 'archive';
}> {
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
    
    // Track zip path for error message
    const zipPath = path.join(tmpArchiveDir, `github-zipball-${params.owner}-${params.repo}-partial.zip`);
    
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

  // Rebuild index.
  reportProgress('indexing', 85, `Rebuilding search index (${allIngestedFiles.length} files)...`);
  await rebuildIndex(paths.searchDbPath, allIngestedFiles, {
    includeDocs: manifest.index.includeDocs,
    includeCode: manifest.index.includeCode,
  });

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

/**
 * Check if a string is a valid UUID (v4 format).
 * Bundle IDs should be UUIDs with dashes.
 */
function isValidBundleId(id: string): boolean {
  // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}

/** List bundles from a single storage directory. */
export async function listBundles(storageDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(storageDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && isValidBundleId(e.name))
      .map((e) => e.name);
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

/**
 * Clear bundle from ALL storage directories (mirror delete).
 * Uses fast rename + background deletion to avoid blocking.
 */
export async function clearBundleMulti(storageDirs: string[], bundleId: string): Promise<boolean> {
  let deleted = false;
  
  for (const dir of storageDirs) {
    try {
      const paths = getBundlePaths(dir, bundleId);
      
      // Check if the bundle directory exists
      try {
        await fs.stat(paths.rootDir);
      } catch {
        // Directory doesn't exist, skip
        continue;
      }
      
      // Fast deletion strategy: rename first (instant), then delete in background
      const deletingPath = `${paths.rootDir}.deleting.${Date.now()}`;
      
      try {
        // Rename is atomic and instant on most filesystems
        await fs.rename(paths.rootDir, deletingPath);
        deleted = true;
        
        // Background deletion (fire-and-forget)
        // The renamed directory is invisible to listBundles (not a valid UUID)
        rmIfExists(deletingPath).catch((err) => {
          logger.warn(`Background deletion failed for ${bundleId}: ${err instanceof Error ? err.message : String(err)}`);
        });
      } catch (err) {
        // Rename failed (maybe concurrent deletion), try direct delete as fallback
        logger.warn(`Rename failed for ${bundleId}, falling back to direct delete`);
        await clearBundle(dir, bundleId);
        deleted = true;
      }
    } catch (err) {
      // Skip unavailable paths
      logger.debug(`Failed to delete bundle from ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  
  return deleted;
}

export async function ensureRepoDirRemoved(storageDir: string, bundleId: string, owner: string, repo: string): Promise<void> {
  const p = getBundlePaths(storageDir, bundleId);
  await rmIfExists(repoRootDir(p, owner, repo));
}
