/**
 * Call Graph tools - build, query, extract, interface_summary
 */

import * as z from 'zod';

import type { ToolDependencies } from './types.js';
import {
  BuildCallGraphInputSchema,
  QueryCallGraphInputSchema,
  ExtractCodeInputSchema,
  InterfaceSummaryInputSchema,
  buildCallGraphToolDescription,
  queryCallGraphToolDescription,
  extractCodeToolDescription,
  interfaceSummaryToolDescription,
  createBuildCallGraphHandler,
  createQueryCallGraphHandler,
  createExtractCodeHandler,
  createInterfaceSummaryHandler,
} from '../../tools/callGraph.js';

/**
 * Register all call graph tools.
 */
export function registerCallGraphTools({ server }: ToolDependencies): void {
  const buildCallGraphHandler = createBuildCallGraphHandler();
  const queryCallGraphHandler = createQueryCallGraphHandler();
  const extractCodeHandler = createExtractCodeHandler();
  const interfaceSummaryHandler = createInterfaceSummaryHandler();

  // ==========================================================================
  // preflight_build_call_graph
  // ==========================================================================
  server.registerTool(
    'preflight_build_call_graph',
    {
      title: 'Build call graph',
      description: buildCallGraphToolDescription,
      inputSchema: BuildCallGraphInputSchema,
      outputSchema: {
        success: z.boolean(),
        summary: z.object({
          totalFunctions: z.number(),
          totalCalls: z.number(),
          filesAnalyzed: z.number(),
          buildTimeMs: z.number(),
          exportedSymbols: z.array(z.string()),
          hasMore: z.boolean(),
        }).optional(),
        hint: z.string().optional(),
        error: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await buildCallGraphHandler(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }
  );

  // ==========================================================================
  // preflight_query_call_graph
  // ==========================================================================
  server.registerTool(
    'preflight_query_call_graph',
    {
      title: 'Query call graph',
      description: queryCallGraphToolDescription,
      inputSchema: QueryCallGraphInputSchema,
      outputSchema: {
        success: z.boolean(),
        symbol: z.object({
          name: z.string(),
          kind: z.string(),
          file: z.string(),
          line: z.number(),
          signature: z.string().optional(),
          documentation: z.string().optional(),
          isExported: z.boolean().optional(),
          isAsync: z.boolean().optional(),
        }).optional(),
        callers: z.array(z.object({
          name: z.string(),
          file: z.string(),
          line: z.number(),
        })).optional(),
        callees: z.array(z.object({
          name: z.string(),
          file: z.string(),
          line: z.number(),
        })).optional(),
        totalRelated: z.number().optional(),
        queryTimeMs: z.number().optional(),
        error: z.string().optional(),
        availableSymbols: z.array(z.string()).optional(),
        hint: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await queryCallGraphHandler(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }
  );

  // ==========================================================================
  // preflight_extract_code
  // ==========================================================================
  server.registerTool(
    'preflight_extract_code',
    {
      title: 'Extract code with dependencies',
      description: extractCodeToolDescription,
      inputSchema: ExtractCodeInputSchema,
      outputSchema: {
        success: z.boolean(),
        format: z.enum(['minimal', 'full', 'markdown']).optional(),
        content: z.string().optional(),
        mainSymbol: z.object({
          name: z.string(),
          kind: z.string(),
          file: z.string(),
          line: z.number(),
        }).optional(),
        dependencies: z.array(z.object({
          name: z.string(),
          kind: z.string(),
          file: z.string(),
          signature: z.string().optional(),
          documentation: z.string().optional(),
          code: z.string().optional(),
        })).optional(),
        files: z.array(z.string()).optional(),
        summary: z.object({
          mainSymbol: z.string(),
          dependencyCount: z.number(),
          fileCount: z.number(),
        }).optional(),
        error: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await extractCodeHandler(args);
      if (result.format === 'markdown' && result.content) {
        return {
          content: [{ type: 'text', text: result.content }],
          structuredContent: result,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }
  );

  // ==========================================================================
  // preflight_interface_summary
  // ==========================================================================
  server.registerTool(
    'preflight_interface_summary',
    {
      title: 'Generate interface summary',
      description: interfaceSummaryToolDescription,
      inputSchema: InterfaceSummaryInputSchema,
      outputSchema: {
        success: z.boolean(),
        summary: z.string().optional(),
        stats: z.object({
          totalFunctions: z.number(),
          exportedFunctions: z.number(),
          files: z.number(),
        }).optional(),
        error: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await interfaceSummaryHandler(args);
      if (result.success && result.summary) {
        return {
          content: [{ type: 'text', text: result.summary }],
          structuredContent: result,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }
  );
}
