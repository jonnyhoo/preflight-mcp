/**
 * Document ingestion module for multimodal content processing.
 * 
 * Handles parsing of PDF, Office documents, and other document formats
 * during bundle creation, extracting text and multimodal content.
 * 
 * @module bundle/document-ingest
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { PdfParser } from '../parser/pdf-parser.js';
import { MineruParser, isMineruAvailable } from '../parser/mineru-parser.js';
import { OfficeParser } from '../parser/office-parser.js';
import { HtmlParser, MarkdownParser } from '../parser/text-parser.js';
import type { ParsedContent, IDocumentParser } from '../parser/types.js';
import { toModalContent } from '../parser/types.js';
import type { ModalContent } from '../modal/types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('document-ingest');

// ============================================================================
// Types
// ============================================================================

/**
 * Supported document format categories for ingestion.
 */
export type DocumentCategory = 'pdf' | 'office' | 'web' | 'markdown';

/**
 * Result of parsing a single document.
 */
export interface DocumentIngestResult {
  /** Original document path */
  sourcePath: string;
  /** Whether parsing succeeded */
  success: boolean;
  /** Extracted full text (for FTS indexing) */
  fullText?: string;
  /** Extracted modal content items */
  modalContents: ModalContent[];
  /** Raw parsed content items (equations, tables, code blocks, images) */
  rawContents?: ParsedContent[];
  /** Page count if multi-page document */
  pageCount?: number;
  /** Parsing duration in milliseconds */
  parseTimeMs: number;
  /** Error message if parsing failed */
  error?: string;
  /** Warnings encountered during parsing */
  warnings?: string[];
  /** Which parser was used (e.g., 'mineru', 'unpdf', 'office') */
  parserUsed?: string;
  /** Extracted assets (images, etc.) - key is relative path, value is buffer */
  assets?: Map<string, Buffer>;
}

/**
 * Batch document ingestion result.
 */
export interface BatchDocumentIngestResult {
  /** Successfully processed documents */
  processed: DocumentIngestResult[];
  /** Failed documents */
  failed: Array<{ path: string; error: string }>;
  /** Statistics */
  stats: {
    totalDocuments: number;
    successCount: number;
    failureCount: number;
    totalModalItems: number;
    totalParseTimeMs: number;
  };
}

/**
 * Options for document ingestion.
 */
export interface DocumentIngestOptions {
  /** Whether to extract images */
  extractImages?: boolean;
  /** Whether to extract tables */
  extractTables?: boolean;
  /** Whether to extract equations */
  extractEquations?: boolean;
  /** Maximum pages to parse per document */
  maxPagesPerDocument?: number;
  /** Timeout per document in milliseconds */
  timeoutPerDocumentMs?: number;
  /** Output directory for extracted assets */
  outputDir?: string;
  /** Enable smart analysis for academic papers */
  smartAnalysis?: boolean;
  /** VLM configuration for enhanced PDF analysis */
  vlmConfig?: {
    apiBase: string;
    apiKey: string;
    model?: string;
  };
  /** Force use of local parser (unpdf+VLM) instead of MinerU for PDF */
  forceLocalParser?: boolean;
}

// ============================================================================
// Parser Registry
// ============================================================================

/**
 * Get appropriate parser for a file extension.
 * 
 * For PDF files:
 * - Uses MineruParser (cloud API) if configured (high-quality extraction)
 * - Falls back to PdfParser (local unpdf/pdf-parse) otherwise
 * @param forceLocalParser - If true, skip MinerU and use local parser
 */
function getParserForExtension(ext: string, forceLocalParser = false): IDocumentParser | null {
  const lowerExt = ext.toLowerCase();
  
  switch (lowerExt) {
    case '.pdf':
      // Force local parser if requested (for testing fallback quality)
      if (forceLocalParser) {
        logger.info('Using local PDF parser (unpdf+VLM) - forceLocalParser=true');
        return new PdfParser();
      }
      // Prefer MinerU for high-quality PDF parsing if available
      if (isMineruAvailable()) {
        logger.info('Using MinerU parser for PDF (cloud API)');
        return new MineruParser();
      }
      // Fallback to local PDF parser
      logger.info('Using local PDF parser (unpdf/pdf-parse) - MinerU not configured');
      return new PdfParser();
    case '.doc':
    case '.docx':
    case '.xls':
    case '.xlsx':
    case '.ppt':
    case '.pptx':
      return new OfficeParser();
    case '.html':
    case '.htm':
    case '.xhtml':
      return new HtmlParser();
    case '.md':
    case '.markdown':
      return new MarkdownParser();
    default:
      return null;
  }
}

/**
 * Check if a file is a parseable document (not plain text/code).
 * Note: Markdown files are handled separately as they are typically already text.
 */
export function isParseableDocument(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  // PDF, Office documents, and HTML files that need specialized parsing
  return ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.html', '.htm', '.xhtml'].includes(ext);
}

/**
 * Get document category from extension.
 */
export function getDocumentCategory(filePath: string): DocumentCategory | null {
  const ext = path.extname(filePath).toLowerCase();
  
  if (ext === '.pdf') return 'pdf';
  if (['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'].includes(ext)) return 'office';
  if (['.html', '.htm', '.xhtml'].includes(ext)) return 'web';
  if (['.md', '.markdown'].includes(ext)) return 'markdown';
  
  return null;
}

// ============================================================================
// Document Ingestion
// ============================================================================

/**
 * Parse a single document and extract content.
 */
export async function ingestDocument(
  filePath: string,
  options?: DocumentIngestOptions
): Promise<DocumentIngestResult> {
  const startTime = Date.now();
  const ext = path.extname(filePath);
  
  // Get parser for this file type
  const parser = getParserForExtension(ext, options?.forceLocalParser);
  if (!parser) {
    return {
      sourcePath: filePath,
      success: false,
      modalContents: [],
      parseTimeMs: Date.now() - startTime,
      error: `No parser available for extension: ${ext}`,
    };
  }
  
  try {
    // Check if parser is available
    const isInstalled = await parser.checkInstallation();
    if (!isInstalled) {
      return {
        sourcePath: filePath,
        success: false,
        modalContents: [],
        parseTimeMs: Date.now() - startTime,
        error: `Parser ${parser.name} is not properly installed`,
      };
    }
    
    // Parse the document
    // When forceLocalParser is true, enable smartAnalysis for VLM-enhanced parsing
    const useSmartAnalysis = options?.smartAnalysis ?? options?.forceLocalParser ?? false;
    const parseResult = await parser.parse(filePath, {
      extractImages: options?.extractImages ?? true,
      extractTables: options?.extractTables ?? true,
      extractEquations: options?.extractEquations ?? true,
      maxPages: options?.maxPagesPerDocument,
      timeoutMs: options?.timeoutPerDocumentMs,
      outputDir: options?.outputDir,
      // Pass additional options via extra field
      extra: {
        smartAnalysis: useSmartAnalysis,
        vlmConfig: options?.vlmConfig,
      },
    });
    
    if (!parseResult.success) {
      return {
        sourcePath: filePath,
        success: false,
        modalContents: [],
        parseTimeMs: Date.now() - startTime,
        error: parseResult.errors?.[0]?.message ?? 'Unknown parse error',
        warnings: parseResult.warnings,
      };
    }
    
    // Convert parsed content to modal content
    const modalContents = convertToModalContents(parseResult.contents, filePath);
    
    return {
      sourcePath: filePath,
      success: true,
      fullText: parseResult.fullText,
      modalContents,
      rawContents: parseResult.contents,
      pageCount: parseResult.metadata.pageCount,
      parseTimeMs: Date.now() - startTime,
      warnings: parseResult.warnings,
      parserUsed: parseResult.metadata.parser,
      assets: parseResult.assets,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`Document ingestion failed: ${filePath}`, error instanceof Error ? error : undefined);
    
    return {
      sourcePath: filePath,
      success: false,
      modalContents: [],
      parseTimeMs: Date.now() - startTime,
      error: errMsg,
    };
  }
}

/**
 * Batch ingest multiple documents.
 */
export async function ingestDocuments(
  filePaths: string[],
  options?: DocumentIngestOptions
): Promise<BatchDocumentIngestResult> {
  const processed: DocumentIngestResult[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  let totalModalItems = 0;
  let totalParseTimeMs = 0;
  
  for (const filePath of filePaths) {
    const result = await ingestDocument(filePath, options);
    
    if (result.success) {
      processed.push(result);
      totalModalItems += result.modalContents.length;
    } else {
      failed.push({ path: filePath, error: result.error ?? 'Unknown error' });
    }
    
    totalParseTimeMs += result.parseTimeMs;
  }
  
  return {
    processed,
    failed,
    stats: {
      totalDocuments: filePaths.length,
      successCount: processed.length,
      failureCount: failed.length,
      totalModalItems,
      totalParseTimeMs,
    },
  };
}

/**
 * Scan a directory for parseable documents.
 */
export async function scanForDocuments(
  rootDir: string,
  options?: { maxFiles?: number }
): Promise<string[]> {
  const documents: string[] = [];
  const maxFiles = options?.maxFiles ?? 1000;
  
  async function scan(dir: string): Promise<void> {
    if (documents.length >= maxFiles) return;
    
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (documents.length >= maxFiles) break;
        
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          // Skip common non-document directories
          if (!['node_modules', '.git', 'dist', 'build', '__pycache__'].includes(entry.name)) {
            await scan(fullPath);
          }
        } else if (entry.isFile() && isParseableDocument(fullPath)) {
          documents.push(fullPath);
        }
      }
    } catch (error) {
      logger.warn(`Failed to scan directory: ${dir}`, { error: String(error) });
    }
  }
  
  await scan(rootDir);
  return documents;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert parsed content items to modal content format.
 */
function convertToModalContents(
  contents: ParsedContent[],
  sourcePath: string
): ModalContent[] {
  return contents
    .filter(c => ['image', 'table', 'equation'].includes(c.type))
    .map(c => ({
      ...toModalContent(c),
      sourcePath,
    }));
}

/**
 * Compute SHA256 hash for text content.
 */
export function computeTextHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Estimate if a document is likely to contain multimodal content.
 */
export function estimateModalContent(filePath: string): {
  likelyHasImages: boolean;
  likelyHasTables: boolean;
  likelyHasEquations: boolean;
} {
  const ext = path.extname(filePath).toLowerCase();
  const category = getDocumentCategory(filePath);
  
  return {
    likelyHasImages: category === 'pdf' || category === 'office' || category === 'web',
    likelyHasTables: category === 'pdf' || category === 'office' || category === 'web',
    likelyHasEquations: category === 'pdf' || ext === '.docx',
  };
}
