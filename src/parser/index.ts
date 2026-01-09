/**
 * Document parsing module for preflight-mcp.
 * 
 * This module provides capabilities for parsing various document formats
 * including PDF, Office documents, HTML, and Markdown.
 * 
 * @module parser
 */

// ============================================================================
// Type Exports
// ============================================================================

export type {
  // Format types
  SupportedFormat,
  FormatCategory,
  ParseMethod,
  
  // Content types
  ParsedContentType,
  ParsedContent,
  ContentPosition,
  ParsedTableData,
  ParsedCodeBlock,
  
  // Result types
  DocumentMetadata,
  ParseStats,
  ParseResult,
  TocEntry,
  ParseError,
  
  // Configuration types
  ParseOptions,
  PdfParseOptions,
  OfficeParseOptions,
  HtmlParseOptions,
  MarkdownParseOptions,
  
  // Interface
  IDocumentParser,
} from './types.js';

export {
  // Utility functions
  getFormatCategory,
  isSupportedFormat,
  toModalContent,
  
  // Constants
  OFFICE_FORMATS,
  WEB_FORMATS,
  TEXT_FORMATS,
  IMAGE_FORMATS,
  DEFAULT_PARSE_OPTIONS,
} from './types.js';

// ============================================================================
// Parser Implementations
// ============================================================================

export { PdfParser, createPdfParser } from './pdf-parser.js';
export { OfficeParser, createOfficeParser } from './office-parser.js';
export {
  HtmlParser,
  MarkdownParser,
  PlainTextParser,
  createHtmlParser,
  createMarkdownParser,
  createPlainTextParser,
} from './text-parser.js';
