/**
 * Search tools - search_and_read
 */

import * as z from 'zod';

import type { ToolDependencies } from './types.js';
import {
  assertBundleComplete,
  findBundleStorageDir,
  getBundlePathsForId,
} from '../../bundle/service.js';
import { SearchAndReadInputSchema, createSearchAndReadHandler, searchAndReadToolDescription } from '../../tools/searchAndRead.js';


const SearchAndReadOutputSchema = z.object({
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
});

type SearchAndReadOutput = z.infer<typeof SearchAndReadOutputSchema>;

export function registerSearchTools({ server, cfg }: ToolDependencies): void {
  // ==========================================================================
  // preflight_search_and_read
  // ==========================================================================
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
      outputSchema: SearchAndReadOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: SearchAndReadOutput }> => {
      const result = await searchAndReadHandler(args);
      return {
        content: [{ type: 'text', text: result.text }],
        structuredContent: result.structuredContent,
      };
    }
  );
}
