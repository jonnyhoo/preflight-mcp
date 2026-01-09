/**
 * MCP Tool: preflight_parse_document
 *
 * Parse documents (PDF, Office, HTML) and extract text and multimodal content.
 * This tool bridges the document parser to MCP for LLM consumption.
 *
 * @module tools/parseDocument
 */

import * as z from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  ingestDocument,
  ingestDocuments,
  isParseableDocument,
  getDocumentCategory,
  type DocumentIngestResult,
} from '../bundle/document-ingest.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('parse-document');

// ============================================================================
// Input Schema
// ============================================================================

/**
 * Input schema for preflight_parse_document.
 */
export const ParseDocumentInputSchema = {
  path: z
    .string()
    .describe('Absolute path to document file (PDF, DOCX, XLSX, PPTX, HTML).'),
  extractImages: z
    .boolean()
    .default(true)
    .describe('Whether to extract images from document.'),
  extractTables: z
    .boolean()
    .default(true)
    .describe('Whether to extract tables from document.'),
  extractEquations: z
    .boolean()
    .default(true)
    .describe('Whether to extract equations from document.'),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Maximum pages to parse (for large documents).'),
  format: z
    .enum(['json', 'text', 'markdown'])
    .default('markdown')
    .describe('Output format: json (structured), text (plain), or markdown (formatted).'),
};

export type ParseDocumentInput = z.infer<z.ZodObject<typeof ParseDocumentInputSchema>>;

// ============================================================================
// Tool Description
// ============================================================================

export const parseDocumentToolDescription = {
  title: 'Parse Document',
  description: `Parse a document file and extract its content, including text, images, tables, and equations.

**Supported formats:**
- PDF (.pdf) - Full text extraction with OCR support
- Word (.doc, .docx) - Text and embedded content
- Excel (.xls, .xlsx) - Spreadsheet data as tables
- PowerPoint (.ppt, .pptx) - Slides as text + images
- HTML (.html, .htm) - Structured web content

**Use when:**
- "解析这个PDF", "读取文档", "提取PDF内容"
- "parse this document", "extract text from PDF"
- "analyze Excel file", "read Word document"
- Need to understand document structure before indexing

**Output includes:**
- Full text content (for search/analysis)
- Extracted images (as base64 or paths)
- Detected tables (as structured data)
- Mathematical equations (as LaTeX)
- Document metadata (pages, author, etc.)

**Note:** For indexing documents into a bundle, use preflight_create_bundle instead.
This tool is for one-off document analysis.`,
};

// ============================================================================
// Tool Handler
// ============================================================================

export interface ParseDocumentResult {
  success: boolean;
  path: string;
  category: string | null;
  pageCount?: number;
  fullText?: string;
  textPreview?: string;
  modalContent: {
    images: number;
    tables: number;
    equations: number;
  };
  warnings?: string[];
  error?: string;
  parseTimeMs: number;
}

/**
 * Create the handler for preflight_parse_document.
 */
export function createParseDocumentHandler() {
  return async (args: ParseDocumentInput): Promise<{
    text: string;
    structuredContent: ParseDocumentResult;
  }> => {
    const startTime = Date.now();
    const filePath = args.path;

    // Validate file exists
    try {
      await fs.access(filePath);
    } catch {
      return {
        text: `❌ File not found: ${filePath}`,
        structuredContent: {
          success: false,
          path: filePath,
          category: null,
          modalContent: { images: 0, tables: 0, equations: 0 },
          error: `File not found: ${filePath}`,
          parseTimeMs: Date.now() - startTime,
        },
      };
    }

    // Check if supported format
    if (!isParseableDocument(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      return {
        text: `❌ Unsupported document format: ${ext}\n\nSupported: .pdf, .doc, .docx, .xls, .xlsx, .ppt, .pptx, .html, .htm, .xhtml`,
        structuredContent: {
          success: false,
          path: filePath,
          category: null,
          modalContent: { images: 0, tables: 0, equations: 0 },
          error: `Unsupported format: ${ext}`,
          parseTimeMs: Date.now() - startTime,
        },
      };
    }

    // Parse document
    const result = await ingestDocument(filePath, {
      extractImages: args.extractImages,
      extractTables: args.extractTables,
      extractEquations: args.extractEquations,
      maxPagesPerDocument: args.maxPages,
    });

    // Count modal content by type
    const modalCounts = {
      images: result.modalContents.filter(c => c.type === 'image').length,
      tables: result.modalContents.filter(c => c.type === 'table').length,
      equations: result.modalContents.filter(c => c.type === 'equation').length,
    };

    const structuredContent: ParseDocumentResult = {
      success: result.success,
      path: filePath,
      category: getDocumentCategory(filePath),
      pageCount: result.pageCount,
      fullText: result.fullText,
      textPreview: result.fullText?.slice(0, 500) + (result.fullText && result.fullText.length > 500 ? '...' : ''),
      modalContent: modalCounts,
      warnings: result.warnings,
      error: result.error,
      parseTimeMs: result.parseTimeMs,
    };

    // Format output based on requested format
    let text: string;
    if (args.format === 'json') {
      text = JSON.stringify(structuredContent, null, 2);
    } else if (args.format === 'text') {
      text = result.fullText ?? result.error ?? 'No content extracted';
    } else {
      // Markdown format
      const lines: string[] = [];
      lines.push(`# Document Analysis: ${path.basename(filePath)}`);
      lines.push('');
      lines.push(`**Status:** ${result.success ? '✅ Success' : '❌ Failed'}`);
      lines.push(`**Format:** ${getDocumentCategory(filePath) ?? 'unknown'}`);
      if (result.pageCount) {
        lines.push(`**Pages:** ${result.pageCount}`);
      }
      lines.push(`**Parse Time:** ${result.parseTimeMs}ms`);
      lines.push('');
      
      lines.push('## Extracted Content');
      lines.push(`- 📄 Text: ${result.fullText ? `${result.fullText.length} characters` : 'None'}`);
      lines.push(`- 🖼️ Images: ${modalCounts.images}`);
      lines.push(`- 📊 Tables: ${modalCounts.tables}`);
      lines.push(`- 🔢 Equations: ${modalCounts.equations}`);
      lines.push('');

      if (structuredContent.textPreview) {
        lines.push('## Text Preview');
        lines.push('```');
        lines.push(structuredContent.textPreview);
        lines.push('```');
      }

      if (result.warnings && result.warnings.length > 0) {
        lines.push('');
        lines.push('## Warnings');
        result.warnings.forEach(w => lines.push(`- ⚠️ ${w}`));
      }

      if (result.error) {
        lines.push('');
        lines.push('## Error');
        lines.push(`❌ ${result.error}`);
      }

      text = lines.join('\n');
    }

    return { text, structuredContent };
  };
}
