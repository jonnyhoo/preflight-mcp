/**
 * Shared types and input schemas for bundle tools.
 */

import * as z from 'zod';

// ==========================================================================
// Input Schemas
// ==========================================================================

/**
 * SPA rendering options.
 */
export const SpaOptionsSchema = z.object({
  /** Wait for specific selector before extracting (e.g., '#content') */
  waitForSelector: z.string().optional()
    .describe('CSS selector to wait for before extraction. Example: "#content"'),
  /** Wait time after page load in ms (default: 2000) */
  waitAfterLoad: z.number().int().min(0).max(30000).optional()
    .describe('Extra wait time after page load in ms. Default: 2000'),
}).strict().optional();

/**
 * Web crawl configuration options.
 * Controls how documentation sites are crawled.
 */
export const WebCrawlConfigSchema = z.object({
  /** Maximum pages to crawl (default: 500) */
  maxPages: z.number().int().min(1).max(5000).optional()
    .describe('Max pages to crawl. Default: 500'),
  /** Maximum crawl depth from baseUrl (default: 5) */
  maxDepth: z.number().int().min(1).max(20).optional()
    .describe('Max depth from base URL. Default: 5'),
  /** URL patterns to include (e.g., ["/docs/", "/api/"]) */
  includePatterns: z.array(z.string()).optional()
    .describe('URL patterns to include. Example: ["/docs/", "/api/"]'),
  /** URL patterns to exclude (e.g., ["/blog/", "/changelog/"]) */
  excludePatterns: z.array(z.string()).optional()
    .describe('URL patterns to exclude. Example: ["/blog/", "/changelog/"]'),
  /** Skip llms.txt detection (default: false) */
  skipLlmsTxt: z.boolean().optional()
    .describe('Skip llms.txt detection and use BFS crawl. Set true for SPA sites. Default: false'),
  /** Use headless browser for SPA rendering (default: false) */
  useSpa: z.boolean().optional()
    .describe('Use headless browser to render JavaScript. Required for SPA sites. Default: false'),
  /** SPA rendering options */
  spaOptions: SpaOptionsSchema
    .describe('Options for SPA rendering (when useSpa=true)'),
}).strict().optional();

export const CreateRepoInputSchema = z.union([
  z.object({
    kind: z.literal('github'),
    repo: z.string().describe('GitHub repo in "owner/repo" format. Example: "facebook/react"'),
    ref: z.string().optional().describe('Git branch or tag. Example: "main", "v18.0.0"'),
  }),
  z.object({
    kind: z.literal('local'),
    repo: z
      .string()
      .describe('Logical identifier in "owner/repo" format for indexing (not necessarily GitHub). If you don’t have one, use "local/<folder>". Example: "local/reverse-mcp-server"'),
    path: z.string().describe('Absolute path to local directory. Example: "C:\\Projects\\myproject" or "/home/user/myproject"'),
    ref: z.string().optional().describe('Optional version label. Example: "v1.0", "dev"'),
  }),
  z.object({
    kind: z.literal('web'),
    url: z.string().url().describe('Documentation site URL to crawl. Example: "https://docs.example.com"'),
    config: WebCrawlConfigSchema.describe('Optional crawl configuration'),
  }),
  z.object({
    kind: z.literal('pdf'),
    url: z.string().url().optional().describe('PDF URL to download and parse. Example: "https://arxiv.org/pdf/2512.14982"'),
    path: z.string().optional().describe('Local file path to PDF. Example: "C:\\\\docs\\\\paper.pdf" or "/home/user/paper.pdf"'),
    name: z.string().optional().describe('Display name for the document. Example: "Prompt Repetition Paper"'),
  }).refine(
    (data) => data.url || data.path,
    { message: 'Either url or path must be provided for PDF input' }
  ),
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
