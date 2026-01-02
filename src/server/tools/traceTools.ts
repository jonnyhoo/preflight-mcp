/**
 * Trace tools - trace_upsert, trace_query, suggest_traces
 */

import * as z from 'zod';

import type { ToolDependencies } from './types.js';
import { assertBundleComplete } from '../../bundle/service.js';
import { wrapPreflightError } from '../../mcp/errorKinds.js';
import { TraceQueryInputSchema, TraceUpsertInputSchema, traceQuery, traceUpsert } from '../../trace/service.js';
import { SuggestTracesInputSchema, suggestTraces, suggestTracesToolDescription, type SuggestTracesResult } from '../../trace/suggest.js';

/**
 * Register all trace-related tools.
 */
export function registerTraceTools({ server, cfg }: ToolDependencies): void {
  // ==========================================================================
  // preflight_trace_upsert
  // ==========================================================================
  server.registerTool(
    'preflight_trace_upsert',
    {
      title: 'Trace: upsert links',
      description:
        'Create or update traceability links (code↔test, code↔doc, file↔requirement). ' +
        '**Proactive use recommended**: When you discover relationships during code analysis ' +
        '(e.g., "this file has a corresponding test", "this module implements feature X"), ' +
        'automatically create trace links to record these findings for future queries.\n\n' +
        '⚠️ **SAFETY: Use dryRun=true to preview changes before writing.**\n\n' +
        '📌 **When to Write Trace Links (LLM Rules):**\n' +
        'Write trace links ONLY for these 3 high-value relationship types:\n' +
        '1. **Entry ↔ Core module** (entrypoint_of): Main entry points and their critical paths\n' +
        '2. **Implementation ↔ Test** (tested_by): Code files and their corresponding tests\n' +
        '3. **Code ↔ Documentation** (documents/implements): Code implementing specs or documented in files\n\n' +
        '⚠️ **Required Evidence (for tested_by/documents/implements):**\n' +
        '- sources: Array of evidence with file path + line range or note (REQUIRED)\n' +
        '- method: "exact" (parser-verified) or "heuristic" (name-based)\n' +
        '- confidence: 0.0-1.0 (use 0.9 for exact matches, 0.6-0.8 for heuristics)\n' +
        '- Edges without sources will be BLOCKED with actionable guidance\n\n' +
        '❌ **Do NOT write:**\n' +
        '- Pure import relationships (use dependency_graph instead)\n' +
        '- Low-value or obvious relationships\n\n' +
        '**Standard edge_types:** tested_by, documents, implements, relates_to, entrypoint_of, depends_on\n\n' +
        '📤 **Auto-export:** trace.json is automatically exported to trace/trace.json after each upsert for LLM direct reading.',
      inputSchema: TraceUpsertInputSchema,
      outputSchema: {
        bundleId: z.string(),
        dryRun: z.boolean().describe('Whether this was a dry run (preview only).'),
        upserted: z.number().int().describe('Number of edges actually written (0 if dryRun=true).'),
        ids: z.array(z.string()).describe('IDs of upserted edges.'),
        warnings: z.array(z.object({
          edgeIndex: z.number(),
          code: z.string(),
          message: z.string(),
        })).optional().describe('Non-blocking validation warnings.'),
        blocked: z.array(z.object({
          edgeIndex: z.number(),
          code: z.string(),
          message: z.string(),
          nextAction: z.object({
            toolName: z.string(),
            why: z.string(),
          }),
        })).optional().describe('Edges blocked due to validation errors (e.g., missing sources).'),
        preview: z.array(z.object({
          id: z.string(),
          source: z.object({ type: z.string(), id: z.string() }),
          target: z.object({ type: z.string(), id: z.string() }),
          type: z.string(),
          confidence: z.number(),
          method: z.enum(['exact', 'heuristic']),
          sourcesCount: z.number(),
        })).optional().describe('Preview of edges (only in dryRun mode).'),
      },
      annotations: { openWorldHint: true },
    },
    async (args) => {
      try {
        await assertBundleComplete(cfg, args.bundleId);
        const out = await traceUpsert(cfg, args);
        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );

  // ==========================================================================
  // preflight_trace_query
  // ==========================================================================
  server.registerTool(
    'preflight_trace_query',
    {
      title: 'Trace: query links',
      description:
        'Query traceability links (code↔test, code↔doc, commit↔ticket). ' +
        '**Proactive use recommended**: When analyzing a specific file or discussing code structure, ' +
        'automatically query trace links to find related tests, documentation, or requirements. ' +
        'This helps answer questions like "does this code have tests?" or "what requirements does this implement?". ' +
        'Provide bundleId for fast queries; if omitted, scans across bundles (capped). This tool is read-only.',
      inputSchema: TraceQueryInputSchema,
      outputSchema: {
        bundleId: z.string().optional(),
        scannedBundles: z.number().int().optional(),
        truncated: z.boolean().optional(),
        edges: z.array(
          z.object({
            id: z.string(),
            source: z.object({ type: z.string(), id: z.string() }),
            target: z.object({ type: z.string(), id: z.string() }),
            type: z.string(),
            confidence: z.number(),
            method: z.enum(['exact', 'heuristic']),
            sources: z.array(z.any()),
            createdAt: z.string(),
            updatedAt: z.string(),
            bundleId: z.string().optional(),
          })
        ),
        reason: z.enum(['no_edges', 'no_matching_edges', 'not_initialized', 'no_matching_bundle']).optional()
          .describe('Reason for empty results. no_edges=no trace links exist across bundles, no_matching_edges=links exist but none match query, not_initialized=trace DB empty for this bundle, no_matching_bundle=no bundles found.'),
        nextSteps: z.array(z.string()).optional()
          .describe('Actionable guidance when edges is empty.'),
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
      try {
        const { parseCursorOrDefault, createNextCursor } = await import('../../mcp/cursor.js');
        const TOOL_NAME = 'preflight_trace_query';
        const { offset, error: cursorError } = parseCursorOrDefault(args.cursor, TOOL_NAME);
        const pageSize = args.limit;

        if (args.bundleId) {
          await assertBundleComplete(cfg, args.bundleId);
        }

        const fetchLimit = offset + pageSize + 1;
        const rawOut = await traceQuery(cfg, { ...args, limit: fetchLimit });
        
        const hasMore = rawOut.edges.length > offset + pageSize;
        const paginatedEdges = rawOut.edges.slice(offset, offset + pageSize);
        
        const out: Record<string, unknown> = {
          ...rawOut,
          edges: paginatedEdges,
        };
        
        if (hasMore || offset > 0 || cursorError) {
          out.truncation = {
            truncated: hasMore,
            returnedCount: paginatedEdges.length,
            ...(hasMore && { nextCursor: createNextCursor(TOOL_NAME, offset, pageSize) }),
            ...(cursorError && { reason: cursorError }),
          };
        }
        
        let textOutput: string;
        if (paginatedEdges.length === 0 && rawOut.reason) {
          textOutput = `No trace links found.\nReason: ${rawOut.reason}\n\nNext steps:\n${(rawOut.nextSteps ?? []).map(s => `- ${s}`).join('\n')}`;
        } else {
          textOutput = JSON.stringify(out, null, 2);
        }
        
        return {
          content: [{ type: 'text', text: textOutput }],
          structuredContent: out,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );

  // ==========================================================================
  // preflight_suggest_traces
  // ==========================================================================
  server.registerTool(
    'preflight_suggest_traces',
    {
      title: suggestTracesToolDescription.title,
      description: suggestTracesToolDescription.description,
      inputSchema: SuggestTracesInputSchema,
      outputSchema: {
        bundleId: z.string(),
        edge_type: z.string(),
        scope: z.string(),
        suggestions: z.array(z.object({
          source: z.object({ type: z.string(), id: z.string() }),
          target: z.object({ type: z.string(), id: z.string() }),
          type: z.string(),
          confidence: z.number().optional(),
          method: z.enum(['exact', 'heuristic']).optional(),
          sources: z.array(z.any()).optional(),
          reason: z.string(),
          matchType: z.enum(['naming', 'import', 'directory', 'heuristic']),
        })),
        stats: z.object({
          totalTestFiles: z.number(),
          totalSourceFiles: z.number(),
          matchedPairs: z.number(),
          avgConfidence: z.number(),
        }),
        hint: z.string(),
        nextSteps: z.array(z.string()),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        await assertBundleComplete(cfg, args.bundleId);
        const result = await suggestTraces(cfg, args);
        
        const lines: string[] = [
          `## Trace Suggestions for ${args.bundleId}`,
          '',
          `**Stats:** ${result.stats.totalTestFiles} test files, ${result.stats.totalSourceFiles} source files`,
          `**Found:** ${result.suggestions.length} potential relationships (avg confidence: ${(result.stats.avgConfidence * 100).toFixed(0)}%)`,
          '',
          `💡 ${result.hint}`,
          '',
        ];
        
        if (result.suggestions.length > 0) {
          lines.push('### Suggestions (top 10)');
          for (const s of result.suggestions.slice(0, 10)) {
            lines.push(`- \`${s.source.id}\` → \`${s.target.id}\` (${(s.confidence ?? 0) * 100}% ${s.matchType})`);
          }
          if (result.suggestions.length > 10) {
            lines.push(`... and ${result.suggestions.length - 10} more`);
          }
          lines.push('');
        }
        
        if (result.nextSteps.length > 0) {
          lines.push('### Next Steps');
          for (const step of result.nextSteps) {
            lines.push(`- ${step}`);
          }
        }
        
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: result,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );
}
