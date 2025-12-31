/**
 * MCP Tool: preflight_analyze_modal
 *
 * Analyze multimodal content (images, tables, equations) in a bundle.
 * Returns structured analysis results with evidence pointers for citations.
 *
 * @module tools/analyzeModal
 */

import * as z from 'zod';
import type { ModalContent, ModalContentType } from '../modal/types.js';
import type { EvidencePointer } from '../mcp/envelope.js';
import {
  ModalProcessingService,
  createModalService,
  type ModalScope,
  type ModalServiceResult,
} from '../modal/service.js';
import {
  type ResponseContext,
  createResponseContext,
  createSuccessResponse,
  createErrorResponse,
  addWarning,
  addEvidence,
  addNextAction,
  formatResponse,
  ErrorCodes,
  WarningCodes,
} from '../mcp/responseBuilder.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('analyze-modal');

// ============================================================================
// Input Schema
// ============================================================================

/**
 * Input schema for preflight_analyze_modal.
 */
export const AnalyzeModalInputSchema = {
  bundleId: z.string().describe('Bundle ID to analyze.'),
  scope: z
    .enum(['images', 'tables', 'equations', 'all'])
    .default('all')
    .describe('Scope of modal content to analyze.'),
  items: z
    .array(
      z.object({
        type: z.enum(['image', 'table', 'equation', 'generic']).describe('Content type.'),
        content: z.any().describe('Content data (base64, text, URL, or structured data).'),
        source: z.string().optional().describe('Source path within bundle.'),
        mimeType: z.string().optional().describe('MIME type of content.'),
      })
    )
    .optional()
    .describe('Explicit items to analyze. If not provided, auto-detect from bundle.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Max items to process (default: 20).'),
  format: z
    .enum(['json', 'text'])
    .default('json')
    .describe('Response format.'),
};

// ============================================================================
// Output Types
// ============================================================================

/**
 * Single analyzed item.
 */
export interface AnalyzedModalItem {
  /** Content type */
  type: ModalContentType;
  /** Source path */
  path?: string;
  /** Whether analysis succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Generated description */
  description?: string;
  /** Extracted text content */
  extractedText?: string;
  /** Entity information */
  entityInfo?: {
    entityName?: string;
    entityType?: string;
    summary?: string;
    keywords?: string[];
  };
  /** Processing time in ms */
  processingTimeMs: number;
}

/**
 * Output data for preflight_analyze_modal.
 */
export interface AnalyzeModalData {
  bundleId: string;
  scope: ModalScope;
  totalItems: number;
  processedItems: number;
  successCount: number;
  errorCount: number;
  items: AnalyzedModalItem[];
}

// ============================================================================
// Input Type
// ============================================================================

export type AnalyzeModalInput = {
  bundleId: string;
  scope?: 'images' | 'tables' | 'equations' | 'all';
  items?: Array<{
    type: 'image' | 'table' | 'equation' | 'generic';
    content: unknown;
    source?: string;
    mimeType?: string;
  }>;
  limit?: number;
  format?: 'json' | 'text';
};

// ============================================================================
// Tool Handler
// ============================================================================

/**
 * Create the tool handler for preflight_analyze_modal.
 */
export function createAnalyzeModalHandler(deps: {
  findBundleStorageDir: (storageDirs: string[], bundleId: string) => Promise<string | null>;
  getBundlePathsForId: (
    storageDir: string,
    bundleId: string
  ) => { rootDir: string; searchDbPath: string };
  assertBundleComplete: (bundleId: string) => Promise<void>;
  storageDirs: string[];
}) {
  const TOOL_NAME = 'preflight_analyze_modal';
  const modalService = createModalService();

  return async (args: AnalyzeModalInput) => {
    const ctx = createResponseContext(TOOL_NAME, args.bundleId);
    const format = args.format ?? 'json';

    try {
      // Find bundle
      const storageDir = await deps.findBundleStorageDir(deps.storageDirs, args.bundleId);
      if (!storageDir) {
        const response = createErrorResponse(
          ctx,
          ErrorCodes.BUNDLE_NOT_FOUND,
          `Bundle not found: ${args.bundleId}`,
          'Run preflight_list_bundles to find available bundles.'
        );
        addNextAction(ctx, 'preflight_list_bundles', {}, 'Find available bundles');
        return formatResponse(response, format);
      }

      // Prepare items for processing
      const scope = args.scope ?? 'all';
      const limit = args.limit ?? 20;

      let itemsToProcess: ModalContent[] = [];

      if (args.items && args.items.length > 0) {
        // Use explicit items
        itemsToProcess = args.items.slice(0, limit).map((item) => ({
          type: item.type as ModalContentType,
          content: item.content as string | Buffer | Record<string, unknown>,
          sourcePath: item.source,
          metadata: item.mimeType ? { mimeType: item.mimeType } : undefined,
        }));
      } else {
        // No items provided - return info message
        addWarning(
          ctx,
          WarningCodes.ITEMS_SKIPPED,
          'No items provided. Pass items[] with content to analyze.',
          true
        );

        const data: AnalyzeModalData = {
          bundleId: args.bundleId,
          scope,
          totalItems: 0,
          processedItems: 0,
          successCount: 0,
          errorCount: 0,
          items: [],
        };

        const response = createSuccessResponse(ctx, data);
        return formatResponse(response, format);
      }

      // Process items
      logger.info('Analyzing modal content', {
        bundleId: args.bundleId,
        scope,
        itemCount: itemsToProcess.length,
      });

      const result = await modalService.process({
        bundleId: args.bundleId,
        items: itemsToProcess,
        scope,
      });

      // Convert to output format
      const analyzedItems: AnalyzedModalItem[] = result.items.map((item) => ({
        type: item.type,
        path: item.path,
        success: item.success,
        error: item.error,
        description: item.description,
        extractedText: item.extractedText,
        entityInfo: item.entityInfo
          ? {
              entityName: item.entityInfo.entityName,
              entityType: item.entityInfo.entityType,
              summary: item.entityInfo.summary,
              keywords: item.entityInfo.keywords,
            }
          : undefined,
        processingTimeMs: item.processingTimeMs,
      }));

      // Add evidence pointers for successful items
      for (const item of result.items) {
        if (item.evidence) {
          addEvidence(ctx, item.evidence);
        }
      }

      // Suggest next actions based on results
      if (result.errorCount > 0) {
        addNextAction(
          ctx,
          'preflight_analyze_modal',
          { bundleId: args.bundleId, scope: args.scope },
          'Retry failed items with different parameters'
        );
      }

      if (result.successCount > 0) {
        addNextAction(
          ctx,
          'preflight_search_bundle',
          { bundleId: args.bundleId, query: 'extracted entity keywords' },
          'Search for related content using extracted information'
        );
      }

      const data: AnalyzeModalData = {
        bundleId: args.bundleId,
        scope,
        totalItems: itemsToProcess.length,
        processedItems: result.processedItems,
        successCount: result.successCount,
        errorCount: result.errorCount,
        items: analyzedItems,
      };

      const response = createSuccessResponse(ctx, data);
      return formatResponse(response, format);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error('Modal analysis failed', err instanceof Error ? err : undefined, {
        bundleId: args.bundleId,
      });

      const response = createErrorResponse(ctx, ErrorCodes.OPERATION_FAILED, errorMessage);
      return formatResponse(response, format);
    }
  };
}

// ============================================================================
// Tool Description
// ============================================================================

/**
 * Tool description for MCP registration.
 */
export const analyzeModalToolDescription = {
  title: 'Analyze multimodal content',
  description:
    'Analyze images, tables, and equations in a bundle. ' +
    'Returns structured analysis with descriptions, extracted text, and entity information.\n\n' +
    '**LLM Usage Guide:**\n' +
    '- Use for understanding visual content (diagrams, charts, screenshots)\n' +
    '- Use for extracting data from tables (CSV, Excel)\n' +
    '- Use for interpreting mathematical equations (LaTeX, MathML)\n\n' +
    '**Scope Options:**\n' +
    '- `images`: Analyze only images (OCR, object detection)\n' +
    '- `tables`: Analyze only tables (structure, data extraction)\n' +
    '- `equations`: Analyze only equations (parsing, variable detection)\n' +
    '- `all`: Analyze all modal content types\n\n' +
    '**Input Format:**\n' +
    '- Pass items[] with type, content, and optional source path\n' +
    '- Content can be base64, URL, or structured data\n\n' +
    'Triggers: "analyze image", "parse table", "understand equation", "分析图片", "解析表格"',
};
