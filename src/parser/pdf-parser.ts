/**
 * PDF document parser using unpdf with Scribe.js OCR fallback.
 *
 * This module provides PDF parsing capabilities including:
 * - Text extraction with position information
 * - Image extraction
 * - Table detection and extraction
 * - Metadata extraction
 * - **OCR support for scanned PDFs** (via Scribe.js)
 *
 * Processing strategy:
 * 1. Try unpdf for fast native text extraction
 * 2. If text is empty/minimal, use Scribe.js OCR
 * 3. Scribe.js auto-detects text-native vs image-native PDFs
 *
 * @module parser/pdf-parser
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDocumentProxy, extractText, extractImages } from 'unpdf';

/** Type for PDF document proxy from unpdf */
type PDFDocumentProxy = Awaited<ReturnType<typeof getDocumentProxy>>;

// Smart PDF analyzer for academic papers
import {
  groupIntoLines,
  calculatePageStats,
  classifyPageElements,
  createVLMConfig,
  processScannedPage,
  processPageWithVLM,
} from './pdf/index.js';
import type { PageStats } from './pdf/types.js';
import type {
  AnalyzedElement,
  RichTextItem,
  VLMConfig,
} from './pdf/types.js';

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
// Scribe.js OCR Integration
// ============================================================================

/**
 * Scribe.js module interface for OCR operations.
 */
interface ScribeModule {
  extractText: (inputs: (string | ArrayBuffer)[], options?: {
    preferNativeText?: boolean;
    maxPages?: number;
  }) => Promise<string>;
  init?: (options?: { ocrMode?: 'quality' | 'speed' }) => Promise<void>;
  terminate?: () => Promise<void>;
}

let scribeModule: ScribeModule | null = null;
let scribeInitialized = false;

/**
 * Get or initialize Scribe.js module for OCR.
 */
async function getScribeOcr(): Promise<ScribeModule | null> {
  if (scribeModule) return scribeModule;

  try {
    // Dynamic import for optional OCR dependency
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('scribe.js-ocr');
    scribeModule = {
      extractText: mod.extractText || mod.default?.extractText,
      init: mod.init || mod.default?.init,
      terminate: mod.terminate || mod.default?.terminate,
    };

    // Initialize Scribe.js if not already done
    if (!scribeInitialized && scribeModule.init) {
      try {
        await scribeModule.init({ ocrMode: 'quality' });
        scribeInitialized = true;
        logger.info('Scribe.js OCR engine initialized');
      } catch {
        // init may not be available in all versions
        scribeInitialized = true;
      }
    }

    return scribeModule;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.debug('Scribe.js OCR not available:', error);
    return null;
  }
}

/**
 * Minimum text length to consider a PDF as having extractable text.
 * PDFs with less text than this threshold will trigger OCR fallback.
 */
const MIN_TEXT_LENGTH_THRESHOLD = 50;

/**
 * Check if extracted text is substantial enough.
 * Scanned PDFs often have no text or just whitespace.
 */
function hasSubstantialText(text: string): boolean {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length >= MIN_TEXT_LENGTH_THRESHOLD;
}

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

      // Check if smart analysis is enabled (for academic papers)
      // Read from opts directly or from extra field (set by document-ingest)
      const extraOpts = opts.extra as { smartAnalysis?: boolean; vlmConfig?: Partial<VLMConfig> } | undefined;
      const useSmartAnalysis = opts.smartAnalysis ?? extraOpts?.smartAnalysis ?? false;
      const vlmConfigOpts = opts.vlmConfig ?? extraOpts?.vlmConfig;
      const vlmConfig = vlmConfigOpts ? createVLMConfig(vlmConfigOpts) : null;

      // Extract text content using unpdf (fast, native text extraction)
      const textResult = await extractText(freshData(), {
        mergePages: false,
      });

      // Process each page
      const fullTextParts: string[] = [];
      let pageTexts = textResult.text; // string[] when mergePages: false

      // Check if we got substantial text from native extraction
      const totalNativeText = pageTexts.join(' ');
      const needsOcr = !hasSubstantialText(totalNativeText);

      // If PDF appears to be scanned (no/minimal text), try VLM first if available
      // VLM provides better structured content extraction than OCR
      let useVLMForAllPages = false;
      if (needsOcr && vlmConfig?.enabled) {
        warnings.push('PDF has minimal text; using VLM for enhanced content extraction');
        useVLMForAllPages = true;
      } else if (needsOcr && opts.enableOcr !== false) {
        // Fallback to OCR if VLM not available
        const ocrResult = await this.tryOcrExtraction(filePath, pagesToProcess, warnings);
        if (ocrResult) {
          pageTexts = ocrResult.pageTexts;
          if (ocrResult.usedOcr) {
            warnings.push('PDF appears to be scanned; used Scribe.js OCR for text extraction');
          }
        }
      }

      const normalizedPageTexts = opts.generateFullText
        ? this.normalizePdfPageTexts(pageTexts)
        : pageTexts;

      // Debug: log VLM entry conditions (avoid logging secrets)
      logger.info(
        `VLM entry check: smartAnalysis=${useSmartAnalysis}, vlmEnabled=${vlmConfig?.enabled}, needsOcr=${needsOcr}, vlmConfig=${JSON.stringify(
          vlmConfigOpts
            ? {
                enabled: vlmConfig?.enabled,
                hasApiBase: !!vlmConfig?.apiBase,
                hasApiKey: !!vlmConfig?.apiKey,
                model: vlmConfig?.model,
              }
            : null
        )}`
      );

      // Standard per-page processing
      {
        for (let pageIdx = startPage; pageIdx < startPage + pagesToProcess; pageIdx++) {
          try {
            // Get page text
            const pageText = pageTexts[pageIdx] ?? '';
            const normalizedPageText = normalizedPageTexts[pageIdx] ?? pageText;
            
            // Use VLM for all pages if scanned/minimal text PDF with VLM enabled
            if (useVLMForAllPages && vlmConfig?.enabled) {
              const vlmElements = await processPageWithVLM(freshData(), pageIdx, vlmConfig);
              if (vlmElements.length > 0) {
                contents.push(...this.convertAnalyzedElements(vlmElements));
                // Extract text from VLM elements for full text
                if (opts.generateFullText) {
                  const vlmText = vlmElements
                    .filter(el => el.type === 'paragraph' || el.type === 'heading')
                    .map(el => el.content)
                    .join('\n\n');
                  if (vlmText.trim()) fullTextParts.push(vlmText);
                }
                continue;
              }
              // If VLM returns nothing, fall through to standard parsing
            }
            
            if (pageText.trim()) {
              // Use smart analysis for academic papers if enabled
              if (useSmartAnalysis) {
                const smartContents = await this.smartAnalyzePage(
                  pdf,
                  pageIdx,
                  vlmConfig,
                  warnings
                );
                contents.push(...smartContents);
              } else {
                // Standard structure detection
                const pageContents = this.parsePageContent(pageText, pageIdx);
                contents.push(...pageContents);
              }
              if (opts.generateFullText && normalizedPageText.trim()) {
                fullTextParts.push(normalizedPageText);
              }
            } else if (vlmConfig?.enabled) {
              // Page has no text but VLM is available - try VLM extraction
              const vlmElements = await processPageWithVLM(freshData(), pageIdx, vlmConfig);
              if (vlmElements.length > 0) {
                contents.push(...this.convertAnalyzedElements(vlmElements));
                if (opts.generateFullText) {
                  const vlmText = vlmElements
                    .filter(el => el.type === 'paragraph' || el.type === 'heading')
                    .map(el => el.content)
                    .join('\n\n');
                  if (vlmText.trim()) fullTextParts.push(vlmText);
                }
              }
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
        const normalizedText = this.normalizePdfPageText(text);
        const finalText = normalizedText.trim() ? normalizedText : text;

        const metadata: DocumentMetadata = {
          title: path.basename(filePath, path.extname(filePath)),
          pageCount: typeof parsed?.numpages === 'number' ? parsed.numpages : undefined,
          format: '.pdf',
          fileSizeBytes: fs.statSync(filePath).size,
          parser: 'pdf-parse',
          parsedAt: new Date().toISOString(),
        };

        const contents: ParsedContent[] = finalText.trim()
          ? [{ type: 'text', content: finalText }]
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
          fullText: finalText,
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

  // ============================================================================
  // PDF Text Normalization (Non-Distill)
  // ============================================================================

  /**
   * Normalize page texts for cleaner full-text output.
   */
  private normalizePdfPageTexts(pageTexts: string[]): string[] {
    if (pageTexts.length === 0) return pageTexts;
    const repeatedLineKeys = this.findRepeatedLineKeys(pageTexts);
    return pageTexts.map((text) => this.normalizePdfPageText(text ?? '', repeatedLineKeys));
  }

  /**
   * Normalize a single page's text.
   */
  private normalizePdfPageText(pageText: string, repeatedLineKeys?: Set<string>): string {
    const lines = this.splitPdfLines(pageText);
    const cleaned: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/g, '');
      const trimmed = line.trim();

      if (!trimmed) {
        if (cleaned.length > 0 && cleaned[cleaned.length - 1] !== '') {
          cleaned.push('');
        }
        continue;
      }

      if (this.isLikelyPageNumberLine(trimmed)) {
        continue;
      }

      const key = this.normalizeLineKey(trimmed);
      if (repeatedLineKeys && repeatedLineKeys.has(key)) {
        continue;
      }

      cleaned.push(trimmed);
    }

    const merged = this.mergePdfLines(cleaned);
    return merged.replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * Split raw PDF text into lines with normalized newlines.
   */
  private splitPdfLines(text: string): string[] {
    return text
      .replace(/\r\n?/g, '\n')
      .replace(/\u0000/g, '')
      .split('\n');
  }

  /**
   * Merge lines into paragraphs using lightweight heuristics.
   */
  private mergePdfLines(lines: string[]): string {
    const out: string[] = [];

    for (const line of lines) {
      if (line === '') {
        if (out.length > 0 && out[out.length - 1] !== '') {
          out.push('');
        }
        continue;
      }

      if (out.length === 0) {
        out.push(line);
        continue;
      }

      const prev = out[out.length - 1] ?? '';
      if (prev === '') {
        out.push(line);
        continue;
      }

      const merged = this.tryMergeLines(prev, line);
      if (merged) {
        out[out.length - 1] = merged;
      } else {
        out.push(line);
      }
    }

    return out.join('\n');
  }

  /**
   * Decide whether to merge two lines, and if so, how.
   */
  private tryMergeLines(prev: string, next: string): string | null {
    const prevTrim = prev.trimEnd();
    const nextTrim = next.trimStart();

    if (this.isHeadingLike(prevTrim) || this.isHeadingLike(nextTrim)) return null;
    if (this.isListItem(prevTrim) || this.isListItem(nextTrim)) return null;

    if (this.isUrlContinuation(prevTrim, nextTrim)) {
      return prevTrim + nextTrim;
    }

    const hyphenMatch = prevTrim.match(/([A-Za-z]{2,})-$/);
    if (hyphenMatch && /^[a-z]/.test(nextTrim)) {
      if (this.shouldKeepHyphen(nextTrim)) {
        return prevTrim + nextTrim;
      }
      return prevTrim.slice(0, -1) + nextTrim;
    }

    if (
      prevTrim.endsWith('(') ||
      prevTrim.endsWith('[') ||
      prevTrim.endsWith('{') ||
      prevTrim.endsWith('/') ||
      prevTrim.endsWith('\\') ||
      prevTrim.endsWith('—')
    ) {
      return prevTrim + nextTrim;
    }

    return `${prevTrim} ${nextTrim}`;
  }

  /**
   * Heading-like detection for line-merge heuristics.
   */
  private isHeadingLike(line: string): boolean {
    if (this.isHeading(line)) return true;
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 80) return false;
    if (/[.!?]$/.test(trimmed)) return false;

    const words = trimmed.split(/\s+/);
    if (words.length === 0 || words.length > 10) return false;

    const smallWords = new Set([
      'a', 'an', 'and', 'or', 'the', 'of', 'in', 'on', 'for', 'to',
      'with', 'by', 'vs', 'via', 'from', 'as',
    ]);

    let matches = 0;
    for (const word of words) {
      const cleaned = word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
      if (!cleaned) continue;
      const lower = cleaned.toLowerCase();
      if (smallWords.has(lower)) {
        matches++;
        continue;
      }
      if (/^[A-Z][a-z]/.test(cleaned) || /^[A-Z]{2,}$/.test(cleaned) || /^\d+/.test(cleaned)) {
        matches++;
      }
    }

    return matches / words.length >= 0.7;
  }

  /**
   * Detect likely page-number/folio lines.
   */
  private isLikelyPageNumberLine(line: string): boolean {
    if (this.isPageNumber(line)) return true;
    if (/^page\s+\d+(\s+of\s+\d+)?$/i.test(line)) return true;
    if (/^\d+\s*\/\s*\d+$/i.test(line)) return true;
    if (/^[ivxlcdm]{1,6}$/i.test(line)) return true;
    return false;
  }

  /**
   * Normalize a line for repeated header/footer detection.
   */
  private normalizeLineKey(line: string): string {
    return line.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /**
   * Detect repeated lines across pages (headers/footers).
   */
  private findRepeatedLineKeys(pageTexts: string[]): Set<string> {
    const totalPages = pageTexts.length;
    if (totalPages < 2) return new Set();

    const counts = new Map<string, number>();

    for (const pageText of pageTexts) {
      const seen = new Set<string>();
      const lines = this.splitPdfLines(pageText ?? '');

      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        if (this.isLikelyPageNumberLine(trimmed)) continue;

        const key = this.normalizeLineKey(trimmed);
        if (!key || key.length < 4 || key.length > 160) continue;
        if (seen.has(key)) continue;

        seen.add(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }

    const minRepeats = Math.max(2, Math.ceil(totalPages * 0.6));
    const repeated = new Set<string>();

    for (const [key, count] of counts) {
      if (count >= minRepeats) {
        repeated.add(key);
      }
    }

    return repeated;
  }

  /**
   * Keep hyphens for compound words (e.g., "state-\nof-the-art").
   */
  private shouldKeepHyphen(next: string): boolean {
    return /^(of|in|on|to|by|for|and|or|the|a|an|vs|per|via|with|from|non|pre|post|anti|co)-/i.test(next);
  }

  /**
   * Detect URLs broken across lines.
   */
  private isUrlContinuation(prev: string, next: string): boolean {
    if (!/(https?:\/\/|www\.)/i.test(prev)) return false;
    if (/[)\].,;:]$/.test(prev)) return false;
    return /^[A-Za-z0-9/_?#=&%.-]/.test(next);
  }

  /**
   * Try OCR extraction using Scribe.js.
   * Scribe.js automatically handles both text-native and image-native PDFs.
   */
  private async tryOcrExtraction(
    filePath: string,
    maxPages: number,
    warnings: string[]
  ): Promise<{ pageTexts: string[]; usedOcr: boolean } | null> {
    try {
      const scribe = await getScribeOcr();
      if (!scribe || !scribe.extractText) {
        logger.debug('Scribe.js OCR not available for PDF fallback');
        return null;
      }

      logger.info(`Attempting OCR extraction for: ${filePath}`);

      // Read file as ArrayBuffer for Scribe.js
      const buffer = fs.readFileSync(filePath);
      const arrayBuffer = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
      );

      // Scribe.js extractText can handle PDF files directly
      // It auto-detects if the PDF is text-native or image-native
      const ocrText = await scribe.extractText([arrayBuffer], {
        maxPages,
        preferNativeText: true, // Try native text first, OCR as fallback
      });

      if (!ocrText || !ocrText.trim()) {
        logger.debug('OCR extraction returned empty text');
        return null;
      }

      // Split OCR result by page markers or paragraphs
      // Scribe.js typically returns combined text, so we split heuristically
      const pageTexts = this.splitOcrTextByPages(ocrText, maxPages);

      logger.info(`OCR extracted ${ocrText.length} characters from PDF`);

      return {
        pageTexts,
        usedOcr: true,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`OCR extraction failed: ${errMsg}`);
      warnings.push(`OCR fallback failed: ${errMsg}`);
      return null;
    }
  }

  /**
   * Split OCR text into page-like segments.
   * Since Scribe.js may return combined text, we use heuristics.
   */
  private splitOcrTextByPages(text: string, expectedPages: number): string[] {
    // Try to split by common page break patterns
    const pageBreakPatterns = [
      /\f/g, // Form feed character
      /\n{3,}/g, // Multiple newlines
      /---+\s*Page\s*\d+\s*---+/gi, // Explicit page markers
    ];

    for (const pattern of pageBreakPatterns) {
      const parts = text.split(pattern).filter(p => p.trim());
      if (parts.length > 1) {
        return parts;
      }
    }

    // If no page breaks found, return as single page or split evenly
    if (expectedPages <= 1) {
      return [text];
    }

    // Split evenly by paragraph count
    const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
    if (paragraphs.length <= expectedPages) {
      return [text]; // Not enough paragraphs to split
    }

    const perPage = Math.ceil(paragraphs.length / expectedPages);
    const pages: string[] = [];
    for (let i = 0; i < paragraphs.length; i += perPage) {
      pages.push(paragraphs.slice(i, i + perPage).join('\n\n'));
    }

    return pages;
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
   * Smart analyze a page using the academic paper analyzer.
   * Detects headings, formulas, code blocks, and tables with higher accuracy.
   */
  private async smartAnalyzePage(
    pdf: PDFDocumentProxy,
    pageIndex: number,
    vlmConfig: VLMConfig | null,
    warnings: string[]
  ): Promise<ParsedContent[]> {
    try {
      const page = await pdf.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 1.0 });
      const textContent = await page.getTextContent();
      
      // Convert to rich text items
      const items: RichTextItem[] = [];
      for (const item of textContent.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        
        const textItem = item as { str: string; transform: number[]; fontName?: string; width?: number; height?: number };
        const transform = textItem.transform;
        
        items.push({
          str: textItem.str,
          x: transform[4] ?? 0,
          y: transform[5] ?? 0,
          fontSize: Math.abs(transform[0] ?? 0) || Math.abs(transform[3] ?? 0) || 10,
          fontName: textItem.fontName ?? '',
          width: textItem.width ?? 0,
          height: textItem.height ?? Math.abs(transform[0] ?? 10),
        });
      }
      
      // Group into lines
      const lines = groupIntoLines(items);
      
      // Calculate page stats
      const stats = calculatePageStats(pageIndex, items, lines, viewport.width, viewport.height);
      
      // Check if scanned page - use VLM for full page analysis
      if (stats.isScanned && vlmConfig?.enabled) {
        const vlmElements = await processScannedPage(pdf, pageIndex, vlmConfig);
        if (vlmElements.length > 0) {
          return this.convertAnalyzedElements(vlmElements);
        }
      }
      
      // Classify elements using rule-based analysis
      const elements = classifyPageElements(lines, stats);
      
      return this.convertAnalyzedElements(elements);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      warnings.push(`Smart analysis failed for page ${pageIndex}: ${errMsg}`);
      // Fallback to standard parsing
      const page = await pdf.getPage(pageIndex + 1);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .filter((item: unknown): item is { str: string } => 
          item !== null && typeof item === 'object' && 'str' in item
        )
        .map((item: { str: string }) => item.str)
        .join(' ');
      return this.parsePageContent(pageText, pageIndex);
    }
  }

  /**
   * Convert analyzed elements to ParsedContent format.
   */
  private convertAnalyzedElements(elements: AnalyzedElement[]): ParsedContent[] {
    return elements.map(el => {
      const base: ParsedContent = {
        type: this.mapElementType(el.type),
        content: el.content,
        pageIndex: el.pageIndex,
      };
      
      if (el.type === 'heading' && el.level) {
        base.metadata = { level: el.level };
      }
      if (el.type === 'table' && el.columns) {
        base.metadata = { columns: el.columns };
      }
      if (el.confidence < 0.8) {
        base.metadata = { ...base.metadata, confidence: el.confidence };
      }
      if (el.vlmProcessed) {
        base.metadata = { ...base.metadata, vlmProcessed: true };
      }
      
      return base;
    });
  }

  /**
   * Map analyzed element type to ParsedContentType.
   */
  private mapElementType(type: AnalyzedElement['type']): ParsedContentType {
    switch (type) {
      case 'heading': return 'heading';
      case 'paragraph': return 'text';
      case 'formula': return 'equation'; // Map to equation type
      case 'code': return 'code_block';
      case 'table': return 'table';
      case 'list': return 'list';
      case 'image': return 'image';
      case 'footnote': return 'footnote';
      case 'caption': return 'caption';
      default: return 'text';
    }
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
      
      // Skip standalone page numbers (noise reduction)
      if (this.isPageNumber(trimmed)) {
        continue;
      }
      
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
   * Detect if a line is a standalone page number.
   * Filters out noise like "2", "3", "4" that appear as isolated lines.
   */
  private isPageNumber(line: string): boolean {
    // Single number (1-4 digits), possibly with surrounding whitespace
    return /^\d{1,4}$/.test(line);
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
