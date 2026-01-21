/**
 * preflight_generate_card - Generate knowledge card from bundle.
 */

import * as z from 'zod';

import type { ToolDependencies } from './types.js';
import { generateRepoCard, exportCardForRAG } from '../../distill/repo-card.js';
import { wrapPreflightError } from '../../mcp/errorKinds.js';

// ============================================================================
// preflight_generate_card
// ============================================================================

export function registerDistillTools({ server }: ToolDependencies): void {
  server.registerTool(
    'preflight_generate_card',
    {
      title: 'Generate knowledge card',
      description: 'Extract a knowledge card from a bundle. Cards capture "what is this project" and "why is it valuable" for later retrieval.\n\n' +
        '**Usage:** `{\"bundleId\": \"<id>\"}` or `{\"bundleId\": \"<id>\", \"repoId\": \"owner/repo\"}`\n' +
        '**Options:** `regenerate: true` to force refresh, `format: \"markdown\"` for human-readable output.\n' +
        'Use when: "生成卡片", "蒸馏项目", "提取知识", "create card", "distill repo".',
      inputSchema: {
        bundleId: z.string().describe('Bundle ID'),
        repoId: z.string().optional().describe('Repo ID (default: first repo in bundle)'),
        regenerate: z.boolean().optional().describe('Force regenerate even if exists'),
        format: z.enum(['json', 'markdown', 'text']).optional().describe('Output format'),
      },
      outputSchema: {
        card: z.object({
          cardId: z.string(),
          name: z.string(),
          oneLiner: z.string(),
          problemSolved: z.string(),
          useCases: z.array(z.string()),
          designHighlights: z.array(z.string()),
          quickStart: z.string(),
          keyAPIs: z.array(z.string()),
          confidence: z.number(),
          warnings: z.array(z.string()),
        }).optional(),
        llmUsed: z.boolean().optional(),
        saved: z.boolean().optional(),
        warnings: z.array(z.string()).optional(),
        markdown: z.string().optional(),
        text: z.string().optional(),
      },
      annotations: { openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await generateRepoCard(args.bundleId, args.repoId, {
          regenerate: args.regenerate,
        });

        const format = args.format || 'json';
        const exported = exportCardForRAG(result.card);

        // Build response based on format
        let textResponse = '';
        if (result.saved) {
          textResponse = `✅ Card generated: ${result.card.name}\n`;
          textResponse += `LLM used: ${result.llmUsed ? 'yes' : 'no (fallback)'}\n`;
          if (result.warnings.length) {
            textResponse += `⚠️ Warnings: ${result.warnings.join(', ')}\n`;
          }
        } else {
          textResponse = `📄 Existing card: ${result.card.name}\n`;
          if (result.warnings.includes('low_confidence')) {
            textResponse += `⚠️ Card may be stale - regenerate with \`regenerate: true\`\n`;
          }
        }

        if (format === 'markdown') {
          textResponse += '\n---\n' + exported.markdown;
        } else if (format === 'text') {
          textResponse += '\n---\n' + exported.text;
        }

        return {
          content: [{ type: 'text', text: textResponse }],
          structuredContent: {
            card: {
              cardId: result.card.cardId,
              name: result.card.name,
              oneLiner: result.card.oneLiner,
              problemSolved: result.card.problemSolved,
              useCases: result.card.useCases,
              designHighlights: result.card.designHighlights,
              quickStart: result.card.quickStart,
              keyAPIs: result.card.keyAPIs,
              confidence: result.card.confidence,
              warnings: result.card.warnings,
            },
            llmUsed: result.llmUsed,
            saved: result.saved,
            warnings: result.warnings,
            ...(format === 'markdown' && { markdown: exported.markdown }),
            ...(format === 'text' && { text: exported.text }),
          },
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );
}
