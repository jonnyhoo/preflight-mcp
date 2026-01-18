/**
 * preflight_repair_bundle - Validate and repair bundle artifacts (non-core).
 */

import * as z from 'zod';

import type { ToolDependencies } from '../types.js';
import { RepairBundleInputSchema, shouldRegisterTool } from './types.js';
import { repairBundle } from '../../../bundle/service.js';
import { wrapPreflightError } from '../../../mcp/errorKinds.js';

// ==========================================================================
// preflight_repair_bundle
// ==========================================================================

/**
 * Register preflight_repair_bundle tool.
 */
export function registerRepairBundleTool({ server, cfg }: ToolDependencies, coreOnly: boolean): void {
  if (!shouldRegisterTool('preflight_repair_bundle', coreOnly)) return;

  server.registerTool(
    'preflight_repair_bundle',
    {
      title: 'Repair bundle (offline)',
      description:
        'Validate and repair missing/empty derived bundle artifacts (offline, no fetching): search index, START_HERE.md, AGENTS.md, OVERVIEW.md. Use when: "bundle is broken", "search fails", "index missing", "修复bundle", "重建索引", "修复概览".',
      inputSchema: RepairBundleInputSchema,
      outputSchema: {
        bundleId: z.string(),
        mode: z.enum(['validate', 'repair']),
        repaired: z.boolean(),
        actionsTaken: z.array(z.string()),
        unfixableIssues: z.array(z.string()).optional(),
        before: z.object({
          isValid: z.boolean(),
          missingComponents: z.array(z.string()),
        }),
        after: z.object({
          isValid: z.boolean(),
          missingComponents: z.array(z.string()),
        }),
        updatedAt: z.string().optional(),
      },
      annotations: { openWorldHint: true },
    },
    async (args) => {
      try {
        const out = await repairBundle(cfg, args.bundleId, {
          mode: args.mode,
          rebuildIndex: args.rebuildIndex,
          rebuildGuides: args.rebuildGuides,
          rebuildOverview: args.rebuildOverview,
        });

        let summaryLine: string;
        if (out.mode === 'validate') {
          summaryLine = `VALIDATE ${out.bundleId}: ${out.before.isValid ? 'OK' : 'INVALID'} (${out.before.missingComponents.length} issue(s))`;
        } else if (out.unfixableIssues && out.unfixableIssues.length > 0) {
          summaryLine = `⚠️ UNFIXABLE ${out.bundleId}: ${out.unfixableIssues.length} issue(s) cannot be repaired offline.\n` +
            out.unfixableIssues.map(i => `  - ${i}`).join('\n');
        } else if (out.repaired) {
          summaryLine = `REPAIRED ${out.bundleId}: ${out.actionsTaken.length} action(s), now ${out.after.isValid ? 'OK' : 'STILL_INVALID'} (${out.after.missingComponents.length} issue(s))`;
        } else {
          summaryLine = `NOOP ${out.bundleId}: nothing to repair (already OK)`;
        }

        return {
          content: [{ type: 'text', text: summaryLine }],
          structuredContent: out,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );
}
