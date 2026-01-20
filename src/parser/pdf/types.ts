/**
 * PDF Smart Analyzer - Type Definitions
 * 
 * @module parser/pdf/types
 */

/**
 * Rich text item with position and font information.
 */
export interface RichTextItem {
  /** Text content */
  str: string;
  /** X coordinate (left) */
  x: number;
  /** Y coordinate (baseline, PDF coordinate system - origin at bottom) */
  y: number;
  /** Font size in points */
  fontSize: number;
  /** Font name (may be encoded like "g_d0_f1") */
  fontName: string;
  /** Text width */
  width: number;
  /** Text height */
  height: number;
}

/**
 * A line of text composed of multiple text items.
 */
export interface TextLine {
  /** Text items in this line */
  items: RichTextItem[];
  /** Y coordinate of the line */
  y: number;
  /** Average font size of items in the line */
  avgFontSize: number;
  /** Concatenated text content */
  text: string;
  /** Left margin (minimum x) */
  leftMargin: number;
  /** Right edge (maximum x + width) */
  rightEdge: number;
}

/**
 * Element types that can be detected in a PDF.
 */
export type ElementType = 
  | 'heading'
  | 'paragraph'
  | 'formula'
  | 'code'
  | 'table'
  | 'list'
  | 'image'
  | 'footnote'
  | 'caption';

/**
 * Analysis result for a detected element.
 */
export interface AnalyzedElement {
  /** Element type */
  type: ElementType;
  /** Text content */
  content: string;
  /** Detection confidence (0-1) */
  confidence: number;
  /** Page index (0-based) */
  pageIndex: number;
  /** Heading level (1-6) for headings */
  level?: number;
  /** Number of columns for tables */
  columns?: number;
  /** Bounding box */
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** Original text items for VLM fallback */
  rawItems?: RichTextItem[];
  /** Whether VLM fallback was used */
  vlmProcessed?: boolean;
}

/**
 * Page statistics for analysis decisions.
 */
export interface PageStats {
  /** Page index */
  pageIndex: number;
  /** Page width in points */
  width: number;
  /** Page height in points */
  height: number;
  /** Number of text items */
  itemCount: number;
  /** Number of detected lines */
  lineCount: number;
  /** Median font size (body text) */
  medianFontSize: number;
  /** Text density (items per square point) */
  textDensity: number;
  /** Whether this appears to be a scanned page */
  isScanned: boolean;
  /** Detected column count */
  columnCount: number;
}

/**
 * Complete analysis result for a page.
 */
export interface PageAnalysisResult {
  /** Page statistics */
  stats: PageStats;
  /** Detected elements */
  elements: AnalyzedElement[];
  /** Elements that need VLM fallback */
  lowConfidenceElements: AnalyzedElement[];
}

/**
 * VLM configuration for fallback processing.
 */
export interface VLMConfig {
  /** API base URL */
  apiBase: string;
  /** API key */
  apiKey: string;
  /** Model name */
  model: string;
  /** Maximum tokens for response */
  maxTokens: number;
  /** Whether VLM fallback is enabled */
  enabled: boolean;
  /** Confidence threshold for triggering VLM */
  confidenceThreshold: number;
}

/**
 * VLM task types.
 */
export type VLMTaskType = 'formula' | 'table' | 'code' | 'image' | 'fullPage';

/**
 * VLM task for processing.
 */
export interface VLMTask {
  /** Task type */
  type: VLMTaskType;
  /** Page index */
  pageIndex: number;
  /** Element to process */
  element?: AnalyzedElement;
  /** Region bounds for partial page rendering */
  bounds?: { x: number; y: number; width: number; height: number };
}

/**
 * Math font patterns for formula detection.
 */
export const MATH_FONT_PATTERNS = [
  'cmmi', 'cmsy', 'cmex', 'cmtt', 'cmr',  // Computer Modern (LaTeX)
  'math', 'stix', 'symbol',                 // Common math fonts
  'cambria', 'mt extra',                    // Microsoft
];

/**
 * Math Unicode ranges for formula detection.
 */
export const MATH_UNICODE_RANGES: [number, number][] = [
  [0x0370, 0x03FF],   // Greek letters
  [0x2200, 0x22FF],   // Mathematical Operators
  [0x2A00, 0x2AFF],   // Supplemental Mathematical Operators
  [0x1D400, 0x1D7FF], // Mathematical Alphanumeric Symbols
  [0x2070, 0x209F],   // Superscripts and Subscripts
  [0x00B2, 0x00B3],   // ² ³
  [0x2080, 0x208F],   // Subscripts
];

/**
 * Monospace font patterns for code detection.
 */
export const MONOSPACE_FONT_PATTERNS = [
  'courier', 'consolas', 'monaco', 'menlo',
  'source code', 'fira code', 'jetbrains',
  'liberation mono', 'dejavu sans mono',
  'monospace', 'mono',
];

/**
 * Code keywords for code block detection.
 */
export const CODE_KEYWORDS = [
  'if', 'else', 'for', 'while', 'return', 'def', 'class', 'function',
  'import', 'from', 'const', 'let', 'var', 'async', 'await', 'try',
  'catch', 'finally', 'throw', 'new', 'this', 'self', 'public', 'private',
  'static', 'void', 'int', 'string', 'bool', 'float', 'double',
];
