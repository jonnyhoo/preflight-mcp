/**
 * Web Source Ingestion Module
 *
 * Handles crawling and ingesting web documentation sources into bundles.
 * Part of the "Bundle Anything" initiative.
 *
 * @module bundle/web-ingest
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { PreflightConfig } from '../config.js';
import type { IngestedFile } from './ingest.js';
import type { SkippedFileEntry } from './manifest.js';
import { getBundlePaths } from './paths.js';
import { ensureDir, nowIso, rmIfExists } from './utils.js';
import {
  crawlWebsite,
  generateSafeId,
  urlToFilename,
  type WebCrawlConfig,
  type CrawlResult,
} from '../web/index.js';

// ============================================================================
// Types
// ============================================================================

export type WebIngestResult = {
  /** Repo ID in format 'web/{safeId}' */
  repoId: string;
  /** Ingested markdown files */
  files: IngestedFile[];
  /** Skipped URLs with reasons */
  skipped: SkippedFileEntry[];
  /** Non-fatal warnings (e.g., Readability failures) */
  warnings: string[];
  /** Crawl process notes */
  notes: string[];
  /** Content fingerprint (hash of all page hashes) */
  contentHash: string;
  /** Number of pages crawled */
  pageCount: number;
  /** Source type */
  source: 'crawl';
  /** Whether llms.txt fast path was used */
  usedLlmsTxt: boolean;
  /** Base URL that was crawled */
  baseUrl: string;
};

// ============================================================================
// Utilities
// ============================================================================

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Write web source metadata JSON.
 */
async function writeWebMeta(params: {
  metaPath: string;
  repoId: string;
  baseUrl: string;
  fetchedAt: string;
  pageCount: number;
  skipped: number;
  contentHash: string;
  usedLlmsTxt: boolean;
  llmsTxtVariant?: string;
  crawlTimeMs: number;
}): Promise<void> {
  await ensureDir(path.dirname(params.metaPath));

  const meta = {
    repoId: params.repoId,
    source: 'crawl',
    baseUrl: params.baseUrl,
    fetchedAt: params.fetchedAt,
    pageCount: params.pageCount,
    skipped: params.skipped,
    contentHash: params.contentHash,
    usedLlmsTxt: params.usedLlmsTxt,
    llmsTxtVariant: params.llmsTxtVariant,
    crawlTimeMs: params.crawlTimeMs,
  };

  await fs.writeFile(params.metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

// ============================================================================
// Main Ingest Function
// ============================================================================

/**
 * Ingest a web source into a bundle.
 *
 * Signature aligned with cloneAndIngestGitHubRepo for consistent integration.
 */
export async function ingestWebSource(params: {
  cfg: PreflightConfig;
  bundleRoot: string;
  url: string;
  config?: WebCrawlConfig;
  onProgress?: (msg: string) => void;
}): Promise<WebIngestResult> {
  const { cfg, bundleRoot, url, config, onProgress } = params;

  // Generate safe ID for this web source
  const safeId = generateSafeId(url);
  const repoId = `web/${safeId}`;

  onProgress?.(`Starting web crawl: ${url}`);

  // Crawl the website
  const crawlConfig: WebCrawlConfig = {
    baseUrl: url,
    maxPages: config?.maxPages ?? 500,
    maxDepth: config?.maxDepth ?? 5,
    includePatterns: config?.includePatterns,
    excludePatterns: config?.excludePatterns,
    rateLimit: config?.rateLimit ?? 200,
    concurrency: config?.concurrency ?? 3,
    timeout: config?.timeout ?? 30000,
    userAgent: config?.userAgent,
    skipLlmsTxt: config?.skipLlmsTxt ?? false,
    respectRobotsTxt: config?.respectRobotsTxt ?? true,
  };

  const crawlResult: CrawlResult = await crawlWebsite(crawlConfig, (progress) => {
    onProgress?.(`[${progress.phase}] ${progress.current}/${progress.total}: ${progress.message}`);
  });

  onProgress?.(`Crawl complete: ${crawlResult.pages.length} pages, ${crawlResult.skipped.length} skipped`);

  // Prepare output directories
  // Structure: repos/web/{safeId}/norm/
  const webRepoDir = path.join(bundleRoot, 'repos', 'web', safeId);
  const normDir = path.join(webRepoDir, 'norm');

  // Clear existing content before writing (prevents stale pages on update)
  await rmIfExists(webRepoDir);
  await ensureDir(normDir);

  const files: IngestedFile[] = [];
  const skipped: SkippedFileEntry[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  // Track content hashes for fingerprint
  const contentHashes: string[] = [];

  // Write crawled pages as markdown files
  for (const page of crawlResult.pages) {
    try {
      // Generate filename from URL
      const filename = urlToFilename(page.url);
      const normPath = path.join(normDir, filename);

      // Ensure parent directory exists (for nested paths like /docs/api/index.md)
      await ensureDir(path.dirname(normPath));

      // Build markdown content with metadata header
      const mdContent = [
        '---',
        `title: "${page.title.replace(/"/g, '\\"')}"`,
        `url: "${page.url}"`,
        `fetched_at: "${page.fetchedAt}"`,
        '---',
        '',
        page.content,
      ].join('\n');

      // Write file
      await fs.writeFile(normPath, mdContent, 'utf8');

      // Track for indexing
      const stat = await fs.stat(normPath);
      const bundleRelPath = `repos/web/${safeId}/norm/${filename}`;

      files.push({
        repoId,
        kind: 'doc',
        repoRelativePath: filename,
        bundleNormRelativePath: bundleRelPath,
        bundleNormAbsPath: normPath,
        sha256: page.contentHash,
        bytes: stat.size,
      });

      contentHashes.push(page.contentHash);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to write page ${page.url}: ${errMsg}`);
    }
  }

  // Convert skipped URLs to SkippedFileEntry format
  // Note: SkippedFileEntry.reason is limited to specific types, so we preserve
  // the original reason in notes and use 'binary' as a catch-all category
  for (const skip of crawlResult.skipped) {
    skipped.push({
      path: skip.url,
      reason: 'binary', // SkippedFileEntry has limited reason types
    });
    // Preserve original skip reason in notes for transparency
    notes.push(`Skipped: ${skip.url} (${skip.reason})`);
  }

  // Compute overall content fingerprint
  contentHashes.sort();
  const contentHash = sha256Text(contentHashes.join(':'));

  // Add crawl notes
  notes.push(`Crawled ${crawlResult.pages.length} pages from ${crawlResult.domain}`);
  if (crawlResult.usedLlmsTxt) {
    notes.push(`Used llms.txt fast path (${crawlResult.llmsTxtVariant})`);
  }
  notes.push(`Crawl time: ${crawlResult.stats.timeMs}ms`);

  // Write metadata
  const metaPath = path.join(webRepoDir, 'meta.json');
  await writeWebMeta({
    metaPath,
    repoId,
    baseUrl: url,
    fetchedAt: nowIso(),
    pageCount: crawlResult.pages.length,
    skipped: crawlResult.skipped.length,
    contentHash,
    usedLlmsTxt: crawlResult.usedLlmsTxt,
    llmsTxtVariant: crawlResult.llmsTxtVariant,
    crawlTimeMs: crawlResult.stats.timeMs,
  });

  return {
    repoId,
    files,
    skipped,
    warnings,
    notes,
    contentHash,
    pageCount: crawlResult.pages.length,
    source: 'crawl',
    usedLlmsTxt: crawlResult.usedLlmsTxt,
    baseUrl: url,
  };
}
