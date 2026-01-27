/**
 * PDF Markdown Preprocessor for Index-Time Enhancement.
 * 
 * This module processes PDF markdown content BEFORE chunking to maximize
 * retrieval quality. All operations are performed at index time because
 * bundles are deleted after indexing.
 * 
 * Features:
 * 1. Page marker filtering/downgrading (avoid polluting heading tree)
 * 2. HTML table → Markdown table conversion (for MinerU output)
 * 3. Image VLM description generation (make images searchable)
 * 4. Dehyphenation (fix PDF line-break hyphenation)
 * 
 * @module rag/pdf-preprocessor
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createModuleLogger } from '../logging/logger.js';
import { getConfig } from '../config.js';

const logger = createModuleLogger('pdf-preprocessor');

// ============================================================================
// VLM Config Loading (reuse vlmConfigs from config.json)
// ============================================================================

interface VLMWorkerConfig {
  apiBase: string;
  apiKey: string;
  model: string;
}

/**
 * Load VLM configs from config.json.
 * Prefers vlmConfigs array for parallel processing, falls back to single config.
 */
function loadVlmConfigs(): VLMWorkerConfig[] {
  const configPaths = [
    process.env.PREFLIGHT_CONFIG_PATH,
    path.join(os.homedir(), '.preflight', 'config.json'),
    path.join(os.homedir(), '.preflight-mcp', 'config.json'),
  ].filter(Boolean) as string[];
  
  for (const configPath of configPaths) {
    try {
      if (!fs.existsSync(configPath)) continue;
      
      const content = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(content) as {
        vlmConfigs?: VLMWorkerConfig[];
        vlmApiBase?: string;
        vlmApiKey?: string;
        vlmModel?: string;
      };
      
      // Prefer vlmConfigs array
      if (config.vlmConfigs && Array.isArray(config.vlmConfigs)) {
        const valid = config.vlmConfigs.filter(
          (c): c is VLMWorkerConfig => !!(c?.apiBase && c?.apiKey && c?.model)
        );
        if (valid.length > 0) {
          logger.info(`[Image Description] Loaded ${valid.length} VLM configs for parallel processing`);
          return valid;
        }
      }
      
      // Fallback to single config
      if (config.vlmApiBase && config.vlmApiKey) {
        return [{
          apiBase: config.vlmApiBase,
          apiKey: config.vlmApiKey,
          model: config.vlmModel || 'qwen3-vl-plus',
        }];
      }
    } catch {
      // Continue to next config path
    }
  }
  
  // Final fallback: environment variables
  const cfg = getConfig();
  if (cfg.vlmApiBase && cfg.vlmApiKey) {
    return [{
      apiBase: cfg.vlmApiBase,
      apiKey: cfg.vlmApiKey,
      model: cfg.vlmModel,
    }];
  }
  
  return [];
}

// ============================================================================
// Types
// ============================================================================

export interface PreprocessOptions {
  /** Bundle path for resolving image references (optional) */
  bundlePath?: string;
  /** Enable VLM image description (default: true if VLM configured) */
  enableImageDescription?: boolean;
  /** Enable LLM-based dehyphenation (default: true if LLM configured) */
  enableDehyphenation?: boolean;
}

export interface PreprocessResult {
  /** Processed markdown content */
  markdown: string;
  /** Statistics */
  stats: {
    pageMarkersRemoved: number;
    tablesConverted: number;
    imagesDescribed: number;
    hyphenationsFixed: number;
    processingTimeMs: number;
  };
  /** Warnings encountered */
  warnings: string[];
  /** 
   * Page boundary map: lineNumber (0-indexed in original) → pageNumber (1-indexed).
   * Used to determine which page each chunk belongs to.
   */
  pageMap: Map<number, number>;
}

// ============================================================================
// Page Marker Filtering
// ============================================================================

/**
 * Convert PDF page markers to HTML comments.
 * 
 * VLM parsers often produce "## Page N" headings which pollute the heading tree
 * and cause incorrect section assignments during semantic chunking.
 * 
 * This function:
 * - Converts "## Page N" headings to `<!-- pagebreak:N -->` HTML comments
 * - The chunker can parse these comments to track page numbers
 * - Returns count of markers converted
 */
function filterPageMarkers(markdown: string): { 
  result: string; 
  count: number; 
  pageMap: Map<number, number>;
} {
  const lines = markdown.split('\n');
  const pageMap = new Map<number, number>();
  let currentPage = 1;
  let count = 0;
  
  // Page marker patterns (capture page number)
  const pagePatterns = [
    /^#{1,6}\s*Page\s+(\d+)\s*$/i,   // ## Page 1
    /^Page\s+(\d+)\s*$/i,            // Page 1 (no heading)
    /^---\s*Page\s+(\d+)\s*---$/i,   // --- Page 1 ---
  ];
  
  // Convert page markers to HTML comments (preserves page info for chunker)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    
    for (const pattern of pagePatterns) {
      const match = line.match(pattern);
      if (match) {
        currentPage = parseInt(match[1]!, 10);
        // Convert to HTML comment that chunker can parse
        lines[i] = `<!-- pagebreak:${currentPage} -->`;
        count++;
        if (count <= 3) {
          logger.debug(`[PageMarker] Converted line ${i}: "${line}" -> page ${currentPage}`);
        }
        break;
      }
    }
    
    // Record current page for this line (for pageMap)
    pageMap.set(i, currentPage);
  }
  
  const result = lines.join('\n');
  
  return { result, count, pageMap };
}

// ============================================================================
// HTML Table to Markdown Conversion
// ============================================================================

/**
 * Convert HTML <table> elements to Markdown tables.
 * 
 * MinerU sometimes outputs HTML tables instead of markdown. This function
 * converts them to proper markdown format for better chunking and embedding.
 */
function convertHtmlTablesToMarkdown(markdown: string): { result: string; count: number } {
  let count = 0;
  
  // Match HTML tables (simplified parser)
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  
  const result = markdown.replace(tableRegex, (match, tableContent: string) => {
    try {
      count++;
      return htmlTableToMarkdown(tableContent);
    } catch (err) {
      logger.warn(`Failed to convert HTML table: ${err}`);
      return match; // Keep original on failure
    }
  });
  
  return { result, count };
}

/**
 * Convert HTML table content to markdown format.
 */
function htmlTableToMarkdown(html: string): string {
  const rows: string[][] = [];
  let hasHeader = false;
  
  // Extract rows (both <tr> with <th> and <td>)
  const rowMatches = html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  
  for (const rowMatch of rowMatches) {
    const rowContent = rowMatch[1] ?? '';
    const cells: string[] = [];
    
    // Check for header cells
    const headerCells = rowContent.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi);
    for (const cell of headerCells) {
      hasHeader = true;
      cells.push(cleanHtmlContent(cell[1] ?? ''));
    }
    
    // Check for data cells
    if (cells.length === 0) {
      const dataCells = rowContent.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi);
      for (const cell of dataCells) {
        cells.push(cleanHtmlContent(cell[1] ?? ''));
      }
    }
    
    if (cells.length > 0) {
      rows.push(cells);
    }
  }
  
  if (rows.length === 0) {
    return ''; // Empty table
  }
  
  // Build markdown table
  const maxCols = Math.max(...rows.map(r => r.length));
  const lines: string[] = [];
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    // Pad row to maxCols
    while (row.length < maxCols) {
      row.push('');
    }
    
    lines.push('| ' + row.join(' | ') + ' |');
    
    // Add separator after header (first row if hasHeader, or always after first row)
    if (i === 0) {
      const separator = '| ' + row.map(() => '---').join(' | ') + ' |';
      lines.push(separator);
    }
  }
  
  return '\n' + lines.join('\n') + '\n';
}

/**
 * Clean HTML content: remove tags, decode entities, normalize whitespace.
 */
function cleanHtmlContent(html: string): string {
  return html
    .replace(/<[^>]+>/g, '') // Remove HTML tags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================================
// Dehyphenation
// ============================================================================

/**
 * Fix PDF hyphenation artifacts.
 * 
 * PDFs often split words at line breaks with hyphens (e.g., "plan-\nning").
 * This function rejoins them for better embedding and search.
 * 
 * Uses pattern matching for common cases. For complex cases, LLM can be used.
 */
function dehyphenate(markdown: string, useLLM = false): { result: string; count: number } {
  let count = 0;
  
  // Pattern: word-\n followed by lowercase continuation
  // e.g., "plan-\nning" → "planning"
  // Be careful not to match legitimate hyphenated words like "state-of-the-art"
  const hyphenPattern = /(\b[a-zA-Z]+)-\n([a-z]+\b)/g;
  
  const result = markdown.replace(hyphenPattern, (match, part1: string, part2: string) => {
    // Skip if part2 starts with capital (likely sentence start)
    // Skip common prefixes that are often hyphenated
    const preserveHyphen = [
      'the', 'a', 'an', 'in', 'on', 'of', 'to', 'for', 'by', 'with',
      'art', 'art', 'time', 'based', 'driven', 'level', 'scale'
    ];
    
    if (preserveHyphen.includes(part2.toLowerCase())) {
      return match; // Keep as-is
    }
    
    count++;
    return part1 + part2;
  });
  
  return { result, count };
}

// ============================================================================
// Image Description (VLM) - Parallel Processing
// ============================================================================

/**
 * Generate VLM descriptions for images referenced in markdown.
 * Uses all available VLM configs for parallel processing (round-robin).
 * 
 * For each ![](images/xxx.jpg) reference:
 * 1. Read the image file from bundle
 * 2. Call VLM to generate a detailed description (parallel across configs)
 * 3. Insert the description as a searchable [Figure: ...] block
 * 
 * This makes image content searchable via embedding.
 */
async function describeImages(
  markdown: string,
  bundlePath?: string
): Promise<{ result: string; count: number }> {
  // Load VLM configs (reuses vlmConfigs array if available)
  const vlmConfigs = loadVlmConfigs();
  
  if (vlmConfigs.length === 0) {
    logger.debug('No VLM configured, skipping image description');
    return { result: markdown, count: 0 };
  }
  
  // Find image references
  const imagePattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const matches = [...markdown.matchAll(imagePattern)];
  
  if (matches.length === 0 || !bundlePath) {
    return { result: markdown, count: 0 };
  }
  
  // Filter images that need description
  interface ImageTask {
    fullMatch: string;
    altText: string;
    imagePath: string;
    resolvedPath: string;
  }
  
  const tasks: ImageTask[] = [];
  for (const match of matches) {
    const [fullMatch, altText, imagePath] = match;
    if (!fullMatch || !imagePath) continue;
    
    // Skip if already has description
    if (altText && altText.length > 20) continue;
    
    // Try to resolve image path
    const resolvedPath = resolveImagePath(bundlePath, imagePath);
    if (!resolvedPath) {
      logger.debug(`Cannot resolve image path: ${imagePath}`);
      continue;
    }
    
    tasks.push({ fullMatch, altText: altText ?? '', imagePath, resolvedPath });
  }
  
  if (tasks.length === 0) {
    return { result: markdown, count: 0 };
  }
  
  logger.info(`[Image Description] Processing ${tasks.length} images with ${vlmConfigs.length} VLM workers`);
  
  // Process all images in parallel using Promise.all with round-robin config assignment
  const results = await Promise.all(
    tasks.map(async (task, index) => {
      // Round-robin: assign each task to a different VLM config
      const config = vlmConfigs[index % vlmConfigs.length]!;
      
      try {
        const description = await callVlmForImage(task.resolvedPath, config);
        return { task, description };
      } catch (err) {
        logger.warn(`Failed to describe image ${task.imagePath}: ${err}`);
        return { task, description: null };
      }
    })
  );
  
  // Apply descriptions to markdown
  let result = markdown;
  let count = 0;
  
  for (const { task, description } of results) {
    if (description) {
      count++;
      const enhancedBlock = `${task.fullMatch}\n\n[Figure: ${description}]\n`;
      result = result.replace(task.fullMatch, enhancedBlock);
    }
  }
  
  logger.info(`[Image Description] Successfully described ${count}/${tasks.length} images`);
  return { result, count };
}

/**
 * Resolve image path relative to bundle.
 */
function resolveImagePath(bundlePath: string, imagePath: string): string | null {
  // Try direct path
  const direct = path.join(bundlePath, imagePath);
  if (fs.existsSync(direct)) {
    return direct;
  }
  
  // Try under repos/*/images (simple glob without dependency)
  try {
    const reposDir = path.join(bundlePath, 'repos');
    if (fs.existsSync(reposDir)) {
      const repos = fs.readdirSync(reposDir);
      for (const repo of repos) {
        const imgPath = path.join(reposDir, repo, 'images', path.basename(imagePath));
        if (fs.existsSync(imgPath)) {
          return imgPath;
        }
      }
    }
  } catch {
    // Ignore errors
  }
  
  return null;
}

/**
 * Call VLM API to generate image description.
 * @param imagePath - Path to image file
 * @param config - VLM worker config to use
 */
async function callVlmForImage(
  imagePath: string,
  config: VLMWorkerConfig
): Promise<string | null> {
  // Read and encode image
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');
  const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
  
  const prompt = `Describe this figure from a research paper. Include:
1. Type of visualization (chart, diagram, table, photo, etc.)
2. Main elements and their relationships
3. Key data points, labels, or text visible
4. What the figure is demonstrating or showing

Be specific and detailed. Output only the description, no preamble.`;

  try {
    const url = `${config.apiBase.replace(/\/$/, '')}/chat/completions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
            ],
          },
        ],
        temperature: 0.3,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(60000), // 60s timeout per image
    });
    
    if (!response.ok) {
      logger.warn(`VLM API error: ${response.status} from ${config.apiBase}`);
      return null;
    }
    
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (err) {
    logger.warn(`VLM request to ${config.apiBase} failed: ${err}`);
    return null;
  }
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Preprocess PDF markdown for optimal indexing quality.
 * 
 * This should be called BEFORE chunking, at index time.
 * All transformations are designed to improve:
 * - Retrieval quality (cleaner content, better embeddings)
 * - Citation accuracy (proper section structure)
 * - Search coverage (images become searchable text)
 * 
 * @param markdown - Raw markdown from MinerU/VLM parser
 * @param options - Preprocessing options
 * @returns Processed markdown with statistics
 */
export async function preprocessPdfMarkdown(
  markdown: string,
  options?: PreprocessOptions
): Promise<PreprocessResult> {
  const startTime = Date.now();
  const warnings: string[] = [];
  let result = markdown;
  let pageMap = new Map<number, number>();
  
  const stats = {
    pageMarkersRemoved: 0,
    tablesConverted: 0,
    imagesDescribed: 0,
    hyphenationsFixed: 0,
    processingTimeMs: 0,
  };
  
  try {
    // 1. Filter page markers (extracts pageMap BEFORE removing markers)
    const pageResult = filterPageMarkers(result);
    result = pageResult.result;
    pageMap = pageResult.pageMap;
    stats.pageMarkersRemoved = pageResult.count;
    if (pageResult.count > 0) {
      logger.debug(`Removed ${pageResult.count} page markers, extracted ${pageMap.size} line->page mappings`);
    }
    
    // 2. Convert HTML tables to Markdown
    const tableResult = convertHtmlTablesToMarkdown(result);
    result = tableResult.result;
    stats.tablesConverted = tableResult.count;
    if (tableResult.count > 0) {
      logger.debug(`Converted ${tableResult.count} HTML tables to Markdown`);
    }
    
    // 3. Dehyphenation
    const enableDehyphenation = options?.enableDehyphenation ?? true;
    if (enableDehyphenation) {
      const hyphenResult = dehyphenate(result, false);
      result = hyphenResult.result;
      stats.hyphenationsFixed = hyphenResult.count;
      if (hyphenResult.count > 0) {
        logger.debug(`Fixed ${hyphenResult.count} hyphenations`);
      }
    }
    
    // 4. Image description (async)
    const enableImageDescription = options?.enableImageDescription ?? true;
    if (enableImageDescription && options?.bundlePath) {
      const imageResult = await describeImages(result, options.bundlePath);
      result = imageResult.result;
      stats.imagesDescribed = imageResult.count;
      if (imageResult.count > 0) {
        logger.info(`Generated descriptions for ${imageResult.count} images`);
      }
    }
  } catch (err) {
    const msg = `Preprocessing error: ${err}`;
    logger.error(msg);
    warnings.push(msg);
  }
  
  stats.processingTimeMs = Date.now() - startTime;
  
  logger.info(
    `PDF preprocessing complete: ` +
    `${stats.pageMarkersRemoved} page markers, ` +
    `${stats.tablesConverted} tables, ` +
    `${stats.hyphenationsFixed} hyphenations, ` +
    `${stats.imagesDescribed} images ` +
    `(${stats.processingTimeMs}ms)`
  );
  
  return { markdown: result, stats, warnings, pageMap };
}
