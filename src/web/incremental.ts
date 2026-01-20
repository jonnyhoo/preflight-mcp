/**
 * Incremental Update Module
 *
 * Multi-layer change detection for efficient web source updates:
 * 1. Sitemap lastmod - fast filter
 * 2. HTTP conditional requests (ETag/Last-Modified)
 * 3. Content hash comparison - final verification
 *
 * @module web/incremental
 */

import type {
  PageState,
  ConditionalFetchResult,
  SitemapEntry,
  CrawlProgressCallback,
} from './types.js';
import { normalizeUrl } from './normalizer.js';
import { isHtmlContentType, shouldSkipContentType } from './extractor.js';
import { fetchSitemapWithIndex, filterChangedBySitemap } from './sitemap.js';

// ============================================================================
// Default Thresholds
// ============================================================================

export const INCREMENTAL_DEFAULTS = {
  changedRatioThreshold: 0.5,
  errorRatioThreshold: 0.3,
  fullCrawlIntervalDays: 7,
} as const;

// ============================================================================
// Conditional Fetch
// ============================================================================

/**
 * Perform conditional HTTP request with ETag/Last-Modified headers.
 * Tries HEAD first, falls back to GET if HEAD not supported.
 */
export async function conditionalFetch(
  url: string,
  options: {
    timeout: number;
    userAgent: string;
    etag?: string;
    lastModified?: string;
  }
): Promise<ConditionalFetchResult> {
  const headers: Record<string, string> = {
    'User-Agent': options.userAgent,
  };

  // Add conditional headers
  if (options.etag) {
    headers['If-None-Match'] = options.etag;
  }
  if (options.lastModified) {
    headers['If-Modified-Since'] = options.lastModified;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers,
      redirect: 'follow',
    });

    clearTimeout(timeoutId);

    // 304 Not Modified
    if (response.status === 304) {
      return { status: 'not_modified' };
    }

    // 4xx/5xx errors
    if (!response.ok) {
      if (response.status === 404 || response.status === 410) {
        return { status: 'removed' };
      }
      return { status: 'error', error: `HTTP ${response.status}` };
    }

    // Check content type
    const contentType = response.headers.get('content-type');
    if (shouldSkipContentType(contentType)) {
      return { status: 'removed', error: `skipped content-type: ${contentType}` };
    }
    if (!isHtmlContentType(contentType)) {
      return { status: 'removed', error: `not HTML: ${contentType}` };
    }

    const html = await response.text();

    return {
      status: 'modified',
      etag: response.headers.get('etag') ?? undefined,
      lastModified: response.headers.get('last-modified') ?? undefined,
      html,
      finalUrl: response.url,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: message.includes('abort') ? 'timeout' : message };
  }
}

// ============================================================================
// Quick Change Detection (for checkForUpdates)
// ============================================================================

/**
 * Quick check if a web source likely has changes.
 * Used by checkForUpdates() for fast detection without full crawl.
 *
 * Strategy:
 * 1. Check sitemap lastmod (if available)
 * 2. HEAD request on a few sample URLs
 * 3. Conservative: returns true if uncertain
 */
export async function quickCheckForChanges(
  baseUrl: string,
  previousState: Map<string, PageState>,
  options: { timeout: number; userAgent: string }
): Promise<{ hasChanges: boolean; reason: string }> {
  if (previousState.size === 0) {
    return { hasChanges: true, reason: 'no_previous_state' };
  }

  // Try sitemap check first
  const sitemap = await fetchSitemapWithIndex(baseUrl, options);
  if (sitemap && sitemap.length > 0) {
    const { maybeChanged } = filterChangedBySitemap(sitemap, previousState);

    // Check for removed URLs
    const sitemapUrls = new Set(sitemap.map((e) => e.url));
    let removedCount = 0;
    for (const url of previousState.keys()) {
      if (!sitemapUrls.has(url)) removedCount++;
    }

    if (maybeChanged.length > 0 || removedCount > 0) {
      return {
        hasChanges: true,
        reason: `sitemap: ${maybeChanged.length} changed, ${removedCount} removed`,
      };
    }

    // Sitemap says all unchanged - still do a spot check
    const sampleUrls = Array.from(previousState.keys()).slice(0, 3);
    for (const url of sampleUrls) {
      const prev = previousState.get(url)!;
      const result = await conditionalFetch(prev.finalUrl ?? url, {
        ...options,
        etag: prev.etag,
        lastModified: prev.lastModified,
      });

      if (result.status === 'modified' || result.status === 'removed') {
        return { hasChanges: true, reason: `spot_check: ${url} ${result.status}` };
      }
    }

    return { hasChanges: false, reason: 'sitemap_unchanged_verified' };
  }

  // No sitemap - do spot check on sample URLs
  const sampleUrls = Array.from(previousState.keys()).slice(0, 5);
  for (const url of sampleUrls) {
    const prev = previousState.get(url)!;
    const result = await conditionalFetch(prev.finalUrl ?? url, {
      ...options,
      etag: prev.etag,
      lastModified: prev.lastModified,
    });

    if (result.status === 'modified' || result.status === 'removed') {
      return { hasChanges: true, reason: `spot_check: ${url} ${result.status}` };
    }
  }

  // Conservative: if no sitemap and spot check passed, still report maybe changed
  // (we can't know if new pages were added)
  return { hasChanges: true, reason: 'no_sitemap_conservative' };
}

// ============================================================================
// URL Discovery
// ============================================================================

/**
 * Discover URLs for incremental crawl.
 * Combines sitemap URLs with previously known URLs.
 */
export async function discoverUrls(
  baseUrl: string,
  previousState: Map<string, PageState>,
  options: { timeout: number; userAgent: string }
): Promise<{
  urls: Set<string>;
  sitemapEntries: Map<string, SitemapEntry>;
  hasSitemap: boolean;
}> {
  const urls = new Set<string>();
  const sitemapEntries = new Map<string, SitemapEntry>();

  // Try to get sitemap
  const sitemap = await fetchSitemapWithIndex(baseUrl, options);
  const hasSitemap = sitemap !== null && sitemap.length > 0;

  if (sitemap) {
    for (const entry of sitemap) {
      urls.add(entry.url);
      sitemapEntries.set(entry.url, entry);
    }
  }

  // Include all previously known URLs
  for (const url of previousState.keys()) {
    urls.add(url);
  }

  // Always include base URL
  try {
    urls.add(normalizeUrl(baseUrl));
  } catch {
    // Invalid base URL
  }

  return { urls, sitemapEntries, hasSitemap };
}

// ============================================================================
// Change Classification
// ============================================================================

export type UrlClassification = {
  /** New URLs not in previous state */
  added: string[];
  /** URLs to check (sitemap says changed or no sitemap info) */
  toCheck: string[];
  /** URLs sitemap says unchanged (still need hash verification) */
  sitemapUnchanged: string[];
  /** URLs in previous state but not in current sitemap/discovery */
  removed: string[];
};

/**
 * Classify URLs based on sitemap and previous state.
 */
export function classifyUrls(
  currentUrls: Set<string>,
  sitemapEntries: Map<string, SitemapEntry>,
  previousState: Map<string, PageState>
): UrlClassification {
  const added: string[] = [];
  const toCheck: string[] = [];
  const sitemapUnchanged: string[] = [];
  const removed: string[] = [];

  // Classify current URLs
  for (const url of currentUrls) {
    const prev = previousState.get(url);
    const sitemap = sitemapEntries.get(url);

    if (!prev) {
      // New URL
      added.push(url);
      continue;
    }

    if (sitemap?.lastmod) {
      // Have sitemap lastmod - compare
      const sitemapDate = new Date(sitemap.lastmod).getTime();
      const fetchedDate = new Date(prev.fetchedAt).getTime();

      if (!isNaN(sitemapDate) && sitemapDate <= fetchedDate) {
        // Sitemap says unchanged
        sitemapUnchanged.push(url);
        continue;
      }
    }

    // Need to check via HTTP
    toCheck.push(url);
  }

  // Find removed URLs
  for (const url of previousState.keys()) {
    if (!currentUrls.has(url)) {
      removed.push(url);
    }
  }

  return { added, toCheck, sitemapUnchanged, removed };
}

// ============================================================================
// Degradation Check
// ============================================================================

/**
 * Check if incremental update should degrade to full crawl.
 */
export function shouldDegradeToFull(params: {
  totalUrls: number;
  changedCount: number;
  errorCount: number;
  changedRatioThreshold: number;
  errorRatioThreshold: number;
}): { degrade: boolean; reason?: string } {
  const { totalUrls, changedCount, errorCount, changedRatioThreshold, errorRatioThreshold } = params;

  if (totalUrls === 0) {
    return { degrade: false };
  }

  const changedRatio = changedCount / totalUrls;
  const errorRatio = errorCount / totalUrls;

  if (changedRatio > changedRatioThreshold) {
    return {
      degrade: true,
      reason: `changed_ratio_exceeded: ${(changedRatio * 100).toFixed(1)}% > ${changedRatioThreshold * 100}%`,
    };
  }

  if (errorRatio > errorRatioThreshold) {
    return {
      degrade: true,
      reason: `error_ratio_exceeded: ${(errorRatio * 100).toFixed(1)}% > ${errorRatioThreshold * 100}%`,
    };
  }

  return { degrade: false };
}
