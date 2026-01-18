/**
 * Shared types and input schemas for bundle tools.
 */

import * as z from 'zod';

// ==========================================================================
// Input Schemas
// ==========================================================================

export const CreateRepoInputSchema = z.union([
  z.object({
    kind: z.literal('github'),
    repo: z.string().describe('GitHub repo in owner/repo form (or github.com/owner/repo URL).'),
    ref: z.string().optional().describe('Optional git ref (branch/tag).'),
  }),
  z.object({
    kind: z.literal('local'),
    repo: z
      .string()
      .describe('Logical repo id in owner/repo form (used for storage layout and de-dup).'),
    path: z.string().describe('Local directory path containing the repository files.'),
    ref: z.string().optional().describe('Optional label/ref for the local snapshot.'),
  }),
]);

export const CreateBundleInputSchema = {
  repos: z.array(CreateRepoInputSchema).min(1).describe('Repositories to ingest into the bundle.'),
  ifExists: z
    .enum(['error', 'returnExisting', 'updateExisting', 'createNew'])
    .default('error')
    .describe(
      'What to do if a bundle with the same normalized inputs already exists. error=reject (default), returnExisting=return existing without fetching, updateExisting=update existing bundle then return it, createNew=bypass de-duplication.'
    ),
};

export const UpdateBundleInputSchema = {
  bundleId: z.string().describe('Bundle ID returned by preflight_create_bundle.'),
  checkOnly: z.boolean().optional().describe('If true, only check if updates are available without applying them.'),
  force: z.boolean().optional().describe('If true, force rebuild index even if no changes detected.'),
};

export const ListBundlesInputSchema = {
  filterByTag: z.string().optional().describe('Filter by tag (e.g., "mcp", "agents", "web-scraping").'),
  limit: z.number().int().min(1).max(200).default(50).describe('Max number of bundles to return.'),
  maxItemsPerList: z.number().int().min(1).max(50).default(10).describe('Max repos/tags to include per bundle to keep output compact.'),
  cursor: z.string().optional().describe('Pagination cursor from previous call. Use to fetch next page.'),
};

export const DeleteBundleInputSchema = {
  bundleId: z.string().describe('Bundle ID to delete.'),
  dryRun: z.boolean().optional().default(true).describe(
    'If true (default), only preview what would be deleted without actually deleting. ' +
    'Set to false AND provide confirm to actually delete.'
  ),
  confirm: z.string().optional().describe(
    'Required when dryRun=false. Must match bundleId exactly to confirm deletion. ' +
    'This prevents accidental deletions.'
  ),
};

export const RepairBundleInputSchema = {
  bundleId: z.string().describe('Bundle ID to repair.'),
  mode: z.enum(['validate', 'repair']).default('repair').describe('validate=report missing components only; repair=fix missing derived artifacts.'),
  rebuildIndex: z.boolean().optional().describe('If true, rebuild search index when missing/empty.'),
  rebuildGuides: z.boolean().optional().describe('If true, rebuild START_HERE.md and AGENTS.md when missing/empty.'),
  rebuildOverview: z.boolean().optional().describe('If true, rebuild OVERVIEW.md when missing/empty.'),
};

export const GetTaskStatusInputSchema = {
  taskId: z.string().optional().describe('Task ID to query (from BUNDLE_IN_PROGRESS error).'),
  fingerprint: z.string().optional().describe('Fingerprint to query (computed from repos).'),
  repos: z.array(CreateRepoInputSchema).optional().describe('Repos to compute fingerprint from (alternative to fingerprint).'),
};

// ==========================================================================
// Constants
// ==========================================================================

/**
 * Tools to register in core mode (6 total).
 * Core bundle tools: create, list, delete, get_overview, read_file, repo_tree
 */
export const CORE_BUNDLE_TOOLS = new Set([
  'preflight_create_bundle',
  'preflight_list_bundles',
  'preflight_delete_bundle',
  'preflight_get_overview',
  'preflight_read_file',
  'preflight_repo_tree',
]);

// ==========================================================================
// Types
// ==========================================================================

export type BundleToolsOptions = {
  coreOnly?: boolean;
};

/**
 * Check if a tool should be registered based on coreOnly option.
 */
export function shouldRegisterTool(toolName: string, coreOnly: boolean): boolean {
  if (!coreOnly) return true;
  return CORE_BUNDLE_TOOLS.has(toolName);
}
