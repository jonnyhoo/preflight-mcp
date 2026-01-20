/**
 * VLM Fallback Module
 *
 * Enhances PDF analysis using Vision-Language Models for:
 * - LaTeX formula extraction
 * - Table structure recognition
 * - Scanned page OCR
 *
 * @module parser/pdf/vlm-fallback
 */

import type { AnalyzedElement, VLMConfig, VLMTask, VLMTaskType } from './types.js';

// ============================================================================
// Types
// ============================================================================

/** PDF document proxy from unpdf */
export type PDFDocumentProxy = Awaited<ReturnType<typeof import('unpdf').getDocumentProxy>>;

// ============================================================================
// Configuration
// ============================================================================

export const DEFAULT_VLM_CONFIG: VLMConfig = {
  apiBase: '',
  apiKey: '',
  model: 'qwen3-vl-plus',
  maxTokens: 1024,
  enabled: false,
  confidenceThreshold: 0.7,
};

/** Concise prompts optimized for academic papers */
const PROMPTS: Record<VLMTaskType, string> = {
  formula: 'Extract the mathematical formula. Return JSON: {latex: "LaTeX code"}',
  table: 'Extract table structure. Return JSON: {headers: [...], rows: [[...]], caption: "..."}',
  code: 'Extract code. Return JSON: {code: "...", language: "..."}',
  image: 'Describe figure. Return JSON: {type: "diagram|chart", description: "..."}',
  fullPage: 'Analyze this paper page. Return JSON: {elements: [{type, content, level, latex}]}',
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
 */
export async function renderPageToBase64(
  pdfData: Uint8Array,
  pageNumber: number,
  scale = 1.5
): Promise<string | null> {
  try {
    const { definePDFJSModule, renderPageAsImage } = await import('unpdf');
    await definePDFJSModule(() => import('pdfjs-dist/legacy/build/pdf.mjs'));

    const imageData = await renderPageAsImage(pdfData, pageNumber, {
      canvasImport: () => import('@napi-rs/canvas'),
      scale,
    });

    return Buffer.from(imageData).toString('base64');
  } catch {
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
 */
export async function processLowConfidenceElements(
  _doc: PDFDocumentProxy,
  elements: AnalyzedElement[],
  config: VLMConfig
): Promise<AnalyzedElement[]> {
  if (!config.enabled || elements.length === 0) return elements;

  // Keep original elements for now - VLM enhancement requires PDF data
  // Future: render specific regions and analyze
  return elements;
}

/**
 * Process scanned page entirely with VLM.
 */
export async function processScannedPage(
  _doc: PDFDocumentProxy,
  _pageIndex: number,
  config: VLMConfig
): Promise<AnalyzedElement[]> {
  if (!config.enabled) return [];

  // Placeholder - full implementation needs PDF data passed through
  return [];
}
