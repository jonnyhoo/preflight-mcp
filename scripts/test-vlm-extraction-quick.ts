/**
 * Quick test: Only process first 2 pages
 */

// Same imports as original
import fs from 'fs/promises';
import path from 'path';
import { getDocumentProxy } from 'unpdf';
import { readFileSync, existsSync } from 'fs';
import os from 'os';

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
  formulaHints: string[];
  tableHints: string[];
  codeHints: string[];
}

interface ExtractedContent {
  pageIndex: number;
  formulas: { latex: string; description?: string }[];
  tables: { markdown: string; caption?: string }[];
  codeBlocks: { code: string; language?: string }[];
}

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
        if (cfg.vlmApiKey && cfg.vlmApiBase) {
          return {
            apiBase: cfg.vlmApiBase,
            apiKey: cfg.vlmApiKey,
            model: cfg.vlmModel || 'qwen3-vl-plus',
            maxTokens: 4096,
          };
        }
      }
    } catch (err) {
      console.log(`[config] Failed to load ${configPath}:`, err);
    }
  }
  
  return null;
}

const MATH_PATTERNS = {
  symbols: /[∑∏∫∂∇∈∉∋∀∃∄∅∆≠≈≤≥≡→←↔⊂⊃⊆⊇∩∪⊕⊗λπσμαβγδεθω∞±×÷√∝∼]/g,
  equation: /[a-zA-Z]\s*=\s*[a-zA-Z\d(]|=\s*\d|log\s*\(|exp\s*\(|sin|cos|tan|argmax|argmin|lim|sup|inf|∑|∏|∫/,
  numbering: /\(\d+(\.\d+)?\)\s*$/,
  scripts: /[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]/,
};

const TABLE_PATTERNS = {
  separators: /\t|  {2,}|│|┃|\|/,
  headers: /^(Table|TABLE)\s+\d+|Method|Model|Dataset|Accuracy|Precision|Recall|F1|Score|Result/i,
  dataRow: /^\s*\d+\.?\s+.*\s+\d+(\.\d+)?%?$/,
};

const CODE_PATTERNS = {
  keywords: /\b(def|function|class|import|from|return|if|else|for|while|try|except|const|let|var|async|await)\b/,
  brackets: /[{}()\[\]]{3,}/,
  operators: /[=!<>]{2}|->|=>|\+=|-=|\*=|\/=/,
};

async function detectPagesWithStructuredContent(pdfPath: string, startPage = 1, endPage = 2): Promise<PageDetectionResult[]> {
  const buffer = await fs.readFile(pdfPath);
  const pdfData = new Uint8Array(buffer);
  const doc = await getDocumentProxy(pdfData);
  
  const results: PageDetectionResult[] = [];
  const lastPage = Math.min(endPage, doc.numPages);
  
  try {
    for (let i = startPage; i <= lastPage; i++) {
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
        
        const mathSymbols = line.match(MATH_PATTERNS.symbols)?.length ?? 0;
        const hasEquation = MATH_PATTERNS.equation.test(line);
        const hasNumbering = MATH_PATTERNS.numbering.test(line);
        const hasScripts = MATH_PATTERNS.scripts.test(line);
        
        if (mathSymbols >= 2 || (hasEquation && (hasNumbering || mathSymbols >= 1)) || hasScripts) {
          result.hasFormulas = true;
          if (result.formulaHints.length < 2) {
            result.formulaHints.push(`L${j + 1}: ${line.slice(0, 60)}...`);
          }
        }
        
        const hasSeparators = TABLE_PATTERNS.separators.test(line);
        const hasHeaders = TABLE_PATTERNS.headers.test(line);
        const isDataRow = TABLE_PATTERNS.dataRow.test(line);
        
        if (hasHeaders) {
          result.hasTables = true;
          if (result.tableHints.length < 2) {
            result.tableHints.push(`L${j + 1}: ${line.slice(0, 60)}...`);
          }
        }
        
        if (isDataRow || hasSeparators) {
          consecutiveDataRows++;
          if (consecutiveDataRows >= 3 && result.tableHints.length < 2) {
            result.hasTables = true;
            result.tableHints.push(`L${j + 1}: ${line.slice(0, 60)}...`);
          }
        } else {
          consecutiveDataRows = 0;
        }
        
        const hasKeywords = CODE_PATTERNS.keywords.test(line);
        const hasBrackets = CODE_PATTERNS.brackets.test(line);
        const hasOperators = CODE_PATTERNS.operators.test(line);
        
        if (hasKeywords || (hasBrackets && hasOperators)) {
          result.hasCode = true;
          if (result.codeHints.length < 2) {
            result.codeHints.push(`L${j + 1}: ${line.slice(0, 60)}...`);
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

async function renderPageToBase64(pdfPath: string, pageNumber: number): Promise<string | null> {
  try {
    const buffer = await fs.readFile(pdfPath);
    const pdfData = new Uint8Array(buffer);
    
    // Use unpdf with @napi-rs/canvas
    const { renderPageAsImage } = await import('unpdf');
    
    const imageData = await renderPageAsImage(pdfData, pageNumber, {
      canvasImport: () => import('@napi-rs/canvas'),
      scale: 1.5,
    });
    
    return Buffer.from(imageData).toString('base64');
  } catch (err) {
    console.error(`[render] Failed to render page ${pageNumber}:`, err);
    return null;
  }
}

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

// Simple describe prompt to see what VLM sees
const DESCRIBE_PROMPT = `请描述这页PDF的主要内容。特别注意：
1. 是否有表格？如果有，说明表格内容
2. 是否有数学公式？
3. 是否有代码块？

简要回答即可。`;

const TABLE_PROMPT = `请从这页PDF中提取所有表格。

对于每个表格：
1. 用 Markdown 格式输出表格（包含表头和数据行）
2. 如果有表格标题/说明，也提取出来

只要表格，忽略普通文本段落。

返回 JSON 数组格式：
[
  {"markdown": "| 列1 | 列2 |\n|---|---|\n| 值1 | 值2 |", "caption": "表 1: ..."},
  ...
]

如果没有表格，返回空数组: []`;

function parseJSON<T>(text: string): T | null {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function extractWithVLM(
  pdfPath: string,
  pagesToProcess: PageDetectionResult[],
  config: VLMConfig
): Promise<ExtractedContent[]> {
  const results: ExtractedContent[] = [];
  
  for (const pageInfo of pagesToProcess) {
    const pageNum = pageInfo.pageIndex + 1;
    console.log(`\n[VLM] Processing page ${pageNum}...`);
    
    console.log(`  [render] Rendering page ${pageNum}...`);
    const imageBase64 = await renderPageToBase64(pdfPath, pageNum);
    if (!imageBase64) {
      console.log(`  [skip] Failed to render page`);
      continue;
    }
    console.log(`  [render] Success (${Math.round(imageBase64.length / 1024)} KB)`);
    
    const content: ExtractedContent = {
      pageIndex: pageInfo.pageIndex,
      formulas: [],
      tables: [],
      codeBlocks: [],
    };
    
    if (pageInfo.hasFormulas) {
      console.log(`  [formulas] Extracting...`);
      try {
        const response = await callVLM(config, imageBase64, FORMULA_PROMPT);
        console.log(`  [formulas] VLM response: ${response.slice(0, 200)}...`);
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
    
    // First, ask VLM to describe what it sees
    console.log(`  [describe] Asking VLM what's on this page...`);
    try {
      const descResponse = await callVLM(config, imageBase64, DESCRIBE_PROMPT);
      console.log(`  [describe] VLM says:\n${descResponse}`);
    } catch (err) {
      console.log(`  [describe] Error: ${err}`);
    }
    
    if (pageInfo.hasTables) {
      console.log(`  [tables] Extracting...`);
      try {
        const response = await callVLM(config, imageBase64, TABLE_PROMPT);
        console.log(`  [tables] VLM response:\n${response}`);
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
    
    results.push(content);
  }
  
  return results;
}

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.log('Usage: npx tsx scripts/test-vlm-extraction-quick.ts <pdf-path>');
    process.exit(1);
  }
  
  const absolutePath = path.resolve(pdfPath);
  console.log(`\nQuick VLM Extraction Test (Page 6)`);
  console.log('='.repeat(60));
  console.log(`PDF: ${absolutePath}\n`);
  
  const vlmConfig = loadVLMConfig();
  if (!vlmConfig) {
    console.error('Error: VLM not configured.');
    process.exit(1);
  }
  console.log(`VLM: ${vlmConfig.model}\n`);
  
  console.log('Phase 1: Detecting...');
  const detectionResults = await detectPagesWithStructuredContent(absolutePath, 6, 6);
  
  const pagesToProcess = detectionResults.filter(r => r.hasFormulas || r.hasTables || r.hasCode);
  
  for (const result of pagesToProcess) {
    const flags: string[] = [];
    if (result.hasFormulas) flags.push('📐 formulas');
    if (result.hasTables) flags.push('📊 tables');
    console.log(`Page ${result.pageIndex + 1}: ${flags.join(', ')}`);
    if (result.tableHints.length > 0) {
      console.log(`  Hints: ${result.tableHints.join(', ')}`);
    }
  }
  
  console.log(`\nPhase 2: Extracting with VLM (${pagesToProcess.length} pages)...`);
  const extractedContent = await extractWithVLM(absolutePath, pagesToProcess, vlmConfig);
  
  console.log('\n' + '='.repeat(60));
  console.log('Results:');
  console.log('='.repeat(60));
  
  for (const content of extractedContent) {
    console.log(`\n## Page ${content.pageIndex + 1}`);
    
    if (content.formulas.length > 0) {
      console.log('\n### Formulas:');
      for (const f of content.formulas) {
        console.log(`- ${f.latex}`);
        if (f.description) console.log(`  > ${f.description}`);
      }
    }
    
    if (content.tables.length > 0) {
      console.log('\n### Tables:');
      for (const t of content.tables) {
        if (t.caption) console.log(`**${t.caption}**`);
        console.log(t.markdown);
      }
    }
  }
}

main().catch(console.error);
