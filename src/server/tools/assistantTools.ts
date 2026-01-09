/**
 * Assistant tool registration.
 *
 * In PREFLIGHT_TOOLSET=minimal, this should be the only exposed tool.
 */

import * as z from 'zod';

import type { ToolDependencies } from './types.js';
import { AssistantInputSchema, createAssistantHandler, assistantToolDescription } from '../../tools/assistant.js';

export function registerAssistantTools({ server, cfg }: ToolDependencies): void {
  const handler = createAssistantHandler({
    cfg,
    onResourcesChanged: () => server.sendResourceListChanged(),
  });

  server.registerTool(
    'preflight_assistant',
    {
      title: assistantToolDescription.title,
      description: assistantToolDescription.description,
      inputSchema: AssistantInputSchema,
      outputSchema: {
        ok: z.boolean(),
        meta: z.object({
          tool: z.string(),
          schemaVersion: z.string(),
          timeMs: z.number(),
        }),
        intent: z.enum(['project', 'paper', 'pair']),
        question: z.string(),
        sources: z.object({
          repos: z.array(z.any()),
          bundleIds: z.array(z.string()),
          docPaths: z.array(z.string()),
        }),
        resolved: z.object({
          usedBundleIds: z.array(z.string()),
          repoBundleId: z.string().optional(),
          docsBundleId: z.string().optional(),
          targetBundleId: z.string().optional(),
        }),
        operations: z.any().optional(),
        evidence: z.array(
          z.object({
            source: z.enum(['overview', 'fts', 'semantic']),
            bundleId: z.string(),
            repo: z.string(),
            kind: z.enum(['doc', 'code']),
            path: z.string(),
            matchRange: z.object({ startLine: z.number(), endLine: z.number() }),
            excerptRange: z.object({ startLine: z.number(), endLine: z.number() }),
            excerpt: z.string(),
            score: z.number().optional(),
            uri: z.string(),
          })
        ),
        target: z.any().optional(),
      },
      annotations: { openWorldHint: true },
    },
    async (args) => {
      const result = await handler(args as any);
      return {
        content: [{ type: 'text', text: result.text }],
        structuredContent: result.structuredContent,
      };
    }
  );
}
