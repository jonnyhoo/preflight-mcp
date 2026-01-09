/**
 * Storage Directory Management Module
 *
 * Handles multi-directory storage operations including fallback,
 * backup mirroring, and synchronization.
 *
 * This module was extracted from service.ts to follow Single Responsibility Principle.
 *
 * @module bundle/storage
 */

import path from 'node:path';

import type { PreflightConfig } from '../config.js';
import { logger } from '../logging/logger.js';
import { getBundlePaths } from './paths.js';
import { readManifest } from './manifest.js';
import {
  ensureDir,
  isPathAvailable,
  isParentAvailable,
  copyDir,
  rmIfExists,
} from './utils.js';

// ============================================================================
// Storage Directory Selection
// ============================================================================

/**
 * Find the first available storage directory from the list.
 * Returns null if none are available.
 */
export async function findFirstAvailableStorageDir(storageDirs: string[]): Promise<string | null> {
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

// ============================================================================
// Backup and Mirroring
// ============================================================================

/**
 * Mirror a bundle to all backup storage directories.
 * Skips unavailable paths (mount disappeared) without blocking.
 * Returns list of successful/failed mirror targets.
 */
export async function mirrorBundleToBackups(
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
 * Sync stale backups: copy from source to any backup that has older data.
 * Called after reading from a backup (means primary was unavailable).
 */
export async function syncStaleBackups(
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
