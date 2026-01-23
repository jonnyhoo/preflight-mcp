/**
 * VLM Extractor for Knowledge Distillation
 * 
 * Uses Vision-Language Models to extract structured content from PDF pages:
 * - Mathematical formulas (LaTeX)
 * - Tables (Markdown)
 * - Code blocks
 * 
 * Strategy: Smart detection + focused prompts
 * 1. Fast scan with unpdf to detect pages with structured content
 * 2. Only call VLM on pages that likely have formulas/tables/code
 * 3. Use focused prompts to reduce output tokens
 * 
 * @module distill/vlm-extractor
 */

import fs from 'fs/promises';
import { getDocumentProxy } from 'unpdf';
import { getConfig } from '../config.js';

// ============================================================================
// Types
// ============================================================================

export interface VLMConfig {
  apiBase: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  enabled: boolean;
}

export interface PageDetectionResult {
  pageIndex: number;
  hasFormulas: boolean;
  hasTables: boolean;
  hasCode: boolean;
  hints: string[];
}

export interface ExtractedFormula {
  latex: string;
  description?: string;
}

export interface ExtractedTable {
  markdown: string;
  caption?: string;
}

export interface ExtractedCode {
  code: string;
  language?: string;
}

export interface PageExtraction {
  pageIndex: number;
  formulas: ExtractedFormula[];
  tables: ExtractedTable[];
  codeBlocks: ExtractedCode[];
  description?: string;
}

export interface ExtractionResult {
  pdfPath: string;
  totalPages: number;
  pagesProcessed: number;
  apiCalls: number;
  extractions: PageExtraction[];
}

export interface ExtractOptions {
  /** Start page (1-based), default: 1 */
  startPage?: number;
  /** End page (1-based), default: last page */
  endPage?: number;
  /** Extract formulas, default: true */
  extractFormulas?: boolean;
  /** Extract tables, default: true */
  extractTables?: boolean;
  /** Extract code, default: true */
  extractCode?: boolean;
  /** Always describe page before extraction, default: false */
  describeFirst?: boolean;
  /** Skip detection, extract from all pages, default: false */
  forceAll?: boolean;
}

// ============================================================================
// Detection Patterns
// ============================================================================

const MATH_PATTERNS = {
  symbols: /[∑∏∫∂∇∈∉∋∀∃∄∅∆≠≈≤≥≡→←↔⊂⊃⊆⊇∩∪⊕⊗λπσμαβγδεθω∞±×÷√∝∼]/g,
  equation: /[a-zA-Z]\s*=\s*[a-zA-Z\d(]|=\s*\d|log\s*\(|exp\s*\(|sin|cos|tan|argmax|argmin|lim|sup|inf|∑|∏|∫/,
  numbering: /\(\d+(\.\d+)?\)\s*$/,
  scripts: /[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]/,
};

const TABLE_PATTERNS = {
  // More strict: require "Table X" pattern
  tableHeader: /^Table\s+\d+[:.]/i,
  // Column-like structure with numbers
  dataColumns: /\d+\.\d+\s+\d+\.\d+\s+\d+\.\d+/,
};

const CODE_PATTERNS = {
  keywords: /\b(def|function|class|import|from|return|if|else|for|while|try|except|const|let|var|async|await|public|private|void)\b/,
  syntax: /[{}];$|=>|->|\(\)|::|#include|#!/,
};

// ============================================================================
// Prompts
// ============================================================================

const PROMPTS = {
  describe: `请描述这页PDF的主要内容。特别注意：
1. 是否有表格？如果有，说明表格数量和主题
2. 是否有数学公式？
3. 是否有代码块？

简要回答即可。`,

  formulas: `请从这页PDF中提取所有数学公式。

对于每个公式：
1. 用 LaTeX 格式表示
2. 简要说明公式含义

只要公式，忽略普通文本。

返回 JSON 数组格式：
[
  {"latex": "\\sum_{i=1}^n x_i", "description": "求和"},
  ...
]

如果没有公式，返回空数组: []`,

  tables: `请从这页PDF中提取所有表格。

对于每个表格：
1. 用 Markdown 格式输出表格（包含表头和数据行）
2. 如果有表格标题/说明，也提取出来

只要表格，忽略普通文本段落。

返回 JSON 数组格式：
[
  {"markdown": "| 列1 | 列2 |\\n|---|---|\\n| 值1 | 值2 |", "caption": "表 1: ..."},
  ...
]

如果没有表格，返回空数组: []`,

  code: `请从这页PDF中提取所有代码块。

对于每个代码块：
1. 提取完整代码
2. 识别编程语言

只要代码，忽略普通文本。

返回 JSON 数组格式：
[
  {"code": "def foo():\\n    return 1", "language": "python"},
  ...
]

如果没有代码，返回空数组: []`,
};

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Get VLM config from preflight config
 */
export function getVLMConfig(): VLMConfig {
  const cfg = getConfig();
  return {
    apiBase: cfg.vlmApiBase || '',
    apiKey: cfg.vlmApiKey || '',
    model: cfg.vlmModel || 'qwen3-vl-plus',
    maxTokens: 32768,  // No limits - user has unlimited budget
    enabled: cfg.vlmEnabled && Boolean(cfg.vlmApiKey && cfg.vlmApiBase),
  };
}

/**
 * Render PDF page to base64 image using unpdf + @napi-rs/canvas
 */
export async function renderPageToBase64(
  pdfPath: string,
  pageNumber: number,
  scale = 1.5
): Promise<string | null> {
  try {
    const buffer = await fs.readFile(pdfPath);
    const pdfData = new Uint8Array(buffer);
    
    const { renderPageAsImage } = await import('unpdf');
    
    const imageData = await renderPageAsImage(pdfData, pageNumber, {
      canvasImport: () => import('@napi-rs/canvas'),
      scale,
    });
    
    return Buffer.from(imageData).toString('base64');
  } catch (err) {
    console.error(`[vlm-extractor] Failed to render page ${pageNumber}:`, err);
    return null;
  }
}

/**
 * Call VLM API
 */
export async function callVLM(
  config: VLMConfig,
  imageBase64: string,
  prompt: string
): Promise<string> {
  if (!config.enabled) {
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

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VLM API ${res.status}: ${text}`);
  }

  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content || '';
}

/**
 * Parse JSON array from VLM response
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

/**
 * Detect pages with structured content (fast, no VLM)
 */
export async function detectStructuredPages(
  pdfPath: string,
  startPage = 1,
  endPage?: number
): Promise<PageDetectionResult[]> {
  const buffer = await fs.readFile(pdfPath);
  const pdfData = new Uint8Array(buffer);
  const doc = await getDocumentProxy(pdfData);
  
  const results: PageDetectionResult[] = [];
  const lastPage = Math.min(endPage ?? doc.numPages, doc.numPages);
  
  try {
    for (let i = startPage; i <= lastPage; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      
      // Group text items into lines
      const lines: string[] = [];
      let currentY = -1;
      let currentLine = '';
      
      for (const item of textContent.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const textItem = item as { str: string; transform: number[] };
        const y = Math.round(textItem.transform[5] ?? 0);
        
        if (currentY === -1) {
          currentY = y;
          currentLine = textItem.str;
        } else if (Math.abs(y - currentY) < 3) {
          currentLine += ' ' + textItem.str;
        } else {
          if (currentLine.trim()) lines.push(currentLine.trim());
          currentY = y;
          currentLine = textItem.str;
        }
      }
      if (currentLine.trim()) lines.push(currentLine.trim());
      
      // Analyze lines
      const result: PageDetectionResult = {
        pageIndex: i - 1,
        hasFormulas: false,
        hasTables: false,
        hasCode: false,
        hints: [],
      };
      
      for (const line of lines) {
        // Check formulas (more strict)
        const mathSymbols = line.match(MATH_PATTERNS.symbols)?.length ?? 0;
        const hasEquation = MATH_PATTERNS.equation.test(line);
        const hasNumbering = MATH_PATTERNS.numbering.test(line);
        
        if (mathSymbols >= 3 || (hasEquation && hasNumbering)) {
          result.hasFormulas = true;
          if (result.hints.length < 2) {
            result.hints.push(`Formula: ${line.slice(0, 50)}...`);
          }
        }
        
        // Check tables (strict: require "Table X" header)
        if (TABLE_PATTERNS.tableHeader.test(line)) {
          result.hasTables = true;
          result.hints.push(`Table: ${line.slice(0, 50)}...`);
        }
        
        // Check code (strict)
        const hasKeywords = CODE_PATTERNS.keywords.test(line);
        const hasSyntax = CODE_PATTERNS.syntax.test(line);
        
        if (hasKeywords && hasSyntax) {
          result.hasCode = true;
          if (result.hints.length < 3) {
            result.hints.push(`Code: ${line.slice(0, 50)}...`);
          }
        }
      }
      
      results.push(result);
    }
  } finally {
    doc.cleanup();
  }
  
  return results;
}

/**
 * Extract structured content from a PDF using VLM
 */
export async function extractFromPDF(
  pdfPath: string,
  options: ExtractOptions = {}
): Promise<ExtractionResult> {
  const {
    startPage = 1,
    endPage,
    extractFormulas = true,
    extractTables = true,
    extractCode = true,
    describeFirst = false,
    forceAll = false,
  } = options;
  
  const vlmConfig = getVLMConfig();
  if (!vlmConfig.enabled) {
    throw new Error('VLM not configured. Set vlmApiBase and vlmApiKey in config.');
  }
  
  // Load PDF
  const buffer = await fs.readFile(pdfPath);
  const pdfData = new Uint8Array(buffer);
  const doc = await getDocumentProxy(pdfData);
  const totalPages = doc.numPages;
  const lastPage = Math.min(endPage ?? totalPages, totalPages);
  doc.cleanup();
  
  // Detect pages with structured content
  let pagesToProcess: PageDetectionResult[];
  
  if (forceAll) {
    // Process all pages
    pagesToProcess = [];
    for (let i = startPage; i <= lastPage; i++) {
      pagesToProcess.push({
        pageIndex: i - 1,
        hasFormulas: extractFormulas,
        hasTables: extractTables,
        hasCode: extractCode,
        hints: [],
      });
    }
  } else {
    // Smart detection
    const detected = await detectStructuredPages(pdfPath, startPage, lastPage);
    pagesToProcess = detected.filter(p => p.hasFormulas || p.hasTables || p.hasCode);
  }
  
  // Extract from each page
  const extractions: PageExtraction[] = [];
  let apiCalls = 0;
  
  for (const pageInfo of pagesToProcess) {
    const pageNum = pageInfo.pageIndex + 1;
    
    // Render page
    const imageBase64 = await renderPageToBase64(pdfPath, pageNum);
    if (!imageBase64) continue;
    
    const extraction: PageExtraction = {
      pageIndex: pageInfo.pageIndex,
      formulas: [],
      tables: [],
      codeBlocks: [],
    };
    
    // Describe first if requested
    if (describeFirst) {
      try {
        extraction.description = await callVLM(vlmConfig, imageBase64, PROMPTS.describe);
        apiCalls++;
      } catch {
        // Ignore describe errors
      }
    }
    
    // Extract formulas
    if (extractFormulas && pageInfo.hasFormulas) {
      try {
        const response = await callVLM(vlmConfig, imageBase64, PROMPTS.formulas);
        extraction.formulas = parseJSONArray<ExtractedFormula>(response);
        apiCalls++;
      } catch {
        // Ignore extraction errors
      }
    }
    
    // Extract tables
    if (extractTables && pageInfo.hasTables) {
      try {
        const response = await callVLM(vlmConfig, imageBase64, PROMPTS.tables);
        extraction.tables = parseJSONArray<ExtractedTable>(response);
        apiCalls++;
      } catch {
        // Ignore extraction errors
      }
    }
    
    // Extract code
    if (extractCode && pageInfo.hasCode) {
      try {
        const response = await callVLM(vlmConfig, imageBase64, PROMPTS.code);
        extraction.codeBlocks = parseJSONArray<ExtractedCode>(response);
        apiCalls++;
      } catch {
        // Ignore extraction errors
      }
    }
    
    extractions.push(extraction);
  }
  
  return {
    pdfPath,
    totalPages,
    pagesProcessed: pagesToProcess.length,
    apiCalls,
    extractions,
  };
}

/**
 * Format extraction result as Markdown
 */
export function formatAsMarkdown(result: ExtractionResult): string {
  const lines: string[] = [
    `# VLM Extraction: ${result.pdfPath}`,
    '',
    `- Total pages: ${result.totalPages}`,
    `- Pages processed: ${result.pagesProcessed}`,
    `- VLM API calls: ${result.apiCalls}`,
    '',
  ];
  
  for (const ext of result.extractions) {
    if (ext.formulas.length === 0 && ext.tables.length === 0 && ext.codeBlocks.length === 0) {
      continue;
    }
    
    lines.push(`## Page ${ext.pageIndex + 1}`);
    lines.push('');
    
    if (ext.description) {
      lines.push(`> ${ext.description}`);
      lines.push('');
    }
    
    if (ext.formulas.length > 0) {
      lines.push('### Formulas');
      lines.push('');
      for (const f of ext.formulas) {
        lines.push(`$$${f.latex}$$`);
        if (f.description) lines.push(`> ${f.description}`);
        lines.push('');
      }
    }
    
    if (ext.tables.length > 0) {
      lines.push('### Tables');
      lines.push('');
      for (const t of ext.tables) {
        if (t.caption) lines.push(`**${t.caption}**`);
        lines.push('');
        lines.push(t.markdown);
        lines.push('');
      }
    }
    
    if (ext.codeBlocks.length > 0) {
      lines.push('### Code');
      lines.push('');
      for (const c of ext.codeBlocks) {
        lines.push('```' + (c.language || ''));
        lines.push(c.code);
        lines.push('```');
        lines.push('');
      }
    }
  }
  
  return lines.join('\n');
}
