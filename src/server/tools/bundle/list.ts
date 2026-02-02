/**
 * preflight_list_bundles - List available bundles.
 */

import * as z from 'zod';

import type { ToolDependencies } from '../types.js';
import { ListBundlesInputSchema, shouldRegisterTool } from './types.js';
import {
  getBundlePathsForId,
  getEffectiveStorageDir,
  listBundles,
} from '../../../bundle/service.js';
import { readManifest } from '../../../bundle/manifest.js';


const ListBundlesOutputSchema = z.object({
  bundles: z.array(
    z.object({
      bundleId: z.string(),
      displayName: z.string(),
      repos: z.array(z.string()),
      tags: z.array(z.string()),
    })
  ),
  truncation: z.object({
    truncated: z.boolean(),
    nextCursor: z.string().optional(),
    totalCount: z.number().optional(),
    returnedCount: z.number().optional(),
  }).optional(),
});

type ListBundlesOutput = z.infer<typeof ListBundlesOutputSchema>;

// ==========================================================================
// preflight_list_bundles
// ==========================================================================

/**
 * Register preflight_list_bundles tool.
 */
export function registerListBundlesTool({ server, cfg }: ToolDependencies, coreOnly: boolean): void {
  if (!shouldRegisterTool('preflight_list_bundles', coreOnly)) return;

  server.registerTool(
    'preflight_list_bundles',
    {
      title: 'List bundles',
      description:
        'List available bundles with IDs, repos, and tags.\n' +
        'Use when: "show bundles", "list repos", "查看bundle", "列出仓库".',
      inputSchema: ListBundlesInputSchema,
      outputSchema: ListBundlesOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: ListBundlesOutput }> => {
      const effectiveDir = await getEffectiveStorageDir(cfg);
      const allIds = await listBundles(effectiveDir);
      
      const { parseCursorOrDefault, createNextCursor, shouldPaginate } = await import('../../../mcp/cursor.js');
      const TOOL_NAME = 'preflight_list_bundles';
      const { offset } = parseCursorOrDefault(args.cursor, TOOL_NAME);
      
      allIds.sort();
      const ids = allIds.slice(offset, offset + args.limit);

      const capList = (items: string[], max: number): string[] => {
        if (items.length <= max) return items;
        const keep = items.slice(0, max);
        keep.push(`...(+${items.length - max})`);
        return keep;
      };

      const bundlesInternal: Array<{
        bundleId: string;
        displayName: string;
        repos: string[];
        tags: string[];
        tagsFull: string[];
      }> = [];

      for (const id of ids) {
        try {
          const paths = getBundlePathsForId(effectiveDir, id);
          const manifest = await readManifest(paths.manifestPath);

          const reposRaw = (manifest.repos ?? []).map((r) => r.id).filter(Boolean);
          const tagsFull = (manifest.tags ?? []).map(String);

          const displayName =
            (manifest.displayName && manifest.displayName.trim()) ||
            (reposRaw[0] && reposRaw[0].trim()) ||
            '(unnamed)';

          bundlesInternal.push({
            bundleId: id,
            displayName,
            repos: capList(reposRaw, args.maxItemsPerList),
            tags: capList(tagsFull, args.maxItemsPerList),
            tagsFull,
          });
        } catch {
          bundlesInternal.push({
            bundleId: id,
            displayName: '(unreadable manifest)',
            repos: [],
            tags: [],
            tagsFull: [],
          });
        }
      }

      const filteredInternal = args.filterByTag
        ? bundlesInternal.filter((b) => b.tagsFull.includes(args.filterByTag!))
        : bundlesInternal;

      const filtered = filteredInternal.map(({ tagsFull: _tagsFull, ...b }) => b);

      const hasMore = shouldPaginate(ids.length, args.limit, allIds.length, offset);
      const truncation = hasMore
        ? {
            truncated: true,
            nextCursor: createNextCursor(TOOL_NAME, offset, ids.length),
            totalCount: allIds.length,
            returnedCount: filtered.length,
          }
        : { truncated: false, returnedCount: filtered.length, totalCount: allIds.length };

      const out: ListBundlesOutput = { bundles: filtered, truncation };

      const lines: string[] = [];
      lines.push(`## Bundles (${filtered.length}${hasMore ? '+' : ''})`);
      lines.push('');
      
      for (const b of filtered) {
        lines.push(`### ${b.displayName}`);
        lines.push(`- **ID**: \`${b.bundleId}\``);
        if (b.repos.length > 0) {
          lines.push(`- **Repos**: ${b.repos.join(', ')}`);
        }
        if (b.tags.length > 0) {
          lines.push(`- **Tags**: ${b.tags.join(', ')}`);
        }
        lines.push('');
      }
      
      if (hasMore) {
        lines.push('---');
        lines.push(`📄 More bundles available (total: ${allIds.length}). Use cursor to fetch next page.`);
      }
      
      const textOutput = filtered.length > 0 ? lines.join('\n') : '(no bundles found)';

      return {
        content: [{ type: 'text', text: textOutput }],
        structuredContent: out,
      };
    }
  );
}
