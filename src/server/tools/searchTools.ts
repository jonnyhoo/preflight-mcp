/**
 * Search tools - search_by_tags, read_files, search_and_read
 */

import * as z from 'zod';

import type { ToolDependencies } from './types.js';
import {
  assertBundleComplete,
  findBundleStorageDir,
  getBundlePathsForId,
  getEffectiveStorageDir,
  listBundles,
} from '../../bundle/service.js';
import { readManifest } from '../../bundle/manifest.js';
import { toBundleFileUri } from '../../mcp/uris.js';
import { searchIndex, type SearchScope } from '../../search/sqliteFts.js';
import { runSearchByTags } from '../../tools/searchByTags.js';
import { ReadFilesInputSchema, createReadFilesHandler, readFilesToolDescription } from '../../tools/readFiles.js';
import { SearchAndReadInputSchema, createSearchAndReadHandler, searchAndReadToolDescription } from '../../tools/searchAndRead.js';

// ==========================================================================
// Input Schemas
// ==========================================================================

const SearchByTagsInputSchema = {
  query: z.string().describe('Search query across bundles.'),
  tags: z.array(z.string()).optional().describe('Filter by tags (e.g., ["mcp", "agents"]). Searches only matching bundles.'),
  scope: z.enum(['docs', 'code', 'all']).default('all').describe('Search scope.'),
  limit: z.number().int().min(1).max(200).default(50).describe('Max total hits across all bundles.'),
  cursor: z.string().optional().describe('Pagination cursor from previous call. Use to fetch next page of results.'),
};

/**
 * Core search tools (1 tool).
 */
const CORE_SEARCH_TOOLS = new Set(['preflight_search_and_read']);

export type SearchToolsOptions = {
  coreOnly?: boolean;
};

/**
 * Register search-related tools.
 * @param deps - Server and config dependencies
 * @param options - Options for registration
 * @param options.coreOnly - If true, only register core tools (search_and_read)
 */
export function registerSearchTools({ server, cfg }: ToolDependencies, options?: SearchToolsOptions): void {
  const coreOnly = options?.coreOnly ?? false;
  
  const shouldRegister = (toolName: string): boolean => {
    if (!coreOnly) return true;
    return CORE_SEARCH_TOOLS.has(toolName);
  };

  // ==========================================================================
  // preflight_search_by_tags (non-core)
  // ==========================================================================
  if (shouldRegister('preflight_search_by_tags'))
  server.registerTool(
    'preflight_search_by_tags',
    {
      title: 'Search by tags',
      description: 'Search across multiple bundles filtered by tags. Use when: "search in MCP bundles", "find in all agent repos", "search web-scraping tools", "在MCP项目中搜索", "搜索所有agent".',
      inputSchema: SearchByTagsInputSchema,
      outputSchema: {
        query: z.string(),
        tags: z.array(z.string()).optional(),
        scope: z.enum(['docs', 'code', 'all']),
        totalBundlesSearched: z.number(),
        hits: z.array(
          z.object({
            bundleId: z.string(),
            bundleName: z.string().optional(),
            kind: z.enum(['doc', 'code']),
            repo: z.string(),
            path: z.string(),
            lineNo: z.number(),
            snippet: z.string(),
            uri: z.string(),
          })
        ),
        warnings: z.array(
          z.object({
            bundleId: z.string(),
            kind: z.string(),
            message: z.string(),
          })
        ).optional(),
        warningsTruncated: z.boolean().optional(),
        truncation: z.object({
          truncated: z.boolean(),
          nextCursor: z.string().optional(),
          reason: z.string().optional(),
          returnedCount: z.number().optional(),
        }).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { parseCursorOrDefault, createNextCursor } = await import('../../mcp/cursor.js');
      const TOOL_NAME = 'preflight_search_by_tags';
      const { offset, error: cursorError } = parseCursorOrDefault(args.cursor, TOOL_NAME);
      const pageSize = args.limit;

      const effectiveDir = await getEffectiveStorageDir(cfg);
      const allBundleIds = await listBundles(effectiveDir);

      const fetchLimit = offset + pageSize + 1;
      const result = await runSearchByTags({
        bundleIds: allBundleIds,
        query: args.query,
        tags: args.tags,
        scope: args.scope as SearchScope,
        limit: fetchLimit,
        readManifestForBundleId: async (bundleId) => {
          const paths = getBundlePathsForId(effectiveDir, bundleId);
          const manifest = await readManifest(paths.manifestPath);
          return { displayName: manifest.displayName, tags: manifest.tags };
        },
        searchIndexForBundleId: (bundleId, query, scope, limit) => {
          const paths = getBundlePathsForId(effectiveDir, bundleId);
          return searchIndex(paths.searchDbPath, query, scope, limit, paths.rootDir);
        },
        toUri: (bundleId, p) => toBundleFileUri({ bundleId, relativePath: p }),
      });

      const hasMore = result.hits.length > offset + pageSize;
      const paginatedHits = result.hits.slice(offset, offset + pageSize);

      const out: Record<string, unknown> = {
        query: args.query,
        tags: args.tags,
        scope: args.scope,
        totalBundlesSearched: result.totalBundlesSearched,
        hits: paginatedHits,
        warnings: result.warnings,
        warningsTruncated: result.warningsTruncated,
      };

      if (hasMore || offset > 0 || cursorError) {
        out.truncation = {
          truncated: hasMore,
          returnedCount: paginatedHits.length,
          ...(hasMore && { nextCursor: createNextCursor(TOOL_NAME, offset, pageSize) }),
          ...(cursorError && { reason: cursorError }),
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    }
  );

  // ==========================================================================
  // preflight_read_files (non-core)
  // ==========================================================================
  if (shouldRegister('preflight_read_files')) {
  const readFilesHandler = createReadFilesHandler({
    findBundleStorageDir: (storageDirs, bundleId) => findBundleStorageDir(storageDirs, bundleId),
    getBundlePathsForId: (storageDir, bundleId) => getBundlePathsForId(storageDir, bundleId),
    storageDirs: cfg.storageDirs,
  });

  server.registerTool(
    'preflight_read_files',
    {
      title: readFilesToolDescription.title,
      description: readFilesToolDescription.description,
      inputSchema: ReadFilesInputSchema,
      outputSchema: {
        ok: z.boolean(),
        meta: z.object({
          tool: z.string(),
          schemaVersion: z.string(),
          requestId: z.string(),
          timeMs: z.number(),
          bundleId: z.string().optional(),
        }),
        data: z.object({
          bundleId: z.string(),
          files: z.array(z.object({
            path: z.string(),
            content: z.string(),
            lineInfo: z.object({
              totalLines: z.number(),
              ranges: z.array(z.object({ start: z.number(), end: z.number() })),
            }),
            error: z.string().optional(),
          })),
        }).optional(),
        error: z.object({
          code: z.string(),
          message: z.string(),
          hint: z.string().optional(),
        }).optional(),
        warnings: z.array(z.object({
          code: z.string(),
          message: z.string(),
          recoverable: z.boolean(),
        })).optional(),
        evidence: z.array(z.object({
          path: z.string(),
          range: z.object({
            startLine: z.number(),
            endLine: z.number(),
          }),
          uri: z.string().optional(),
          snippet: z.string().optional(),
          snippetSha256: z.string().optional(),
        })).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await readFilesHandler(args);
      return {
        content: [{ type: 'text', text: result.text }],
        structuredContent: result.structuredContent,
      };
    }
  );
  } // end if shouldRegister('preflight_read_files')

  // ==========================================================================
  // preflight_search_and_read (core)
  // ==========================================================================
  if (shouldRegister('preflight_search_and_read')) {
  const searchAndReadHandler = createSearchAndReadHandler({
    findBundleStorageDir: (storageDirs, bundleId) => findBundleStorageDir(storageDirs, bundleId),
    getBundlePathsForId: (storageDir, bundleId) => getBundlePathsForId(storageDir, bundleId),
    assertBundleComplete: (bundleId) => assertBundleComplete(cfg, bundleId),
    storageDirs: cfg.storageDirs,
  });

  server.registerTool(
    'preflight_search_and_read',
    {
      title: searchAndReadToolDescription.title,
      description: searchAndReadToolDescription.description,
      inputSchema: SearchAndReadInputSchema,
      outputSchema: {
        ok: z.boolean(),
        meta: z.object({
          tool: z.string(),
          schemaVersion: z.string(),
          requestId: z.string(),
          timeMs: z.number(),
          bundleId: z.string().optional(),
        }),
        data: z.object({
          bundleId: z.string(),
          query: z.string(),
          scope: z.enum(['docs', 'code', 'all']),
          hits: z.array(z.object({
            path: z.string(),
            repo: z.string(),
            kind: z.enum(['doc', 'code']),
            matchRange: z.object({ startLine: z.number(), endLine: z.number() }),
            excerptRange: z.object({ startLine: z.number(), endLine: z.number() }),
            excerpt: z.string(),
            score: z.number().optional(),
          })),
        }).optional(),
        error: z.object({
          code: z.string(),
          message: z.string(),
          hint: z.string().optional(),
        }).optional(),
        warnings: z.array(z.object({
          code: z.string(),
          message: z.string(),
          recoverable: z.boolean(),
        })).optional(),
        nextActions: z.array(z.object({
          tool: z.string(),
          args: z.record(z.string(), z.unknown()),
          reason: z.string(),
        })).optional(),
        truncation: z.object({
          truncated: z.boolean(),
          nextCursor: z.string().optional(),
          reason: z.string().optional(),
          returnedCount: z.number().optional(),
        }).optional(),
        evidence: z.array(z.object({
          path: z.string(),
          range: z.object({
            startLine: z.number(),
            endLine: z.number(),
          }),
          uri: z.string().optional(),
          snippet: z.string().optional(),
          snippetSha256: z.string().optional(),
        })).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await searchAndReadHandler(args);
      return {
        content: [{ type: 'text', text: result.text }],
        structuredContent: result.structuredContent,
      };
    }
  );
  } // end if shouldRegister('preflight_search_and_read')
}
