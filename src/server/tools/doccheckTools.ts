/**
 * Documentation check tools - check documentation-code consistency.
 */
import * as z from 'zod';
import type { ToolDependencies } from './types.js';
import { DocCheckInputSchema, doccheckToolDescription, createDocCheckHandler } from '../../tools/doccheck.js';

/**
 * Register documentation check tools.
 */
export function registerDocCheckTools({ server }: ToolDependencies): void {
  const doccheckHandler = createDocCheckHandler();

  server.registerTool(
    'preflight_doccheck',
    {
      title: 'Documentation consistency check',
      description: doccheckToolDescription,
      inputSchema: DocCheckInputSchema,
      outputSchema: {
        success: z.boolean(),
        result: z.string().optional(),
        error: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await doccheckHandler(args);
      const text = result.success ? result.result ?? 'OK' : `Error: ${result.error}`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          success: result.success,
          result: result.result,
          error: result.error,
          summary: result.data?.summary,
          issueCount: result.data?.issues.length ?? 0,
        },
      };
    }
  );
}
