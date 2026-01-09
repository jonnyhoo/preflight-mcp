/**
 * Text-based document parsers for HTML, Markdown, and plain text.
 *
 * @module parser/text-parser
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  IDocumentParser,
  ParseResult,
  ParsedContent,
  DocumentMetadata,
  ParseStats,
  ParseOptions,
  HtmlParseOptions,
  MarkdownParseOptions,
  SupportedFormat,
  ParsedContentType,
  ParseError,
  TocEntry,
  ParsedTableData,
  ParsedCodeBlock,
} from './types.js';
import { DEFAULT_PARSE_OPTIONS, WEB_FORMATS, TEXT_FORMATS } from './types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('text-parser');

// ============================================================================
// HTML Parser Implementation
// ============================================================================

/**
 * HTML document parser.
 */
export class HtmlParser implements IDocumentParser {
  readonly name = 'html-parser';
  readonly supportedFormats: readonly SupportedFormat[] = WEB_FORMATS;

  canParse(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return this.supportedFormats.includes(ext as SupportedFormat);
  }

  async checkInstallation(): Promise<boolean> {
    return true; // No external dependencies
  }

  async parse(filePath: string, options?: HtmlParseOptions): Promise<ParseResult> {
    const startTime = Date.now();
    const opts = { ...DEFAULT_PARSE_OPTIONS, ...options };
    const errors: ParseError[] = [];
    const contents: ParsedContent[] = [];

    try {
      const html = fs.readFileSync(filePath, 'utf-8');
      const metadata = this.extractMetadata(filePath, html);

      // Strip HTML tags and extract text content
      const { textContents, tableOfContents } = this.parseHtml(html, opts);
      contents.push(...textContents);

      // Build full text
      const fullText = opts.generateFullText
        ? contents
            .filter(c => typeof c.content === 'string')
            .map(c => c.content as string)
            .join('\n\n')
        : undefined;

      if (fullText) {
        metadata.wordCount = fullText.split(/\s+/).filter(w => w.length > 0).length;
        metadata.charCount = fullText.length;
      }

      const stats = this.buildStats(contents, startTime);

      return {
        success: true,
        contents,
        metadata,
        stats,
        fullText,
        tableOfContents: tableOfContents.length > 0 ? tableOfContents : undefined,
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`HTML parsing failed: ${errMsg}`);

      return {
        success: false,
        contents: [],
        metadata: {
          format: '.html',
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
        }],
      };
    }
  }

  private extractMetadata(filePath: string, html: string): DocumentMetadata {
    const stats = fs.statSync(filePath);
    
    // Extract title from <title> tag
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch?.[1]?.trim() ?? path.basename(filePath);

    return {
      title,
      format: path.extname(filePath).toLowerCase(),
      fileSizeBytes: stats.size,
      parser: this.name,
      parsedAt: new Date().toISOString(),
    };
  }

  private parseHtml(html: string, opts: HtmlParseOptions): {
    textContents: ParsedContent[];
    tableOfContents: TocEntry[];
  } {
    const contents: ParsedContent[] = [];
    const toc: TocEntry[] = [];

    // Remove script and style tags
    let cleanHtml = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

    // Extract headings for TOC
    const headingRegex = /<h([1-6])[^>]*>([^<]+)<\/h\1>/gi;
    let match;
    while ((match = headingRegex.exec(cleanHtml)) !== null) {
      const levelStr = match[1] ?? '1';
      const level = parseInt(levelStr, 10);
      const rawText = match[2] ?? '';
      const text = this.stripTags(rawText).trim();
      
      if (text) {
        toc.push({ title: text, level });
        contents.push({
          type: 'heading',
          content: text,
        });
      }
    }

    // Extract paragraphs
    const paragraphRegex = /<p[^>]*>([^]*?)<\/p>/gi;
    while ((match = paragraphRegex.exec(cleanHtml)) !== null) {
      const rawText = match[1] ?? '';
      const text = this.stripTags(rawText).trim();
      if (text) {
        contents.push({
          type: 'text',
          content: text,
        });
      }
    }

    // Extract lists
    const listRegex = /<[ou]l[^>]*>([^]*?)<\/[ou]l>/gi;
    while ((match = listRegex.exec(cleanHtml)) !== null) {
      const listContent = match[1] ?? '';
      const listItems = listContent.match(/<li[^>]*>([^]*?)<\/li>/gi) ?? [];
      const items = listItems.map(li => this.stripTags(li).trim()).filter(t => t);
      
      if (items.length > 0) {
        contents.push({
          type: 'list',
          content: items.join('\n'),
        });
      }
    }

    // Extract tables if enabled
    if (opts.extractTables) {
      const tableRegex = /<table[^>]*>([^]*?)<\/table>/gi;
      while ((match = tableRegex.exec(cleanHtml)) !== null) {
        const tableContent = match[1] ?? '';
        const table = this.parseHtmlTable(tableContent);
        if (table) {
          contents.push({
            type: 'table',
            content: table,
          });
        }
      }
    }

    // Extract code blocks
    const codeRegex = /<pre[^>]*>(?:<code[^>]*>)?([^]*?)(?:<\/code>)?<\/pre>/gi;
    while ((match = codeRegex.exec(cleanHtml)) !== null) {
      const codeContent = match[1] ?? '';
      const code = this.stripTags(codeContent).trim();
      if (code) {
        const codeBlock: ParsedCodeBlock = {
          code,
          languageAutoDetected: true,
        };
        contents.push({
          type: 'code_block',
          content: codeBlock,
        });
      }
    }

    // If no structured content found, extract all text
    if (contents.length === 0) {
      const text = this.stripTags(cleanHtml).trim();
      if (text) {
        contents.push({
          type: 'text',
          content: text,
        });
      }
    }

    return { textContents: contents, tableOfContents: toc };
  }

  private parseHtmlTable(tableHtml: string): ParsedTableData | null {
    const rows: string[][] = [];
    let headers: string[] | undefined;

    // Extract header row
    const theadMatch = tableHtml.match(/<thead[^>]*>([^]*?)<\/thead>/i);
    if (theadMatch) {
      const theadContent = theadMatch[1] ?? '';
      const headerCells = theadContent.match(/<t[hd][^>]*>([^]*?)<\/t[hd]>/gi) ?? [];
      headers = headerCells.map(cell => this.stripTags(cell).trim());
    }

    // Extract body rows
    const rowRegex = /<tr[^>]*>([^]*?)<\/tr>/gi;
    let match;
    while ((match = rowRegex.exec(tableHtml)) !== null) {
      const rowContent = match[1] ?? '';
      const cells = rowContent.match(/<t[hd][^>]*>([^]*?)<\/t[hd]>/gi) ?? [];
      const row = cells.map(cell => this.stripTags(cell).trim());
      
      if (row.length > 0) {
        if (!headers && rows.length === 0) {
          // Use first row as headers if no thead
          headers = row;
        } else {
          rows.push(row);
        }
      }
    }

    if (rows.length === 0) return null;

    return {
      headers,
      rows,
      rowCount: rows.length,
      colCount: headers?.length || rows[0]?.length || 0,
      html: tableHtml,
    };
  }

  private stripTags(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ');
  }

  private buildStats(contents: ParsedContent[], startTime: number): ParseStats {
    const byType: Partial<Record<ParsedContentType, number>> = {};
    for (const content of contents) {
      byType[content.type] = (byType[content.type] || 0) + 1;
    }
    return {
      totalItems: contents.length,
      byType,
      parseTimeMs: Date.now() - startTime,
    };
  }
}

// ============================================================================
// Markdown Parser Implementation
// ============================================================================

/**
 * Markdown document parser.
 */
export class MarkdownParser implements IDocumentParser {
  readonly name = 'markdown-parser';
  readonly supportedFormats: readonly SupportedFormat[] = ['.md', '.markdown'] as const;

  canParse(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return this.supportedFormats.includes(ext as SupportedFormat);
  }

  async checkInstallation(): Promise<boolean> {
    return true;
  }

  async parse(filePath: string, options?: MarkdownParseOptions): Promise<ParseResult> {
    const startTime = Date.now();
    const opts = { ...DEFAULT_PARSE_OPTIONS, ...options };
    const errors: ParseError[] = [];
    const contents: ParsedContent[] = [];

    try {
      const markdown = fs.readFileSync(filePath, 'utf-8');
      const metadata = this.extractMetadata(filePath, markdown);

      const { textContents, tableOfContents } = this.parseMarkdown(markdown, opts);
      contents.push(...textContents);

      const fullText = opts.generateFullText ? markdown : undefined;

      if (fullText) {
        metadata.wordCount = fullText.split(/\s+/).filter(w => w.length > 0).length;
        metadata.charCount = fullText.length;
      }

      const stats = this.buildStats(contents, startTime);

      return {
        success: true,
        contents,
        metadata,
        stats,
        fullText,
        tableOfContents: tableOfContents.length > 0 ? tableOfContents : undefined,
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Markdown parsing failed: ${errMsg}`);

      return {
        success: false,
        contents: [],
        metadata: {
          format: '.md',
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
        }],
      };
    }
  }

  private extractMetadata(filePath: string, markdown: string): DocumentMetadata {
    const stats = fs.statSync(filePath);
    
    // Try to extract title from first heading
    const titleMatch = markdown.match(/^#\s+(.+)$/m);
    const title = titleMatch?.[1]?.trim() ?? path.basename(filePath);

    return {
      title,
      format: path.extname(filePath).toLowerCase(),
      fileSizeBytes: stats.size,
      parser: this.name,
      parsedAt: new Date().toISOString(),
    };
  }

  private parseMarkdown(markdown: string, opts: MarkdownParseOptions): {
    textContents: ParsedContent[];
    tableOfContents: TocEntry[];
  } {
    const contents: ParsedContent[] = [];
    const toc: TocEntry[] = [];
    const lines = markdown.split('\n');
    
    let currentBlock: string[] = [];
    let inCodeBlock = false;
    let codeLanguage: string | undefined;
    let inList = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';

      // Code blocks
      if (line.startsWith('```')) {
        if (!inCodeBlock) {
          // Start code block
          this.flushBlock(currentBlock, contents, inList ? 'list' : 'text');
          currentBlock = [];
          inList = false;
          inCodeBlock = true;
          codeLanguage = line.slice(3).trim() || undefined;
        } else {
          // End code block
          const codeBlock: ParsedCodeBlock = {
            code: currentBlock.join('\n'),
            language: codeLanguage,
            languageAutoDetected: !codeLanguage,
          };
          contents.push({
            type: 'code_block',
            content: codeBlock,
          });
          currentBlock = [];
          inCodeBlock = false;
          codeLanguage = undefined;
        }
        continue;
      }

      if (inCodeBlock) {
        currentBlock.push(line);
        continue;
      }

      // Headings
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        this.flushBlock(currentBlock, contents, inList ? 'list' : 'text');
        currentBlock = [];
        inList = false;

        const hashes = headingMatch[1] ?? '#';
        const level = hashes.length;
        const headingText = headingMatch[2] ?? '';
        const text = headingText.trim();
        
        toc.push({ title: text, level });
        contents.push({
          type: 'heading',
          content: text,
        });
        continue;
      }

      // List items
      if (/^[\s]*[-*+]\s/.test(line) || /^[\s]*\d+\.\s/.test(line)) {
        if (!inList) {
          this.flushBlock(currentBlock, contents, 'text');
          currentBlock = [];
        }
        inList = true;
        currentBlock.push(line.trim());
        continue;
      }

      // Tables
      if (line.includes('|') && opts.extractTables) {
        // Look ahead to see if this is a table
        const nextLine = lines[i + 1] ?? '';
        if (i + 1 < lines.length && /^\|?[\s:-]+\|/.test(nextLine)) {
          this.flushBlock(currentBlock, contents, inList ? 'list' : 'text');
          currentBlock = [];
          inList = false;

          // Parse table
          const tableLines: string[] = [line];
          let j = i + 1;
          while (j < lines.length) {
            const tableLine = lines[j] ?? '';
            if (!tableLine.includes('|')) break;
            tableLines.push(tableLine);
            j++;
          }
          
          const table = this.parseMarkdownTable(tableLines);
          if (table) {
            contents.push({
              type: 'table',
              content: table,
            });
          }
          
          i = j - 1; // Skip processed lines
          continue;
        }
      }

      // Empty line ends current block
      if (!line.trim()) {
        this.flushBlock(currentBlock, contents, inList ? 'list' : 'text');
        currentBlock = [];
        inList = false;
        continue;
      }

      // Regular text
      if (inList) {
        this.flushBlock(currentBlock, contents, 'list');
        currentBlock = [];
        inList = false;
      }
      currentBlock.push(line);
    }

    // Flush remaining content
    if (inCodeBlock) {
      const codeBlock: ParsedCodeBlock = {
        code: currentBlock.join('\n'),
        language: codeLanguage,
      };
      contents.push({
        type: 'code_block',
        content: codeBlock,
      });
    } else {
      this.flushBlock(currentBlock, contents, inList ? 'list' : 'text');
    }

    return { textContents: contents, tableOfContents: toc };
  }

  private flushBlock(
    block: string[],
    contents: ParsedContent[],
    type: ParsedContentType
  ): void {
    const text = block.join('\n').trim();
    if (text) {
      contents.push({ type, content: text });
    }
  }

  private parseMarkdownTable(lines: string[]): ParsedTableData | null {
    if (lines.length < 2) return null;

    // Parse header row
    const headerLine = lines[0] ?? '';
    const headers = headerLine
      .split('|')
      .map(c => c.trim())
      .filter(c => c);

    // Skip separator row
    const dataLines = lines.slice(2);
    const rows: string[][] = [];

    for (const line of dataLines) {
      const cells = line
        .split('|')
        .map(c => c.trim())
        .filter(c => c);
      
      if (cells.length > 0) {
        rows.push(cells);
      }
    }

    if (rows.length === 0) return null;

    return {
      headers,
      rows,
      rowCount: rows.length,
      colCount: headers.length,
      markdown: lines.join('\n'),
    };
  }

  private buildStats(contents: ParsedContent[], startTime: number): ParseStats {
    const byType: Partial<Record<ParsedContentType, number>> = {};
    for (const content of contents) {
      byType[content.type] = (byType[content.type] || 0) + 1;
    }
    return {
      totalItems: contents.length,
      byType,
      parseTimeMs: Date.now() - startTime,
    };
  }
}

// ============================================================================
// Plain Text Parser Implementation
// ============================================================================

/**
 * Plain text parser.
 */
export class PlainTextParser implements IDocumentParser {
  readonly name = 'plaintext-parser';
  readonly supportedFormats: readonly SupportedFormat[] = ['.txt', '.text'] as const;

  canParse(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return this.supportedFormats.includes(ext as SupportedFormat);
  }

  async checkInstallation(): Promise<boolean> {
    return true;
  }

  async parse(filePath: string, options?: ParseOptions): Promise<ParseResult> {
    const startTime = Date.now();
    const opts = { ...DEFAULT_PARSE_OPTIONS, ...options };

    try {
      const text = fs.readFileSync(filePath, 'utf-8');
      const stats = fs.statSync(filePath);

      const contents: ParsedContent[] = [{
        type: 'text',
        content: text,
      }];

      const metadata: DocumentMetadata = {
        title: path.basename(filePath),
        format: path.extname(filePath).toLowerCase(),
        fileSizeBytes: stats.size,
        wordCount: text.split(/\s+/).filter(w => w.length > 0).length,
        charCount: text.length,
        parser: this.name,
        parsedAt: new Date().toISOString(),
      };

      return {
        success: true,
        contents,
        metadata,
        stats: {
          totalItems: 1,
          byType: { text: 1 },
          parseTimeMs: Date.now() - startTime,
        },
        fullText: opts.generateFullText ? text : undefined,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Plain text parsing failed: ${errMsg}`);

      return {
        success: false,
        contents: [],
        metadata: {
          format: '.txt',
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
        }],
      };
    }
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

export function createHtmlParser(): HtmlParser {
  return new HtmlParser();
}

export function createMarkdownParser(): MarkdownParser {
  return new MarkdownParser();
}

export function createPlainTextParser(): PlainTextParser {
  return new PlainTextParser();
}
