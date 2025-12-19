import fs from 'node:fs/promises';
import path from 'node:path';
import { Job } from '../core/scheduler.js';
import { logger } from '../logging/logger.js';
import { getConfig } from '../config.js';

/**
 * Cleanup job for temporary directories.
 * Removes temporary checkout directories older than 24 hours.
 */
export class TmpCleanupJob extends Job {
  private readonly maxAgeHours = 24;

  getName(): string {
    return 'tmp-cleanup';
  }

  getMaxRetries(): number {
    return 2; // Fewer retries for cleanup jobs
  }

  async run(): Promise<void> {
    const cfg = getConfig();
    const checkoutsDir = path.join(cfg.tmpDir, 'checkouts');

    try {
      const exists = await this.pathExists(checkoutsDir);
      if (!exists) {
        logger.debug('Checkouts directory does not exist, skipping cleanup');
        return;
      }

      const entries = await fs.readdir(checkoutsDir, { withFileTypes: true });
      const now = Date.now();
      const maxAgeMs = this.maxAgeHours * 60 * 60 * 1000;

      let cleanedCount = 0;
      let errorCount = 0;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const entryPath = path.join(checkoutsDir, entry.name);

        try {
          const stats = await fs.stat(entryPath);
          const ageMs = now - stats.mtimeMs;

          if (ageMs > maxAgeMs) {
            logger.info(`Cleaning up old temporary directory: ${entry.name} (age: ${Math.round(ageMs / 3600000)}h)`);
            await fs.rm(entryPath, { recursive: true, force: true });
            cleanedCount++;
          }
        } catch (err) {
          logger.warn(`Failed to cleanup temporary directory ${entry.name}`, err instanceof Error ? err : undefined);
          errorCount++;
        }
      }

      if (cleanedCount > 0) {
        logger.info(`Temporary directory cleanup completed: ${cleanedCount} removed, ${errorCount} errors`);
      } else {
        logger.debug('No old temporary directories to clean up');
      }
    } catch (err) {
      logger.error('Temporary directory cleanup failed', err instanceof Error ? err : undefined);
      throw err;
    }
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }
}
