/**
 * preflight_delete_bundle - Delete a bundle.
 */

import * as z from 'zod';

import type { ToolDependencies } from '../types.js';
import { DeleteBundleInputSchema, shouldRegisterTool } from './types.js';
import {
  clearBundleMulti,
  findBundleStorageDir,
  getBundlePathsForId,
} from '../../../bundle/service.js';
import { readManifest } from '../../../bundle/manifest.js';
import { wrapPreflightError } from '../../../mcp/errorKinds.js';
import { BundleNotFoundError } from '../../../errors.js';

// ==========================================================================
// preflight_delete_bundle
// ==========================================================================

/**
 * Register preflight_delete_bundle tool.
 */
export function registerDeleteBundleTool({ server, cfg }: ToolDependencies, coreOnly: boolean): void {
  if (!shouldRegisterTool('preflight_delete_bundle', coreOnly)) return;

  server.registerTool(
    'preflight_delete_bundle',
    {
      title: 'Delete bundle',
      description:
        'Delete/remove a bundle permanently. ' +
        '⚠️ SAFETY: By default runs in dryRun mode (preview only). ' +
        'To actually delete: set dryRun=false AND confirm=bundleId. ' +
        'Use when: "delete bundle", "remove bundle", "清除bundle", "删除索引", "移除仓库".',
      inputSchema: DeleteBundleInputSchema,
      outputSchema: {
        dryRun: z.boolean(),
        deleted: z.boolean(),
        bundleId: z.string(),
        displayName: z.string().optional(),
        repos: z.array(z.string()).optional(),
        message: z.string().optional(),
        nextAction: z.object({
          toolName: z.string(),
          paramsTemplate: z.record(z.string(), z.unknown()),
          why: z.string(),
        }).optional(),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      try {
        const dryRun = args.dryRun ?? true;
        
        const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
        if (!storageDir) {
          throw new BundleNotFoundError(args.bundleId);
        }
        
        const paths = getBundlePathsForId(storageDir, args.bundleId);
        let displayName: string | undefined;
        let repos: string[] = [];
        try {
          const manifest = await readManifest(paths.manifestPath);
          displayName = manifest.displayName;
          repos = (manifest.repos ?? []).map((r) => r.id).filter(Boolean);
        } catch {
          // Manifest might be missing/corrupt
        }
        
        if (dryRun) {
          const out = {
            dryRun: true,
            deleted: false,
            bundleId: args.bundleId,
            displayName,
            repos,
            message: `DRY RUN: Would delete bundle "${displayName || args.bundleId}" containing ${repos.length} repo(s).`,
            nextAction: {
              toolName: 'preflight_delete_bundle',
              paramsTemplate: {
                bundleId: args.bundleId,
                dryRun: false,
                confirm: args.bundleId,
              },
              why: 'Set dryRun=false and confirm=bundleId to actually delete.',
            },
          };
          
          return {
            content: [{ type: 'text', text: `⚠️ ${out.message}\n\nTo confirm deletion:\n- Set dryRun: false\n- Set confirm: "${args.bundleId}"` }],
            structuredContent: out,
          };
        }
        
        if (!args.confirm || args.confirm !== args.bundleId) {
          const out = {
            dryRun: false,
            deleted: false,
            bundleId: args.bundleId,
            displayName,
            repos,
            message: `BLOCKED: confirm must match bundleId exactly. Got "${args.confirm || '(missing)'}", expected "${args.bundleId}".`,
            nextAction: {
              toolName: 'preflight_delete_bundle',
              paramsTemplate: {
                bundleId: args.bundleId,
                dryRun: false,
                confirm: args.bundleId,
              },
              why: 'Provide confirm=bundleId to proceed with deletion.',
            },
          };
          
          return {
            content: [{ type: 'text', text: `❌ ${out.message}` }],
            structuredContent: out,
          };
        }
        
        const deleted = await clearBundleMulti(cfg.storageDirs, args.bundleId);
        if (!deleted) {
          throw new BundleNotFoundError(args.bundleId);
        }

        server.sendResourceListChanged();

        const out = {
          dryRun: false,
          deleted: true,
          bundleId: args.bundleId,
          displayName,
          repos,
          message: `Deleted bundle "${displayName || args.bundleId}" (${repos.length} repo(s)).`,
        };
        return {
          content: [{ type: 'text', text: `✅ ${out.message}` }],
          structuredContent: out,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );
}
