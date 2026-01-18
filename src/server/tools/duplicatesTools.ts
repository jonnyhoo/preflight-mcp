/**
 * Code duplication check tools - detect copy-paste patterns.
 */
import * as z from 'zod';
import type { ToolDependencies } from './types.js';
import { DuplicatesInputSchema, duplicatesToolDescription, createDuplicatesHandler } from '../../tools/duplicates.js';

/**
 * Register code duplication check tools.
 */
export function registerDuplicatesTools({ server }: ToolDependencies): void {
  const duplicatesHandler = createDuplicatesHandler();

  server.registerTool(
    'preflight_duplicates',
    {
      title: 'Code duplication detection',
      description: duplicatesToolDescription,
      inputSchema: DuplicatesInputSchema,
      outputSchema: {
        success: z.boolean(),
        result: z.string().optional(),
        error: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await duplicatesHandler(args);
      const text = result.success ? result.result ?? 'OK' : `Error: ${result.error}`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          success: result.success,
          result: result.result,
          error: result.error,
          summary: result.data?.summary,
          cloneCount: result.data?.clones.length ?? 0,
        },
      };
    }
  );
}
