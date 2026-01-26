/**
 * VLM PDF Parser
 *
 * Parses PDF documents using multiple Vision-Language Models in parallel.
 * Each page is assigned to a different VLM worker for concurrent processing,
 * significantly reducing total parsing time for multi-page documents.
 *
 * Configuration:
 * - Reads `vlmConfigs` array from ~/.preflight/config.json
 * - Each config should have: { apiBase, apiKey, model }
 * - Falls back to single VLM from main config if vlmConfigs not present
 *
 * Usage:
 * - Used when `vlmParser=true` option is set in preflight create command
 * - Alternative to MinerU for local VLM-based parsing
 *
 * @module parser/vlm-parser
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { getDocumentProxy, definePDFJSModule } from 'unpdf';
import { renderPageToBase64 } from './pdf/vlm-fallback.js';

// ============================================================================
// PDF.js Initialization
// ============================================================================

/**
 * Flag to track if PDF.js module has been initialized.
 * unpdf requires definePDFJSModule to be called before any operations.
 */
let pdfjsInitialized = false;

/**
 * Ensure PDF.js module is initialized with the legacy build.
 * This must be called before using any unpdf functions.
 */
async function ensurePDFJSInitialized(): Promise<void> {
  if (pdfjsInitialized) return;
  
  try {
    await definePDFJSModule(() => import('pdfjs-dist/legacy/build/pdf.mjs'));
    pdfjsInitialized = true;
  } catch (err) {
    // Log but continue - unpdf may still work with default worker
    console.warn('[vlm-parser] Failed to initialize PDF.js legacy module:', err);
  }
}
import { createModuleLogger } from '../logging/logger.js';
import type {
  IDocumentParser,
  ParseResult,
  ParsedContent,
  DocumentMetadata,
  ParseStats,
  ParseOptions,
  PdfParseOptions,
  SupportedFormat,
  ParsedContentType,
  ParseError,
} from './types.js';

const logger = createModuleLogger('vlm-parser');

// ============================================================================
// Error Messages for LLM
// ============================================================================

/**
 * User-friendly error messages explaining configuration issues.
 * These are designed to be clear for LLM context to help users diagnose problems.
 */
const LLM_ERRORS = {
  CONFIG_NOT_FOUND: `[VLM Parser Configuration Error]
No VLM configurations found. To use vlmParser=true, you need to configure VLM APIs.

Setup option 1 - Add vlmConfigs array to ~/.preflight/config.json:
{
  "vlmConfigs": [
    { "apiBase": "https://api.example.com/v1", "apiKey": "your-key", "model": "qwen3-vl-plus" }
  ]
}

Setup option 2 - Set environment variables:
  VLM_API_BASE, VLM_API_KEY, VLM_MODEL

Alternative: Remove vlmParser=true to use default MinerU parser (requires mineruApiBase config).`,

  CONFIG_INVALID_FORMAT: (path: string, error: string) => `[VLM Parser Configuration Error]
config.json at ${path} has invalid JSON format.

Error: ${error}

Please fix the JSON syntax in your config file.`,

  CONFIG_MISSING_FIELDS: (path: string, issues: string[]) => `[VLM Parser Configuration Error]
config.json at ${path} has incomplete vlmConfigs entries.

Issues found:
${issues.map(i => `  - ${i}`).join('\n')}

Each vlmConfigs entry must have: apiBase, apiKey, model`,

  ENDPOINT_UNREACHABLE: (apiBase: string, error: string) => `[VLM Parser Connection Error]
Cannot connect to VLM API endpoint: ${apiBase}

Error: ${error}

Possible causes:
  1. Network connectivity issue
  2. API endpoint URL is incorrect
  3. API service is down

Please verify your apiBase URL and network connection.`,

  ENDPOINT_AUTH_FAILED: (apiBase: string) => `[VLM Parser Authentication Error]
VLM API authentication failed for: ${apiBase}

Possible causes:
  1. API key is invalid or expired
  2. API key doesn't have required permissions

Please verify your apiKey in config.json.`,
} as const;

// ============================================================================
// Types
// ============================================================================

/**
 * Single VLM configuration for parallel processing.
 */
interface VLMWorkerConfig {
  apiBase: string;
  apiKey: string;
  model: string;
}

/**
 * Extended config file interface with vlmConfigs array.
 */
interface ExtendedConfigFile {
  vlmConfigs?: VLMWorkerConfig[];
  vlmApiBase?: string;
  vlmApiKey?: string;
  vlmModel?: string;
}

/**
 * Result from processing a single page.
 */
interface PageProcessResult {
  pageIndex: number;
  success: boolean;
  content?: string;
  error?: string;
  charCount: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Prompt for full page content extraction.
 * Optimized for academic papers with formulas, tables, and structured content.
 */
const FULL_PAGE_PROMPT = `Extract ALL content from this PDF page. Output clean Markdown directly.

Rules:
- Headings: Use # ## ### based on visual hierarchy
- Paragraphs: Plain text, preserve paragraph breaks
- Formulas: Use $...$ for inline, $$...$$ for display math. Use LaTeX syntax.
- Tables: Use Markdown table syntax with | and ---
- Lists: Use - or 1. 2. 3. format
- Figures/Charts/Diagrams: Describe in detail as [Figure: <type> - <detailed description of what the figure shows, including axes labels, data trends, key values, legend items>]
- Code blocks: Use triple backticks with language identifier
- Algorithm/Pseudocode: Extract as code block with "algorithm" or "pseudocode" language tag
- Keep reading order from top to bottom, left to right
- Do NOT wrap output in markdown code blocks (no \`\`\`markdown)
- Do NOT add any meta-commentary or explanation
- If page is blank, output "[Empty page]"`;

/**
 * Maximum concurrent VLM requests per batch.
 * With free VLM APIs (e.g., Qwen-VL), no need to throttle.
 * Process all pages in parallel for maximum speed.
 */
const MAX_CONCURRENT_REQUESTS = 100;

/**
 * Timeout for individual VLM requests in milliseconds.
 */
const VLM_REQUEST_TIMEOUT_MS = 120_000; // 2 minutes

// ============================================================================
// VLM Parser Implementation
// ============================================================================

/**
 * PDF parser using multiple VLMs in parallel.
 */
export class VlmParser implements IDocumentParser {
  readonly name = 'vlm-parallel';
  readonly supportedFormats: readonly SupportedFormat[] = ['.pdf'] as const;

  private vlmConfigs: VLMWorkerConfig[] = [];

  constructor() {
    this.loadVLMConfigs();
  }

  /** Configuration loading result for detailed error reporting */
  private configLoadError: string | null = null;
  private configPath: string | null = null;

  /**
   * Load VLM configurations from config file.
   * Supports both vlmConfigs array and single VLM fallback.
   * Stores detailed error information for LLM-friendly reporting.
   */
  private loadVLMConfigs(): void {
    try {
      // Try to load from config file
      const configPaths = [
        process.env.PREFLIGHT_CONFIG_PATH,
        path.join(os.homedir(), '.preflight', 'config.json'),
        path.join(os.homedir(), '.preflight-mcp', 'config.json'),
      ].filter(Boolean) as string[];

      for (const configPath of configPaths) {
        if (fs.existsSync(configPath)) {
          this.configPath = configPath;
          
          // Read and parse config with detailed error handling
          let content: string;
          let config: ExtendedConfigFile;
          
          try {
            content = fs.readFileSync(configPath, 'utf8');
          } catch (readErr) {
            this.configLoadError = `Cannot read config file: ${(readErr as Error).message}`;
            continue;
          }
          
          try {
            config = JSON.parse(content) as ExtendedConfigFile;
          } catch (parseErr) {
            this.configLoadError = LLM_ERRORS.CONFIG_INVALID_FORMAT(configPath, (parseErr as Error).message);
            logger.error(`Invalid JSON in config file: ${configPath}`);
            continue;
          }

          // Check for vlmConfigs array first
          if (config.vlmConfigs && Array.isArray(config.vlmConfigs)) {
            // Validate each entry and collect issues
            const validConfigs: VLMWorkerConfig[] = [];
            const issues: string[] = [];
            
            for (let i = 0; i < config.vlmConfigs.length; i++) {
              const c = config.vlmConfigs[i];
              const missing: string[] = [];
              if (!c?.apiBase) missing.push('apiBase');
              if (!c?.apiKey) missing.push('apiKey');
              if (!c?.model) missing.push('model');
              
              if (missing.length > 0) {
                issues.push(`vlmConfigs[${i}]: missing ${missing.join(', ')}`);
              } else {
                validConfigs.push(c as VLMWorkerConfig);
              }
            }
            
            if (issues.length > 0 && validConfigs.length === 0) {
              this.configLoadError = LLM_ERRORS.CONFIG_MISSING_FIELDS(configPath, issues);
              logger.warn(`vlmConfigs has invalid entries: ${issues.join('; ')}`);
            }
            
            if (validConfigs.length > 0) {
              this.vlmConfigs = validConfigs;
              logger.info(`[VLM Parser] Loaded ${this.vlmConfigs.length} VLM configs from ${configPath}`);
              this.configLoadError = null; // Clear any previous error
              return;
            }
          }

          // Fallback to single VLM config
          if (config.vlmApiBase && config.vlmApiKey) {
            this.vlmConfigs = [{
              apiBase: config.vlmApiBase,
              apiKey: config.vlmApiKey,
              model: config.vlmModel || 'qwen3-vl-plus',
            }];
            logger.info('[VLM Parser] Using single VLM config from config file');
            this.configLoadError = null;
            return;
          }
        }
      }

      // Final fallback: try environment variables
      const envApiBase = process.env.VLM_API_BASE || process.env.PREFLIGHT_VLM_API_BASE;
      const envApiKey = process.env.VLM_API_KEY || process.env.PREFLIGHT_VLM_API_KEY;
      if (envApiBase && envApiKey) {
        this.vlmConfigs = [{
          apiBase: envApiBase,
          apiKey: envApiKey,
          model: process.env.VLM_MODEL || process.env.PREFLIGHT_VLM_MODEL || 'qwen3-vl-plus',
        }];
        logger.info('[VLM Parser] Using VLM config from environment variables');
        this.configLoadError = null;
        return;
      }
      
      // No configuration found
      if (!this.configLoadError) {
        this.configLoadError = LLM_ERRORS.CONFIG_NOT_FOUND;
      }
    } catch (err) {
      this.configLoadError = `Failed to load VLM configs: ${(err as Error).message}`;
      logger.error('Failed to load VLM configs:', err instanceof Error ? err : undefined);
    }
  }
  
  /**
   * Check endpoint connectivity before processing.
   * Tests ALL VLM endpoints in parallel and filters out unavailable ones.
   * Returns ok if at least one endpoint is available.
   */
  async checkEndpointConnectivity(): Promise<{ ok: boolean; error?: string; availableCount?: number; failedEndpoints?: string[] }> {
    if (this.vlmConfigs.length === 0) {
      return { ok: false, error: this.configLoadError || LLM_ERRORS.CONFIG_NOT_FOUND };
    }
    
    // Test all endpoints in parallel
    const results = await Promise.all(
      this.vlmConfigs.map(async (config, index) => {
        const testUrl = `${config.apiBase}/models`;
        
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10_000); // 10s timeout
          
          const response = await fetch(testUrl, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${config.apiKey}`,
            },
            signal: controller.signal,
          });
          
          clearTimeout(timeoutId);
          
          if (response.status === 401 || response.status === 403) {
            return { index, ok: false, error: `Auth failed: ${config.apiBase}` };
          }
          
          // Any 2xx or 4xx (except auth) means endpoint is reachable
          if (response.ok || response.status === 404 || response.status === 405) {
            logger.info(`[VLM Parser] Endpoint ${index + 1} OK: ${config.apiBase}`);
            return { index, ok: true };
          }
          
          return { index, ok: false, error: `HTTP ${response.status}: ${config.apiBase}` };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const reason = errMsg.includes('abort') ? 'timeout' : errMsg;
          return { index, ok: false, error: `${reason}: ${config.apiBase}` };
        }
      })
    );
    
    // Filter available endpoints
    const available = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);
    const failedEndpoints = failed.map(r => r.error!);
    
    if (available.length === 0) {
      // All endpoints failed
      return {
        ok: false,
        error: `All ${this.vlmConfigs.length} VLM endpoints unavailable:\n${failedEndpoints.map(e => `  - ${e}`).join('\n')}`,
        failedEndpoints,
      };
    }
    
    // Keep only available endpoints
    if (failed.length > 0) {
      logger.warn(`[VLM Parser] ${failed.length}/${this.vlmConfigs.length} endpoints unavailable, using ${available.length} available`);
      // Reorder vlmConfigs to only include available ones
      this.vlmConfigs = available.map(r => this.vlmConfigs[r.index]!);
    }
    
    logger.info(`[VLM Parser] ${available.length} endpoints available for parallel processing`);
    return {
      ok: true,
      availableCount: available.length,
      failedEndpoints: failedEndpoints.length > 0 ? failedEndpoints : undefined,
    };
  }
  
  /**
   * Get detailed configuration status for LLM reporting.
   */
  getConfigStatus(): { configured: boolean; workerCount: number; error?: string; configPath?: string } {
    return {
      configured: this.vlmConfigs.length > 0,
      workerCount: this.vlmConfigs.length,
      error: this.configLoadError || undefined,
      configPath: this.configPath || undefined,
    };
  }

  /**
   * Check if this parser can handle the file.
   */
  canParse(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return this.supportedFormats.includes(ext as SupportedFormat);
  }

  /**
   * Check if VLM parsing is properly configured.
   */
  async checkInstallation(): Promise<boolean> {
    return this.vlmConfigs.length > 0;
  }

  /**
   * Parse a PDF document using parallel VLM processing.
   */
  async parse(filePath: string, options?: PdfParseOptions): Promise<ParseResult> {
    const startTime = Date.now();
    const errors: ParseError[] = [];
    const warnings: string[] = [];

    // Validate configuration with detailed error reporting
    if (this.vlmConfigs.length === 0) {
      const errorMsg = this.configLoadError || LLM_ERRORS.CONFIG_NOT_FOUND;
      return this.createErrorResult(
        filePath,
        startTime,
        'VLM_NOT_CONFIGURED',
        errorMsg
      );
    }
    
    // Check endpoint connectivity before processing
    const connectivity = await this.checkEndpointConnectivity();
    if (!connectivity.ok) {
      return this.createErrorResult(
        filePath,
        startTime,
        'VLM_ENDPOINT_UNREACHABLE',
        connectivity.error || 'Cannot connect to VLM API endpoint'
      );
    }

    // Check file exists
    if (!fs.existsSync(filePath)) {
      return this.createErrorResult(
        filePath,
        startTime,
        'FILE_NOT_FOUND',
        `File not found: ${filePath}`
      );
    }

    try {
      logger.info(`Parsing PDF with ${this.vlmConfigs.length} VLM workers: ${filePath}`);

      // Ensure PDF.js is initialized with legacy build before any unpdf calls
      await ensurePDFJSInitialized();

      // Read PDF and get page count
      const pdfBuffer = fs.readFileSync(filePath);
      const pdfData = new Uint8Array(pdfBuffer);
      const doc = await getDocumentProxy(pdfData);
      const numPages = doc.numPages;
      doc.cleanup();

      // Determine page range
      const startPage = options?.pageRange?.start ?? 0;
      const endPage = Math.min(options?.pageRange?.end ?? numPages - 1, numPages - 1);
      const maxPages = options?.maxPages ?? numPages;
      const pagesToProcess = Math.min(endPage - startPage + 1, maxPages);

      logger.info(`Processing ${pagesToProcess} pages (${startPage + 1} to ${startPage + pagesToProcess})`);

      // Render all pages first
      const pageImages = await this.renderAllPages(filePath, startPage, pagesToProcess, warnings);

      if (pageImages.size === 0) {
        return this.createErrorResult(
          filePath,
          startTime,
          'RENDER_FAILED',
          'Failed to render any PDF pages. The PDF may be corrupted or unsupported.'
        );
      }

      // Process pages in parallel batches
      const pageResults = await this.processPagesBatch(
        pageImages,
        startPage,
        pagesToProcess,
        errors,
        warnings
      );

      // Build contents from results
      const contents = this.buildContents(pageResults);
      const fullText = this.buildFullText(pageResults);

      // Extract metadata
      const metadata = this.extractMetadata(filePath, numPages, startTime);

      // Build statistics
      const stats = this.buildStats(contents, pageResults, startTime);

      // Add processing summary
      const successCount = pageResults.filter((r) => r.success).length;
      const failCount = pageResults.filter((r) => !r.success).length;
      warnings.push(`VLM processed ${successCount}/${pagesToProcess} pages successfully`);
      if (failCount > 0) {
        warnings.push(`${failCount} pages failed to process`);
      }

      return {
        success: true,
        contents,
        metadata,
        stats,
        fullText,
        errors: errors.length > 0 ? errors : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`VLM PDF parsing failed: ${errMsg}`);

      return this.createErrorResult(
        filePath,
        startTime,
        'PARSE_ERROR',
        errMsg
      );
    }
  }

  // ============================================================================
  // Page Rendering
  // ============================================================================

  /**
   * Render all pages to base64 images.
   */
  private async renderAllPages(
    pdfPath: string,
    startPage: number,
    pagesToProcess: number,
    warnings: string[]
  ): Promise<Map<number, string>> {
    const pageImages = new Map<number, string>();
    const pdfBuffer = fs.readFileSync(pdfPath);

    logger.info(`Rendering ${pagesToProcess} pages...`);

    for (let i = 0; i < pagesToProcess; i++) {
      const pageNum = startPage + i + 1; // 1-based for renderPageToBase64
      const pageIndex = startPage + i;

      try {
        // IMPORTANT: Create fresh Uint8Array for each render call
        // unpdf may detach ArrayBuffers when crossing worker boundaries
        const freshData = new Uint8Array(pdfBuffer);
        const imageBase64 = await renderPageToBase64(freshData, pageNum, 1.5);

        if (imageBase64) {
          pageImages.set(pageIndex, imageBase64);
        } else {
          warnings.push(`Page ${pageNum} rendered empty or failed`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        warnings.push(`Failed to render page ${pageNum}: ${errMsg}`);
      }
    }

    logger.info(`Rendered ${pageImages.size}/${pagesToProcess} pages`);
    return pageImages;
  }

  // ============================================================================
  // VLM Processing
  // ============================================================================

  /**
   * Process pages in parallel batches using multiple VLM workers.
   */
  private async processPagesBatch(
    pageImages: Map<number, string>,
    startPage: number,
    pagesToProcess: number,
    errors: ParseError[],
    warnings: string[]
  ): Promise<PageProcessResult[]> {
    const results: PageProcessResult[] = [];
    const pageIndices = Array.from(pageImages.keys()).sort((a, b) => a - b);

    // Calculate batch size based on VLM worker count
    const batchSize = Math.min(this.vlmConfigs.length, MAX_CONCURRENT_REQUESTS);

    logger.info(`Processing with batch size ${batchSize} (${this.vlmConfigs.length} VLM workers)`);

    for (let batchStart = 0; batchStart < pageIndices.length; batchStart += batchSize) {
      const batchIndices = pageIndices.slice(batchStart, batchStart + batchSize);

      // Create parallel promises for this batch
      const batchPromises = batchIndices.map(async (pageIndex, idx) => {
        const vlmConfig = this.vlmConfigs[idx % this.vlmConfigs.length]!;
        const imageBase64 = pageImages.get(pageIndex);

        if (!imageBase64) {
          return {
            pageIndex,
            success: false,
            error: 'No image data',
            charCount: 0,
          } as PageProcessResult;
        }

        try {
          const content = await this.callVLMWithTimeout(
            vlmConfig,
            imageBase64,
            pageIndex
          );

          return {
            pageIndex,
            success: true,
            content,
            charCount: content.length,
          } as PageProcessResult;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);

          errors.push({
            code: 'VLM_ERROR',
            message: `Page ${pageIndex + 1}: ${errMsg}`,
            pageIndex,
            recoverable: true,
          });

          return {
            pageIndex,
            success: false,
            error: errMsg,
            charCount: 0,
          } as PageProcessResult;
        }
      });

      // Wait for batch to complete
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Log progress
      const processed = Math.min(batchStart + batchSize, pageIndices.length);
      logger.info(`Processed ${processed}/${pageIndices.length} pages`);
    }

    return results;
  }

  /**
   * Call VLM API with timeout handling.
   */
  private async callVLMWithTimeout(
    config: VLMWorkerConfig,
    imageBase64: string,
    pageIndex: number
  ): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VLM_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${config.apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
              { type: 'text', text: FULL_PAGE_PROMPT },
            ],
          }],
          max_tokens: 8192,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`VLM API ${response.status}: ${errorText}`);
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const content = data.choices?.[0]?.message?.content?.trim() || '';

      // Validate content is not empty or just error message
      if (!content || content === '[Empty page]') {
        logger.debug(`Page ${pageIndex + 1} returned empty content`);
        return '';
      }

      return content;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ============================================================================
  // Result Building
  // ============================================================================

  /**
   * Build ParsedContent array from page results.
   */
  private buildContents(pageResults: PageProcessResult[]): ParsedContent[] {
    const contents: ParsedContent[] = [];

    for (const result of pageResults) {
      if (!result.success || !result.content) continue;

      // Parse markdown content into structured elements
      const pageContents = this.parseMarkdownContent(result.content, result.pageIndex);
      contents.push(...pageContents);
    }

    return contents;
  }

  /**
   * Parse markdown content into ParsedContent items.
   */
  private parseMarkdownContent(markdown: string, pageIndex: number): ParsedContent[] {
    const contents: ParsedContent[] = [];
    const lines = markdown.split('\n');
    let currentText = '';
    let inCodeBlock = false;
    let codeBlockLang = '';
    let codeBlockContent = '';
    let inTable = false;
    let tableLines: string[] = [];

    const flushText = () => {
      const trimmed = currentText.trim();
      if (trimmed) {
        contents.push({
          type: 'text',
          content: trimmed,
          pageIndex,
        });
      }
      currentText = '';
    };

    const flushTable = () => {
      if (tableLines.length > 0) {
        contents.push({
          type: 'table',
          content: tableLines.join('\n'),
          pageIndex,
        });
        tableLines = [];
      }
      inTable = false;
    };

    for (const line of lines) {
      // Code block handling
      if (line.startsWith('```')) {
        if (inCodeBlock) {
          // End code block
          contents.push({
            type: 'code_block',
            content: { code: codeBlockContent.trim(), language: codeBlockLang || undefined },
            pageIndex,
          });
          inCodeBlock = false;
          codeBlockContent = '';
          codeBlockLang = '';
        } else {
          // Start code block
          flushText();
          flushTable();
          inCodeBlock = true;
          codeBlockLang = line.slice(3).trim();
        }
        continue;
      }

      if (inCodeBlock) {
        codeBlockContent += line + '\n';
        continue;
      }

      // Table handling
      if (line.includes('|') && line.trim().startsWith('|')) {
        if (!inTable) {
          flushText();
          inTable = true;
        }
        tableLines.push(line);
        continue;
      } else if (inTable && line.trim() === '') {
        // Empty line may end table
        flushTable();
        continue;
      } else if (inTable) {
        // Non-table line ends table
        flushTable();
      }

      // Heading detection
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        flushText();
        contents.push({
          type: 'heading',
          content: headingMatch[2]!.trim(),
          pageIndex,
          metadata: { level: headingMatch[1]!.length },
        });
        continue;
      }

      // Display math ($$...$$)
      const displayMathMatch = line.match(/^\$\$(.+)\$\$$/);
      if (displayMathMatch) {
        flushText();
        contents.push({
          type: 'equation',
          content: displayMathMatch[1]!.trim(),
          pageIndex,
        });
        continue;
      }

      // Figure descriptions
      const figureMatch = line.match(/^\[Figure:\s*(.+)\]$/i);
      if (figureMatch) {
        flushText();
        contents.push({
          type: 'caption',
          content: figureMatch[1]!.trim(),
          pageIndex,
        });
        continue;
      }

      // Regular text
      currentText += line + '\n';
    }

    // Flush remaining content
    flushText();
    flushTable();

    return contents;
  }

  /**
   * Build full text from page results.
   */
  private buildFullText(pageResults: PageProcessResult[]): string {
    const parts: string[] = [];

    for (const result of pageResults.sort((a, b) => a.pageIndex - b.pageIndex)) {
      if (result.success && result.content) {
        parts.push(`\n---\n## Page ${result.pageIndex + 1}\n---\n\n${result.content}`);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Extract document metadata.
   */
  private extractMetadata(
    filePath: string,
    pageCount: number,
    startTime: number
  ): DocumentMetadata {
    const stats = fs.statSync(filePath);

    return {
      title: path.basename(filePath, path.extname(filePath)),
      pageCount,
      format: '.pdf',
      fileSizeBytes: stats.size,
      parser: this.name,
      parsedAt: new Date().toISOString(),
      extra: {
        vlmWorkerCount: this.vlmConfigs.length,
      },
    };
  }

  /**
   * Build parsing statistics.
   */
  private buildStats(
    contents: ParsedContent[],
    pageResults: PageProcessResult[],
    startTime: number
  ): ParseStats {
    const byType: Partial<Record<ParsedContentType, number>> = {};
    const byPage: Record<number, number> = {};

    for (const content of contents) {
      byType[content.type] = (byType[content.type] || 0) + 1;
      if (content.pageIndex !== undefined) {
        byPage[content.pageIndex] = (byPage[content.pageIndex] || 0) + 1;
      }
    }

    const totalChars = pageResults.reduce((sum, r) => sum + r.charCount, 0);

    return {
      totalItems: contents.length,
      byType,
      byPage: Object.keys(byPage).length > 0 ? byPage : undefined,
      parseTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Create an error result.
   */
  private createErrorResult(
    filePath: string,
    startTime: number,
    code: string,
    message: string
  ): ParseResult {
    return {
      success: false,
      contents: [],
      metadata: {
        format: '.pdf',
        parser: this.name,
        parsedAt: new Date().toISOString(),
      },
      stats: {
        totalItems: 0,
        byType: {},
        parseTimeMs: Date.now() - startTime,
      },
      errors: [{
        code,
        message,
        recoverable: false,
      }],
    };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new VLM parser instance.
 */
export function createVlmParser(): VlmParser {
  return new VlmParser();
}

// Default export
export default VlmParser;
