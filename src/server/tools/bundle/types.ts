/**
 * Shared types and input schemas for bundle tools.
 */

import * as z from 'zod';

import type { RepoInput } from '../../../bundle/manifest.js';

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

export const CreateRepoInputSchema = z.object({
  kind: z.enum(['github', 'local', 'web', 'pdf', 'markdown']).describe(
    'Source kind. Required fields by kind: github=>repo, local=>repo+path, web=>url, pdf=>url or path, markdown=>path.'
  ),
  repo: z
    .string()
    .optional()
    .describe('GitHub repo or logical local repo id in "owner/repo" format. For local repos, use something like "local/my-project".'),
  ref: z.string().optional().describe('Git branch, tag, commit, or version label. Example: "main", "v1.0.0", "dev"'),
  path: z.string().optional().describe('Absolute local path. Used for local repos, local PDFs, or markdown folders.'),
  url: z.string().url().optional().describe('Remote URL. Used for web docs or PDF URLs.'),
  config: WebCrawlConfigSchema.describe('Optional crawl configuration for web sources'),
  name: z.string().optional().describe('Optional display name for PDF or markdown inputs.'),
  vlmParser: z.boolean().optional().describe(
    'PDF only. Use VLM Parser (parallel Vision-Language Model) instead of default MinerU. ' +
    'Requires vlmConfigs in config.json. Fails immediately if endpoint unavailable (no fallback).'
  ),
  ruleBasedParser: z.boolean().optional().describe(
    'PDF only. Use simple rule-based PDF extraction (no API required). ' +
    'Lower quality but always available. Use as last resort when MinerU/VLM unavailable.'
  ),
}).strict().superRefine((data, ctx) => {
  const requireField = (field: 'repo' | 'path' | 'url', message: string) => {
    if (!data[field]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message,
      });
    }
  };

  switch (data.kind) {
    case 'github':
      requireField('repo', 'GitHub inputs require repo in "owner/repo" format.');
      break;
    case 'local':
      requireField('repo', 'Local inputs require repo in logical "owner/repo" format, e.g. "local/my-project".');
      requireField('path', 'Local inputs require an absolute path.');
      break;
    case 'web':
      requireField('url', 'Web inputs require a documentation site URL.');
      break;
    case 'pdf':
      if (!data.url && !data.path) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['url'],
          message: 'PDF inputs require either url or path.',
        });
      }
      break;
    case 'markdown':
      requireField('path', 'Markdown inputs require an absolute directory path.');
      break;
  }
});

export type CreateRepoToolInput = z.infer<typeof CreateRepoInputSchema>;

export type NormalizedCreateRepoInput =
  | Exclude<RepoInput, { kind: 'pdf' }>
  | (Extract<RepoInput, { kind: 'pdf' }> & {
      vlmParser?: boolean;
      ruleBasedParser?: boolean;
    });

export function normalizeCreateRepoInput(input: CreateRepoToolInput): NormalizedCreateRepoInput {
  switch (input.kind) {
    case 'github':
      return {
        kind: 'github',
        repo: input.repo!,
        ...(input.ref ? { ref: input.ref } : {}),
      };
    case 'local':
      return {
        kind: 'local',
        repo: input.repo!,
        path: input.path!,
        ...(input.ref ? { ref: input.ref } : {}),
      };
    case 'web':
      return {
        kind: 'web',
        url: input.url!,
        ...(input.config ? { config: input.config } : {}),
      };
    case 'pdf':
      return {
        kind: 'pdf',
        ...(input.url ? { url: input.url } : {}),
        ...(input.path ? { path: input.path } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.vlmParser !== undefined ? { vlmParser: input.vlmParser } : {}),
        ...(input.ruleBasedParser !== undefined ? { ruleBasedParser: input.ruleBasedParser } : {}),
      };
    case 'markdown':
      return {
        kind: 'markdown',
        path: input.path!,
        ...(input.name ? { name: input.name } : {}),
      };
  }
}

export const CreateBundleInputSchema = {
  repos: z.array(CreateRepoInputSchema).min(1).describe(
    'Repositories to ingest into the bundle. Each item is one source descriptor: github=>repo, local=>repo+path, web=>url, pdf=>url or path, markdown=>path.'
  ),
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
