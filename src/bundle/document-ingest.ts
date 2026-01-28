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
import { VlmParser } from '../parser/vlm-parser.js';
import { MineruParser, isMineruAvailable, type BatchParseResult } from '../parser/mineru-parser.js';
import { OfficeParser } from '../parser/office-parser.js';
import { HtmlParser, MarkdownParser } from '../parser/text-parser.js';
import type { ParsedContent, IDocumentParser } from '../parser/types.js';
import { toModalContent } from '../parser/types.js';
import type { ModalContent } from '../modal/types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('document-ingest');

// ============================================================================
// LLM-Friendly Messages
// ============================================================================

/**
 * Detailed messages for LLM context about PDF parsing modes and fallback behavior.
 * These help users understand what happened and what options they have.
 */
const LLM_MESSAGES = {
  PDF_PARSING_MODES: `[PDF Parsing Information]
Preflight supports three PDF parsing modes:

1. MinerU (Default): Cloud-based API with highest quality extraction
   - Requires: mineruApiBase and mineruApiKey in config.json
   - Best for: Complex PDFs with tables, formulas, figures

2. VLM Parser (vlmParser=true): Local parallel Vision-Language Model processing
   - Requires: vlmConfigs array in config.json
   - Best for: When MinerU is unavailable or you prefer local processing

3. PdfParser (Fallback ONLY): Rule-based text extraction using unpdf
   - Only used as automatic fallback when MinerU/VLM parsing fails
   - NOT available as primary parser without explicit configuration
   - Limitations: May miss complex layouts, formulas rendered as images`,

  FALLBACK_TO_PDFPARSER: (primaryParser: string, reason: string) => `[PDF Parser Fallback Warning]
Primary parser "${primaryParser}" failed, automatically falling back to PdfParser (rule-based).

Reason: ${reason}

Note: PdfParser uses rule-based extraction which may have limitations:
  - Tables may not be perfectly formatted
  - Formulas rendered as images won't be converted to LaTeX
  - Complex layouts may have extraction issues

For better quality, consider:
  - If using MinerU: Check your mineruApiBase and mineruApiKey configuration
  - If using VLM Parser: Verify vlmConfigs in config.json and API connectivity`,

  PDF_NO_PARSER_AVAILABLE: `[PDF Parsing Error]
Cannot parse PDF: No high-quality parser is configured.

PdfParser (rule-based) is only available as a fallback when MinerU or VLM parsing fails.
To parse PDFs, you must configure at least one of:

1. MinerU (Recommended):
   Add to ~/.preflight/config.json:
   {
     "mineruApiBase": "https://your-mineru-api.com",
     "mineruApiKey": "your-api-key"
   }

2. VLM Parser:
   Add to ~/.preflight/config.json:
   {
     "vlmApiBase": "https://your-vlm-api.com",
     "vlmApiKey": "your-api-key",
     "vlmEnabled": true
   }
   Then use vlmParser=true when ingesting.

Note: PdfParser will still be used as automatic fallback if MinerU/VLM fails.`,
} as const;

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
  /** Use VLM Parser (parallel Vision-Language Model) for PDF instead of MinerU */
  vlmParser?: boolean;
}

// ============================================================================
// Parser Registry
// ============================================================================

/**
 * Get appropriate parser for a file extension.
 * 
 * PDF parsing has two primary modes:
 * 1. MinerU (default): Cloud API with highest quality extraction
 * 2. VLM Parser (vlmParser=true): Local parallel VLM processing, requires vlmConfigs in config.json
 * 
 * PdfParser (rule-based) is ONLY used as automatic fallback when primary parsing fails.
 * It is NOT returned as a primary parser when neither MinerU nor VLM is configured.
 * 
 * @param useVlmParser - If true, use VlmParser for parallel VLM processing
 * @returns Parser instance, or null if no parser available (PDF without MinerU/VLM)
 */
function getParserForExtension(ext: string, useVlmParser = false): IDocumentParser | null {
  const lowerExt = ext.toLowerCase();
  
  switch (lowerExt) {
    case '.pdf':
      // Use VlmParser for parallel VLM processing when explicitly requested
      if (useVlmParser) {
        logger.info('[PDF] Using VLM Parser (parallel Vision-Language Model processing) - vlmParser=true');
        return new VlmParser();
      }
      // Prefer MinerU for high-quality PDF parsing if available
      if (isMineruAvailable()) {
        logger.info('[PDF] Using MinerU Parser (cloud API) - default mode');
        return new MineruParser();
      }
      // IMPORTANT: Do NOT fall back to PdfParser as primary parser
      // PdfParser is only for automatic fallback when MinerU/VLM fails (see ingestDocument)
      // Return null to signal that no high-quality parser is available
      logger.error(LLM_MESSAGES.PDF_NO_PARSER_AVAILABLE);
      return null;
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
  const parser = getParserForExtension(ext, options?.vlmParser);
  if (!parser) {
    // For PDF: provide LLM-friendly message about configuration requirements
    const isPdf = ext.toLowerCase() === '.pdf';
    const errorMsg = isPdf
      ? LLM_MESSAGES.PDF_NO_PARSER_AVAILABLE
      : `No parser available for extension: ${ext}`;
    
    return {
      sourcePath: filePath,
      success: false,
      modalContents: [],
      parseTimeMs: Date.now() - startTime,
      error: errorMsg,
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
    // When vlmParser is true, enable smartAnalysis for VLM-enhanced parsing
    const useSmartAnalysis = options?.smartAnalysis ?? options?.vlmParser ?? false;
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
      // For PDF files, try fallback to rule-based parser if primary parser failed
      const isPdf = ext.toLowerCase() === '.pdf';
      const canFallback = isPdf && parser.name !== 'unpdf'; // Don't fallback if already using PdfParser
      
      if (canFallback) {
        const primaryError = parseResult.errors?.[0]?.message ?? 'Unknown error';
        const fallbackMessage = LLM_MESSAGES.FALLBACK_TO_PDFPARSER(parser.name, primaryError);
        logger.warn(fallbackMessage);
        
        const fallbackParser = new PdfParser();
        try {
          const fallbackResult = await fallbackParser.parse(filePath, {
            extractImages: options?.extractImages ?? true,
            extractTables: options?.extractTables ?? true,
            maxPages: options?.maxPagesPerDocument,
          });
          
          if (fallbackResult.success) {
            const modalContents = convertToModalContents(fallbackResult.contents, filePath);
            return {
              sourcePath: filePath,
              success: true,
              fullText: fallbackResult.fullText,
              modalContents,
              rawContents: fallbackResult.contents,
              pageCount: fallbackResult.metadata.pageCount,
              parseTimeMs: Date.now() - startTime,
              warnings: [
                // Include detailed fallback explanation for LLM
                fallbackMessage,
                ...(fallbackResult.warnings || []),
              ],
              parserUsed: `${fallbackResult.metadata.parser} (fallback from ${parser.name})`,
            };
          }
        } catch (fallbackErr) {
          logger.error('Fallback parser also failed:', fallbackErr instanceof Error ? fallbackErr : undefined);
        }
      }
      
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
 * For PDF files, uses MinerU batch API for efficient parallel processing.
 */
export async function ingestDocuments(
  filePaths: string[],
  options?: DocumentIngestOptions
): Promise<BatchDocumentIngestResult> {
  const processed: DocumentIngestResult[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  let totalModalItems = 0;
  let totalParseTimeMs = 0;
  
  // Separate PDF files from other documents for batch processing
  const pdfFiles: string[] = [];
  const otherFiles: string[] = [];
  
  for (const filePath of filePaths) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pdf' && !options?.vlmParser && isMineruAvailable()) {
      pdfFiles.push(filePath);
    } else {
      otherFiles.push(filePath);
    }
  }
  
  // Process PDFs in batch if there are multiple
  if (pdfFiles.length > 1) {
    logger.info(`Batch processing ${pdfFiles.length} PDF files with MinerU`);
    const batchResult = await ingestPdfBatch(pdfFiles, options);
    
    for (const result of batchResult.results) {
      if (result.success) {
        processed.push(result);
        totalModalItems += result.modalContents.length;
      } else {
        failed.push({ path: result.sourcePath, error: result.error ?? 'Unknown error' });
      }
      totalParseTimeMs += result.parseTimeMs;
    }
  } else if (pdfFiles.length === 1) {
    // Single PDF, use regular ingestion
    otherFiles.push(pdfFiles[0]!);
  }
  
  // Process other files sequentially
  for (const filePath of otherFiles) {
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
 * Batch ingest multiple PDF files using MinerU batch API.
 * Internal function used by ingestDocuments.
 */
async function ingestPdfBatch(
  filePaths: string[],
  options?: DocumentIngestOptions
): Promise<{ results: DocumentIngestResult[] }> {
  const startTime = Date.now();
  const results: DocumentIngestResult[] = [];
  
  const parser = new MineruParser();
  const batchResult: BatchParseResult = await parser.parseBatch(filePaths, {
    extractImages: options?.extractImages ?? true,
    extractTables: options?.extractTables ?? true,
    extractEquations: options?.extractEquations ?? true,
    maxPages: options?.maxPagesPerDocument,
    timeoutMs: options?.timeoutPerDocumentMs,
  });
  
  for (const fileResult of batchResult.results) {
    if (fileResult.success && fileResult.result) {
      const parseResult = fileResult.result;
      const modalContents = convertToModalContents(parseResult.contents, fileResult.source);
      
      results.push({
        sourcePath: fileResult.source,
        success: true,
        fullText: parseResult.fullText,
        modalContents,
        rawContents: parseResult.contents,
        pageCount: parseResult.metadata.pageCount,
        parseTimeMs: parseResult.stats.parseTimeMs,
        parserUsed: parseResult.metadata.parser,
        assets: parseResult.assets,
      });
    } else {
      // Try fallback to PdfParser for failed files
      const fallbackResult = await tryPdfParserFallback(fileResult.source, options);
      if (fallbackResult) {
        results.push(fallbackResult);
      } else {
        results.push({
          sourcePath: fileResult.source,
          success: false,
          modalContents: [],
          parseTimeMs: Date.now() - startTime,
          error: fileResult.error ?? 'Batch parsing failed',
        });
      }
    }
  }
  
  return { results };
}

/**
 * Try to parse a PDF with the fallback PdfParser.
 */
async function tryPdfParserFallback(
  filePath: string,
  options?: DocumentIngestOptions
): Promise<DocumentIngestResult | null> {
  const startTime = Date.now();
  
  try {
    const fallbackParser = new PdfParser();
    const fallbackResult = await fallbackParser.parse(filePath, {
      extractImages: options?.extractImages ?? true,
      extractTables: options?.extractTables ?? true,
      maxPages: options?.maxPagesPerDocument,
    });
    
    if (fallbackResult.success) {
      const modalContents = convertToModalContents(fallbackResult.contents, filePath);
      return {
        sourcePath: filePath,
        success: true,
        fullText: fallbackResult.fullText,
        modalContents,
        rawContents: fallbackResult.contents,
        pageCount: fallbackResult.metadata.pageCount,
        parseTimeMs: Date.now() - startTime,
        warnings: [
          LLM_MESSAGES.FALLBACK_TO_PDFPARSER('mineru-batch', 'Batch parsing failed'),
          ...(fallbackResult.warnings || []),
        ],
        parserUsed: `${fallbackResult.metadata.parser} (fallback from mineru-batch)`,
      };
    }
  } catch (err) {
    logger.error('Fallback parser also failed:', err instanceof Error ? err : undefined);
  }
  
  return null;
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
