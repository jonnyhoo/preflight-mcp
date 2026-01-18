/**
 * preflight_get_task_status - Check status of bundle creation tasks (non-core).
 */

import * as z from 'zod';

import type { ToolDependencies } from '../types.js';
import { GetTaskStatusInputSchema, shouldRegisterTool } from './types.js';
import { checkInProgressLock, computeCreateInputFingerprint } from '../../../bundle/service.js';
import { getProgressTracker, type TaskProgress } from '../../../jobs/progressTracker.js';
import { wrapPreflightError } from '../../../mcp/errorKinds.js';

// ==========================================================================
// preflight_get_task_status
// ==========================================================================

/**
 * Register preflight_get_task_status tool.
 */
export function registerGetTaskStatusTool({ server, cfg }: ToolDependencies, coreOnly: boolean): void {
  if (!shouldRegisterTool('preflight_get_task_status', coreOnly)) return;

  server.registerTool(
    'preflight_get_task_status',
    {
      title: 'Get task status',
      description: 'Check status of bundle creation tasks (especially in-progress ones). Use when: "check bundle creation progress", "what is the status", "查看任务状态", "下载进度". Can query by taskId (from error), fingerprint, or repos.',
      inputSchema: GetTaskStatusInputSchema,
      outputSchema: {
        found: z.boolean(),
        task: z.object({
          taskId: z.string(),
          fingerprint: z.string(),
          phase: z.string(),
          progress: z.number(),
          total: z.number().optional(),
          message: z.string(),
          startedAt: z.string(),
          updatedAt: z.string(),
          repos: z.array(z.string()),
          bundleId: z.string().optional(),
          error: z.string().optional(),
        }).optional(),
        inProgressLock: z.object({
          bundleId: z.string(),
          status: z.string(),
          startedAt: z.string().optional(),
          taskId: z.string().optional(),
          repos: z.array(z.string()).optional(),
          elapsedSeconds: z.number().optional(),
        }).optional(),
        activeTasks: z.array(z.object({
          taskId: z.string(),
          fingerprint: z.string(),
          phase: z.string(),
          progress: z.number(),
          message: z.string(),
          repos: z.array(z.string()),
          startedAt: z.string(),
        })).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const tracker = getProgressTracker();
        let result: {
          found: boolean;
          task?: TaskProgress;
          inProgressLock?: {
            bundleId: string;
            status: string;
            startedAt?: string;
            taskId?: string;
            repos?: string[];
            elapsedSeconds?: number;
          };
          activeTasks?: TaskProgress[];
        } = { found: false };

        let fingerprint = args.fingerprint;
        if (!fingerprint && args.repos?.length) {
          fingerprint = computeCreateInputFingerprint({
            repos: args.repos,
          });
        }

        if (args.taskId) {
          const task = tracker.getTask(args.taskId);
          if (task) {
            result = { found: true, task };
          }
        }
        else if (fingerprint) {
          const task = tracker.getTaskByFingerprint(fingerprint);
          if (task) {
            result = { found: true, task };
          }
          
          const lock = await checkInProgressLock(cfg, fingerprint);
          if (lock) {
            const elapsedSeconds = lock.startedAt
              ? Math.round((Date.now() - new Date(lock.startedAt).getTime()) / 1000)
              : undefined;
            result.inProgressLock = {
              bundleId: lock.bundleId,
              status: lock.status ?? 'unknown',
              startedAt: lock.startedAt,
              taskId: lock.taskId,
              repos: lock.repos,
              elapsedSeconds,
            };
            result.found = true;
          }
        }
        else {
          const activeTasks = tracker.listActiveTasks();
          if (activeTasks.length > 0) {
            result = { found: true, activeTasks };
          }
        }

        const summary = result.found
          ? result.task
            ? `Task ${result.task.taskId}: ${result.task.phase} (${result.task.progress}%) - ${result.task.message}`
            : result.activeTasks
              ? `${result.activeTasks.length} active task(s)`
              : result.inProgressLock
                ? `In-progress lock found (started ${result.inProgressLock.elapsedSeconds}s ago)`
                : 'Status found'
          : 'No matching task found';

        return {
          content: [{ type: 'text', text: summary }],
          structuredContent: result,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );
}
