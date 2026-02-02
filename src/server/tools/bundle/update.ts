/**
 * preflight_update_bundle - Refresh/sync a bundle with latest repo changes (non-core).
 */

import * as z from 'zod';

import type { ToolDependencies } from '../types.js';
import { UpdateBundleInputSchema, shouldRegisterTool } from './types.js';
import {
  checkForUpdates,
  findBundleStorageDir,
  updateBundle,
} from '../../../bundle/service.js';
import { getProgressTracker } from '../../../jobs/progressTracker.js';
import { toBundleFileUri } from '../../../mcp/uris.js';
import { wrapPreflightError } from '../../../mcp/errorKinds.js';
import { BundleNotFoundError } from '../../../errors.js';


const UpdateBundleOutputSchema = z.object({
  changed: z.boolean(),
  checkOnly: z.boolean().optional(),
  updateDetails: z.array(
    z.object({
      repoId: z.string(),
      currentSha: z.string().optional(),
      remoteSha: z.string().optional(),
      changed: z.boolean(),
    })
  ).optional(),
  bundleId: z.string(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  resources: z.object({
    startHere: z.string(),
    agents: z.string(),
    overview: z.string(),
    manifest: z.string(),
  }).optional(),
  repos: z.array(
    z.object({
      kind: z.enum(['github', 'local']),
      id: z.string(),
      source: z.enum(['git', 'archive', 'local']).optional(),
      headSha: z.string().optional(),
      notes: z.array(z.string()).optional(),
    })
  ).optional(),
});

type UpdateBundleOutput = z.infer<typeof UpdateBundleOutputSchema>;

// ==========================================================================
// preflight_update_bundle
// ==========================================================================

/**
 * Register preflight_update_bundle tool.
 */
export function registerUpdateBundleTool({ server, cfg }: ToolDependencies, coreOnly: boolean): void {
  if (!shouldRegisterTool('preflight_update_bundle', coreOnly)) return;

  server.registerTool(
    'preflight_update_bundle',
    {
      title: 'Update bundle',
      description: 'Refresh/sync a bundle with latest repo changes. Use when: "update bundle", "refresh bundle", "sync bundle", "check for updates", "更新bundle", "同步仓库", "刷新索引". Set checkOnly=true to only check without applying.',
      inputSchema: UpdateBundleInputSchema,
      outputSchema: UpdateBundleOutputSchema,
      annotations: { openWorldHint: true },
    },
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: UpdateBundleOutput }> => {
      try {
        const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
        if (!storageDir) {
          throw new BundleNotFoundError(args.bundleId);
        }

        if (args.checkOnly) {
          const { hasUpdates, details } = await checkForUpdates(cfg, args.bundleId);
          const out: UpdateBundleOutput = {
            bundleId: args.bundleId,
            changed: hasUpdates,
            checkOnly: true,
            updateDetails: details,
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
            structuredContent: out,
          };
        }

        const tracker = getProgressTracker();
        const fingerprint = `update-${args.bundleId}`;
        const taskId = tracker.startTask(fingerprint, [args.bundleId]);

        try {
          const { summary, changed } = await updateBundle(cfg, args.bundleId, {
            force: args.force,
            onProgress: (phase, progress, message, total) => {
              tracker.updateProgress(taskId, phase, progress, message, total);
            },
          });

          tracker.completeTask(taskId, args.bundleId);

          const resources = {
            startHere: toBundleFileUri({ bundleId: summary.bundleId, relativePath: 'START_HERE.md' }),
            agents: toBundleFileUri({ bundleId: summary.bundleId, relativePath: 'AGENTS.md' }),
            overview: toBundleFileUri({ bundleId: summary.bundleId, relativePath: 'OVERVIEW.md' }),
            manifest: toBundleFileUri({ bundleId: summary.bundleId, relativePath: 'manifest.json' }),
          };

          const repos = summary.repos
            .filter(
              (repo): repo is typeof summary.repos[number] & { kind: 'github' | 'local' } =>
                repo.kind === 'github' || repo.kind === 'local'
            )
            .map((repo) => ({
              ...repo,
              source: repo.source === 'git' || repo.source === 'archive' || repo.source === 'local'
                ? repo.source
                : undefined,
            }));
          const { warnings: _warnings, repos: _repos, ...summaryData } = summary;
          const out: UpdateBundleOutput = {
            changed: args.force ? true : changed,
            ...summaryData,
            repos,
            resources,
          };

          return {
            content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
            structuredContent: out,
          };
        } catch (updateErr) {
          tracker.failTask(taskId, updateErr instanceof Error ? updateErr.message : String(updateErr));
          throw updateErr;
        }
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );
}
