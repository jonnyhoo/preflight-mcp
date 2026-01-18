/**
 * Unified code check tools - run multiple code quality checks.
 */
import * as z from 'zod';
import type { ToolDependencies } from './types.js';
import { CheckInputSchema, checkToolDescription, createCheckHandler } from '../../tools/check.js';

/**
 * Register unified code check tool.
 */
export function registerCheckTools({ server }: ToolDependencies): void {
  const checkHandler = createCheckHandler();

  server.registerTool(
    'preflight_check',
    {
      title: 'Code quality checks',
      description: checkToolDescription,
      inputSchema: CheckInputSchema,
      outputSchema: {
        success: z.boolean(),
        result: z.string().optional(),
        error: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await checkHandler(args);
      const text = result.success ? result.result ?? 'OK' : `Error: ${result.error}`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          success: result.success,
          result: result.result,
          error: result.error,
          totalIssues: result.data?.totalIssues ?? 0,
          issuesByCheck: result.data?.summary.issuesByCheck,
          issuesBySeverity: result.data?.summary.issuesBySeverity,
        },
      };
    }
  );
}
