/**
 * preflight_cleanup_orphans - Remove incomplete or corrupted bundles (non-core).
 */

import * as z from 'zod';

import type { ToolDependencies } from '../types.js';
import { shouldRegisterTool } from './types.js';
import { cleanupOrphanBundles } from '../../../bundle/cleanup.js';
import { wrapPreflightError } from '../../../mcp/errorKinds.js';


const CleanupOrphansOutputSchema = z.object({
  totalFound: z.number(),
  totalCleaned: z.number(),
  details: z.array(
    z.object({
      storageDir: z.string(),
      found: z.array(z.string()),
      cleaned: z.array(z.string()),
      skipped: z.array(z.object({ bundleId: z.string(), reason: z.string() })),
    })
  ),
});

type CleanupOrphansOutput = z.infer<typeof CleanupOrphansOutputSchema>;

// ==========================================================================
// preflight_cleanup_orphans
// ==========================================================================

/**
 * Register preflight_cleanup_orphans tool.
 */
export function registerCleanupOrphansTool({ server, cfg }: ToolDependencies, coreOnly: boolean): void {
  if (!shouldRegisterTool('preflight_cleanup_orphans', coreOnly)) return;

  server.registerTool(
    'preflight_cleanup_orphans',
    {
      title: 'Cleanup orphan bundles',
      description: 'Remove incomplete or corrupted bundles (bundles without valid manifest.json). Safe to run anytime. Use when: "clean up broken bundles", "remove orphans", "清理孤儿bundle", "清除损坏的bundle".',
      inputSchema: {
        dryRun: z.boolean().default(true).describe('If true, only report orphans without deleting. Set to false to actually delete.'),
        minAgeHours: z.number().default(1).describe('Only clean bundles older than N hours (safety margin to avoid race conditions).'),
      },
      outputSchema: CleanupOrphansOutputSchema,
      annotations: { destructiveHint: true },
    },
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: CleanupOrphansOutput }> => {
      try {
        const result = await cleanupOrphanBundles(cfg, {
          minAgeHours: args.minAgeHours,
          dryRun: args.dryRun,
        });

        const summary = args.dryRun
          ? `Found ${result.totalFound} orphan bundle(s) (DRY RUN - not deleted)`
          : `Cleaned ${result.totalCleaned} of ${result.totalFound} orphan bundle(s)`;

        const out: CleanupOrphansOutput = result;

        return {
          content: [{ type: 'text', text: summary }],
          structuredContent: out,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );
}
