/**
 * PDF Text Extractor
 * 
 * Extracts rich text items with position and font information from PDF pages.
 * Uses unpdf's getTextContent() for detailed text extraction.
 * 
 * @module parser/pdf/text-extractor
 */

import type { RichTextItem, TextLine, PageStats } from './types.js';

/**
 * Type for PDF document proxy returned by unpdf's getDocumentProxy.
 */
export type PDFDocumentProxy = Awaited<ReturnType<typeof import('unpdf').getDocumentProxy>>;

/**
 * Extracts rich text items from a PDF page.
 * 
 * @param doc - PDF document proxy from unpdf
 * @param pageIndex - 0-based page index
 * @returns Array of rich text items with position data
 */
export async function extractPageText(
  doc: PDFDocumentProxy,
  pageIndex: number
): Promise<{ items: RichTextItem[]; width: number; height: number }> {
  const page = await doc.getPage(pageIndex + 1); // 1-based in pdfjs
  const viewport = page.getViewport({ scale: 1.0 });
  const textContent = await page.getTextContent();
  
  const items: RichTextItem[] = [];
  
  for (const item of textContent.items) {
    // Skip empty items or markers
    if (!('str' in item)) continue;
    
    const textItem = item as { 
      str: string; 
      transform: number[]; 
      fontName?: string; 
      width?: number; 
      height?: number;
    };
    
    if (!textItem.str.trim()) continue;
    
    const transform = textItem.transform;
    
    // Extract position from transform matrix [scaleX, skewX, skewY, scaleY, x, y]
    const x = transform[4] ?? 0;
    const y = transform[5] ?? 0;
    const fontSize = Math.abs(transform[0] ?? 0) || Math.abs(transform[3] ?? 0) || 10;
    
    items.push({
      str: textItem.str,
      x,
      y,
      fontSize,
      fontName: textItem.fontName ?? '',
      width: textItem.width ?? 0,
      height: textItem.height ?? fontSize,
    });
  }
  
  return {
    items,
    width: viewport.width,
    height: viewport.height,
  };
}

/**
 * Groups text items into lines based on Y coordinate clustering.
 * Items within threshold of each other vertically are considered same line.
 * 
 * @param items - Rich text items
 * @param threshold - Y tolerance for line grouping (default: auto-calculated)
 * @returns Array of text lines
 */
export function groupIntoLines(
  items: RichTextItem[],
  threshold?: number
): TextLine[] {
  if (items.length === 0) return [];
  
  // Sort by Y descending (PDF coords: bottom = 0), then X ascending
  const sorted = [...items].sort((a, b) => {
    if (Math.abs(a.y - b.y) < 2) return a.x - b.x;
    return b.y - a.y;
  });
  
  // Calculate threshold based on median font size if not provided
  if (!threshold) {
    const fontSizes = sorted.map(i => i.fontSize).sort((a, b) => a - b);
    const medianFontSize = fontSizes[Math.floor(fontSizes.length / 2)] || 10;
    threshold = medianFontSize * 0.5;
  }
  
  const lines: TextLine[] = [];
  const firstItem = sorted[0];
  if (!firstItem) return [];
  
  let currentLine: RichTextItem[] = [firstItem];
  let currentY = firstItem.y;
  
  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];
    if (!item) continue;
    
    if (Math.abs(item.y - currentY) <= threshold) {
      currentLine.push(item);
    } else {
      // Finish current line
      if (currentLine.length > 0) {
        lines.push(createTextLine(currentLine));
      }
      currentLine = [item];
      currentY = item.y;
    }
  }
  
  // Don't forget the last line
  if (currentLine.length > 0) {
    lines.push(createTextLine(currentLine));
  }
  
  return lines;
}

/**
 * Creates a TextLine from an array of items on the same line.
 */
function createTextLine(items: RichTextItem[]): TextLine {
  // Sort items by x position
  const sorted = [...items].sort((a, b) => a.x - b.x);
  
  // Calculate average font size
  const avgFontSize = sorted.reduce((sum, i) => sum + i.fontSize, 0) / sorted.length;
  
  // Concatenate text with intelligent spacing
  let text = '';
  let prevEnd = 0;
  
  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i];
    if (!item) continue;
    
    // Add space if there's a gap
    if (i > 0) {
      const gap = item.x - prevEnd;
      if (gap > avgFontSize * 0.3) {
        text += ' ';
      }
    }
    
    text += item.str;
    prevEnd = item.x + item.width;
  }
  
  const firstSorted = sorted[0];
  return {
    items: sorted,
    y: firstSorted?.y ?? 0,
    avgFontSize,
    text: text.trim(),
    leftMargin: Math.min(...sorted.map(i => i.x)),
    rightEdge: Math.max(...sorted.map(i => i.x + i.width)),
  };
}

/**
 * Calculates page statistics for analysis decisions.
 */
export function calculatePageStats(
  pageIndex: number,
  items: RichTextItem[],
  lines: TextLine[],
  width: number,
  height: number
): PageStats {
  // Calculate median font size
  const fontSizes = items.map(i => i.fontSize).sort((a, b) => a - b);
  const medianFontSize = fontSizes.length > 0 
    ? (fontSizes[Math.floor(fontSizes.length / 2)] ?? 10)
    : 10;
  
  // Detect if page is likely scanned (very few text items)
  const isScanned = items.length < 10;
  
  // Simple column detection based on x-coordinate clustering
  const xCoords = lines.map(l => l.leftMargin);
  const columnCount = detectColumnCount(xCoords, width);
  
  return {
    pageIndex,
    width,
    height,
    itemCount: items.length,
    lineCount: lines.length,
    medianFontSize,
    textDensity: items.length / (width * height),
    isScanned,
    columnCount,
  };
}

/**
 * Detects the number of text columns based on x-coordinate distribution.
 */
function detectColumnCount(xCoords: number[], pageWidth: number): number {
  if (xCoords.length < 5) return 1;
  
  // Simple heuristic: check for bimodal distribution
  const sorted = [...xCoords].sort((a, b) => a - b);
  const midPoint = pageWidth / 2;
  
  const leftCount = sorted.filter(x => x < midPoint - 50).length;
  const rightCount = sorted.filter(x => x > midPoint + 50).length;
  
  // If both sides have significant text, likely 2 columns
  const total = xCoords.length;
  if (leftCount > total * 0.3 && rightCount > total * 0.3) {
    return 2;
  }
  
  return 1;
}

/**
 * Extracts all text from a PDF document with rich information.
 * 
 * @param doc - PDF document proxy
 * @param options - Extraction options
 * @returns Array of page data with items, lines, and stats
 */
export async function extractAllPages(
  doc: PDFDocumentProxy,
  options: {
    startPage?: number;
    endPage?: number;
    lineThreshold?: number;
  } = {}
): Promise<{
  pageIndex: number;
  items: RichTextItem[];
  lines: TextLine[];
  stats: PageStats;
}[]> {
  const numPages = doc.numPages;
  const startPage = options.startPage ?? 0;
  const endPage = Math.min(options.endPage ?? numPages - 1, numPages - 1);
  
  const results: {
    pageIndex: number;
    items: RichTextItem[];
    lines: TextLine[];
    stats: PageStats;
  }[] = [];
  
  for (let i = startPage; i <= endPage; i++) {
    const { items, width, height } = await extractPageText(doc, i);
    const lines = groupIntoLines(items, options.lineThreshold);
    const stats = calculatePageStats(i, items, lines, width, height);
    
    results.push({
      pageIndex: i,
      items,
      lines,
      stats,
    });
  }
  
  return results;
}
