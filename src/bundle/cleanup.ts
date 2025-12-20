/**
 * Bundle cleanup utilities for MCP architecture
 * Designed to run on-demand (startup, list, etc.) rather than as a daemon
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../logging/logger.js';
import { type PreflightConfig } from '../config.js';
import { getBundlePaths } from './paths.js';
import { rmIfExists } from '../utils/index.js';

/**
 * Check if a string is a valid UUID (v4 format)
 */
function isValidBundleId(id: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}

/**
 * Check if a bundle is orphaned (incomplete/corrupted)
 */
async function isOrphanBundle(storageDir: string, bundleId: string): Promise<{
  isOrphan: boolean;
  reason?: string;
  ageHours?: number;
}> {
  const bundlePath = path.join(storageDir, bundleId);
  const manifestPath = path.join(bundlePath, 'manifest.json');

  try {
    // Check if manifest exists and is valid
    const manifestContent = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestContent);
    
    // Valid manifest exists
    if (manifest.bundleId && manifest.schemaVersion) {
      return { isOrphan: false };
    }
    
    return { isOrphan: true, reason: 'invalid manifest' };
  } catch {
    // Manifest missing or unreadable
    try {
      const stats = await fs.stat(bundlePath);
      const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
      return { isOrphan: true, reason: 'missing manifest', ageHours };
    } catch {
      return { isOrphan: true, reason: 'directory inaccessible' };
    }
  }
}

/**
 * Clean up orphan bundles from a single storage directory
 * Only removes bundles older than minAgeHours to avoid race conditions
 */
async function cleanupOrphansInDir(
  storageDir: string,
  options: {
    minAgeHours: number;
    dryRun: boolean;
  }
): Promise<{
  found: string[];
  cleaned: string[];
  skipped: Array<{ bundleId: string; reason: string }>;
}> {
  const found: string[] = [];
  const cleaned: string[] = [];
  const skipped: Array<{ bundleId: string; reason: string }> = [];

  try {
    const entries = await fs.readdir(storageDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      // Handle .deleting directories (from background deletion)
      if (entry.name.endsWith('.deleting')) {
        // Always clean .deleting directories (they're already marked for deletion)
        try {
          const deletingPath = path.join(storageDir, entry.name);
          await rmIfExists(deletingPath);
          logger.info(`Cleaned pending deletion: ${entry.name}`);
        } catch (err) {
          logger.warn(`Failed to clean pending deletion ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }
      
      // Only process directories with valid UUID names
      if (!isValidBundleId(entry.name)) {
        continue;
      }

      const bundleId = entry.name;
      const orphanCheck = await isOrphanBundle(storageDir, bundleId);

      if (orphanCheck.isOrphan) {
        found.push(bundleId);

        // Check age threshold
        if (orphanCheck.ageHours !== undefined && orphanCheck.ageHours < options.minAgeHours) {
          skipped.push({
            bundleId,
            reason: `too new (${orphanCheck.ageHours.toFixed(1)}h < ${options.minAgeHours}h)`,
          });
          continue;
        }

        if (!options.dryRun) {
          try {
            const bundlePath = path.join(storageDir, bundleId);
            await rmIfExists(bundlePath);
            cleaned.push(bundleId);
            logger.info(`Cleaned orphan bundle: ${bundleId} (${orphanCheck.reason})`);
          } catch (err) {
            skipped.push({
              bundleId,
              reason: `cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        } else {
          cleaned.push(bundleId); // In dry-run, mark as "would clean"
        }
      }
    }
  } catch (err) {
    logger.warn(`Failed to scan storage dir ${storageDir}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { found, cleaned, skipped };
}

/**
 * Clean up orphan bundles across all storage directories
 * Safe to call on every server startup - fast when no orphans exist
 */
export async function cleanupOrphanBundles(
  cfg: PreflightConfig,
  options?: {
    minAgeHours?: number;
    dryRun?: boolean;
  }
): Promise<{
  totalFound: number;
  totalCleaned: number;
  details: Array<{
    storageDir: string;
    found: string[];
    cleaned: string[];
    skipped: Array<{ bundleId: string; reason: string }>;
  }>;
}> {
  const minAgeHours = options?.minAgeHours ?? 1; // Default: 1 hour safety margin
  const dryRun = options?.dryRun ?? false;

  const details: Array<{
    storageDir: string;
    found: string[];
    cleaned: string[];
    skipped: Array<{ bundleId: string; reason: string }>;
  }> = [];

  let totalFound = 0;
  let totalCleaned = 0;

  for (const storageDir of cfg.storageDirs) {
    const result = await cleanupOrphansInDir(storageDir, { minAgeHours, dryRun });
    
    totalFound += result.found.length;
    totalCleaned += result.cleaned.length;

    if (result.found.length > 0) {
      details.push({
        storageDir,
        ...result,
      });
    }
  }

  if (totalFound > 0) {
    logger.info(
      `Orphan cleanup: found ${totalFound}, cleaned ${totalCleaned}, skipped ${totalFound - totalCleaned}${dryRun ? ' (dry-run)' : ''}`
    );
  }

  return { totalFound, totalCleaned, details };
}

/**
 * Run orphan cleanup on server startup (best-effort, non-blocking)
 * Only logs warnings on failure, doesn't throw
 */
export async function cleanupOnStartup(cfg: PreflightConfig): Promise<void> {
  try {
    const result = await cleanupOrphanBundles(cfg, {
      minAgeHours: 1,
      dryRun: false,
    });

    if (result.totalCleaned > 0) {
      logger.info(`Startup cleanup: removed ${result.totalCleaned} orphan bundle(s)`);
    }
  } catch (err) {
    // Non-critical: just log and continue
    logger.warn(`Startup cleanup failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
  }
}
