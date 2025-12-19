/**
 * Concurrency limiter to prevent DoS attacks via resource exhaustion.
 * Limits the number of concurrent operations (e.g., bundle creations).
 */

import { logger } from '../logging/logger.js';

export class ConcurrencyLimiter {
  private activeCount = 0;
  private readonly maxConcurrent: number;
  private readonly queue: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    addedAt: number;
  }> = [];
  private readonly queueTimeoutMs: number;

  constructor(maxConcurrent: number, queueTimeoutMs = 5 * 60 * 1000) {
    if (maxConcurrent <= 0) {
      throw new Error('maxConcurrent must be positive');
    }
    this.maxConcurrent = maxConcurrent;
    this.queueTimeoutMs = queueTimeoutMs;
  }

  /**
   * Acquire a slot for executing an operation.
   * Waits in queue if all slots are occupied.
   * Throws if waiting exceeds queueTimeoutMs.
   */
  async acquire(): Promise<void> {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++;
      logger.debug(`Concurrency slot acquired (${this.activeCount}/${this.maxConcurrent})`);
      return;
    }

    // Queue is full, wait for a slot
    logger.info(`Concurrency limit reached (${this.maxConcurrent}), queuing request. Queue size: ${this.queue.length}`);
    
    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        // Remove from queue
        const index = this.queue.findIndex(item => item.resolve === resolve);
        if (index >= 0) {
          this.queue.splice(index, 1);
        }
        reject(new Error(`Operation timed out waiting in queue (${this.queueTimeoutMs}ms)`));
      }, this.queueTimeoutMs);

      this.queue.push({
        resolve: () => {
          clearTimeout(timeoutId);
          this.activeCount++;
          logger.debug(`Concurrency slot acquired from queue (${this.activeCount}/${this.maxConcurrent})`);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timeoutId);
          reject(err);
        },
        addedAt: Date.now(),
      });
    });
  }

  /**
   * Release a slot after operation completes.
   */
  release(): void {
    if (this.activeCount <= 0) {
      logger.warn('ConcurrencyLimiter.release() called with no active operations');
      return;
    }

    this.activeCount--;
    logger.debug(`Concurrency slot released (${this.activeCount}/${this.maxConcurrent})`);

    // Process next item in queue
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        const waitTime = Date.now() - next.addedAt;
        logger.info(`Processing queued request (waited ${waitTime}ms)`);
        next.resolve();
      }
    }
  }

  /**
   * Execute a function with concurrency control.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Get current status for monitoring.
   */
  getStatus(): { active: number; max: number; queued: number } {
    return {
      active: this.activeCount,
      max: this.maxConcurrent,
      queued: this.queue.length,
    };
  }
}

// Global limiter for bundle creation operations
// Default: allow 10 concurrent bundle creations
export const bundleCreationLimiter = new ConcurrencyLimiter(
  parseInt(process.env.PREFLIGHT_MAX_CONCURRENT_BUNDLES ?? '10', 10)
);
