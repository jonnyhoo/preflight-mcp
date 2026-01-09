/**
 * Modal content tools - analyze_modal, parse_document, search_modal
 */

import * as z from 'zod';

import type { ToolDependencies } from './types.js';
import {
  assertBundleComplete,
  findBundleStorageDir,
  getBundlePathsForId,
} from '../../bundle/service.js';
import {
  AnalyzeModalInputSchema,
  createAnalyzeModalHandler,
  analyzeModalToolDescription,
  type AnalyzeModalInput,
} from '../../tools/analyzeModal.js';
import {
  ParseDocumentInputSchema,
  createParseDocumentHandler,
  parseDocumentToolDescription,
  type ParseDocumentInput,
} from '../../tools/parseDocument.js';
import {
  SearchModalInputSchema,
  createSearchModalHandler,
  searchModalToolDescription,
  type SearchModalInput,
} from '../../tools/searchModal.js';

/**
 * Register all modal content analysis tools.
 */
export function registerModalTools({ server, cfg }: ToolDependencies): void {
  // ==========================================================================
  // preflight_analyze_modal
  // ==========================================================================
  server.registerTool(
    'preflight_analyze_modal',
    {
      title: analyzeModalToolDescription.title,
      description: analyzeModalToolDescription.description,
      inputSchema: AnalyzeModalInputSchema,
      outputSchema: {
        bundleId: z.string(),
        scope: z.enum(['images', 'tables', 'equations', 'all']),
        totalItems: z.number(),
        processedItems: z.number(),
        successCount: z.number(),
        errorCount: z.number(),
        items: z.array(z.object({
          type: z.string(),
          path: z.string().optional(),
          success: z.boolean(),
          error: z.string().optional(),
          description: z.string().optional(),
          extractedText: z.string().optional(),
          entityInfo: z.object({
            entityName: z.string().optional(),
            entityType: z.string().optional(),
            summary: z.string().optional(),
            keywords: z.array(z.string()).optional(),
          }).optional(),
          processingTimeMs: z.number(),
        })),
      },
      annotations: { readOnlyHint: true },
    },
    async (args: AnalyzeModalInput) => {
      const handler = createAnalyzeModalHandler({
        findBundleStorageDir: (dirs, id) => findBundleStorageDir(dirs, id),
        getBundlePathsForId,
        assertBundleComplete: (id) => assertBundleComplete(cfg, id),
        storageDirs: cfg.storageDirs,
      });
      const result = await handler(args);
      return {
        content: [{ type: 'text', text: result.text }],
        structuredContent: result.structuredContent,
      };
    }
  );

  // ==========================================================================
  // preflight_parse_document
  // ==========================================================================
  server.registerTool(
    'preflight_parse_document',
    {
      title: parseDocumentToolDescription.title,
      description: parseDocumentToolDescription.description,
      inputSchema: ParseDocumentInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args: ParseDocumentInput) => {
      const handler = createParseDocumentHandler();
      const result = await handler(args);
      return {
        content: [{ type: 'text', text: result.text }],
      };
    }
  );

  // ==========================================================================
  // preflight_search_modal
  // ==========================================================================
  server.registerTool(
    'preflight_search_modal',
    {
      title: searchModalToolDescription.title,
      description: searchModalToolDescription.description,
      inputSchema: SearchModalInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args: SearchModalInput) => {
      const handler = createSearchModalHandler({
        findBundleStorageDir: (dirs, id) => findBundleStorageDir(dirs, id),
        getBundlePathsForId,
        storageDirs: cfg.storageDirs,
      });
      const result = await handler(args);
      return {
        content: [{ type: 'text', text: result.text }],
      };
    }
  );
}
