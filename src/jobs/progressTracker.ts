/**
 * Progress tracking for long-running bundle creation tasks.
 * Enables progress notifications via MCP and prevents duplicate task creation.
 */

import crypto from 'node:crypto';

export type TaskPhase =
  | 'starting'
  | 'cloning'      // git clone
  | 'downloading'  // zipball download
  | 'extracting'   // unzip
  | 'ingesting'    // file ingestion
  | 'crawling'     // web crawling
  | 'indexing'     // building search index
  | 'analyzing'    // static analysis
  | 'generating'   // generating overview
  | 'finalizing'   // atomic move
  | 'complete'
  | 'failed';

export type TaskProgress = {
  taskId: string;
  fingerprint: string;
  phase: TaskPhase;
  /** Current progress (0-100 for percentage, or absolute value if total is provided) */
  progress: number;
  /** Total value for progress calculation (e.g., total bytes) */
  total?: number;
  /** Human-readable progress message */
  message: string;
  /** Task start time */
  startedAt: string;
  /** Last update time */
  updatedAt: string;
  /** Repository identifiers being processed */
  repos: string[];
  /** Bundle ID (set on completion) */
  bundleId?: string;
  /** Error message (set on failure) */
  error?: string;
};

export type ProgressCallback = (progress: TaskProgress) => void;

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Tracks progress of bundle creation tasks.
 * Provides in-memory state for active tasks and emits progress updates.
 */
export class ProgressTracker {
  private tasks: Map<string, TaskProgress> = new Map();
  private fingerprintToTaskId: Map<string, string> = new Map();
  private progressCallback?: ProgressCallback;

  /**
   * Set a callback to receive progress updates.
   * Used to forward updates to MCP progress notifications.
   */
  setProgressCallback(callback: ProgressCallback): void {
    this.progressCallback = callback;
  }

  /**
   * Start tracking a new task.
   * @returns taskId for the new task
   */
  startTask(fingerprint: string, repos: string[]): string {
    // Check if task already exists for this fingerprint
    const existingTaskId = this.fingerprintToTaskId.get(fingerprint);
    if (existingTaskId) {
      const existingTask = this.tasks.get(existingTaskId);
      if (existingTask && existingTask.phase !== 'complete' && existingTask.phase !== 'failed') {
        // Return existing active task
        return existingTaskId;
      }
    }

    const taskId = crypto.randomUUID();
    const now = nowIso();
    
    const task: TaskProgress = {
      taskId,
      fingerprint,
      phase: 'starting',
      progress: 0,
      message: `Starting bundle creation for ${repos.join(', ')}`,
      startedAt: now,
      updatedAt: now,
      repos,
    };

    this.tasks.set(taskId, task);
    this.fingerprintToTaskId.set(fingerprint, taskId);
    
    this.emitProgress(task);
    
    return taskId;
  }

  /**
   * Update progress for an existing task.
   */
  updateProgress(
    taskId: string,
    phase: TaskPhase,
    progress: number,
    message: string,
    total?: number
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.phase = phase;
    task.progress = progress;
    task.message = message;
    task.updatedAt = nowIso();
    if (total !== undefined) {
      task.total = total;
    }

    this.emitProgress(task);
  }

  /**
   * Mark a task as complete.
   */
  completeTask(taskId: string, bundleId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.phase = 'complete';
    task.progress = 100;
    task.message = `Bundle created: ${bundleId}`;
    task.updatedAt = nowIso();
    task.bundleId = bundleId;

    this.emitProgress(task);
    
    // Clean up after a delay to allow final status queries
    const cleanup = setTimeout(() => {
      this.tasks.delete(taskId);
      if (this.fingerprintToTaskId.get(task.fingerprint) === taskId) {
        this.fingerprintToTaskId.delete(task.fingerprint);
      }
    }, 60_000); // Keep completed task for 1 minute
    cleanup.unref?.();
  }

  /**
   * Mark a task as failed.
   */
  failTask(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.phase = 'failed';
    task.message = `Failed: ${error}`;
    task.updatedAt = nowIso();
    task.error = error;

    this.emitProgress(task);
    
    // Clean up after a delay
    const cleanup = setTimeout(() => {
      this.tasks.delete(taskId);
      if (this.fingerprintToTaskId.get(task.fingerprint) === taskId) {
        this.fingerprintToTaskId.delete(task.fingerprint);
      }
    }, 60_000);
    cleanup.unref?.();
  }

  /**
   * Get task by ID.
   */
  getTask(taskId: string): TaskProgress | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get task by fingerprint.
   */
  getTaskByFingerprint(fingerprint: string): TaskProgress | undefined {
    const taskId = this.fingerprintToTaskId.get(fingerprint);
    if (!taskId) return undefined;
    return this.tasks.get(taskId);
  }

  /**
   * List all active (non-complete, non-failed) tasks.
   */
  listActiveTasks(): TaskProgress[] {
    return Array.from(this.tasks.values()).filter(
      (t) => t.phase !== 'complete' && t.phase !== 'failed'
    );
  }

  /**
   * List all tasks (including recently completed/failed).
   */
  listAllTasks(): TaskProgress[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Check if a task is active (in progress).
   */
  isTaskActive(fingerprint: string): boolean {
    const task = this.getTaskByFingerprint(fingerprint);
    return task !== undefined && task.phase !== 'complete' && task.phase !== 'failed';
  }

  /**
   * Remove a task (e.g., when lock times out).
   */
  removeTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      this.tasks.delete(taskId);
      if (this.fingerprintToTaskId.get(task.fingerprint) === taskId) {
        this.fingerprintToTaskId.delete(task.fingerprint);
      }
    }
  }

  private emitProgress(task: TaskProgress): void {
    if (this.progressCallback) {
      this.progressCallback(task);
    }
  }
}

// Singleton instance for global access
let globalTracker: ProgressTracker | undefined;

export function getProgressTracker(): ProgressTracker {
  if (!globalTracker) {
    globalTracker = new ProgressTracker();
  }
  return globalTracker;
}

/**
 * Helper to format bytes for display.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

/**
 * Helper to calculate percentage.
 */
export function calcPercent(current: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((current / total) * 100));
}
