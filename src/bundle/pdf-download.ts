/**
 * PDF Download Module
 *
 * Handles downloading remote PDF files to local storage for processing.
 * Downloads are cached based on URL hash to avoid redundant downloads.
 *
 * @module bundle/pdf-download
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';

import { createModuleLogger } from '../logging/logger.js';
import { ensureDir, isPathAvailable } from './utils.js';

const logger = createModuleLogger('pdf-download');

// ============================================================================
// Types
// ============================================================================

/**
 * Result of a PDF download operation.
 */
export interface PdfDownloadResult {
  /** Whether the download succeeded */
  success: boolean;
  /** Local file path where PDF was saved */
  localPath?: string;
  /** Original URL */
  url: string;
  /** File size in bytes */
  fileSize?: number;
  /** Whether the file was served from cache */
  cached: boolean;
  /** Error message if download failed */
  error?: string;
  /** Content hash (SHA256) of the downloaded file */
  contentHash?: string;
}

/**
 * Options for PDF download.
 */
export interface PdfDownloadOptions {
  /** Timeout in milliseconds (default: 60000) */
  timeoutMs?: number;
  /** Maximum file size in bytes (default: 100MB) */
  maxSizeBytes?: number;
  /** Force re-download even if cached (default: false) */
  forceRefresh?: boolean;
  /** Custom User-Agent header */
  userAgent?: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100MB
const DEFAULT_USER_AGENT = 'preflight-mcp/1.0 (PDF Downloader)';

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Generate a deterministic filename from a URL.
 * Uses SHA256 hash of the URL for uniqueness.
 */
function urlToFilename(url: string): string {
  const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
  // Try to extract original filename from URL
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/');
    const lastPart = pathParts[pathParts.length - 1];
    if (lastPart && lastPart.toLowerCase().endsWith('.pdf')) {
      // Sanitize filename
      const sanitized = lastPart.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 50);
      return `${hash}_${sanitized}`;
    }
  } catch {
    // Ignore URL parsing errors
  }
  return `${hash}.pdf`;
}

/**
 * Compute SHA256 hash of a file.
 */
async function computeFileHash(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Get file size.
 */
async function getFileSize(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath);
  return stat.size;
}

// ============================================================================
// Download Function
// ============================================================================

/**
 * Download a PDF from a URL to local storage.
 *
 * Features:
 * - Caches downloads based on URL hash
 * - Supports HTTP and HTTPS
 * - Handles redirects
 * - Validates content type
 * - Size limits to prevent abuse
 *
 * @param url - URL of the PDF to download
 * @param downloadsDir - Directory to store downloaded PDFs
 * @param options - Download options
 * @returns Download result with local file path
 */
export async function downloadPdfToLocal(
  url: string,
  downloadsDir: string,
  options?: PdfDownloadOptions
): Promise<PdfDownloadResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const forceRefresh = options?.forceRefresh ?? false;
  const userAgent = options?.userAgent ?? DEFAULT_USER_AGENT;

  const filename = urlToFilename(url);
  const localPath = path.join(downloadsDir, filename);

  logger.info(`Downloading PDF: ${url} -> ${localPath}`);

  try {
    // Ensure downloads directory exists
    await ensureDir(downloadsDir);

    // Check if already cached
    if (!forceRefresh && await isPathAvailable(localPath)) {
      const fileSize = await getFileSize(localPath);
      const contentHash = await computeFileHash(localPath);
      logger.info(`Using cached PDF: ${localPath} (${fileSize} bytes)`);
      return {
        success: true,
        localPath,
        url,
        fileSize,
        cached: true,
        contentHash,
      };
    }

    // Download the file
    const result = await downloadFile(url, localPath, {
      timeoutMs,
      maxSizeBytes,
      userAgent,
    });

    if (!result.success) {
      return {
        success: false,
        url,
        cached: false,
        error: result.error,
      };
    }

    const fileSize = await getFileSize(localPath);
    const contentHash = await computeFileHash(localPath);

    logger.info(`Downloaded PDF: ${localPath} (${fileSize} bytes)`);

    return {
      success: true,
      localPath,
      url,
      fileSize,
      cached: false,
      contentHash,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to download PDF: ${url}`, error instanceof Error ? error : undefined);
    return {
      success: false,
      url,
      cached: false,
      error: errMsg,
    };
  }
}

/**
 * Internal download function using Node.js http/https modules.
 */
async function downloadFile(
  url: string,
  destPath: string,
  options: {
    timeoutMs: number;
    maxSizeBytes: number;
    userAgent: string;
    redirectCount?: number;
  }
): Promise<{ success: boolean; error?: string }> {
  const { timeoutMs, maxSizeBytes, userAgent, redirectCount = 0 } = options;

  // Prevent infinite redirects
  if (redirectCount > 5) {
    return { success: false, error: 'Too many redirects' };
  }

  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const transport = isHttps ? https : http;

      const requestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'User-Agent': userAgent,
          'Accept': 'application/pdf,*/*',
        },
        timeout: timeoutMs,
      };

      const req = transport.request(requestOptions, async (res) => {
        // Handle redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).toString();
          logger.info(`Following redirect: ${redirectUrl}`);
          const result = await downloadFile(redirectUrl, destPath, {
            ...options,
            redirectCount: redirectCount + 1,
          });
          resolve(result);
          return;
        }

        // Check status code
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          resolve({ success: false, error: `HTTP ${res.statusCode}: ${res.statusMessage}` });
          return;
        }

        // Check content type (allow missing content-type for some servers)
        const contentType = res.headers['content-type']?.toLowerCase() ?? '';
        if (contentType && !contentType.includes('pdf') && !contentType.includes('octet-stream')) {
          // Log warning but don't fail - some servers send wrong content-type
          logger.warn(`Unexpected content-type: ${contentType}, proceeding anyway`);
        }

        // Check content length if available
        const contentLength = parseInt(res.headers['content-length'] ?? '0', 10);
        if (contentLength > maxSizeBytes) {
          resolve({ success: false, error: `File too large: ${contentLength} bytes (max: ${maxSizeBytes})` });
          return;
        }

        // Stream to file with size checking
        const chunks: Buffer[] = [];
        let totalSize = 0;

        res.on('data', (chunk: Buffer) => {
          totalSize += chunk.length;
          if (totalSize > maxSizeBytes) {
            req.destroy();
            resolve({ success: false, error: `File too large: exceeded ${maxSizeBytes} bytes` });
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', async () => {
          try {
            const buffer = Buffer.concat(chunks);
            
            // Basic PDF validation - check magic bytes
            if (buffer.length < 4 || buffer.slice(0, 4).toString() !== '%PDF') {
              resolve({ success: false, error: 'Downloaded file is not a valid PDF' });
              return;
            }

            await fs.writeFile(destPath, buffer);
            resolve({ success: true });
          } catch (err) {
            resolve({ success: false, error: `Failed to write file: ${err}` });
          }
        });

        res.on('error', (err) => {
          resolve({ success: false, error: `Response error: ${err.message}` });
        });
      });

      req.on('error', (err) => {
        resolve({ success: false, error: `Request error: ${err.message}` });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: `Request timed out after ${timeoutMs}ms` });
      });

      req.end();
    } catch (err) {
      resolve({ success: false, error: `URL parsing error: ${err}` });
    }
  });
}

/**
 * Clean up old downloads based on age.
 *
 * @param downloadsDir - Directory containing downloads
 * @param maxAgeMs - Maximum age in milliseconds (default: 7 days)
 * @returns Number of files cleaned up
 */
export async function cleanupOldDownloads(
  downloadsDir: string,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000
): Promise<number> {
  let cleanedCount = 0;

  try {
    const files = await fs.readdir(downloadsDir);
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(downloadsDir, file);
      try {
        const stat = await fs.stat(filePath);
        if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
          await fs.unlink(filePath);
          cleanedCount++;
          logger.info(`Cleaned up old download: ${file}`);
        }
      } catch {
        // Ignore individual file errors
      }
    }
  } catch {
    // Ignore directory errors
  }

  return cleanedCount;
}
