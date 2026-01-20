/**
 * Bundle De-duplication Module
 *
 * Manages the de-duplication index for bundles, preventing duplicate
 * bundle creation and tracking in-progress locks.
 *
 * This module was extracted from service.ts to follow Single Responsibility Principle.
 *
 * @module bundle/deduplicator
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { PreflightConfig } from '../config.js';
import { logger } from '../logging/logger.js';
import { parseOwnerRepo } from './github.js';
import { getBundlePaths, type BundlePaths } from './paths.js';
import { readManifest, type RepoInput } from './manifest.js';
import { listBundles, bundleExistsMulti } from './list.js';

// ============================================================================
// Types
// ============================================================================

export type DedupEntryStatus = 'complete' | 'in-progress';

export type DedupEntry = {
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

export type DedupIndexV1 = {
  schemaVersion: 1;
  updatedAt: string;
  byFingerprint: Record<string, DedupEntry>;
};

export type CreateBundleInput = {
  repos: RepoInput[];
  libraries?: string[];
  topics?: string[];
};

// ============================================================================
// Constants
// ============================================================================

const DEDUP_INDEX_FILE = '.preflight-dedup-index.json';

// ============================================================================
// Utility Functions
// ============================================================================

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

async function isPathAvailable(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isParentAvailable(p: string): Promise<boolean> {
  const parent = path.dirname(p);
  return isPathAvailable(parent);
}

// ============================================================================
// Fingerprint Generation
// ============================================================================

function normalizeList(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toLowerCase())
    .sort();
}

/** Canonical web config for fingerprinting (sorted fields) */
type CanonicalWebConfig = {
  maxPages?: number;
  maxDepth?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
};

type CanonicalRepoInput =
  | { kind: 'github'; repo: string; ref?: string }
  | { kind: 'web'; url: string; config?: CanonicalWebConfig };

/**
 * Normalize web URL for consistent fingerprinting.
 * - Lowercase host
 * - Remove default ports (80/443)
 * - Remove trailing slash for non-root paths
 * - Remove fragment
 */
function normalizeWebUrlForFingerprint(url: string): string {
  try {
    const parsed = new URL(url);
    // Lowercase host
    let normalized = `${parsed.protocol}//${parsed.hostname.toLowerCase()}`;
    // Remove default ports
    if (parsed.port && !((parsed.protocol === 'http:' && parsed.port === '80') ||
        (parsed.protocol === 'https:' && parsed.port === '443'))) {
      normalized += `:${parsed.port}`;
    }
    // Normalize path: remove trailing slash for non-root paths
    let pathname = parsed.pathname;
    if (pathname !== '/' && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    normalized += pathname;
    return normalized;
  } catch {
    return url.toLowerCase();
  }
}

function canonicalizeCreateInput(input: CreateBundleInput): {
  schemaVersion: 1;
  repos: CanonicalRepoInput[];
  libraries: string[];
  topics: string[];
} {
  const repos: CanonicalRepoInput[] = input.repos
    .map((r): CanonicalRepoInput => {
      if (r.kind === 'web') {
        const normalizedUrl = normalizeWebUrlForFingerprint(r.url);
        // Include config in fingerprint (different configs = different bundles)
        const canonicalConfig: CanonicalWebConfig | undefined = r.config ? {
          maxPages: r.config.maxPages,
          maxDepth: r.config.maxDepth,
          includePatterns: r.config.includePatterns ? [...r.config.includePatterns].sort() : undefined,
          excludePatterns: r.config.excludePatterns ? [...r.config.excludePatterns].sort() : undefined,
        } : undefined;
        // Remove undefined values
        if (canonicalConfig) {
          Object.keys(canonicalConfig).forEach(key => {
            if ((canonicalConfig as any)[key] === undefined) {
              delete (canonicalConfig as any)[key];
            }
          });
        }
        return {
          kind: 'web' as const,
          url: normalizedUrl,
          config: canonicalConfig && Object.keys(canonicalConfig).length > 0 ? canonicalConfig : undefined,
        };
      }
      // For de-duplication, treat local imports as equivalent to github imports of the same logical repo/ref.
      const { owner, repo } = parseOwnerRepo(r.repo);
      return {
        kind: 'github' as const,
        repo: `${owner.toLowerCase()}/${repo.toLowerCase()}`,
        ref: (r.ref ?? '').trim() || undefined,
      };
    })
    .sort((a, b) => {
      const ka = a.kind === 'web' ? `web:${a.url}:${JSON.stringify(a.config ?? {})}` : `github:${a.repo}:${a.ref ?? ''}`;
      const kb = b.kind === 'web' ? `web:${b.url}:${JSON.stringify(b.config ?? {})}` : `github:${b.repo}:${b.ref ?? ''}`;
      return ka.localeCompare(kb);
    });

  return {
    schemaVersion: 1,
    repos,
    libraries: normalizeList(input.libraries),
    topics: normalizeList(input.topics),
  };
}

/**
 * Compute a deterministic fingerprint for bundle creation inputs.
 * Used for de-duplication to prevent creating duplicate bundles.
 */
export function computeCreateInputFingerprint(input: CreateBundleInput): string {
  const canonical = canonicalizeCreateInput(input);
  return sha256Hex(JSON.stringify(canonical));
}

// ============================================================================
// Dedup Index Operations
// ============================================================================

function dedupIndexPath(storageDir: string): string {
  return path.join(storageDir, DEDUP_INDEX_FILE);
}

/**
 * Read the de-duplication index from a storage directory.
 */
export async function readDedupIndex(storageDir: string): Promise<DedupIndexV1> {
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

/**
 * Write the de-duplication index to a storage directory.
 * Uses atomic write (temp file + rename) to prevent corruption.
 */
export async function writeDedupIndex(storageDir: string, idx: DedupIndexV1): Promise<void> {
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

/**
 * Update the de-duplication index in all storage directories (best-effort).
 */
export async function updateDedupIndexBestEffort(
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

// ============================================================================
// In-Progress Lock Management
// ============================================================================

/**
 * Set in-progress lock for a fingerprint.
 * Returns false if already locked (not timed out).
 */
export async function setInProgressLock(
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
export async function clearInProgressLock(cfg: PreflightConfig, fingerprint: string): Promise<void> {
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

// ============================================================================
// Bundle Lookup
// ============================================================================

/**
 * Find an existing bundle by fingerprint.
 * First checks the dedup index (fast path), then scans manifests (slow path).
 */
export async function findExistingBundleByFingerprint(cfg: PreflightConfig, fingerprint: string): Promise<string | null> {
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

/**
 * Find an existing bundle by input specification.
 */
export async function findBundleByInputs(cfg: PreflightConfig, input: CreateBundleInput): Promise<string | null> {
  const fingerprint = computeCreateInputFingerprint(input);
  return findExistingBundleByFingerprint(cfg, fingerprint);
}
