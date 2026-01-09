/**
 * RFC v2: preflight_read_files - Batch file reading tool.
 * 
 * Enables LLM to read multiple files in a single call, reducing round-trips.
 * Each file can specify optional line ranges and line number formatting.
 */

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import * as z from 'zod';

import { type EvidencePointer, type SourceRange, createRange } from '../mcp/envelope.js';
import {
  type ResponseContext,
  createResponseContext,
  createSuccessResponse,
  createErrorResponse,
  addWarning,
  addEvidence,
  setTruncation,
  formatResponse,
  ErrorCodes,
  WarningCodes,
} from '../mcp/responseBuilder.js';
import { safeJoin, toBundleFileUri } from '../mcp/uris.js';

/**
 * Input schema for a single file request.
 */
export const FileRequestSchema = z.object({
  /** Bundle-relative path to the file */
  path: z.string().describe('Bundle-relative path (e.g., "repos/owner/repo/norm/src/index.ts").'),
  /** Optional line ranges to read (e.g., ["20-80", "100-120"]) */
  ranges: z
    .array(z.string())
    .optional()
    .describe('Line ranges to read, e.g. ["20-80", "100-120"]. Each range is "start-end" (1-indexed, inclusive). If omitted, reads entire file.'),
  /** Whether to prefix lines with line numbers */
  withLineNumbers: z
    .boolean()
    .optional()
    .default(true)
    .describe('If true (default), prefix each line with "N|" for evidence citation.'),
});

/**
 * Input schema for preflight_read_files.
 */
export const ReadFilesInputSchema = {
  bundleId: z.string().describe('Bundle ID to read from.'),
  files: z
    .array(FileRequestSchema)
    .min(1)
    .max(20)
    .describe('Files to read (max 20 per call).'),
  format: z
    .enum(['json', 'text'])
    .default('json')
    .describe('Response format. json=unified envelope (default), text=human-readable.'),
};

/**
 * Result for a single file read.
 */
export interface FileReadResult {
  path: string;
  content: string;
  lineInfo: {
    totalLines: number;
    ranges: Array<{ start: number; end: number }>;
  };
  error?: string;
}

/**
 * Output data for preflight_read_files.
 */
export interface ReadFilesData {
  bundleId: string;
  files: FileReadResult[];
}

/**
 * Parse range string "start-end" into { start, end }.
 */
function parseRange(rangeStr: string): { start: number; end: number } | null {
  const match = rangeStr.match(/^(\d+)-(\d+)$/);
  if (!match) return null;
  const start = parseInt(match[1]!, 10);
  const end = parseInt(match[2]!, 10);
  if (start < 1 || end < start) return null;
  return { start, end };
}

/**
 * Format file content with optional line numbers and ranges.
 */
function formatContent(
  rawContent: string,
  withLineNumbers: boolean,
  ranges?: Array<{ start: number; end: number }>
): { content: string; lineInfo: { totalLines: number; ranges: Array<{ start: number; end: number }> } } {
  const lines = rawContent.replace(/\r\n/g, '\n').split('\n');
  const totalLines = lines.length;

  let selectedLines: Array<{ lineNo: number; text: string }> = [];

  if (ranges && ranges.length > 0) {
    // Extract specified ranges
    for (const range of ranges) {
      const start = Math.max(1, range.start);
      const end = Math.min(totalLines, range.end);
      for (let i = start; i <= end; i++) {
        selectedLines.push({ lineNo: i, text: lines[i - 1] ?? '' });
      }
    }
  } else {
    // All lines
    selectedLines = lines.map((text, idx) => ({ lineNo: idx + 1, text }));
  }

  // Format output
  const formatted = withLineNumbers
    ? selectedLines.map((l) => `${l.lineNo}|${l.text}`).join('\n')
    : selectedLines.map((l) => l.text).join('\n');

  const actualRanges =
    ranges && ranges.length > 0
      ? ranges.map((r) => ({ start: Math.max(1, r.start), end: Math.min(totalLines, r.end) }))
      : [{ start: 1, end: totalLines }];

  return { content: formatted, lineInfo: { totalLines, ranges: actualRanges } };
}

/**
 * Compute SHA256 hash of content for integrity verification.
 */
function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Read multiple files from a bundle.
 * 
 * @param bundleRoot - Absolute path to bundle root directory
 * @param bundleId - Bundle ID for URI generation
 * @param files - Array of file requests
 * @param ctx - Response context for tracking warnings and evidence
 * @returns Array of file read results
 */
export async function readMultipleFiles(
  bundleRoot: string,
  bundleId: string,
  files: Array<z.infer<typeof FileRequestSchema>>,
  ctx: ResponseContext
): Promise<FileReadResult[]> {
  const results: FileReadResult[] = [];
  let totalBytes = 0;
  const MAX_TOTAL_BYTES = 1024 * 1024; // 1MB total limit

  for (const fileReq of files) {
    try {
      // Safe path join to prevent traversal
      const absPath = safeJoin(bundleRoot, fileReq.path);
      const rawContent = await fs.readFile(absPath, 'utf8');

      // Check total bytes limit
      totalBytes += rawContent.length;
      if (totalBytes > MAX_TOTAL_BYTES) {
        addWarning(ctx, WarningCodes.RESULT_TRUNCATED, `Total response size exceeded ${MAX_TOTAL_BYTES} bytes`, true);
        setTruncation(ctx, true, { reason: 'Total response size limit exceeded' });
        break;
      }

      // Parse ranges if provided
      let parsedRanges: Array<{ start: number; end: number }> | undefined;
      if (fileReq.ranges && fileReq.ranges.length > 0) {
        parsedRanges = [];
        for (const rangeStr of fileReq.ranges) {
          const parsed = parseRange(rangeStr);
          if (!parsed) {
            results.push({
              path: fileReq.path,
              content: '',
              lineInfo: { totalLines: 0, ranges: [] },
              error: `Invalid range format: "${rangeStr}". Expected "start-end" (e.g., "20-80").`,
            });
            continue;
          }
          parsedRanges.push(parsed);
        }
        // Sort and deduplicate ranges
        parsedRanges.sort((a, b) => a.start - b.start);
      }

      const withLineNumbers = fileReq.withLineNumbers ?? true;
      const { content, lineInfo } = formatContent(rawContent, withLineNumbers, parsedRanges);

      results.push({
        path: fileReq.path,
        content,
        lineInfo,
      });

      // Create evidence pointer for each range
      for (const range of lineInfo.ranges) {
        const snippet = content.length <= 500 ? content : content.slice(0, 500) + '…';
        const evidence: EvidencePointer = {
          path: fileReq.path,
          range: createRange(range.start, range.end),
          uri: toBundleFileUri({ bundleId, relativePath: fileReq.path }),
          snippet,
          snippetSha256: computeSha256(snippet),
        };
        addEvidence(ctx, evidence);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      results.push({
        path: fileReq.path,
        content: '',
        lineInfo: { totalLines: 0, ranges: [] },
        error: errorMessage,
      });
    }
  }

  return results;
}

/**
 * Tool handler input type.
 */
export type ReadFilesInput = {
  bundleId: string;
  files: Array<z.infer<typeof FileRequestSchema>>;
  format?: 'json' | 'text';
};

/**
 * Create the tool handler for preflight_read_files.
 */
export function createReadFilesHandler(deps: {
  findBundleStorageDir: (storageDirs: string[], bundleId: string) => Promise<string | null>;
  getBundlePathsForId: (storageDir: string, bundleId: string) => { rootDir: string };
  storageDirs: string[];
}) {
  return async (args: ReadFilesInput) => {
    const ctx = createResponseContext('preflight_read_files', args.bundleId);
    const format = args.format ?? 'json';

    try {
      // Find bundle storage directory
      const storageDir = await deps.findBundleStorageDir(deps.storageDirs, args.bundleId);
      if (!storageDir) {
        const response = createErrorResponse(
          ctx,
          ErrorCodes.BUNDLE_NOT_FOUND,
          `Bundle not found: ${args.bundleId}`,
          'Run preflight_list_bundles to find available bundles.'
        );
        return formatResponse(response, format);
      }

      const paths = deps.getBundlePathsForId(storageDir, args.bundleId);
      const results = await readMultipleFiles(paths.rootDir, args.bundleId, args.files, ctx);

      const data: ReadFilesData = {
        bundleId: args.bundleId,
        files: results,
      };

      // Check if any files had errors
      const filesWithErrors = results.filter((r) => r.error);
      if (filesWithErrors.length > 0 && filesWithErrors.length < results.length) {
        addWarning(
          ctx,
          WarningCodes.PARTIAL_RESULTS,
          `${filesWithErrors.length} of ${results.length} files had errors`,
          true
        );
      }

      const response = createSuccessResponse(ctx, data);
      return formatResponse(response, format);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const response = createErrorResponse(ctx, ErrorCodes.OPERATION_FAILED, errorMessage);
      return formatResponse(response, format);
    }
  };
}

/**
 * Tool description for MCP registration.
 */
export const readFilesToolDescription = {
  title: 'Read multiple files (DEPRECATED)',
  description:
    '⚠️ **DEPRECATED**: Use multiple `preflight_read_file` calls, or use `preflight_search_and_read` ' +
    'which combines search and reading in one call.\n\n' +
    'Read multiple files from a bundle in a single call. ' +
    'Each file can specify optional line ranges and line number formatting.',
};
