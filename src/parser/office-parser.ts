/**
 * Office document parser using officeparser.
 *
 * This module provides parsing capabilities for Microsoft Office formats:
 * - Word documents (.doc, .docx)
 * - PowerPoint presentations (.ppt, .pptx)
 * - Excel spreadsheets (.xls, .xlsx)
 *
 * @module parser/office-parser
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import officeParser from 'officeparser';

import type {
  IDocumentParser,
  ParseResult,
  ParsedContent,
  DocumentMetadata,
  ParseStats,
  ParseOptions,
  OfficeParseOptions,
  SupportedFormat,
  ParsedContentType,
  ParseError,
  ParsedTableData,
} from './types.js';
import { DEFAULT_PARSE_OPTIONS, OFFICE_FORMATS } from './types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('office-parser');

// ============================================================================
// Office Parser Implementation
// ============================================================================

/**
 * Office document parser using officeparser library.
 */
export class OfficeParser implements IDocumentParser {
  readonly name = 'officeparser';
  readonly supportedFormats: readonly SupportedFormat[] = OFFICE_FORMATS;

  /**
   * Check if this parser can handle the file.
   */
  canParse(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return this.supportedFormats.includes(ext as SupportedFormat);
  }

  /**
   * Check if officeparser is properly installed.
   */
  async checkInstallation(): Promise<boolean> {
    try {
      return typeof officeParser.parseOfficeAsync === 'function';
    } catch {
      return false;
    }
  }

  /**
   * Parse an Office document.
   */
  async parse(filePath: string, options?: OfficeParseOptions): Promise<ParseResult> {
    const startTime = Date.now();
    const opts = { ...DEFAULT_PARSE_OPTIONS, ...options };
    const errors: ParseError[] = [];
    const warnings: string[] = [];
    const contents: ParsedContent[] = [];

    try {
      // Get file extension to determine document type
      const ext = path.extname(filePath).toLowerCase() as SupportedFormat;
      
      // Extract metadata first
      const metadata = await this.extractMetadata(filePath, ext);

      // Parse document content
      const text = await officeParser.parseOfficeAsync(filePath, {
        newlineDelimiter: '\n',
        ignoreNotes: false,
      });

      if (!text || typeof text !== 'string') {
        throw new Error('Failed to extract text from document');
      }

      // Parse content based on document type
      switch (ext) {
        case '.doc':
        case '.docx':
          contents.push(...this.parseWordContent(text, opts));
          break;
        case '.ppt':
        case '.pptx':
          contents.push(...this.parsePowerPointContent(text, opts));
          break;
        case '.xls':
        case '.xlsx':
          contents.push(...this.parseExcelContent(text, opts));
          break;
        default:
          contents.push({
            type: 'text',
            content: text,
          });
      }

      // Build statistics
      const stats = this.buildStats(contents, startTime);

      // Generate full text
      const fullText = opts.generateFullText ? text : undefined;

      // Calculate word count
      metadata.wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
      metadata.charCount = text.length;

      return {
        success: true,
        contents,
        metadata,
        stats,
        fullText,
        errors: errors.length > 0 ? errors : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Office document parsing failed: ${errMsg}`);

      return {
        success: false,
        contents: [],
        metadata: {
          format: path.extname(filePath).toLowerCase(),
          parser: this.name,
          parsedAt: new Date().toISOString(),
        },
        stats: {
          totalItems: 0,
          byType: {},
          parseTimeMs: Date.now() - startTime,
        },
        errors: [{
          code: 'PARSE_ERROR',
          message: errMsg,
          recoverable: false,
          stack: error instanceof Error ? error.stack : undefined,
        }],
      };
    }
  }

  /**
   * Extract metadata from Office document.
   */
  private async extractMetadata(
    filePath: string,
    format: SupportedFormat
  ): Promise<DocumentMetadata> {
    const stats = fs.statSync(filePath);
    const fileName = path.basename(filePath);

    return {
      title: fileName.replace(/\.[^.]+$/, ''), // Use filename without extension as title
      format,
      fileSizeBytes: stats.size,
      parser: this.name,
      parsedAt: new Date().toISOString(),
      createdAt: stats.birthtime.toISOString(),
      modifiedAt: stats.mtime.toISOString(),
    };
  }

  /**
   * Parse Word document content.
   */
  private parseWordContent(text: string, opts: ParseOptions): ParsedContent[] {
    const contents: ParsedContent[] = [];
    const lines = text.split('\n');
    
    let currentText = '';
    let currentType: ParsedContentType = 'text';

    for (const line of lines) {
      const trimmed = line.trim();
      
      // Detect headings
      if (this.isHeading(trimmed)) {
        if (currentText.trim()) {
          contents.push({
            type: currentType,
            content: currentText.trim(),
          });
          currentText = '';
        }
        
        contents.push({
          type: 'heading',
          content: trimmed,
        });
        currentType = 'text';
        continue;
      }

      // Detect list items
      if (this.isListItem(trimmed)) {
        if (currentText.trim() && currentType !== 'list') {
          contents.push({
            type: currentType,
            content: currentText.trim(),
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
      });
    }

    // Detect tables if enabled
    if (opts.extractTables) {
      const tables = this.detectTablesInText(text);
      contents.push(...tables);
    }

    return contents;
  }

  /**
   * Parse PowerPoint content.
   */
  private parsePowerPointContent(text: string, _opts: ParseOptions): ParsedContent[] {
    const contents: ParsedContent[] = [];
    
    // PowerPoint typically separates slides with multiple newlines
    const slides = text.split(/\n{3,}/);
    
    for (let slideIdx = 0; slideIdx < slides.length; slideIdx++) {
      const slideText = (slides[slideIdx] ?? '').trim();
      if (!slideText) continue;

      const lines = slideText.split('\n');
      
      // First non-empty line is usually the slide title
      let titleFound = false;
      let slideContent = '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (!titleFound) {
          contents.push({
            type: 'heading',
            content: trimmed,
            pageIndex: slideIdx,
          });
          titleFound = true;
        } else {
          slideContent += trimmed + '\n';
        }
      }

      if (slideContent.trim()) {
        // Check if it's a list
        const listLines = slideContent.split('\n').filter(l => l.trim());
        const isList = listLines.every(l => this.isListItem(l.trim()));

        contents.push({
          type: isList ? 'list' : 'text',
          content: slideContent.trim(),
          pageIndex: slideIdx,
        });
      }
    }

    return contents;
  }

  /**
   * Parse Excel content.
   */
  private parseExcelContent(text: string, opts: ParseOptions): ParsedContent[] {
    const contents: ParsedContent[] = [];
    
    // Excel content from officeparser is typically tab or comma separated
    const lines = text.split('\n').filter(l => l.trim());
    
    if (lines.length === 0) return contents;

    // Try to detect if it's tabular data
    const firstLine = lines[0] ?? '';
    const delimiter = firstLine.includes('\t') ? '\t' : ',';
    
    // Parse as table
    const rows: string[][] = [];
    for (const line of lines) {
      const cells = line.split(delimiter).map(c => c.trim());
      if (cells.some(c => c.length > 0)) {
        rows.push(cells);
      }
    }

    if (rows.length >= 2) {
      const headers = rows[0] ?? [];
      const table: ParsedTableData = {
        headers,
        rows: rows.slice(1),
        rowCount: rows.length - 1,
        colCount: headers.length,
      };

      contents.push({
        type: 'table',
        content: table,
      });
    } else if (rows.length === 1) {
      const firstRow = rows[0] ?? [];
      contents.push({
        type: 'text',
        content: firstRow.join(' '),
      });
    }

    return contents;
  }

  /**
   * Detect if a line is a heading.
   */
  private isHeading(line: string): boolean {
    if (!line || line.length > 200) return false;
    
    // Check for numbered sections
    if (/^\d+(\.\d+)*\.?\s+\w/.test(line)) return true;
    
    // Check for all caps (with reasonable length)
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
    if (/^[•●○◦▪▫►▸-]\s/.test(line)) return true;
    // Numbered lists
    if (/^\d+[.)]\s/.test(line)) return true;
    // Letter lists
    if (/^[a-zA-Z][.)]\s/.test(line)) return true;
    // Checkbox style
    if (/^\[[ x]\]\s/.test(line)) return true;
    
    return false;
  }

  /**
   * Detect tables in text content.
   */
  private detectTablesInText(text: string): ParsedContent[] {
    const tables: ParsedContent[] = [];
    const lines = text.split('\n');
    
    let tableLines: string[] = [];
    let inTable = false;

    for (const line of lines) {
      // Detect tab-separated or multi-space separated lines
      const hasTabs = line.includes('\t');
      const columns = hasTabs 
        ? line.split('\t').filter(c => c.trim())
        : line.split(/\s{2,}/).filter(c => c.trim());
      
      if (columns.length >= 2) {
        if (!inTable) {
          inTable = true;
          tableLines = [];
        }
        tableLines.push(line);
      } else if (inTable && line.trim() === '') {
        if (tableLines.length >= 2) {
          const table = this.parseTableLines(tableLines);
          if (table) {
            tables.push({
              type: 'table',
              content: table,
            });
          }
        }
        inTable = false;
        tableLines = [];
      } else if (inTable) {
        if (tableLines.length >= 2) {
          const table = this.parseTableLines(tableLines);
          if (table) {
            tables.push({
              type: 'table',
              content: table,
            });
          }
        }
        inTable = false;
        tableLines = [];
      }
    }

    // Handle table at end
    if (inTable && tableLines.length >= 2) {
      const table = this.parseTableLines(tableLines);
      if (table) {
        tables.push({
          type: 'table',
          content: table,
        });
      }
    }

    return tables;
  }

  /**
   * Parse table lines into structured data.
   */
  private parseTableLines(lines: string[]): ParsedTableData | null {
    if (lines.length < 2) return null;

    const rows: string[][] = [];
    const firstLine = lines[0] ?? '';
    const hasTabs = firstLine.includes('\t');
    
    for (const line of lines) {
      const cells = hasTabs
        ? line.split('\t').map(c => c.trim())
        : line.split(/\s{2,}/).map(c => c.trim()).filter(c => c);
      
      if (cells.length > 0) {
        rows.push(cells);
      }
    }

    if (rows.length < 2) return null;

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
   * Build parsing statistics.
   */
  private buildStats(contents: ParsedContent[], startTime: number): ParseStats {
    const byType: Partial<Record<ParsedContentType, number>> = {};
    const byPage: Record<number, number> = {};

    for (const content of contents) {
      byType[content.type] = (byType[content.type] || 0) + 1;

      if (content.pageIndex !== undefined) {
        byPage[content.pageIndex] = (byPage[content.pageIndex] || 0) + 1;
      }
    }

    return {
      totalItems: contents.length,
      byType,
      byPage: Object.keys(byPage).length > 0 ? byPage : undefined,
      parseTimeMs: Date.now() - startTime,
    };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new Office parser instance.
 */
export function createOfficeParser(): OfficeParser {
  return new OfficeParser();
}

// Default export
export default OfficeParser;
