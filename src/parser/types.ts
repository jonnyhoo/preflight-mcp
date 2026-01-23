/**
 * Document parser types for preflight-mcp.
 * 
 * This module defines the type system for parsing various document formats
 * including PDF, Office documents, HTML, and Markdown.
 * 
 * Design reference: RAG-Anything parser.py
 */

import type { ModalContentType, ModalContent } from '../modal/types.js';

// ============================================================================
// Supported Formats
// ============================================================================

/**
 * Supported document file extensions.
 */
export type SupportedFormat =
  // PDF
  | '.pdf'
  // Office formats
  | '.doc' | '.docx'
  | '.ppt' | '.pptx'
  | '.xls' | '.xlsx'
  // Web formats
  | '.html' | '.htm' | '.xhtml'
  // Text formats
  | '.md' | '.markdown'
  | '.txt' | '.text'
  // Image formats (for direct image parsing)
  | '.png' | '.jpg' | '.jpeg' | '.gif' | '.bmp' | '.webp' | '.tiff' | '.tif';

/**
 * Format categories for parser selection.
 */
export type FormatCategory = 
  | 'pdf'
  | 'office'
  | 'web'
  | 'text'
  | 'image';

/**
 * Parsing method selection.
 */
export type ParseMethod =
  | 'auto'    // Automatically select best method
  | 'txt'     // Text extraction only (fast)
  | 'ocr'     // OCR-based extraction (for scanned documents)
  | 'hybrid'; // Combined text + OCR

// ============================================================================
// Parsed Content Types
// ============================================================================

/**
 * Content type in parsed output.
 */
export type ParsedContentType = 
  | 'text'
  | 'image'
  | 'table'
  | 'equation'
  | 'heading'
  | 'list'
  | 'code_block'
  | 'footnote'
  | 'caption'
  | 'unknown';

/**
 * A single content item extracted from a document.
 */
export interface ParsedContent {
  /** Content type */
  type: ParsedContentType;
  
  /** 
   * Content data.
   * - For text/heading/list: plain text string
   * - For image: file path to extracted image or base64
   * - For table: structured table data or HTML string
   * - For equation: LaTeX or MathML string
   * - For code_block: source code with language hint
   */
  content: string | ParsedTableData | ParsedCodeBlock;
  
  /** Page index (0-based), if from a multi-page document */
  pageIndex?: number;
  
  /** Section/heading hierarchy path */
  sectionPath?: string[];
  
  /** Position within the source (for evidence linking) */
  position?: ContentPosition;
  
  /** Associated captions (for images, tables, equations) */
  captions?: string[];
  
  /** Associated footnotes */
  footnotes?: string[];
  
  /** Confidence score for OCR-extracted content (0.0 - 1.0) */
  ocrConfidence?: number;
  
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Position information for content within a document.
 */
export interface ContentPosition {
  /** Page number (0-based) */
  page?: number;
  
  /** Bounding box coordinates (normalized 0-1 or absolute pixels) */
  bbox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  
  /** Line range in source text (for text-based formats) */
  lineRange?: {
    start: number;
    end: number;
  };
  
  /** Character offset in source (for text-based formats) */
  charOffset?: {
    start: number;
    end: number;
  };
}

/**
 * Structured table data.
 */
export interface ParsedTableData {
  /** Table headers */
  headers?: string[];
  
  /** Table rows (array of cell values) */
  rows: string[][];
  
  /** Table caption */
  caption?: string;
  
  /** Raw HTML representation if available */
  html?: string;
  
  /** Raw markdown representation if available */
  markdown?: string;
  
  /** Number of rows */
  rowCount: number;
  
  /** Number of columns */
  colCount: number;
}

/**
 * Parsed code block with language information.
 */
export interface ParsedCodeBlock {
  /** Source code content */
  code: string;
  
  /** Programming language hint */
  language?: string;
  
  /** Whether language was auto-detected */
  languageAutoDetected?: boolean;
  
  /** Line numbers in original source */
  lineNumbers?: number[];
}

// ============================================================================
// Parse Result Types
// ============================================================================

/**
 * Document metadata extracted during parsing.
 */
export interface DocumentMetadata {
  /** Document title if detected */
  title?: string;
  
  /** Document author(s) */
  authors?: string[];
  
  /** Creation date */
  createdAt?: string;
  
  /** Modification date */
  modifiedAt?: string;
  
  /** Total page count */
  pageCount?: number;
  
  /** Word count estimate */
  wordCount?: number;
  
  /** Character count */
  charCount?: number;
  
  /** Detected document language(s) */
  languages?: string[];
  
  /** Document subject/keywords */
  keywords?: string[];
  
  /** Original file format */
  format: string;
  
  /** File size in bytes */
  fileSizeBytes?: number;
  
  /** Parser used */
  parser: string;
  
  /** Parsing timestamp */
  parsedAt: string;
  
  /** Additional format-specific metadata */
  extra?: Record<string, unknown>;
}

/**
 * Statistics about parsed content.
 */
export interface ParseStats {
  /** Total content items extracted */
  totalItems: number;
  
  /** Items by type */
  byType: Partial<Record<ParsedContentType, number>>;
  
  /** Items by page (for multi-page documents) */
  byPage?: Record<number, number>;
  
  /** OCR-extracted items count */
  ocrItemsCount?: number;
  
  /** Average OCR confidence (if applicable) */
  averageOcrConfidence?: number;
  
  /** Parsing duration in milliseconds */
  parseTimeMs: number;
}

/**
 * Complete result of parsing a document.
 */
export interface ParseResult {
  /** Whether parsing succeeded */
  success: boolean;
  
  /** Parsed content items in document order */
  contents: ParsedContent[];
  
  /** Document metadata */
  metadata: DocumentMetadata;
  
  /** Parsing statistics */
  stats: ParseStats;
  
  /** Extracted text as a single string (for search indexing) */
  fullText?: string;
  
  /** Table of contents if extracted */
  tableOfContents?: TocEntry[];
  
  /** Errors encountered during parsing */
  errors?: ParseError[];
  
  /** Warnings (non-fatal issues) */
  warnings?: string[];
  
  /** Extracted assets (images, etc.) - key is relative path, value is buffer */
  assets?: Map<string, Buffer>;
}

/**
 * Table of contents entry.
 */
export interface TocEntry {
  /** Heading text */
  title: string;
  
  /** Heading level (1-6) */
  level: number;
  
  /** Page number (0-based) */
  pageIndex?: number;
  
  /** Nested entries */
  children?: TocEntry[];
}

/**
 * Parse error details.
 */
export interface ParseError {
  /** Error code */
  code: string;
  
  /** Human-readable message */
  message: string;
  
  /** Page where error occurred */
  pageIndex?: number;
  
  /** Whether parsing continued after this error */
  recoverable: boolean;
  
  /** Stack trace for debugging */
  stack?: string;
}

// ============================================================================
// Parser Configuration
// ============================================================================

/**
 * Base parser options.
 */
export interface ParseOptions {
  /** Parsing method selection */
  method?: ParseMethod;
  
  /** Document language hint for OCR */
  language?: string;
  
  /** Output directory for extracted assets (images, etc.) */
  outputDir?: string;
  
  /** Whether to extract images */
  extractImages?: boolean;
  
  /** Whether to extract tables */
  extractTables?: boolean;
  
  /** Whether to extract equations */
  extractEquations?: boolean;
  
  /** Whether to generate full text */
  generateFullText?: boolean;
  
  /** Maximum pages to parse (for large documents) */
  maxPages?: number;
  
  /** Page range to parse */
  pageRange?: {
    start: number;
    end: number;
  };
  
  /** Timeout in milliseconds */
  timeoutMs?: number;
  
  /**
   * Whether to enable smart analysis for academic papers.
   * Uses position and font information to detect headings, formulas,
   * code blocks, and tables with higher accuracy.
   * @default false
   */
  smartAnalysis?: boolean;
  
  /**
   * VLM configuration for fallback processing of low-confidence elements.
   */
  vlmConfig?: VLMConfigOptions;
  
  /** Additional parser-specific options */
  extra?: Record<string, unknown>;
}

/**
 * VLM configuration for fallback processing.
 */
export interface VLMConfigOptions {
  /** API base URL */
  apiBase?: string;
  /** API key */
  apiKey?: string;
  /** Model name */
  model?: string;
  /** Maximum tokens for response */
  maxTokens?: number;
  /** Whether VLM fallback is enabled */
  enabled?: boolean;
  /** Confidence threshold for triggering VLM (default: 0.7) */
  confidenceThreshold?: number;
}

/**
 * PDF-specific parse options.
 */
export interface PdfParseOptions extends ParseOptions {
  /** Backend to use */
  backend?: 'pdfjs' | 'mineru' | 'docling';
  
  /** Whether to enable formula detection */
  detectFormulas?: boolean;
  
  /** Whether to enable table detection */
  detectTables?: boolean;
  
  /** Device for ML inference (CPU/GPU) */
  device?: 'cpu' | 'cuda';
  
  /** VLM URL for vision-language model backend */
  vlmUrl?: string;
  
  /**
   * Whether to enable OCR fallback for scanned PDFs.
   * When true (default), if native text extraction yields empty/minimal content,
   * the parser will use Scribe.js OCR to extract text from images.
   * @default true
   */
  enableOcr?: boolean;
  
  /**
   * Whether to enable smart analysis for academic papers.
   * Uses position and font information to detect headings, formulas,
   * code blocks, and tables with higher accuracy.
   * @default false
   */
  smartAnalysis?: boolean;
  
  /**
   * VLM configuration for fallback processing of low-confidence elements.
   * If provided and enabled, elements with confidence below threshold
   * will be processed using a Vision-Language Model.
   */
  vlmConfig?: VLMConfigOptions;
}

/**
 * Office document parse options.
 */
export interface OfficeParseOptions extends ParseOptions {
  /** Backend to use */
  backend?: 'libreoffice' | 'docling';
  
  /** Whether to convert to PDF first */
  convertToPdf?: boolean;
  
  /** LibreOffice executable path */
  libreOfficePath?: string;
}

/**
 * HTML parse options.
 */
export interface HtmlParseOptions extends ParseOptions {
  /** Base URL for resolving relative links */
  baseUrl?: string;
  
  /** CSS selector for main content */
  contentSelector?: string;
  
  /** Whether to include scripts */
  includeScripts?: boolean;
  
  /** Whether to include styles */
  includeStyles?: boolean;
}

/**
 * Markdown parse options.
 */
export interface MarkdownParseOptions extends ParseOptions {
  /** Whether to resolve local image paths */
  resolveImages?: boolean;
  
  /** Base path for resolving relative paths */
  basePath?: string;
  
  /** Markdown flavor */
  flavor?: 'gfm' | 'commonmark' | 'original';
}

// ============================================================================
// Parser Interface
// ============================================================================

/**
 * Abstract parser interface.
 * All document parsers should implement this interface.
 */
export interface IDocumentParser {
  /** Parser name */
  readonly name: string;
  
  /** Supported file extensions */
  readonly supportedFormats: readonly SupportedFormat[];
  
  /** Check if parser can handle a file */
  canParse(filePath: string): boolean;
  
  /** Parse a document */
  parse(filePath: string, options?: ParseOptions): Promise<ParseResult>;
  
  /** Check if parser is properly installed/configured */
  checkInstallation(): Promise<boolean>;
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Map file extension to format category.
 */
export function getFormatCategory(ext: SupportedFormat): FormatCategory {
  if (ext === '.pdf') return 'pdf';
  if (['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx'].includes(ext)) return 'office';
  if (['.html', '.htm', '.xhtml'].includes(ext)) return 'web';
  if (['.md', '.markdown', '.txt', '.text'].includes(ext)) return 'text';
  return 'image';
}

/**
 * Check if a file extension is supported.
 */
export function isSupportedFormat(ext: string): ext is SupportedFormat {
  const supported: SupportedFormat[] = [
    '.pdf',
    '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx',
    '.html', '.htm', '.xhtml',
    '.md', '.markdown', '.txt', '.text',
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.tif'
  ];
  return supported.includes(ext.toLowerCase() as SupportedFormat);
}

/**
 * Convert ParsedContent to ModalContent for processor pipeline.
 */
export function toModalContent(parsed: ParsedContent): ModalContent {
  const typeMap: Record<ParsedContentType, ModalContentType> = {
    'text': 'text',
    'image': 'image',
    'table': 'table',
    'equation': 'equation',
    'heading': 'text',
    'list': 'text',
    'code_block': 'code',
    'footnote': 'text',
    'caption': 'text',
    'unknown': 'generic',
  };
  
  // Convert content to a format compatible with ModalContent
  let content: string | Buffer | Record<string, unknown>;
  if (typeof parsed.content === 'string') {
    content = parsed.content;
  } else if ('code' in parsed.content) {
    // ParsedCodeBlock
    content = { code: parsed.content.code, language: parsed.content.language };
  } else {
    // ParsedTableData
    content = parsed.content as unknown as Record<string, unknown>;
  }
  
  return {
    type: typeMap[parsed.type] || 'generic',
    content,
    pageIndex: parsed.pageIndex,
    captions: parsed.captions,
    footnotes: parsed.footnotes,
    metadata: parsed.metadata,
    position: parsed.position?.bbox,
  };
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Office document formats.
 */
export const OFFICE_FORMATS: readonly SupportedFormat[] = [
  '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx'
] as const;

/**
 * Web document formats.
 */
export const WEB_FORMATS: readonly SupportedFormat[] = [
  '.html', '.htm', '.xhtml'
] as const;

/**
 * Text document formats.
 */
export const TEXT_FORMATS: readonly SupportedFormat[] = [
  '.md', '.markdown', '.txt', '.text'
] as const;

/**
 * Image formats that can be parsed directly.
 */
export const IMAGE_FORMATS: readonly SupportedFormat[] = [
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.tif'
] as const;

/**
 * Default parse options.
 */
export const DEFAULT_PARSE_OPTIONS: ParseOptions = {
  method: 'auto',
  extractImages: true,
  extractTables: true,
  extractEquations: true,
  generateFullText: true,
  timeoutMs: 120000, // 2 minutes
} as const;
