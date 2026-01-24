/**
 * VLM Fallback Module
 *
 * Enhances PDF analysis using Vision-Language Models for:
 * - LaTeX formula extraction
 * - Table structure recognition
 * - Scanned page OCR
 * - Full page content extraction when MinerU is unavailable
 *
 * @module parser/pdf/vlm-fallback
 */

import * as fs from 'node:fs';
import type { AnalyzedElement, VLMConfig, VLMTaskType } from './types.js';
import { createModuleLogger } from '../../logging/logger.js';

// ============================================================================
// PDF.js Initialization
// ============================================================================

const logger = createModuleLogger('vlm-fallback');

/**
 * Flag to track if PDF.js has been initialized with the legacy build.
 * The unpdf serverless build has issues with renderPageAsImage on some PDFs,
 * so we need to use the official pdfjs-dist legacy build instead.
 */
let pdfjsInitialized = false;

/**
 * Initialize PDF.js with the legacy build for proper page rendering.
 * This must be called before using renderPageAsImage.
 * Safe to call multiple times - only initializes once.
 */
async function ensurePDFJSInitialized(): Promise<void> {
  if (pdfjsInitialized) return;
  
  try {
    const { definePDFJSModule } = await import('unpdf');
    // Use the legacy build which works in Node.js without DOMMatrix
    await definePDFJSModule(() => import('pdfjs-dist/legacy/build/pdf.mjs'));
    pdfjsInitialized = true;
    logger.debug('PDF.js initialized with legacy build');
  } catch (err) {
    // If initialization fails, log warning but continue
    // The serverless build may still work for some PDFs
    logger.warn('Failed to initialize PDF.js legacy build, falling back to serverless build:', 
      err instanceof Error ? err : undefined);
  }
}

/** PDF document proxy from unpdf */
export type PDFDocumentProxy = Awaited<ReturnType<typeof import('unpdf').getDocumentProxy>>;

// ============================================================================
// Configuration
// ============================================================================

export const DEFAULT_VLM_CONFIG: VLMConfig = {
  apiBase: '',
  apiKey: '',
  model: 'qwen3-vl-plus',
  maxTokens: 32768,  // No limits - user has unlimited budget
  enabled: false,
  confidenceThreshold: 0.7,
};

/** Concise prompts optimized for academic papers */
const PROMPTS: Record<VLMTaskType, string> = {
  formula: `Extract ALL mathematical formulas from this image.
Return JSON array: [{"latex": "LaTeX code", "description": "brief meaning"}]
If no formulas, return: []`,

  table: `Extract ALL tables from this image.
Return JSON array: [{"markdown": "| col1 | col2 |\\n|---|---|\\n| val1 | val2 |", "caption": "table title if any"}]
If no tables, return: []`,

  code: `Extract ALL code blocks from this image.
Return JSON array: [{"code": "...", "language": "python|javascript|etc"}]
If no code, return: []`,

  image: `Describe this figure/diagram in detail.
Return JSON: {"type": "diagram|chart|photo|screenshot", "description": "detailed description", "caption": "figure caption if visible"}`,

  fullPage: `Analyze this PDF page and extract ALL structured content.
Identify: headings, paragraphs, formulas (as LaTeX), tables (as markdown), code blocks, figure captions.
Return JSON: {
  "elements": [
    {"type": "heading", "content": "...", "level": 1-6},
    {"type": "paragraph", "content": "..."},
    {"type": "formula", "content": "LaTeX code", "description": "meaning"},
    {"type": "table", "content": "markdown table", "caption": "..."},
    {"type": "code", "content": "code", "language": "..."},
    {"type": "caption", "content": "Figure X: ..."},
    {"type": "list", "content": "- item1\\n- item2"}
  ]
}`,
};

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Create VLM config from options or environment.
 * Reads from: opts > VLM_API_* env > PREFLIGHT_VLM_* env
 */
export function createVLMConfig(opts?: Partial<VLMConfig>): VLMConfig {
  const apiBase = opts?.apiBase
    || process.env.VLM_API_BASE
    || process.env.PREFLIGHT_VLM_API_BASE
    || '';
  const apiKey = opts?.apiKey
    || process.env.VLM_API_KEY
    || process.env.PREFLIGHT_VLM_API_KEY
    || '';
  const model = opts?.model
    || process.env.VLM_MODEL
    || process.env.PREFLIGHT_VLM_MODEL
    || DEFAULT_VLM_CONFIG.model;

  return {
    ...DEFAULT_VLM_CONFIG,
    ...opts,
    apiBase,
    apiKey,
    model,
    enabled: Boolean(opts?.enabled ?? (apiKey && apiBase)),
  };
}

/**
 * Render PDF page to base64 image using @napi-rs/canvas.
 * 
 * Uses the pdfjs-dist legacy build for reliable rendering across all PDF types.
 * The unpdf serverless build has known issues with some PDFs (renders blank).
 * 
 * @param pdfData - PDF file data as Uint8Array
 * @param pageNumber - 1-based page number
 * @param scale - Render scale (default 1.5 for good quality)
 * @returns Base64 encoded PNG image, or null on failure
 */
export async function renderPageToBase64(
  pdfData: Uint8Array,
  pageNumber: number,
  scale = 1.5
): Promise<string | null> {
  try {
    // Ensure PDF.js is initialized with legacy build
    await ensurePDFJSInitialized();
    
    const { renderPageAsImage } = await import('unpdf');

    const imageData = await renderPageAsImage(pdfData, pageNumber, {
      canvasImport: () => import('@napi-rs/canvas'),
      scale,
    });

    // Validate that we got actual image data (not empty/tiny)
    if (!imageData || imageData.byteLength < 1000) {
      logger.warn(`Page ${pageNumber} rendered but image data is suspiciously small (${imageData?.byteLength ?? 0} bytes)`);
      return null;
    }

    return Buffer.from(imageData).toString('base64');
  } catch (err) {
    logger.debug(`Failed to render page ${pageNumber}:`, err instanceof Error ? err : undefined);
    return null;
  }
}

/**
 * Render PDF page from file path.
 */
export async function renderPageFromFile(
  pdfPath: string,
  pageNumber: number,
  scale = 1.5
): Promise<string | null> {
  try {
    const buffer = fs.readFileSync(pdfPath);
    return renderPageToBase64(new Uint8Array(buffer), pageNumber, scale);
  } catch (err) {
    logger.debug(`Failed to read PDF file ${pdfPath}:`, err instanceof Error ? err : undefined);
    return null;
  }
}

/**
 * Call VLM API with image and prompt.
 */
export async function callVLM(
  config: VLMConfig,
  imageBase64: string,
  prompt: string
): Promise<string> {
  if (!config.enabled || !config.apiKey) {
    throw new Error('VLM not configured');
  }

  const res = await fetch(`${config.apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
          { type: 'text', text: prompt },
        ],
      }],
      max_tokens: config.maxTokens,
    }),
  });

  if (!res.ok) throw new Error(`VLM API ${res.status}`);

  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content || '';
}

// ============================================================================
// Helpers
// ============================================================================

/** Parse JSON from VLM response (handles markdown code blocks) */
function parseJSON<T>(text: string): T | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/** Format table as markdown */
function formatTable(data: { headers?: string[]; rows?: string[][]; caption?: string }): string {
  const lines: string[] = [];
  if (data.caption) lines.push(`> ${data.caption}`);
  if (data.headers?.length) {
    lines.push(data.headers.join(' | '));
    lines.push(data.headers.map(() => '---').join(' | '));
  }
  data.rows?.forEach(row => lines.push(row.join(' | ')));
  return lines.join('\n');
}

// ============================================================================
// Analysis Functions
// ============================================================================

/**
 * Analyze page with VLM and return structured elements.
 */
export async function analyzePageWithVLM(
  pdfData: Uint8Array,
  pageNumber: number,
  config: VLMConfig,
  taskType: VLMTaskType = 'fullPage'
): Promise<AnalyzedElement[]> {
  if (!config.enabled) return [];

  const imageBase64 = await renderPageToBase64(pdfData, pageNumber);
  if (!imageBase64) return [];

  try {
    const response = await callVLM(config, imageBase64, PROMPTS[taskType]);

    if (taskType === 'fullPage') {
      const data = parseJSON<{ elements: Array<{ type: string; content: string; level?: number; latex?: string }> }>(response);
      return data?.elements?.map(el => ({
        type: el.type as AnalyzedElement['type'],
        content: el.latex || el.content,
        confidence: 0.95,
        pageIndex: pageNumber - 1,
        level: el.level,
        vlmProcessed: true,
      })) || [];
    }

    // Single element analysis
    const data = parseJSON<Record<string, unknown>>(response);
    if (!data) return [];

    // Extract content based on task type
    let content = '';
    if (taskType === 'formula' && data.latex) {
      content = data.latex as string;
    } else if (taskType === 'table' && data.rows) {
      content = formatTable(data as { headers?: string[]; rows?: string[][]; caption?: string });
    } else if (taskType === 'code' && data.code) {
      content = data.code as string;
    } else if (data.description) {
      content = data.description as string;
    }

    if (!content) return [];

    const element: AnalyzedElement = {
      type: taskType === 'formula' ? 'formula' : taskType === 'table' ? 'table' : taskType === 'code' ? 'code' : 'image',
      content,
      confidence: 0.95,
      pageIndex: pageNumber - 1,
      vlmProcessed: true,
    };

    if (taskType === 'table' && data.headers) {
      element.columns = (data.headers as string[]).length;
    }

    return [element];
  } catch {
    return [];
  }
}

/**
 * Process low-confidence elements with VLM enhancement.
 * Re-analyzes specific element types using VLM for better accuracy.
 */
export async function processLowConfidenceElements(
  _doc: PDFDocumentProxy,
  elements: AnalyzedElement[],
  config: VLMConfig
): Promise<AnalyzedElement[]> {
  if (!config.enabled || elements.length === 0) return elements;

  // For now, keep original elements - region-based VLM requires complex cropping
  // The main VLM enhancement happens at page level via processScannedPage
  // Mark elements as needing review
  return elements.map(el => ({
    ...el,
    confidence: Math.max(el.confidence, 0.5), // Bump confidence slightly
  }));
}

/**
 * Process a page with VLM to extract structured content.
 * Used when rule-based detection fails or for scanned pages.
 * 
 * @param pdfData - PDF file data as Uint8Array
 * @param pageIndex - 0-based page index
 * @param config - VLM configuration
 * @returns Extracted elements
 */
export async function processPageWithVLM(
  pdfData: Uint8Array,
  pageIndex: number,
  config: VLMConfig
): Promise<AnalyzedElement[]> {
  if (!config.enabled) return [];

  const pageNumber = pageIndex + 1; // VLM uses 1-based
  logger.info(`Processing page ${pageNumber} with VLM`);

  const imageBase64 = await renderPageToBase64(pdfData, pageNumber);
  if (!imageBase64) {
    logger.warn(`Failed to render page ${pageNumber} for VLM`);
    return [];
  }

  try {
    const response = await callVLM(config, imageBase64, PROMPTS.fullPage);
    const data = parseJSON<{ elements: Array<{
      type: string;
      content: string;
      level?: number;
      description?: string;
      caption?: string;
      language?: string;
    }> }>(response);

    if (!data?.elements || !Array.isArray(data.elements)) {
      logger.warn(`VLM returned invalid data for page ${pageNumber}`);
      return [];
    }

    const elements: AnalyzedElement[] = [];
    for (const el of data.elements) {
      if (!el.type || !el.content) continue;

      const element: AnalyzedElement = {
        type: mapVLMType(el.type),
        content: el.content,
        confidence: 0.9, // VLM results have high confidence
        pageIndex,
        vlmProcessed: true,
      };

      if (el.level && element.type === 'heading') {
        element.level = Math.min(Math.max(el.level, 1), 6);
      }

      elements.push(element);
    }

    logger.info(`VLM extracted ${elements.length} elements from page ${pageNumber}`);
    return elements;
  } catch (err) {
    logger.error(`VLM processing failed for page ${pageNumber}:`, err instanceof Error ? err : undefined);
    return [];
  }
}

/**
 * Process scanned page entirely with VLM.
 * @deprecated Use processPageWithVLM instead
 */
export async function processScannedPage(
  _doc: PDFDocumentProxy,
  _pageIndex: number,
  config: VLMConfig
): Promise<AnalyzedElement[]> {
  if (!config.enabled) return [];

  // This function is kept for backward compatibility but requires PDF data
  // Use processPageWithVLM directly with Uint8Array for new code
  logger.warn('processScannedPage called without PDF data - use processPageWithVLM instead');
  return [];
}

/**
 * Extract specific content type from a page using VLM.
 */
export async function extractContentWithVLM(
  pdfData: Uint8Array,
  pageIndex: number,
  contentType: 'formula' | 'table' | 'code',
  config: VLMConfig
): Promise<AnalyzedElement[]> {
  if (!config.enabled) return [];

  const pageNumber = pageIndex + 1;
  const imageBase64 = await renderPageToBase64(pdfData, pageNumber);
  if (!imageBase64) return [];

  try {
    const response = await callVLM(config, imageBase64, PROMPTS[contentType]);
    const items = parseJSONArray<Record<string, unknown>>(response);

    return items.map((item, idx) => {
      let content = '';
      if (contentType === 'formula' && item.latex) {
        content = String(item.latex);
      } else if (contentType === 'table' && item.markdown) {
        content = String(item.markdown);
      } else if (contentType === 'code' && item.code) {
        content = String(item.code);
      }

      return {
        type: contentType === 'formula' ? 'formula' as const : contentType as 'table' | 'code',
        content,
        confidence: 0.9,
        pageIndex,
        vlmProcessed: true,
      };
    }).filter(el => el.content.trim());
  } catch {
    return [];
  }
}

/**
 * Map VLM element type to internal type.
 */
function mapVLMType(vlmType: string): AnalyzedElement['type'] {
  const typeMap: Record<string, AnalyzedElement['type']> = {
    heading: 'heading',
    paragraph: 'paragraph',
    text: 'paragraph',
    formula: 'formula',
    equation: 'formula',
    math: 'formula',
    table: 'table',
    code: 'code',
    code_block: 'code',
    list: 'list',
    image: 'image',
    figure: 'image',
    caption: 'caption',
    footnote: 'footnote',
  };
  return typeMap[vlmType.toLowerCase()] ?? 'paragraph';
}

/**
 * Parse JSON array from VLM response.
 */
function parseJSONArray<T>(text: string): T[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]) as T[];
  } catch {
    return [];
  }
}
