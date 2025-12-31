/**
 * MCP Tool: preflight_search_modal
 *
 * Search multimodal content (images, tables, equations) indexed in bundles.
 * Uses FTS5 full-text search on content descriptions and keywords.
 *
 * @module tools/searchModal
 */

import * as z from 'zod';
import {
  searchModalContent,
  searchModalByKeywords,
  getModalContentStats,
  type ModalSearchHit,
  type ModalSearchScope,
  type ModalContentKind,
} from '../search/sqliteFts.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('search-modal');

// ============================================================================
// Input Schema
// ============================================================================

/**
 * Input schema for preflight_search_modal.
 */
export const SearchModalInputSchema = {
  bundleId: z.string().describe('Bundle ID to search.'),
  query: z.string().describe('Search query for modal content descriptions.'),
  scope: z
    .enum(['all', 'image', 'table', 'equation', 'diagram'])
    .default('all')
    .describe('Filter by content type: all, image, table, equation, or diagram.'),
  keywords: z
    .array(z.string())
    .optional()
    .describe('Optional keywords to filter by (exact match on indexed keywords).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Maximum results to return.'),
  includeScore: z
    .boolean()
    .default(false)
    .describe('Include BM25 relevance score in results.'),
  format: z
    .enum(['json', 'markdown'])
    .default('markdown')
    .describe('Output format.'),
};

export type SearchModalInput = z.infer<z.ZodObject<typeof SearchModalInputSchema>>;

// ============================================================================
// Tool Description
// ============================================================================

export const searchModalToolDescription = {
  title: 'Search Multimodal Content',
  description: `Search for images, tables, equations, and diagrams in a bundle.

**Search capabilities:**
- Full-text search on content descriptions
- Keyword-based filtering
- Filter by content type (image/table/equation/diagram)
- BM25 relevance ranking

**Use when:**
- "找到所有架构图", "搜索表格", "查找公式"
- "find architecture diagrams", "search for tables about config"
- "show equations related to physics"
- Looking for specific visual/structured content in documents

**Best practices:**
- Use descriptive queries (e.g., "system architecture diagram" not just "diagram")
- Filter by scope when you know the content type
- Use keywords for exact term matching

**Example queries:**
- "configuration parameters" with scope=table
- "neural network architecture" with scope=image
- "differential equation" with scope=equation`,
};

// ============================================================================
// Tool Handler
// ============================================================================

export interface SearchModalResult {
  bundleId: string;
  query: string;
  scope: string;
  totalHits: number;
  hits: ModalSearchHit[];
  stats?: {
    totalItems: number;
    byKind: Record<string, number>;
    uniqueDocuments: number;
  };
}

/**
 * Create the handler for preflight_search_modal.
 */
export function createSearchModalHandler(deps: {
  findBundleStorageDir: (storageDirs: string[], bundleId: string) => Promise<string | null>;
  getBundlePathsForId: (storageDir: string, bundleId: string) => { searchDbPath: string };
  storageDirs: string[];
}) {
  return async (args: SearchModalInput): Promise<{
    text: string;
    structuredContent: SearchModalResult;
  }> => {
    // Find bundle
    const storageDir = await deps.findBundleStorageDir(deps.storageDirs, args.bundleId);
    if (!storageDir) {
      return {
        text: `❌ Bundle not found: ${args.bundleId}\n\nRun preflight_list_bundles to see available bundles.`,
        structuredContent: {
          bundleId: args.bundleId,
          query: args.query,
          scope: args.scope,
          totalHits: 0,
          hits: [],
        },
      };
    }

    const paths = deps.getBundlePathsForId(storageDir, args.bundleId);
    const dbPath = paths.searchDbPath;

    // Perform search
    let hits: ModalSearchHit[];

    if (args.keywords && args.keywords.length > 0) {
      // Keyword-based search
      hits = searchModalByKeywords(dbPath, args.keywords, {
        scope: args.scope as ModalSearchScope,
        limit: args.limit,
      });
    } else {
      // Full-text search
      hits = searchModalContent(dbPath, args.query, {
        scope: args.scope as ModalSearchScope,
        limit: args.limit,
        includeScore: args.includeScore,
      });
    }

    // Get stats for context
    const stats = getModalContentStats(dbPath);

    const result: SearchModalResult = {
      bundleId: args.bundleId,
      query: args.query,
      scope: args.scope,
      totalHits: hits.length,
      hits,
      stats,
    };

    // Format output
    let text: string;
    if (args.format === 'json') {
      text = JSON.stringify(result, null, 2);
    } else {
      // Markdown format
      const lines: string[] = [];
      lines.push(`# Modal Search Results`);
      lines.push('');
      lines.push(`**Bundle:** ${args.bundleId}`);
      lines.push(`**Query:** "${args.query}"`);
      lines.push(`**Scope:** ${args.scope}`);
      lines.push(`**Results:** ${hits.length} hit(s)`);
      lines.push('');

      if (stats.totalItems > 0) {
        lines.push('## Index Stats');
        lines.push(`- Total indexed items: ${stats.totalItems}`);
        lines.push(`- Images: ${stats.byKind.image}, Tables: ${stats.byKind.table}`);
        lines.push(`- Equations: ${stats.byKind.equation}, Diagrams: ${stats.byKind.diagram}`);
        lines.push(`- Unique documents: ${stats.uniqueDocuments}`);
        lines.push('');
      }

      if (hits.length === 0) {
        lines.push('## No Results');
        lines.push('');
        lines.push('Try:');
        lines.push('- Broadening your search query');
        lines.push('- Using different keywords');
        lines.push('- Searching with scope="all"');
      } else {
        lines.push('## Results');
        lines.push('');

        for (let i = 0; i < hits.length; i++) {
          const hit = hits[i]!;
          const icon = hit.kind === 'image' ? '🖼️' :
                       hit.kind === 'table' ? '📊' :
                       hit.kind === 'equation' ? '🔢' : '📈';
          
          lines.push(`### ${i + 1}. ${icon} ${hit.entityName ?? hit.kind}`);
          lines.push(`- **Type:** ${hit.kind}`);
          lines.push(`- **Source:** ${hit.sourcePath}`);
          if (hit.pageIndex !== undefined) {
            lines.push(`- **Page:** ${hit.pageIndex + 1}`);
          }
          if (hit.score !== undefined) {
            lines.push(`- **Relevance:** ${Math.abs(hit.score).toFixed(3)}`);
          }
          lines.push('');
          lines.push('**Description:**');
          lines.push(`> ${hit.snippet}`);
          lines.push('');
        }
      }

      text = lines.join('\n');
    }

    return { text, structuredContent: result };
  };
}
