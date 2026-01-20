/**
 * PDF Element Classifier
 * 
 * Classifies text lines into semantic elements like headings, formulas, code blocks, etc.
 * Uses heuristics based on font size, position, and text patterns.
 * 
 * @module parser/pdf/element-classifier
 */

import type { TextLine, PageStats, AnalyzedElement, RichTextItem } from './types.js';
import { 
  MATH_UNICODE_RANGES, 
  MATH_FONT_PATTERNS, 
  MONOSPACE_FONT_PATTERNS, 
  CODE_KEYWORDS 
} from './types.js';

/**
 * Classifies all lines in a page into semantic elements.
 * 
 * @param lines - Text lines from the page
 * @param stats - Page statistics
 * @returns Array of analyzed elements
 */
export function classifyPageElements(
  lines: TextLine[],
  stats: PageStats
): AnalyzedElement[] {
  const elements: AnalyzedElement[] = [];
  let i = 0;
  
  while (i < lines.length) {
    const line = lines[i];
    if (!line) {
      i++;
      continue;
    }
    
    // Try to classify each line
    const heading = detectHeading(line, stats);
    if (heading) {
      elements.push(heading);
      i++;
      continue;
    }
    
    // Try to detect multi-line elements (code blocks, formulas, tables)
    const codeBlock = detectCodeBlock(lines, i, stats);
    if (codeBlock) {
      elements.push(codeBlock.element);
      i = codeBlock.endIndex + 1;
      continue;
    }
    
    const formula = detectFormula(lines, i, stats);
    if (formula) {
      elements.push(formula.element);
      i = formula.endIndex + 1;
      continue;
    }
    
    const table = detectTable(lines, i, stats);
    if (table) {
      elements.push(table.element);
      i = table.endIndex + 1;
      continue;
    }
    
    // Default: paragraph
    elements.push({
      type: 'paragraph',
      content: line.text,
      confidence: 1.0,
      pageIndex: stats.pageIndex,
    });
    i++;
  }
  
  return elements;
}

/**
 * Detects if a line is a heading based on font size and text patterns.
 */
export function detectHeading(
  line: TextLine,
  stats: PageStats
): AnalyzedElement | null {
  const fontRatio = line.avgFontSize / stats.medianFontSize;
  const text = line.text.trim();
  
  // Skip very short lines unless they're numbered sections
  if (text.length < 2) return null;
  
  // Skip lines that look like math formulas (start with math symbols or greek letters)
  const mathStartPattern = /^[∑∏∫∂∇∈∉∋∀∃∄∅∆≠≈≤≥≡→←↔⊂⊃⊆⊇∩∪⊕⊗λπσμαβγδεθω∞𝜋𝜗𝜑𝜓𝑝𝑟𝑠𝑡𝑎𝑏]/;
  if (mathStartPattern.test(text)) return null;
  
  // Skip lines that are primarily symbols/numbers (likely formulas or figure references)
  const alphaCount = (text.match(/[a-zA-Z]/g) || []).length;
  if (alphaCount < text.length * 0.3 && text.length > 5) return null;
  
  // Skip very long lines (likely paragraphs, not headings)
  if (text.length > 100) return null;
  
  // Pattern: numbered section like "1. Introduction", "2.1 Methods", or "1 Introduction"
  const numberedWithDot = /^(\d+\.)+\s*\d*\s+[A-Z]/;  // 1. or 1.1 or 1.1.1
  // "1 Introduction" - single/double digit, not year (1000-2099), short title
  const numberedNoDot = /^[1-9]\d?\s+[A-Z][a-z]/;
  const isYear = /^(1\d{3}|20\d{2})\s/.test(text);  // 1000-2099 likely a year
  const isNumberedSection = numberedWithDot.test(text) || (numberedNoDot.test(text) && !isYear && text.length < 50);
  
  // Pattern: uppercase title
  const isUpperCase = text === text.toUpperCase() && text.length > 3;
  
  // Detect heading level
  let level: number | null = null;
  let confidence = 0;
  
  if (fontRatio > 1.8) {
    // Large font - likely main title (H1)
    level = 1;
    confidence = 0.9;
  } else if (fontRatio > 1.4) {
    // Medium-large font - section heading
    level = 1;
    confidence = 0.85;
  } else if (isNumberedSection) {
    // Numbered section is strong indicator
    // Check if it starts with a top-level number pattern like "1." or "1 "
    if (/^\d+[.\s]\s*[A-Z]/.test(text) && !/^\d+\.\d/.test(text)) {
      level = 1;  // Top-level numbered section (1. or 1 )
    } else {
      level = 2;  // Sub-section (1.1, 2.3.1, etc.)
    }
    confidence = 0.95;
  } else if (fontRatio > 1.25 && text.length < 60) {
    // Moderately larger font + short line = likely heading
    level = 2;
    confidence = 0.75;
  } else if (isUpperCase && fontRatio >= 1.0 && text.length < 50) {
    // Uppercase at normal size could be heading (but short)
    level = 2;
    confidence = 0.6;
  }
  
  if (level !== null) {
    // Boost confidence for numbered sections
    if (isNumberedSection) {
      confidence = Math.min(confidence + 0.1, 1.0);
    }
    
    return {
      type: 'heading',
      content: text,
      confidence,
      pageIndex: stats.pageIndex,
      level,
    };
  }
  
  return null;
}

/**
 * Detects if lines starting at index form a formula/equation.
 * Uses math Unicode detection and font analysis.
 */
export function detectFormula(
  lines: TextLine[],
  startIndex: number,
  stats: PageStats
): { element: AnalyzedElement; endIndex: number } | null {
  const line = lines[startIndex];
  if (!line) return null;
  const text = line.text;
  
  // Skip if line is too long (likely prose with math)
  if (text.length > 100) return null;
  
  // Skip short lines that look like superscript references (e.g., "1∗ 2 2 2")
  const superscriptPattern = /^[\d\s∗\*†‡§¶]+$/;
  if (superscriptPattern.test(text) && text.length < 20) return null;
  
  // Skip single characters that might be bullet points
  if (text.length <= 2) return null;
  
  // Skip author names with asterisks (e.g., "John Smith∗ Jane Doe∗")
  const authorPattern = /^[A-Z][a-z]+\s+[A-Z][a-z]+[∗\*†‡]/;
  if (authorPattern.test(text) && text.split(/[∗\*†‡]/).length >= 2) return null;
  
  // Count math indicators
  let mathScore = 0;
  const reasons: string[] = [];
  
  // Check for math Unicode characters
  const mathUnicodeCount = countMathUnicode(text);
  if (mathUnicodeCount >= 2) {
    mathScore += 30;
    reasons.push(`math-unicode:${mathUnicodeCount}`);
  }
  
  // Check for common math symbols
  const mathSymbols = /[∑∏∫∂∇∈∉∋∀∃∄∅∆≠≈≤≥≡→←↔⊂⊃⊆⊇∩∪⊕⊗λπσμαβγδεθω∞]/g;
  const symbolMatches = text.match(mathSymbols);
  if (symbolMatches && symbolMatches.length >= 1) {
    mathScore += 20 * symbolMatches.length;
    reasons.push(`symbols:${symbolMatches.length}`);
  }
  
  // Check for equation patterns
  const equationPattern = /[a-zA-Z]\s*=|=\s*[a-zA-Z\d]|[a-zA-Z]\([^)]+\)|log|exp|sin|cos|tan|max|min|argmax|argmin|lim|sup|inf/;
  if (equationPattern.test(text)) {
    mathScore += 15;
    reasons.push('equation-pattern');
  }
  
  // Check for centered alignment (common for display math)
  const pageCenter = stats.width / 2;
  const lineCenter = (line.leftMargin + line.rightEdge) / 2;
  const isCentered = Math.abs(lineCenter - pageCenter) < stats.width * 0.15;
  if (isCentered) {
    mathScore += 10;
    reasons.push('centered');
  }
  
  // Check font for math fonts
  const hasMathFont = line.items.some(item => 
    MATH_FONT_PATTERNS.some(p => item.fontName.toLowerCase().includes(p))
  );
  if (hasMathFont) {
    mathScore += 25;
    reasons.push('math-font');
  }
  
  // Check for fraction patterns
  const fractionPattern = /\d+\s*\/\s*\d+|\d+[⁄∕]\d+/;
  if (fractionPattern.test(text)) {
    mathScore += 10;
    reasons.push('fraction');
  }
  
  // Equation numbering like (1), (2.1), etc.
  const eqNumbering = /\(\d+(\.\d+)?\)\s*$/;
  if (eqNumbering.test(text)) {
    mathScore += 20;
    reasons.push('eq-number');
  }
  
  // Determine if it's a formula
  if (mathScore >= 40) {
    const confidence = Math.min(mathScore / 100, 0.95);
    
    // Try to find continuation lines (multi-line formulas)
    let endIndex = startIndex;
    for (let j = startIndex + 1; j < lines.length && j < startIndex + 5; j++) {
      const nextLine = lines[j];
      if (!nextLine) break;
      const nextMathScore = calculateMathScore(nextLine.text, nextLine.items);
      
      // Check if continuation (indented or has alignment)
      const yGap = Math.abs(line.y - nextLine.y);
      if (nextMathScore >= 30 && yGap < stats.medianFontSize * 3) {
        endIndex = j;
      } else {
        break;
      }
    }
    
    // Gather content
    const content = lines
      .slice(startIndex, endIndex + 1)
      .map(l => l.text)
      .join(' ');
    
    return {
      element: {
        type: 'formula',
        content,
        confidence,
        pageIndex: stats.pageIndex,
      },
      endIndex,
    };
  }
  
  return null;
}

/**
 * Helper to calculate math score for a line.
 */
function calculateMathScore(text: string, items: RichTextItem[]): number {
  let score = 0;
  
  const mathUnicodeCount = countMathUnicode(text);
  if (mathUnicodeCount >= 2) score += 30;
  
  const mathSymbols = /[∑∏∫∂∇∈∉∋∀∃∄∅∆≠≈≤≥≡→←↔⊂⊃⊆⊇∩∪⊕⊗λπσμαβγδεθω∞]/g;
  const symbolMatches = text.match(mathSymbols);
  if (symbolMatches) score += 20 * symbolMatches.length;
  
  const hasMathFont = items.some(item => 
    MATH_FONT_PATTERNS.some(p => item.fontName.toLowerCase().includes(p))
  );
  if (hasMathFont) score += 25;
  
  return score;
}

/**
 * Counts characters in mathematical Unicode ranges.
 */
function countMathUnicode(text: string): number {
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    for (const [start, end] of MATH_UNICODE_RANGES) {
      if (code >= start && code <= end) {
        count++;
        break;
      }
    }
  }
  return count;
}

/**
 * Detects if lines starting at index form a code block.
 */
export function detectCodeBlock(
  lines: TextLine[],
  startIndex: number,
  stats: PageStats
): { element: AnalyzedElement; endIndex: number } | null {
  const line = lines[startIndex];
  if (!line) return null;
  const text = line.text;
  
  // Skip very short lines
  if (text.length < 5) return null;
  
  // Calculate code score
  let codeScore = 0;
  const reasons: string[] = [];
  
  // Check for monospace font
  const hasMonospaceFont = line.items.some(item =>
    MONOSPACE_FONT_PATTERNS.some(p => item.fontName.toLowerCase().includes(p))
  );
  if (hasMonospaceFont) {
    codeScore += 40;
    reasons.push('monospace-font');
  }
  
  // Check for code-like characters
  const codeChars = /[{}()\[\];:=<>]/g;
  const codeCharMatches = text.match(codeChars);
  if (codeCharMatches && codeCharMatches.length >= 3) {
    codeScore += 20;
    reasons.push(`code-chars:${codeCharMatches.length}`);
  }
  
  // Check for programming keywords
  const words = text.split(/\s+/);
  const keywordMatches = words.filter(w => 
    CODE_KEYWORDS.includes(w.toLowerCase())
  );
  if (keywordMatches.length >= 1) {
    codeScore += 15 * keywordMatches.length;
    reasons.push(`keywords:${keywordMatches.join(',')}`);
  }
  
  // Check for function call patterns: name(...)
  const funcCallPattern = /\w+\s*\([^)]*\)/;
  if (funcCallPattern.test(text)) {
    codeScore += 10;
    reasons.push('func-call');
  }
  
  // Check for assignment patterns
  const assignPattern = /\w+\s*[:=]\s*[^=]/;
  if (assignPattern.test(text) && !text.includes('http')) {
    codeScore += 10;
    reasons.push('assignment');
  }
  
  // Check for string literals
  const stringLiterals = /["'][^"']{2,}["']/;
  if (stringLiterals.test(text)) {
    codeScore += 10;
    reasons.push('string-literal');
  }
  
  // Indentation check
  const leadingSpaces = text.match(/^\s+/)?.[0].length || 0;
  if (leadingSpaces >= 4) {
    codeScore += 10;
    reasons.push('indented');
  }
  
  // Must have strong code indicators to avoid false positives
  if (codeScore >= 50 && (hasMonospaceFont || keywordMatches.length >= 2 || (codeCharMatches?.length ?? 0) >= 5)) {
    // Find continuation lines
    let endIndex = startIndex;
    
    for (let j = startIndex + 1; j < lines.length && j < startIndex + 50; j++) {
      const nextLine = lines[j];
      if (!nextLine) break;
      const nextScore = calculateCodeScore(nextLine.text, nextLine.items);
      
      // Check if likely continuation
      if (nextScore >= 30 || 
          nextLine.items.some(i => MONOSPACE_FONT_PATTERNS.some(p => i.fontName.toLowerCase().includes(p)))) {
        endIndex = j;
      } else {
        // Allow one non-code line gap
        if (j + 1 < lines.length) {
          const afterNext = lines[j + 1];
          if (!afterNext) break;
          const afterScore = calculateCodeScore(afterNext.text, afterNext.items);
          if (afterScore >= 40) {
            endIndex = j + 1;
            continue;
          }
        }
        break;
      }
    }
    
    // Gather content
    const content = lines
      .slice(startIndex, endIndex + 1)
      .map(l => l.text)
      .join('\n');
    
    const confidence = Math.min(codeScore / 100, 0.9);
    
    return {
      element: {
        type: 'code',
        content,
        confidence,
        pageIndex: stats.pageIndex,
      },
      endIndex,
    };
  }
  
  return null;
}

/**
 * Helper to calculate code score.
 */
function calculateCodeScore(text: string, items: RichTextItem[]): number {
  let score = 0;
  
  const hasMonospaceFont = items.some(item =>
    MONOSPACE_FONT_PATTERNS.some(p => item.fontName.toLowerCase().includes(p))
  );
  if (hasMonospaceFont) score += 40;
  
  const codeChars = /[{}()\[\];:=<>]/g;
  const codeCharMatches = text.match(codeChars);
  if (codeCharMatches && codeCharMatches.length >= 3) score += 20;
  
  const words = text.split(/\s+/);
  const keywordMatches = words.filter(w => CODE_KEYWORDS.includes(w.toLowerCase()));
  score += 15 * keywordMatches.length;
  
  return score;
}

/**
 * Detects if lines starting at index form a table.
 * Uses column alignment detection.
 */
export function detectTable(
  lines: TextLine[],
  startIndex: number,
  stats: PageStats
): { element: AnalyzedElement; endIndex: number } | null {
  const line = lines[startIndex];
  if (!line) return null;
  
  // Tables usually have multiple columns with consistent spacing
  // Check if this line has multiple "cells" (text clusters)
  const cells = detectTableCells(line);
  
  if (cells.length < 2) return null;
  
  // Check if following lines have similar structure
  let tableLines = [line];
  let endIndex = startIndex;
  
  for (let j = startIndex + 1; j < lines.length && j < startIndex + 30; j++) {
    const nextLine = lines[j];
    if (!nextLine) break;
    const nextCells = detectTableCells(nextLine);
    
    // Similar column count suggests table continuation
    if (Math.abs(nextCells.length - cells.length) <= 1 && nextCells.length >= 2) {
      tableLines.push(nextLine);
      endIndex = j;
    } else {
      // Allow one gap for table separators
      if (j + 1 < lines.length) {
        const afterNext = lines[j + 1];
        if (!afterNext) break;
        const afterCells = detectTableCells(afterNext);
        if (Math.abs(afterCells.length - cells.length) <= 1 && afterCells.length >= 2) {
          tableLines.push(afterNext);
          endIndex = j + 1;
          continue;
        }
      }
      break;
    }
  }
  
  // Need at least 2 rows to consider it a table
  if (tableLines.length < 2) return null;
  
  const content = tableLines.map(l => l.text).join('\n');
  const confidence = Math.min(0.6 + (tableLines.length * 0.05), 0.85);
  
  return {
    element: {
      type: 'table',
      content,
      confidence,
      pageIndex: stats.pageIndex,
      columns: cells.length,
    },
    endIndex,
  };
}

/**
 * Detects table cells in a line based on spacing.
 */
function detectTableCells(line: TextLine): { x: number; text: string }[] {
  const cells: { x: number; text: string }[] = [];
  
  if (line.items.length === 0) return cells;
  
  const firstItem = line.items[0];
  if (!firstItem) return cells;
  
  const avgFontSize = line.avgFontSize;
  const gapThreshold = avgFontSize * 2; // Large gap suggests column separation
  
  let currentCell = { x: firstItem.x, text: firstItem.str };
  let prevEnd = firstItem.x + firstItem.width;
  
  for (let i = 1; i < line.items.length; i++) {
    const item = line.items[i];
    if (!item) continue;
    const gap = item.x - prevEnd;
    
    if (gap > gapThreshold) {
      // New cell
      cells.push({ ...currentCell, text: currentCell.text.trim() });
      currentCell = { x: item.x, text: item.str };
    } else {
      // Continue current cell
      currentCell.text += (gap > avgFontSize * 0.3 ? ' ' : '') + item.str;
    }
    
    prevEnd = item.x + item.width;
  }
  
  cells.push({ ...currentCell, text: currentCell.text.trim() });
  
  return cells.filter(c => c.text.length > 0);
}

/**
 * Filter elements and identify low-confidence ones for VLM fallback.
 */
export function identifyLowConfidenceElements(
  elements: AnalyzedElement[],
  threshold: number = 0.7
): { highConfidence: AnalyzedElement[]; lowConfidence: AnalyzedElement[] } {
  const highConfidence: AnalyzedElement[] = [];
  const lowConfidence: AnalyzedElement[] = [];
  
  for (const element of elements) {
    // Paragraphs are always high confidence
    if (element.type === 'paragraph') {
      highConfidence.push(element);
    } else if (element.confidence >= threshold) {
      highConfidence.push(element);
    } else {
      lowConfidence.push(element);
    }
  }
  
  return { highConfidence, lowConfidence };
}
