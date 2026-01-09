/**
 * Bundle deduplication index management.
 * Tracks bundle fingerprints to avoid recreating identical bundles.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { type PreflightConfig } from '../../config.js';
import { logger } from '../../logging/logger.js';

const DEDUP_INDEX_FILE = '.preflight-dedup-index.json';

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

function nowIso(): string {
  return new Date().toISOString();
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

/**
 * Get the path to the dedup index file for a storage directory.
 */
export function dedupIndexPath(storageDir: string): string {
  return path.join(storageDir, DEDUP_INDEX_FILE);
}

/**
 * Check if a path's parent directory exists and is accessible.
 */
async function isParentAvailable(p: string): Promise<boolean> {
  try {
    const parent = path.dirname(p);
    await fs.access(parent);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a path exists and is accessible.
 */
async function isPathAvailable(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the dedup index from a storage directory.
 * Returns an empty index if the file doesn't exist or is invalid.
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
 * Write the dedup index to a storage directory.
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
 * Update the dedup index across all storage directories (best-effort).
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

/**
 * Set an in-progress lock for a fingerprint.
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
 * Clear an in-progress lock (on failure or completion with status='complete').
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
