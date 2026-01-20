/**
 * Smart PDF Analyzer
 * 
 * A pure TypeScript solution for analyzing academic PDF papers.
 * Extracts structured content including headings, formulas, code blocks, and tables.
 * Supports VLM fallback for low-confidence elements and scanned pages.
 * 
 * @module parser/pdf
 */

import { getDocumentProxy } from 'unpdf';

/**
 * Type for PDF document proxy returned by unpdf's getDocumentProxy.
 */
export type PDFDocumentProxy = Awaited<ReturnType<typeof getDocumentProxy>>;

import { extractAllPages, groupIntoLines, calculatePageStats } from './text-extractor.js';
import { classifyPageElements, identifyLowConfidenceElements } from './element-classifier.js';
import { processLowConfidenceElements, processScannedPage, createVLMConfig } from './vlm-fallback.js';
import type {
  AnalyzedElement,
  PageAnalysisResult,
  PageStats,
  VLMConfig,
  RichTextItem,
  TextLine,
} from './types.js';

// Re-export types
export * from './types.js';
export { extractAllPages, groupIntoLines, calculatePageStats } from './text-extractor.js';
export { classifyPageElements, identifyLowConfidenceElements } from './element-classifier.js';
export {
  createVLMConfig,
  callVLM,
  renderPageToBase64,
  analyzePageWithVLM,
  processLowConfidenceElements,
  processScannedPage,
} from './vlm-fallback.js';

/**
 * Options for PDF analysis.
 */
export interface AnalyzeOptions {
  /** Start page (0-based), default: 0 */
  startPage?: number;
  /** End page (0-based, inclusive), default: last page */
  endPage?: number;
  /** VLM configuration for fallback processing */
  vlmConfig?: Partial<VLMConfig>;
  /** Confidence threshold for VLM fallback (default: 0.7) */
  confidenceThreshold?: number;
  /** Whether to process scanned pages with VLM (default: true if VLM enabled) */
  processScannedPages?: boolean;
}

/**
 * Complete analysis result for a PDF document.
 */
export interface PDFAnalysisResult {
  /** Number of pages */
  numPages: number;
  /** Analysis results per page */
  pages: PageAnalysisResult[];
  /** All elements across all pages */
  allElements: AnalyzedElement[];
  /** Document-level statistics */
  documentStats: {
    totalElements: number;
    elementsByType: Record<string, number>;
    averageConfidence: number;
    vlmProcessedCount: number;
    scannedPageCount: number;
  };
}

/**
 * Analyzes a PDF document and extracts structured content.
 * 
 * @param input - PDF file path, URL, or Buffer
 * @param options - Analysis options
 * @returns Complete analysis result
 */
export async function analyzePDF(
  input: string | Buffer | ArrayBuffer,
  options: AnalyzeOptions = {}
): Promise<PDFAnalysisResult> {
  // Load PDF
  let pdfData: ArrayBuffer;
  
  if (typeof input === 'string') {
    if (input.startsWith('http://') || input.startsWith('https://')) {
      const response = await fetch(input);
      pdfData = await response.arrayBuffer();
    } else {
      const fs = await import('fs/promises');
      const buffer = await fs.readFile(input);
      pdfData = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
  } else if (Buffer.isBuffer(input)) {
    // Handle Node.js Buffer - create a copy to avoid SharedArrayBuffer issues
    const arr = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) {
      arr[i] = input[i]!;
    }
    pdfData = arr.buffer as ArrayBuffer;
  } else {
    pdfData = input;
  }
  
  const doc = await getDocumentProxy(new Uint8Array(pdfData));
  
  try {
    return await analyzeDocument(doc, options);
  } finally {
    doc.cleanup();
  }
}

/**
 * Analyzes a PDF document proxy.
 */
async function analyzeDocument(
  doc: PDFDocumentProxy,
  options: AnalyzeOptions
): Promise<PDFAnalysisResult> {
  const numPages = doc.numPages;
  const startPage = options.startPage ?? 0;
  const endPage = Math.min(options.endPage ?? numPages - 1, numPages - 1);
  
  // Setup VLM config
  const vlmConfig = createVLMConfig(options.vlmConfig);
  const confidenceThreshold = options.confidenceThreshold ?? vlmConfig.confidenceThreshold;
  const processScannedPages = options.processScannedPages ?? vlmConfig.enabled;
  
  const pages: PageAnalysisResult[] = [];
  const allElements: AnalyzedElement[] = [];
  let vlmProcessedCount = 0;
  let scannedPageCount = 0;
  
  // Process each page
  for (let pageIndex = startPage; pageIndex <= endPage; pageIndex++) {
    const pageResult = await analyzePage(
      doc,
      pageIndex,
      vlmConfig,
      confidenceThreshold,
      processScannedPages
    );
    
    pages.push(pageResult);
    allElements.push(...pageResult.elements);
    
    // Count VLM processed elements
    vlmProcessedCount += pageResult.elements.filter(e => e.vlmProcessed).length;
    
    // Count scanned pages
    if (pageResult.stats.isScanned) {
      scannedPageCount++;
    }
  }
  
  // Calculate document-level statistics
  const elementsByType: Record<string, number> = {};
  let totalConfidence = 0;
  
  for (const element of allElements) {
    elementsByType[element.type] = (elementsByType[element.type] || 0) + 1;
    totalConfidence += element.confidence;
  }
  
  return {
    numPages,
    pages,
    allElements,
    documentStats: {
      totalElements: allElements.length,
      elementsByType,
      averageConfidence: allElements.length > 0 ? totalConfidence / allElements.length : 0,
      vlmProcessedCount,
      scannedPageCount,
    },
  };
}

/**
 * Analyzes a single page.
 */
async function analyzePage(
  doc: PDFDocumentProxy,
  pageIndex: number,
  vlmConfig: VLMConfig,
  confidenceThreshold: number,
  processScannedPages: boolean
): Promise<PageAnalysisResult> {
  // Extract text with position data
  const page = await doc.getPage(pageIndex + 1);
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
  
  const width = viewport.width;
  const height = viewport.height;
  
  // Group into lines
  const lines = groupIntoLines(items);
  
  // Calculate page stats
  const stats = calculatePageStats(pageIndex, items, lines, width, height);
  
  // Check if scanned page
  if (stats.isScanned && processScannedPages && vlmConfig.enabled) {
    // Process entire page with VLM
    const vlmElements = await processScannedPage(doc, pageIndex, vlmConfig);
    return {
      stats,
      elements: vlmElements,
      lowConfidenceElements: [],
    };
  }
  
  // Classify elements
  const elements = classifyPageElements(lines, stats);
  
  // Identify low-confidence elements
  const { highConfidence, lowConfidence } = identifyLowConfidenceElements(
    elements,
    confidenceThreshold
  );
  
  // Smart routing: Use VLM for pages with many low-confidence elements
  const lowConfidenceRatio = elements.length > 0 ? lowConfidence.length / elements.length : 0;
  const useVLMForPage = vlmConfig.enabled && lowConfidenceRatio > 0.3;
  
  let finalElements: AnalyzedElement[];
  
  if (useVLMForPage) {
    // High complexity - let VLM analyze entire page
    // Note: This requires PDF data, which we don't have here yet
    // For now, just mark and continue with TS analysis
    finalElements = elements.map(e => ({ ...e, needsVLMReview: lowConfidenceRatio > 0.3 })) as AnalyzedElement[];
  } else if (lowConfidence.length > 0 && vlmConfig.enabled) {
    const improved = await processLowConfidenceElements(doc, lowConfidence, vlmConfig);
    finalElements = [...highConfidence, ...improved];
  } else {
    finalElements = elements;
  }
  
  return {
    stats,
    elements: finalElements,
    lowConfidenceElements: lowConfidence,
  };
}

/**
 * Quick analysis - extracts structured content without VLM.
 * Faster but may have lower accuracy for complex elements.
 */
export async function quickAnalyzePDF(
  input: string | Buffer | ArrayBuffer,
  options: Omit<AnalyzeOptions, 'vlmConfig'> = {}
): Promise<PDFAnalysisResult> {
  return analyzePDF(input, {
    ...options,
    vlmConfig: { enabled: false },
  });
}

/**
 * Formats analysis result as Markdown.
 */
export function formatAsMarkdown(result: PDFAnalysisResult): string {
  const lines: string[] = [];
  
  for (const page of result.pages) {
    lines.push(`\n---\n## Page ${page.stats.pageIndex + 1}\n`);
    
    for (const element of page.elements) {
      switch (element.type) {
        case 'heading':
          const prefix = '#'.repeat(Math.min(element.level || 1, 6));
          lines.push(`${prefix} ${element.content}\n`);
          break;
          
        case 'paragraph':
          lines.push(`${element.content}\n`);
          break;
          
        case 'formula':
          lines.push(`$$\n${element.content}\n$$\n`);
          break;
          
        case 'code':
          lines.push('```\n' + element.content + '\n```\n');
          break;
          
        case 'table':
          lines.push(`[Table]\n${element.content}\n`);
          break;
          
        case 'image':
          lines.push(`[Figure: ${element.content}]\n`);
          break;
          
        default:
          lines.push(`${element.content}\n`);
      }
    }
  }
  
  return lines.join('\n');
}

/**
 * Extracts only specific element types.
 */
export function filterElements(
  result: PDFAnalysisResult,
  types: AnalyzedElement['type'][]
): AnalyzedElement[] {
  return result.allElements.filter(e => types.includes(e.type));
}

/**
 * Gets document outline (headings hierarchy).
 */
export function getOutline(result: PDFAnalysisResult): {
  level: number;
  content: string;
  pageIndex: number;
}[] {
  return result.allElements
    .filter(e => e.type === 'heading')
    .map(e => ({
      level: e.level || 1,
      content: e.content,
      pageIndex: e.pageIndex,
    }));
}
