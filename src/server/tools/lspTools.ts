/**
 * LSP tools - language server protocol operations.
 */
import * as z from 'zod';
import type { ToolDependencies } from './types.js';
import { LspInputSchema, lspToolDescription, createLspHandler } from '../../tools/lsp.js';


const LspOutputSchema = z.object({
  success: z.boolean(),
  action: z.enum(['definition', 'references', 'hover', 'symbols', 'diagnostics']).optional(),
  result: z.string().optional(),
  error: z.string().optional(),
  file: z.string().optional(),
  line: z.number().optional(),
  column: z.number().optional(),
  data: z.unknown().optional(),
});

type LspOutput = z.infer<typeof LspOutputSchema>;

/**
 * Register LSP tools (only when PREFLIGHT_LSP_ENABLED=true).
 */
export function registerLspTools({ server }: ToolDependencies): void {
  const lspHandler = createLspHandler();

  server.registerTool(
    'preflight_lsp',
    {
      title: 'LSP code intelligence',
      description: lspToolDescription,
      inputSchema: LspInputSchema,
      outputSchema: LspOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: LspOutput }> => {
      const result = await lspHandler(args);
      const text = result.success ? result.result ?? 'OK' : `Error: ${result.error}`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: result,
      };
    }
  );
}
