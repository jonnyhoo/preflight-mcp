/**
 * MinerU PDF Parser
 *
 * High-quality PDF parsing using MinerU API (https://mineru.net).
 * Supports:
 * - Local PDF files (uploaded to API)
 * - Remote PDF URLs (passed directly to API)
 * - Extraction of text, formulas, tables, images as structured Markdown
 *
 * API Flow:
 * 1. Submit file/URL → get task_id
 * 2. Poll task status until complete
 * 3. Download and extract result (zip with markdown + assets)
 *
 * @module parser/mineru-parser
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { getConfig } from '../config.js';
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

const logger = createModuleLogger('mineru-parser');

// ============================================================================
// Types
// ============================================================================

/** MinerU API task status */
type MineruTaskStatus = 'pending' | 'running' | 'done' | 'failed';

/** MinerU API response for file-urls/batch (get upload URLs) */
interface MineruFileUrlsResponse {
  code: number;
  msg: string;
  data?: {
    batch_id: string;
    /** Array of pre-signed upload URLs (one per file in request) */
    file_urls: string[];
  };
}

/** MinerU API response for task submission (URL-based) */
interface MineruSubmitResponse {
  code: number;
  msg: string;
  data?: {
    task_id: string;
  };
}

/** MinerU API response for batch status */
interface MineruBatchStatusResponse {
  code: number;
  msg: string;
  data?: {
    batch_id: string;
    extract_result: Array<{
      file_name: string;
      state: MineruTaskStatus;
      err_msg?: string;
      full_zip_url?: string;
      extract_progress?: {
        extracted_pages: number;
        total_pages: number;
        start_time: string;
      };
    }>;
  };
}

/** MinerU API response for task status (single task) */
interface MineruStatusResponse {
  code: number;
  msg: string;
  data?: {
    state: MineruTaskStatus;
    progress?: number;
    err_msg?: string;
    full_zip_url?: string;
    result_url?: string;
  };
}

/** MinerU parser configuration */
interface MineruConfig {
  apiBase: string;
  apiKey: string;
  timeoutMs: number;
  pollIntervalMs: number;
  enabled: boolean;
}

// ============================================================================
// MinerU Parser Implementation
// ============================================================================

/**
 * MinerU-based PDF parser using cloud API.
 */
export class MineruParser implements IDocumentParser {
  readonly name = 'mineru';
  readonly supportedFormats: readonly SupportedFormat[] = ['.pdf'] as const;

  private config: MineruConfig;

  constructor() {
    const cfg = getConfig();
    this.config = {
      apiBase: cfg.mineruApiBase,
      apiKey: cfg.mineruApiKey ?? '',
      timeoutMs: cfg.mineruTimeoutMs,
      pollIntervalMs: cfg.mineruPollIntervalMs,
      enabled: cfg.mineruEnabled,
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
   * Check if MinerU is properly configured.
   */
  async checkInstallation(): Promise<boolean> {
    return this.config.enabled && Boolean(this.config.apiKey);
  }

  /**
   * Parse a local PDF file using MinerU API.
   */
  async parse(filePath: string, options?: PdfParseOptions): Promise<ParseResult> {
    const startTime = Date.now();

    // Validate configuration
    if (!this.config.enabled || !this.config.apiKey) {
      return this.createErrorResult(
        filePath,
        startTime,
        'MINERU_NOT_CONFIGURED',
        'MinerU API is not configured. Set mineruApiKey in config.'
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
      logger.info(`Parsing PDF with MinerU: ${filePath}`);

      // Submit file to MinerU API (returns batch_id)
      const submitResult = await this.submitLocalFile(filePath, options);
      if (!submitResult) {
        return this.createErrorResult(
          filePath,
          startTime,
          'SUBMIT_FAILED',
          'Failed to submit file to MinerU API'
        );
      }

      logger.info(`MinerU batch submitted: ${submitResult.batchId}`);

      // Poll for batch completion
      const result = await this.pollBatchStatus(submitResult.batchId, submitResult.fileName);
      if (!result.success) {
        return this.createErrorResult(
          filePath,
          startTime,
          'TASK_FAILED',
          result.error ?? 'MinerU task failed'
        );
      }

      // Download and parse result
      const parseResult = await this.downloadAndParseResult(
        result.downloadUrl!,
        filePath,
        startTime,
        options
      );

      return parseResult;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`MinerU parsing failed: ${errMsg}`, error instanceof Error ? error : undefined);
      return this.createErrorResult(filePath, startTime, 'PARSE_ERROR', errMsg);
    }
  }

  /**
   * Parse a remote PDF URL using MinerU API.
   * This is more efficient as MinerU can fetch the URL directly.
   */
  async parseUrl(url: string, options?: PdfParseOptions): Promise<ParseResult> {
    const startTime = Date.now();

    // Validate configuration
    if (!this.config.enabled || !this.config.apiKey) {
      return this.createErrorResult(
        url,
        startTime,
        'MINERU_NOT_CONFIGURED',
        'MinerU API is not configured. Set mineruApiKey in config.'
      );
    }

    try {
      logger.info(`Parsing PDF URL with MinerU: ${url}`);

      // Submit URL to MinerU API
      const taskId = await this.submitUrl(url, options);
      if (!taskId) {
        return this.createErrorResult(
          url,
          startTime,
          'SUBMIT_FAILED',
          'Failed to submit URL to MinerU API'
        );
      }

      logger.info(`MinerU task submitted: ${taskId}`);

      // Poll for completion
      const result = await this.pollTaskStatus(taskId);
      if (!result.success) {
        return this.createErrorResult(
          url,
          startTime,
          'TASK_FAILED',
          result.error ?? 'MinerU task failed'
        );
      }

      // Download and parse result
      const parseResult = await this.downloadAndParseResult(
        result.downloadUrl!,
        url,
        startTime,
        options
      );

      return parseResult;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`MinerU URL parsing failed: ${errMsg}`, error instanceof Error ? error : undefined);
      return this.createErrorResult(url, startTime, 'PARSE_ERROR', errMsg);
    }
  }

  // ============================================================================
  // API Methods
  // ============================================================================

  /**
   * Submit a local file to MinerU API.
   * 
   * API Flow:
   * 1. Call /api/v4/file-urls/batch to get an upload URL
   * 2. Upload the file to the returned URL via PUT
   * 3. Return batch_id for status polling
   */
  private async submitLocalFile(
    filePath: string,
    _options?: PdfParseOptions
  ): Promise<{ batchId: string; fileName: string } | null> {
    const fileName = path.basename(filePath);
    const dataId = crypto.randomUUID();

    try {
      // Step 1: Request upload URL from MinerU
      logger.info(`Requesting upload URL for: ${fileName}`);
      
      const urlResponse = await fetch(`${this.config.apiBase}/api/v4/file-urls/batch`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          files: [
            { name: fileName, data_id: dataId }
          ],
          model_version: 'vlm',
          enable_formula: true,
          enable_table: true,
        }),
      });

      if (!urlResponse.ok) {
        const text = await urlResponse.text();
        logger.error(`MinerU get upload URL failed: ${urlResponse.status} - ${text}`);
        return null;
      }

      const urlData = await urlResponse.json() as MineruFileUrlsResponse;
      if (urlData.code !== 0 || !urlData.data?.batch_id || !urlData.data?.file_urls?.length) {
        logger.error(`MinerU get upload URL error: ${urlData.msg}`);
        return null;
      }

      const batchId = urlData.data.batch_id;
      const uploadUrl = urlData.data.file_urls[0]!;

      logger.info(`Got batch_id: ${batchId}, uploading file...`);

      // Step 2: Upload file to the returned URL
      // Note: Do NOT set Content-Type header as per MinerU API docs
      const fileBuffer = fs.readFileSync(filePath);
      
      const uploadResponse = await fetch(uploadUrl, {
        method: 'PUT',
        body: fileBuffer,
      });

      if (!uploadResponse.ok) {
        const text = await uploadResponse.text();
        logger.error(`MinerU file upload failed: ${uploadResponse.status} - ${text}`);
        return null;
      }

      logger.info(`File uploaded successfully, batch_id: ${batchId}`);
      return { batchId, fileName };
    } catch (error) {
      logger.error('MinerU submit request failed:', error instanceof Error ? error : undefined);
      return null;
    }
  }

  /**
   * Submit a URL to MinerU API.
   */
  private async submitUrl(
    url: string,
    options?: PdfParseOptions
  ): Promise<string | null> {
    const payload: Record<string, unknown> = {
      url,
      model_version: 'vlm',
      is_ocr: options?.method === 'ocr',
      enable_formula: options?.extractEquations ?? true,
      enable_table: options?.extractTables ?? true,
      language: options?.language ?? 'ch',
    };

    if (options?.pageRange) {
      payload.page_ranges = `${options.pageRange.start + 1}-${options.pageRange.end + 1}`;
    }

    try {
      const response = await fetch(`${this.config.apiBase}/api/v4/extract/task`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.error(`MinerU URL submit failed: ${response.status} - ${text}`);
        return null;
      }

      const data = await response.json() as MineruSubmitResponse;
      if (data.code !== 0 || !data.data?.task_id) {
        logger.error(`MinerU URL submit error: ${data.msg}`);
        return null;
      }

      return data.data.task_id;
    } catch (error) {
      logger.error('MinerU URL submit request failed:', error instanceof Error ? error : undefined);
      return null;
    }
  }

  /**
   * Poll task status until completion or timeout.
   */
  private async pollTaskStatus(
    taskId: string
  ): Promise<{ success: boolean; downloadUrl?: string; error?: string }> {
    const startTime = Date.now();
    const timeout = this.config.timeoutMs;
    const pollInterval = this.config.pollIntervalMs;

    while (Date.now() - startTime < timeout) {
      try {
        const response = await fetch(
          `${this.config.apiBase}/api/v4/extract/task/${taskId}`,
          {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${this.config.apiKey}`,
            },
          }
        );

        if (!response.ok) {
          const text = await response.text();
          logger.warn(`MinerU status check failed: ${response.status} - ${text}`);
          await this.sleep(pollInterval);
          continue;
        }

        const data = await response.json() as MineruStatusResponse;

        if (data.code !== 0) {
          logger.warn(`MinerU status error: ${data.msg}`);
          await this.sleep(pollInterval);
          continue;
        }

        const state = data.data?.state;
        const progress = data.data?.progress ?? 0;

        logger.debug(`MinerU task ${taskId}: ${state} (${progress}%)`);

        if (state === 'done') {
          const downloadUrl = data.data?.full_zip_url ?? data.data?.result_url;
          if (!downloadUrl) {
            return { success: false, error: 'No download URL in completed task' };
          }
          return { success: true, downloadUrl };
        }

        if (state === 'failed') {
          return { success: false, error: data.data?.err_msg ?? 'Task failed' };
        }

        // Continue polling for pending/running states
        await this.sleep(pollInterval);
      } catch (error) {
        logger.warn('MinerU status check error:', error instanceof Error ? error : undefined);
        await this.sleep(pollInterval);
      }
    }

    return { success: false, error: `Task timed out after ${timeout}ms` };
  }

  /**
   * Poll batch status until completion or timeout.
   * Used for local file uploads which use batch_id instead of task_id.
   */
  private async pollBatchStatus(
    batchId: string,
    fileName: string
  ): Promise<{ success: boolean; downloadUrl?: string; error?: string }> {
    const startTime = Date.now();
    const timeout = this.config.timeoutMs;
    const pollInterval = this.config.pollIntervalMs;

    while (Date.now() - startTime < timeout) {
      try {
        const response = await fetch(
          `${this.config.apiBase}/api/v4/extract-results/batch/${batchId}`,
          {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${this.config.apiKey}`,
            },
          }
        );

        if (!response.ok) {
          const text = await response.text();
          logger.warn(`MinerU batch status check failed: ${response.status} - ${text}`);
          await this.sleep(pollInterval);
          continue;
        }

        const data = await response.json() as MineruBatchStatusResponse;

        if (data.code !== 0) {
          logger.warn(`MinerU batch status error: ${data.msg}`);
          await this.sleep(pollInterval);
          continue;
        }

        // Find our file in the batch results
        const fileResult = data.data?.extract_result?.find(r => r.file_name === fileName);
        if (!fileResult) {
          logger.warn(`File ${fileName} not found in batch results, waiting...`);
          await this.sleep(pollInterval);
          continue;
        }

        const state = fileResult.state;
        const progress = fileResult.extract_progress;

        if (progress) {
          logger.debug(`MinerU batch ${batchId}: ${state} (${progress.extracted_pages}/${progress.total_pages} pages)`);
        } else {
          logger.debug(`MinerU batch ${batchId}: ${state}`);
        }

        if (state === 'done') {
          const downloadUrl = fileResult.full_zip_url;
          if (!downloadUrl) {
            return { success: false, error: 'No download URL in completed batch' };
          }
          return { success: true, downloadUrl };
        }

        if (state === 'failed') {
          return { success: false, error: fileResult.err_msg ?? 'Batch task failed' };
        }

        // Continue polling for pending/running states
        await this.sleep(pollInterval);
      } catch (error) {
        logger.warn('MinerU batch status check error:', error instanceof Error ? error : undefined);
        await this.sleep(pollInterval);
      }
    }

    return { success: false, error: `Batch timed out after ${timeout}ms` };
  }

  /**
   * Download result and parse into ParseResult format.
   */
  private async downloadAndParseResult(
    downloadUrl: string,
    sourcePath: string,
    startTime: number,
    options?: PdfParseOptions
  ): Promise<ParseResult> {
    try {
      // Download the result
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        return this.createErrorResult(
          sourcePath,
          startTime,
          'DOWNLOAD_FAILED',
          `Failed to download result: ${response.status}`
        );
      }

      const contentType = response.headers.get('content-type') ?? '';
      const isZip = contentType.includes('zip') || downloadUrl.endsWith('.zip');

      let markdown: string;
      let assets: Map<string, Buffer> = new Map();

      if (isZip) {
        // Extract zip content
        const zipBuffer = Buffer.from(await response.arrayBuffer());
        const extracted = await this.extractZip(zipBuffer);
        markdown = extracted.markdown;
        assets = extracted.assets;
      } else {
        // Direct markdown response
        markdown = await response.text();
      }

      // Parse markdown into structured content
      const contents = this.parseMarkdownContent(markdown, assets, options);

      // Build metadata
      const metadata: DocumentMetadata = {
        title: this.extractTitleFromMarkdown(markdown) ?? path.basename(sourcePath, '.pdf'),
        format: '.pdf',
        parser: this.name,
        parsedAt: new Date().toISOString(),
        extra: {
          mineruTaskUrl: downloadUrl,
          hasAssets: assets.size > 0,
        },
      };

      // Build stats
      const stats = this.buildStats(contents, startTime);

      return {
        success: true,
        contents,
        metadata,
        stats,
        fullText: markdown,
        warnings: assets.size > 0 ? [`Extracted ${assets.size} assets from PDF`] : undefined,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return this.createErrorResult(sourcePath, startTime, 'RESULT_PARSE_ERROR', errMsg);
    }
  }

  // ============================================================================
  // Parsing Helpers
  // ============================================================================

  /**
   * Extract zip file contents.
   * Returns markdown content and asset files.
   */
  private async extractZip(
    zipBuffer: Buffer
  ): Promise<{ markdown: string; assets: Map<string, Buffer> }> {
    // Try to use yauzl for zip extraction
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const yauzl = await import('yauzl') as any;
      return await new Promise((resolve, reject) => {
        yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (err: Error | null, zipFile: any) => {
          if (err || !zipFile) {
            reject(err ?? new Error('Failed to open zip'));
            return;
          }

          let markdown = '';
          const assets = new Map<string, Buffer>();

          zipFile.readEntry();
          zipFile.on('entry', (entry: any) => {
            const fileName = entry.fileName as string;
            if (/\/$/.test(fileName)) {
              // Directory entry, skip
              zipFile.readEntry();
            } else {
              zipFile.openReadStream(entry, (streamErr: Error | null, readStream: any) => {
                if (streamErr || !readStream) {
                  zipFile.readEntry();
                  return;
                }

                const chunks: Buffer[] = [];
                readStream.on('data', (chunk: Buffer) => chunks.push(chunk));
                readStream.on('end', () => {
                  const content = Buffer.concat(chunks);
                  const lowerFileName = fileName.toLowerCase();

                  if (lowerFileName.endsWith('.md') || lowerFileName.endsWith('.markdown')) {
                    markdown += content.toString('utf8') + '\n';
                  } else if (/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(lowerFileName)) {
                    assets.set(fileName, content);
                  }

                  zipFile.readEntry();
                });
              });
            }
          });

          zipFile.on('end', () => {
            resolve({ markdown, assets });
          });

          zipFile.on('error', reject);
        });
      });
    } catch {
      // Fallback: try to find markdown in raw buffer (simple heuristic)
      logger.warn('yauzl not available, attempting basic extraction');
      const text = zipBuffer.toString('utf8');
      const mdMatch = text.match(/^#[^\n]+[\s\S]+/m);
      return {
        markdown: mdMatch ? mdMatch[0] : text,
        assets: new Map(),
      };
    }
  }

  /**
   * Parse MinerU markdown output into structured ParsedContent.
   */
  private parseMarkdownContent(
    markdown: string,
    assets: Map<string, Buffer>,
    _options?: PdfParseOptions
  ): ParsedContent[] {
    const contents: ParsedContent[] = [];
    const lines = markdown.split('\n');

    let currentText = '';
    let inCodeBlock = false;
    let codeBlockLang = '';
    let codeBlockContent = '';
    let inTable = false;
    let tableLines: string[] = [];
    let pageIndex = 0;

    for (const line of lines) {
      // Track page markers (MinerU may include these)
      const pageMatch = line.match(/^<!--\s*page[:\s]+(\d+)\s*-->/i);
      if (pageMatch) {
        pageIndex = parseInt(pageMatch[1]!, 10) - 1;
        continue;
      }

      // Code block handling
      if (line.startsWith('```')) {
        if (!inCodeBlock) {
          // Start of code block
          if (currentText.trim()) {
            contents.push(this.createTextContent(currentText, pageIndex));
            currentText = '';
          }
          inCodeBlock = true;
          codeBlockLang = line.slice(3).trim();
          codeBlockContent = '';
        } else {
          // End of code block
          contents.push({
            type: 'code_block',
            content: {
              code: codeBlockContent.trim(),
              language: codeBlockLang || undefined,
            },
            pageIndex,
          });
          inCodeBlock = false;
          codeBlockLang = '';
          codeBlockContent = '';
        }
        continue;
      }

      if (inCodeBlock) {
        codeBlockContent += line + '\n';
        continue;
      }

      // Table handling
      if (line.startsWith('|') && line.endsWith('|')) {
        if (!inTable) {
          if (currentText.trim()) {
            contents.push(this.createTextContent(currentText, pageIndex));
            currentText = '';
          }
          inTable = true;
          tableLines = [];
        }
        tableLines.push(line);
        continue;
      } else if (inTable) {
        // End of table
        contents.push(this.createTableContent(tableLines, pageIndex));
        inTable = false;
        tableLines = [];
      }

      // Equation handling (LaTeX blocks)
      const blockLatexMatch = line.match(/^\$\$([\s\S]*?)\$\$/);
      if (blockLatexMatch) {
        if (currentText.trim()) {
          contents.push(this.createTextContent(currentText, pageIndex));
          currentText = '';
        }
        contents.push({
          type: 'equation',
          content: blockLatexMatch[1]!.trim(),
          pageIndex,
        });
        continue;
      }

      // Heading handling
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        if (currentText.trim()) {
          contents.push(this.createTextContent(currentText, pageIndex));
          currentText = '';
        }
        contents.push({
          type: 'heading',
          content: headingMatch[2]!.trim(),
          pageIndex,
          metadata: { level: headingMatch[1]!.length },
        });
        continue;
      }

      // Image handling
      const imgMatch = line.match(/!\[([^\]]*)\]\(([^)]+)\)/);
      if (imgMatch) {
        if (currentText.trim()) {
          contents.push(this.createTextContent(currentText, pageIndex));
          currentText = '';
        }
        const imgPath = imgMatch[2]!;
        const imgData = assets.get(imgPath);
        contents.push({
          type: 'image',
          content: imgData
            ? `data:image/png;base64,${imgData.toString('base64')}`
            : imgPath,
          pageIndex,
          captions: imgMatch[1] ? [imgMatch[1]] : undefined,
        });
        continue;
      }

      // Regular text
      currentText += line + '\n';
    }

    // Handle remaining content
    if (inTable && tableLines.length > 0) {
      contents.push(this.createTableContent(tableLines, pageIndex));
    }
    if (currentText.trim()) {
      contents.push(this.createTextContent(currentText, pageIndex));
    }

    return contents;
  }

  /**
   * Create text content from accumulated text.
   */
  private createTextContent(text: string, pageIndex: number): ParsedContent {
    const trimmed = text.trim();
    // Check if it's a list
    if (/^[-*+]\s|^\d+\.\s/m.test(trimmed)) {
      return { type: 'list', content: trimmed, pageIndex };
    }
    return { type: 'text', content: trimmed, pageIndex };
  }

  /**
   * Create table content from markdown table lines.
   */
  private createTableContent(lines: string[], pageIndex: number): ParsedContent {
    const rows: string[][] = [];
    let headers: string[] | undefined;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Skip separator line
      if (/^\|[\s-:|]+\|$/.test(line)) continue;

      const cells = line
        .split('|')
        .slice(1, -1) // Remove first and last empty parts
        .map(c => c.trim());

      if (i === 0) {
        headers = cells;
      } else {
        rows.push(cells);
      }
    }

    return {
      type: 'table',
      content: {
        headers,
        rows,
        rowCount: rows.length,
        colCount: headers?.length ?? (rows[0]?.length ?? 0),
        markdown: lines.join('\n'),
      },
      pageIndex,
    };
  }

  /**
   * Extract title from markdown content.
   */
  private extractTitleFromMarkdown(markdown: string): string | undefined {
    const match = markdown.match(/^#\s+(.+)$/m);
    return match ? match[1]!.trim() : undefined;
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Create an error result.
   */
  private createErrorResult(
    sourcePath: string,
    startTime: number,
    code: string,
    message: string
  ): ParseResult {
    const error: ParseError = {
      code,
      message,
      recoverable: false,
    };

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
      errors: [error],
    };
  }

  /**
   * Build parsing statistics.
   */
  private buildStats(contents: ParsedContent[], startTime: number): ParseStats {
    const byType: Partial<Record<ParsedContentType, number>> = {};
    const byPage: Record<number, number> = {};

    for (const content of contents) {
      byType[content.type] = (byType[content.type] || 0) + 1;
      if (content.pageIndex !== undefined) {
        byPage[content.pageIndex] = (byPage[content.pageIndex] || 0) + 1;
      }
    }

    return {
      totalItems: contents.length,
      byType,
      byPage: Object.keys(byPage).length > 0 ? byPage : undefined,
      parseTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Sleep for specified milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new MinerU parser instance.
 */
export function createMineruParser(): MineruParser {
  return new MineruParser();
}

/**
 * Check if MinerU parsing is available.
 */
export function isMineruAvailable(): boolean {
  const cfg = getConfig();
  return cfg.mineruEnabled && Boolean(cfg.mineruApiKey);
}

// Default export
export default MineruParser;
