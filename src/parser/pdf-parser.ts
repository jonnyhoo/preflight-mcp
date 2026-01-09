/**
 * PDF document parser using unpdf.
 *
 * This module provides PDF parsing capabilities including:
 * - Text extraction with position information
 * - Image extraction
 * - Table detection and extraction
 * - Metadata extraction
 *
 * @module parser/pdf-parser
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDocumentProxy, extractText, extractImages } from 'unpdf';

import type {
  IDocumentParser,
  ParseResult,
  ParsedContent,
  DocumentMetadata,
  ParseStats,
  ParseOptions,
  PdfParseOptions,
  SupportedFormat,
  ParsedContentType,
  ParseError,
  TocEntry,
  ParsedTableData,
} from './types.js';
import { DEFAULT_PARSE_OPTIONS } from './types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('pdf-parser');

// ============================================================================
// PDF Parser Implementation
// ============================================================================

/**
 * PDF parser using unpdf library.
 */
export class PdfParser implements IDocumentParser {
  readonly name = 'unpdf';
  readonly supportedFormats: readonly SupportedFormat[] = ['.pdf'] as const;

  /**
   * Check if this parser can handle the file.
   */
  canParse(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return this.supportedFormats.includes(ext as SupportedFormat);
  }

  /**
   * Check if unpdf is properly installed.
   */
  async checkInstallation(): Promise<boolean> {
    try {
      // Just check if imports work
      return typeof getDocumentProxy === 'function';
    } catch {
      return false;
    }
  }

  /**
   * Parse a PDF document.
   */
  async parse(filePath: string, options?: PdfParseOptions): Promise<ParseResult> {
    const startTime = Date.now();
    const opts = { ...DEFAULT_PARSE_OPTIONS, ...options };
    const errors: ParseError[] = [];
    const warnings: string[] = [];
    const contents: ParsedContent[] = [];

    try {
      // Read PDF file once.
      const buffer = fs.readFileSync(filePath);

      // IMPORTANT: unpdf may detach/transfer ArrayBuffers when crossing worker boundaries.
      // Never reuse the same Uint8Array instance for multiple unpdf calls.
      const freshData = () => new Uint8Array(buffer);

      // Get document proxy for metadata and structure
      const pdf = await getDocumentProxy(freshData());

      // Extract metadata
      const metadata = await this.extractMetadata(filePath, pdf, startTime);

      // Determine page range
      const pageCount = pdf.numPages;
      metadata.pageCount = pageCount;
      const startPage = opts.pageRange?.start ?? 0;
      const endPage = Math.min(opts.pageRange?.end ?? pageCount - 1, pageCount - 1);

      // Check maxPages limit
      const maxPages = opts.maxPages ?? pageCount;
      const pagesToProcess = Math.min(endPage - startPage + 1, maxPages);

      // Extract text content
      const textResult = await extractText(freshData(), {
        mergePages: false,
      });

      // Process each page
      const fullTextParts: string[] = [];
      const pageTexts = textResult.text; // string[] when mergePages: false

      for (let pageIdx = startPage; pageIdx < startPage + pagesToProcess; pageIdx++) {
        try {
          // Get page text
          const pageText = pageTexts[pageIdx] ?? '';
          
          if (pageText.trim()) {
            // Detect structure in page text
            const pageContents = this.parsePageContent(pageText, pageIdx);
            contents.push(...pageContents);
            fullTextParts.push(pageText);
          }
        } catch (pageError) {
          const errMsg = pageError instanceof Error ? pageError.message : String(pageError);
          errors.push({
            code: 'PAGE_ERROR',
            message: `Error processing page ${pageIdx}: ${errMsg}`,
            pageIndex: pageIdx,
            recoverable: true,
          });
        }
      }

      // Extract images if requested
      if (opts.extractImages) {
        try {
          // extractImages takes (data, pageNumber) for a single page
          for (let pageIdx = startPage; pageIdx < startPage + pagesToProcess; pageIdx++) {
            const pageImages = await extractImages(freshData(), pageIdx + 1); // 1-indexed
            
            for (const image of pageImages) {
              contents.push({
                type: 'image',
                content: `data:image/png;base64,${Buffer.from(image.data).toString('base64')}`,
                pageIndex: pageIdx,
                metadata: {
                  width: image.width,
                  height: image.height,
                  key: image.key,
                },
              });
            }
          }
        } catch (imgError) {
          const errMsg = imgError instanceof Error ? imgError.message : String(imgError);
          warnings.push(`Image extraction failed: ${errMsg}`);
        }
      }

      // Detect tables in text content
      if (opts.extractTables) {
        const tables = this.detectTables(pageTexts);
        contents.push(...tables);
      }

      // Build statistics
      const stats = this.buildStats(contents, startTime);

      // Generate full text
      const fullText = opts.generateFullText ? fullTextParts.join('\n\n') : undefined;

      // Extract TOC if available
      const tableOfContents = await this.extractToc(pdf);

      return {
        success: true,
        contents,
        metadata,
        stats,
        fullText,
        tableOfContents: tableOfContents.length > 0 ? tableOfContents : undefined,
        errors: errors.length > 0 ? errors : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`PDF parsing failed (unpdf): ${errMsg}`);

      // Fallback: pdf-parse for text-only extraction (more robust across environments).
      try {
        const pdfParseMod = await import('pdf-parse');
        const pdfParse = (pdfParseMod as unknown as { default: (data: Buffer) => Promise<any> }).default;

        const buffer = fs.readFileSync(filePath);
        const parsed = await pdfParse(buffer);
        const text = (parsed?.text as string | undefined) ?? '';

        const metadata: DocumentMetadata = {
          title: path.basename(filePath, path.extname(filePath)),
          pageCount: typeof parsed?.numpages === 'number' ? parsed.numpages : undefined,
          format: '.pdf',
          fileSizeBytes: fs.statSync(filePath).size,
          parser: 'pdf-parse',
          parsedAt: new Date().toISOString(),
        };

        const contents: ParsedContent[] = text.trim()
          ? [{ type: 'text', content: text }]
          : [];

        const stats: ParseStats = {
          totalItems: contents.length,
          byType: { text: contents.length },
          parseTimeMs: Date.now() - startTime,
        };

        return {
          success: true,
          contents,
          metadata,
          stats,
          fullText: text,
          warnings: [
            `unpdf failed; used pdf-parse fallback: ${errMsg}`,
          ],
        };
      } catch (fallbackErr) {
        const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);

        return {
          success: false,
          contents: [],
          metadata: {
            format: '.pdf',
            parser: this.name,
            parsedAt: new Date().toISOString(),
          },
          stats: {
            totalItems: 0,
            byType: {},
            parseTimeMs: Date.now() - startTime,
          },
          errors: [
            {
              code: 'PARSE_ERROR',
              message: `${errMsg}; fallback failed: ${fallbackMsg}`,
              recoverable: false,
              stack: error instanceof Error ? error.stack : undefined,
            },
          ],
        };
      }
    }
  }

  /**
   * Extract metadata from PDF.
   */
  private async extractMetadata(
    filePath: string,
    pdf: Awaited<ReturnType<typeof getDocumentProxy>>,
    startTime: number
  ): Promise<DocumentMetadata> {
    const stats = fs.statSync(filePath);
    
    let info: Record<string, unknown> = {};
    try {
      const metadataResult = await pdf.getMetadata();
      info = metadataResult?.info || {};
    } catch {
      // Metadata extraction failed, continue with defaults
    }

    return {
      title: info.Title as string | undefined,
      authors: info.Author ? [info.Author as string] : undefined,
      createdAt: info.CreationDate as string | undefined,
      modifiedAt: info.ModDate as string | undefined,
      pageCount: pdf.numPages,
      format: '.pdf',
      fileSizeBytes: stats.size,
      parser: this.name,
      parsedAt: new Date().toISOString(),
      extra: {
        producer: info.Producer,
        creator: info.Creator,
        subject: info.Subject,
      },
    };
  }

  /**
   * Parse page content and detect structure.
   */
  private parsePageContent(pageText: string, pageIndex: number): ParsedContent[] {
    const contents: ParsedContent[] = [];
    const lines = pageText.split('\n');
    
    let currentText = '';
    let currentType: ParsedContentType = 'text';

    for (const line of lines) {
      const trimmed = line.trim();
      
      // Detect headings (heuristic: all caps or numbered sections)
      if (this.isHeading(trimmed)) {
        // Save accumulated text
        if (currentText.trim()) {
          contents.push({
            type: currentType,
            content: currentText.trim(),
            pageIndex,
          });
          currentText = '';
        }
        
        contents.push({
          type: 'heading',
          content: trimmed,
          pageIndex,
        });
        continue;
      }

      // Detect list items
      if (this.isListItem(trimmed)) {
        if (currentText.trim() && currentType !== 'list') {
          contents.push({
            type: currentType,
            content: currentText.trim(),
            pageIndex,
          });
          currentText = '';
        }
        currentType = 'list';
        currentText += trimmed + '\n';
        continue;
      }

      // Regular text
      if (currentType === 'list' && currentText.trim()) {
        contents.push({
          type: 'list',
          content: currentText.trim(),
          pageIndex,
        });
        currentText = '';
        currentType = 'text';
      }
      
      currentText += line + '\n';
    }

    // Add remaining text
    if (currentText.trim()) {
      contents.push({
        type: currentType,
        content: currentText.trim(),
        pageIndex,
      });
    }

    return contents;
  }

  /**
   * Detect if a line is a heading.
   */
  private isHeading(line: string): boolean {
    if (!line || line.length > 200) return false;
    
    // Check for numbered sections (e.g., "1. Introduction", "1.1 Background")
    if (/^\d+(\.\d+)*\.?\s+\w/.test(line)) return true;
    
    // Check for all caps (minimum 3 words)
    const words = line.split(/\s+/);
    if (words.length >= 2 && words.length <= 10) {
      const allCaps = words.every(w => w === w.toUpperCase() && /[A-Z]/.test(w));
      if (allCaps) return true;
    }
    
    return false;
  }

  /**
   * Detect if a line is a list item.
   */
  private isListItem(line: string): boolean {
    // Bullet points
    if (/^[•●○◦▪▫-]\s/.test(line)) return true;
    // Numbered lists
    if (/^\d+[.)]\s/.test(line)) return true;
    // Letter lists
    if (/^[a-zA-Z][.)]\s/.test(line)) return true;
    
    return false;
  }

  /**
   * Detect tables in extracted text.
   */
  private detectTables(pages: string[]): ParsedContent[] {
    const tables: ParsedContent[] = [];

    for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
      const pageText = pages[pageIdx];
      const detectedTables = this.findTablesInText(pageText ?? '');
      
      for (const table of detectedTables) {
        tables.push({
          type: 'table',
          content: table,
          pageIndex: pageIdx,
        });
      }
    }

    return tables;
  }

  /**
   * Find tables in text using heuristics.
   */
  private findTablesInText(text: string): ParsedTableData[] {
    const tables: ParsedTableData[] = [];
    const lines = text.split('\n');
    
    let tableLines: string[] = [];
    let inTable = false;

    for (const line of lines) {
      // Detect table-like patterns (multiple columns separated by whitespace)
      const columns = line.split(/\s{2,}/).filter(c => c.trim());
      
      if (columns.length >= 2) {
        if (!inTable) {
          inTable = true;
          tableLines = [];
        }
        tableLines.push(line);
      } else if (inTable && line.trim() === '') {
        // End of table
        if (tableLines.length >= 2) {
          const table = this.parseTableLines(tableLines);
          if (table) tables.push(table);
        }
        inTable = false;
        tableLines = [];
      } else if (inTable) {
        // Non-table line ends table
        if (tableLines.length >= 2) {
          const table = this.parseTableLines(tableLines);
          if (table) tables.push(table);
        }
        inTable = false;
        tableLines = [];
      }
    }

    // Handle table at end of text
    if (inTable && tableLines.length >= 2) {
      const table = this.parseTableLines(tableLines);
      if (table) tables.push(table);
    }

    return tables;
  }

  /**
   * Parse table lines into structured data.
   */
  private parseTableLines(lines: string[]): ParsedTableData | null {
    if (lines.length < 2) return null;

    const rows: string[][] = [];
    
    for (const line of lines) {
      const cells = line.split(/\s{2,}/).map(c => c.trim()).filter(c => c);
      if (cells.length > 0) {
        rows.push(cells);
      }
    }

    if (rows.length < 2) return null;

    // Assume first row is header
    const headers = rows[0];
    const dataRows = rows.slice(1);

    return {
      headers,
      rows: dataRows,
      rowCount: dataRows.length,
      colCount: headers?.length ?? 0,
    };
  }

  /**
   * Extract table of contents from PDF.
   */
  private async extractToc(
    pdf: Awaited<ReturnType<typeof getDocumentProxy>>
  ): Promise<TocEntry[]> {
    try {
      const outline = await pdf.getOutline();
      if (!outline) return [];

      return this.convertOutlineToToc(outline);
    } catch {
      return [];
    }
  }

  /**
   * Convert PDF outline to TOC entries.
   */
  private convertOutlineToToc(outline: unknown[], level = 1): TocEntry[] {
    const entries: TocEntry[] = [];

    for (const item of outline) {
      const entry = item as { title?: string; items?: unknown[]; dest?: unknown };
      
      if (entry.title) {
        const tocEntry: TocEntry = {
          title: entry.title,
          level,
        };

        if (entry.items && Array.isArray(entry.items) && entry.items.length > 0) {
          tocEntry.children = this.convertOutlineToToc(entry.items, level + 1);
        }

        entries.push(tocEntry);
      }
    }

    return entries;
  }

  /**
   * Build parsing statistics.
   */
  private buildStats(contents: ParsedContent[], startTime: number): ParseStats {
    const byType: Partial<Record<ParsedContentType, number>> = {};
    const byPage: Record<number, number> = {};
    let ocrItemsCount = 0;
    let ocrConfidenceSum = 0;

    for (const content of contents) {
      // Count by type
      byType[content.type] = (byType[content.type] || 0) + 1;

      // Count by page
      if (content.pageIndex !== undefined) {
        byPage[content.pageIndex] = (byPage[content.pageIndex] || 0) + 1;
      }

      // Track OCR stats
      if (content.ocrConfidence !== undefined) {
        ocrItemsCount++;
        ocrConfidenceSum += content.ocrConfidence;
      }
    }

    return {
      totalItems: contents.length,
      byType,
      byPage: Object.keys(byPage).length > 0 ? byPage : undefined,
      ocrItemsCount: ocrItemsCount > 0 ? ocrItemsCount : undefined,
      averageOcrConfidence: ocrItemsCount > 0 ? ocrConfidenceSum / ocrItemsCount : undefined,
      parseTimeMs: Date.now() - startTime,
    };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new PDF parser instance.
 */
export function createPdfParser(): PdfParser {
  return new PdfParser();
}

// Default export
export default PdfParser;
