/**
 * Test Script: Smart VLM Extraction
 * 
 * Strategy: 方案 2+3
 * - 选择性调用: 先用 unpdf 扫描，检测哪些页面有表格/公式，只对这些页面调用 VLM
 * - Prompt 优化: 只提取公式和表格，忽略普通文本
 * 
 * Usage: npx tsx scripts/test-vlm-extraction.ts <pdf-path>
 */

import fs from 'fs/promises';
import path from 'path';
import { getDocumentProxy } from 'unpdf';

// ============================================================================
// Types
// ============================================================================

interface VLMConfig {
  apiBase: string;
  apiKey: string;
  model: string;
  maxTokens: number;
}

interface PageDetectionResult {
  pageIndex: number;
  hasFormulas: boolean;
  hasTables: boolean;
  hasCode: boolean;
  formulaHints: string[];  // Line numbers/text that suggest formulas
  tableHints: string[];    // Line numbers/text that suggest tables
  codeHints: string[];     // Line numbers/text that suggest code
}

interface ExtractedContent {
  pageIndex: number;
  formulas: { latex: string; description?: string }[];
  tables: { markdown: string; caption?: string }[];
  codeBlocks: { code: string; language?: string }[];
}

// ============================================================================
// Configuration
// ============================================================================

import { readFileSync, existsSync } from 'fs';
import os from 'os';

function loadVLMConfig(): VLMConfig | null {
  const home = os.homedir();
  const configPaths = [
    path.join(home, '.preflight', 'config.json'),
    path.join(home, '.preflight-mcp', 'config.json'),
  ];
  
  for (const configPath of configPaths) {
    try {
      if (existsSync(configPath)) {
        const content = readFileSync(configPath, 'utf8');
        const cfg = JSON.parse(content);
        console.log(`[config] Loaded from ${configPath}`);
        if (cfg.vlmApiKey && cfg.vlmApiBase) {
          return {
            apiBase: cfg.vlmApiBase,
            apiKey: cfg.vlmApiKey,
            model: cfg.vlmModel || 'qwen3-vl-plus',
            maxTokens: 4096,  // Increased for tables
          };
        }
      }
    } catch (err) {
      console.log(`[config] Failed to load ${configPath}:`, err);
    }
  }
  
  // Try env
  if (process.env.VLM_API_KEY && process.env.VLM_API_BASE) {
    return {
      apiBase: process.env.VLM_API_BASE,
      apiKey: process.env.VLM_API_KEY,
      model: process.env.VLM_MODEL || 'qwen3-vl-plus',
      maxTokens: 4096,
    };
  }
  
  return null;
}

// ============================================================================
// Phase 1: Fast Detection with unpdf
// ============================================================================

/** Math indicators for detection */
const MATH_PATTERNS = {
  // Common math Unicode symbols
  symbols: /[∑∏∫∂∇∈∉∋∀∃∄∅∆≠≈≤≥≡→←↔⊂⊃⊆⊇∩∪⊕⊗λπσμαβγδεθω∞±×÷√∝∼]/g,
  // Equation patterns
  equation: /[a-zA-Z]\s*=\s*[a-zA-Z\d(]|=\s*\d|log\s*\(|exp\s*\(|sin|cos|tan|argmax|argmin|lim|sup|inf|∑|∏|∫/,
  // Equation numbering
  numbering: /\(\d+(\.\d+)?\)\s*$/,
  // Superscripts/subscripts (unicode)
  scripts: /[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]/,
  // Math italic letters (unicode ranges 1D400-1D7FF)
  mathItalic: /[\u{1D400}-\u{1D7FF}]/u,
};

/** Table indicators for detection */
const TABLE_PATTERNS = {
  // Column separators
  separators: /\t|  {2,}|│|┃|\|/,
  // Table-like text
  headers: /^(Table|TABLE)\s+\d+|Method|Model|Dataset|Accuracy|Precision|Recall|F1|Score|Result/i,
  // Row-like patterns
  dataRow: /^\s*\d+\.?\s+.*\s+\d+(\.\d+)?%?$/,
};

/** Code indicators for detection */
const CODE_PATTERNS = {
  keywords: /\b(def|function|class|import|from|return|if|else|for|while|try|except|const|let|var|async|await)\b/,
  brackets: /[{}()\[\]]{3,}/,
  operators: /[=!<>]{2}|->|=>|\+=|-=|\*=|\/=/,
  comments: /^[\s]*[#\/\/]/,
};

/**
 * Detect which pages likely contain formulas, tables, or code
 */
async function detectPagesWithStructuredContent(pdfPath: string): Promise<PageDetectionResult[]> {
  const buffer = await fs.readFile(pdfPath);
  const pdfData = new Uint8Array(buffer);
  const doc = await getDocumentProxy(pdfData);
  
  const results: PageDetectionResult[] = [];
  
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      
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
      
      // Analyze lines for structured content
      const result: PageDetectionResult = {
        pageIndex: i - 1,
        hasFormulas: false,
        hasTables: false,
        hasCode: false,
        formulaHints: [],
        tableHints: [],
        codeHints: [],
      };
      
      let consecutiveDataRows = 0;
      
      for (let j = 0; j < lines.length; j++) {
        const line = lines[j];
        if (!line) continue;
        
        // Check for formulas
        const mathSymbols = line.match(MATH_PATTERNS.symbols)?.length ?? 0;
        const hasEquation = MATH_PATTERNS.equation.test(line);
        const hasNumbering = MATH_PATTERNS.numbering.test(line);
        const hasScripts = MATH_PATTERNS.scripts.test(line);
        
        if (mathSymbols >= 2 || (hasEquation && (hasNumbering || mathSymbols >= 1)) || hasScripts) {
          result.hasFormulas = true;
          result.formulaHints.push(`L${j + 1}: ${line.slice(0, 60)}...`);
        }
        
        // Check for tables
        const hasSeparators = TABLE_PATTERNS.separators.test(line);
        const hasHeaders = TABLE_PATTERNS.headers.test(line);
        const isDataRow = TABLE_PATTERNS.dataRow.test(line);
        
        if (hasHeaders) {
          result.hasTables = true;
          result.tableHints.push(`L${j + 1}: ${line.slice(0, 60)}...`);
        }
        
        if (isDataRow || hasSeparators) {
          consecutiveDataRows++;
          if (consecutiveDataRows >= 3) {
            result.hasTables = true;
            result.tableHints.push(`L${j + 1}: ${line.slice(0, 60)}...`);
          }
        } else {
          consecutiveDataRows = 0;
        }
        
        // Check for code
        const hasKeywords = CODE_PATTERNS.keywords.test(line);
        const hasBrackets = CODE_PATTERNS.brackets.test(line);
        const hasOperators = CODE_PATTERNS.operators.test(line);
        
        if (hasKeywords || (hasBrackets && hasOperators)) {
          result.hasCode = true;
          result.codeHints.push(`L${j + 1}: ${line.slice(0, 60)}...`);
        }
      }
      
      results.push(result);
    }
  } finally {
    doc.cleanup();
  }
  
  return results;
}

// ============================================================================
// Phase 2: VLM Extraction with Focused Prompts
// ============================================================================

/**
 * Render PDF page to base64 using pdf-to-img
 */
async function renderPageToBase64(pdfPath: string, pageNumber: number): Promise<string | null> {
  try {
    const { pdf } = await import('pdf-to-img');
    const buffer = await fs.readFile(pdfPath);
    
    let pageIndex = 0;
    for await (const image of pdf(buffer, { scale: 1.5 })) {
      pageIndex++;
      if (pageIndex === pageNumber) {
        return image.toString('base64');
      }
    }
    return null;
  } catch (err) {
    console.error(`[render] Failed to render page ${pageNumber}:`, err);
    return null;
  }
}

/**
 * Call VLM with focused prompt
 */
async function callVLM(
  config: VLMConfig, 
  imageBase64: string, 
  prompt: string
): Promise<string> {
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
 * Focused prompt for formula extraction only 
 * 输出限制：只要公式，不要普通文本
 */
const FORMULA_PROMPT = `Extract ALL mathematical formulas/equations from this page.

For each formula, provide:
1. The LaTeX representation
2. Brief description (what it computes)

ONLY return formulas, IGNORE regular text/paragraphs.

Return JSON array:
[
  {"latex": "\\\\sum_{i=1}^n x_i", "description": "sum of x values"},
  ...
]

If no formulas found, return empty array: []`;

/**
 * Focused prompt for table extraction only
 */
const TABLE_PROMPT = `Extract ALL tables from this page.

For each table, provide:
1. Markdown table format with headers and rows
2. Table caption if visible

ONLY return tables, IGNORE regular text/paragraphs.

Return JSON array:
[
  {"markdown": "| Col1 | Col2 |\\n|---|---|\\n| val1 | val2 |", "caption": "Table 1: ..."},
  ...
]

If no tables found, return empty array: []`;

/**
 * Focused prompt for code extraction only
 */
const CODE_PROMPT = `Extract ALL code blocks/snippets from this page.

For each code block, provide:
1. The exact code
2. Programming language if identifiable

ONLY return code, IGNORE regular text/paragraphs.

Return JSON array:
[
  {"code": "def foo():\\n    return 1", "language": "python"},
  ...
]

If no code found, return empty array: []`;

/**
 * Parse JSON from VLM response
 */
function parseJSON<T>(text: string): T | null {
  // Try to find JSON array in response
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Extract structured content from specific pages using VLM
 */
async function extractWithVLM(
  pdfPath: string,
  pagesToProcess: PageDetectionResult[],
  config: VLMConfig
): Promise<ExtractedContent[]> {
  const results: ExtractedContent[] = [];
  
  for (const pageInfo of pagesToProcess) {
    const pageNum = pageInfo.pageIndex + 1;
    console.log(`\n[VLM] Processing page ${pageNum}...`);
    
    const imageBase64 = await renderPageToBase64(pdfPath, pageNum);
    if (!imageBase64) {
      console.log(`  [skip] Failed to render page`);
      continue;
    }
    
    const content: ExtractedContent = {
      pageIndex: pageInfo.pageIndex,
      formulas: [],
      tables: [],
      codeBlocks: [],
    };
    
    // Extract formulas if detected
    if (pageInfo.hasFormulas) {
      console.log(`  [formulas] Extracting...`);
      try {
        const response = await callVLM(config, imageBase64, FORMULA_PROMPT);
        const formulas = parseJSON<{ latex: string; description?: string }[]>(response);
        if (formulas && formulas.length > 0) {
          content.formulas = formulas;
          console.log(`  [formulas] Found ${formulas.length}`);
        } else {
          console.log(`  [formulas] None extracted`);
        }
      } catch (err) {
        console.log(`  [formulas] Error: ${err}`);
      }
    }
    
    // Extract tables if detected
    if (pageInfo.hasTables) {
      console.log(`  [tables] Extracting...`);
      try {
        const response = await callVLM(config, imageBase64, TABLE_PROMPT);
        const tables = parseJSON<{ markdown: string; caption?: string }[]>(response);
        if (tables && tables.length > 0) {
          content.tables = tables;
          console.log(`  [tables] Found ${tables.length}`);
        } else {
          console.log(`  [tables] None extracted`);
        }
      } catch (err) {
        console.log(`  [tables] Error: ${err}`);
      }
    }
    
    // Extract code if detected
    if (pageInfo.hasCode) {
      console.log(`  [code] Extracting...`);
      try {
        const response = await callVLM(config, imageBase64, CODE_PROMPT);
        const codeBlocks = parseJSON<{ code: string; language?: string }[]>(response);
        if (codeBlocks && codeBlocks.length > 0) {
          content.codeBlocks = codeBlocks;
          console.log(`  [code] Found ${codeBlocks.length}`);
        } else {
          console.log(`  [code] None extracted`);
        }
      } catch (err) {
        console.log(`  [code] Error: ${err}`);
      }
    }
    
    results.push(content);
  }
  
  return results;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.log('Usage: npx tsx scripts/test-vlm-extraction.ts <pdf-path>');
    process.exit(1);
  }
  
  const absolutePath = path.resolve(pdfPath);
  console.log(`\n${'='.repeat(60)}`);
  console.log('Smart VLM Extraction Test');
  console.log(`${'='.repeat(60)}`);
  console.log(`PDF: ${absolutePath}\n`);
  
  // Load VLM config
  const vlmConfig = loadVLMConfig();
  if (!vlmConfig) {
    console.error('Error: VLM not configured. Set up ~/.preflight/config.json or VLM_API_* env vars.');
    process.exit(1);
  }
  console.log(`VLM: ${vlmConfig.model} @ ${vlmConfig.apiBase}\n`);
  
  // Phase 1: Fast detection
  console.log('Phase 1: Detecting pages with structured content...');
  console.log('-'.repeat(40));
  
  const detectionResults = await detectPagesWithStructuredContent(absolutePath);
  
  let totalFormulas = 0, totalTables = 0, totalCode = 0;
  const pagesToProcess: PageDetectionResult[] = [];
  
  for (const result of detectionResults) {
    const hasContent = result.hasFormulas || result.hasTables || result.hasCode;
    if (hasContent) {
      pagesToProcess.push(result);
      
      const flags: string[] = [];
      if (result.hasFormulas) { flags.push('📐 formulas'); totalFormulas++; }
      if (result.hasTables) { flags.push('📊 tables'); totalTables++; }
      if (result.hasCode) { flags.push('💻 code'); totalCode++; }
      
      console.log(`Page ${result.pageIndex + 1}: ${flags.join(', ')}`);
      
      // Show first hint for each type
      if (result.formulaHints.length > 0) {
        console.log(`  Formula hint: ${result.formulaHints[0]}`);
      }
      if (result.tableHints.length > 0) {
        console.log(`  Table hint: ${result.tableHints[0]}`);
      }
      if (result.codeHints.length > 0) {
        console.log(`  Code hint: ${result.codeHints[0]}`);
      }
    }
  }
  
  console.log('\nSummary:');
  console.log(`  Total pages: ${detectionResults.length}`);
  console.log(`  Pages with formulas: ${totalFormulas}`);
  console.log(`  Pages with tables: ${totalTables}`);
  console.log(`  Pages with code: ${totalCode}`);
  console.log(`  Pages to process with VLM: ${pagesToProcess.length}`);
  
  if (pagesToProcess.length === 0) {
    console.log('\nNo structured content detected. Exiting.');
    return;
  }
  
  // Calculate API calls
  let apiCalls = 0;
  for (const p of pagesToProcess) {
    if (p.hasFormulas) apiCalls++;
    if (p.hasTables) apiCalls++;
    if (p.hasCode) apiCalls++;
  }
  console.log(`  Estimated VLM API calls: ${apiCalls}`);
  
  // Phase 2: VLM extraction
  console.log('\nPhase 2: Extracting with VLM...');
  console.log('-'.repeat(40));
  
  const extractedContent = await extractWithVLM(absolutePath, pagesToProcess, vlmConfig);
  
  // Output results
  console.log('\n' + '='.repeat(60));
  console.log('Extraction Results');
  console.log('='.repeat(60));
  
  for (const content of extractedContent) {
    if (content.formulas.length === 0 && content.tables.length === 0 && content.codeBlocks.length === 0) {
      continue;
    }
    
    console.log(`\n## Page ${content.pageIndex + 1}`);
    
    if (content.formulas.length > 0) {
      console.log('\n### Formulas');
      for (const f of content.formulas) {
        console.log(`$$${f.latex}$$`);
        if (f.description) console.log(`> ${f.description}`);
      }
    }
    
    if (content.tables.length > 0) {
      console.log('\n### Tables');
      for (const t of content.tables) {
        if (t.caption) console.log(`**${t.caption}**`);
        console.log(t.markdown);
      }
    }
    
    if (content.codeBlocks.length > 0) {
      console.log('\n### Code');
      for (const c of content.codeBlocks) {
        console.log('```' + (c.language || ''));
        console.log(c.code);
        console.log('```');
      }
    }
  }
  
  // Final stats
  let totalExtractedFormulas = 0, totalExtractedTables = 0, totalExtractedCode = 0;
  for (const c of extractedContent) {
    totalExtractedFormulas += c.formulas.length;
    totalExtractedTables += c.tables.length;
    totalExtractedCode += c.codeBlocks.length;
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('Final Stats');
  console.log('='.repeat(60));
  console.log(`Total formulas extracted: ${totalExtractedFormulas}`);
  console.log(`Total tables extracted: ${totalExtractedTables}`);
  console.log(`Total code blocks extracted: ${totalExtractedCode}`);
  console.log(`VLM API calls made: ${apiCalls}`);
}

main().catch(console.error);
