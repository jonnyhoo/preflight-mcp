/**
 * Web Crawler Module
 *
 * BFS-based web crawler with:
 * - Concurrent requests with p-limit
 * - Rate limiting
 * - robots.txt support
 * - llms.txt fast path
 *
 * @module web/crawler
 */

import pLimit from 'p-limit';
import type {
  WebCrawlConfig,
  CrawledPage,
  CrawlResult,
  CrawlProgressCallback,
  PageState,
  IncrementalCrawlResult,
  SpaOptions,
} from './types.js';
import { validateWebUrl, normalizeUrl, matchesPatterns } from './normalizer.js';
import { fetchAndParseLlmsTxt } from './llms-txt.js';
import { extractPage, isHtmlContentType, shouldSkipContentType, cleanMarkdown } from './extractor.js';
import { createPageState, needsFullCrawl } from './page-state.js';
import {
  conditionalFetch,
  discoverUrls,
  classifyUrls,
  shouldDegradeToFull,
  INCREMENTAL_DEFAULTS,
} from './incremental.js';
import { fetchUrlWithBrowser, closeBrowser, looksLikeSpa } from './spa-fetcher.js';

/** Default configuration values */
const DEFAULTS = {
  maxPages: 500,
  maxDepth: 5,
  rateLimit: 200,
  concurrency: 3,
  timeout: 30000,
  userAgent: 'Preflight-Web-Crawler/1.0 (+https://github.com/jonnyhoo/preflight-mcp)',
  respectRobotsTxt: true,
  skipLlmsTxt: false,
  useSpa: false,
} as const;

/**
 * Sleep for a given duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch and parse robots.txt for a domain.
 */
/** Robot interface from robots-parser */
interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined;
  isDisallowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
}

async function fetchRobotsTxt(
  origin: string,
  options: { timeout: number; userAgent: string }
): Promise<Robot | null> {
  const robotsUrl = `${origin}/robots.txt`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout);

    const response = await fetch(robotsUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': options.userAgent },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    const text = await response.text();
    // Dynamic import for robots-parser (CommonJS module with incomplete types)
    const robotsParserModule = await import('robots-parser') as unknown as { default: (url: string, content: string) => Robot };
    return robotsParserModule.default(robotsUrl, text);
  } catch {
    // robots.txt not available or parse failed - allow crawling
    return null;
  }
}

/**
 * Fetch a single URL and return HTML content.
 *
 * @param url - URL to fetch
 * @param options - Fetch options including SPA mode
 */
async function fetchUrl(
  url: string,
  options: {
    timeout: number;
    userAgent: string;
    useSpa?: boolean;
    spaOptions?: SpaOptions;
  }
): Promise<{ html: string; finalUrl: string } | { error: string }> {
  // Use browser-based fetch for SPA mode
  if (options.useSpa) {
    return fetchUrlWithBrowser(url, {
      timeout: options.timeout,
      userAgent: options.userAgent,
      spaOptions: options.spaOptions,
    });
  }

  // Standard HTTP fetch for non-SPA
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout);

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': options.userAgent },
      redirect: 'follow',
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { error: `HTTP ${response.status}: ${response.statusText}` };
    }

    // Check content type
    const contentType = response.headers.get('content-type');

    if (shouldSkipContentType(contentType)) {
      return { error: `skipped content-type: ${contentType}` };
    }

    if (!isHtmlContentType(contentType)) {
      return { error: `not HTML: ${contentType}` };
    }

    const html = await response.text();
    const finalUrl = response.url; // After redirects

    return { html, finalUrl };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('abort')) {
      return { error: 'timeout' };
    }
    return { error: message };
  }
}

/**
 * Main crawl function.
 *
 * Implements BFS with optional llms.txt fast path:
 * 1. Check for llms.txt - if found and valid, crawl listed URLs
 * 2. Otherwise, BFS from baseUrl discovering links
 */
export async function crawlWebsite(
  config: WebCrawlConfig,
  onProgress?: CrawlProgressCallback
): Promise<CrawlResult> {
  const startTime = Date.now();

  // Apply defaults
  const cfg = {
    baseUrl: config.baseUrl,
    maxPages: config.maxPages ?? DEFAULTS.maxPages,
    maxDepth: config.maxDepth ?? DEFAULTS.maxDepth,
    rateLimit: config.rateLimit ?? DEFAULTS.rateLimit,
    concurrency: config.concurrency ?? DEFAULTS.concurrency,
    timeout: config.timeout ?? DEFAULTS.timeout,
    userAgent: config.userAgent ?? DEFAULTS.userAgent,
    respectRobotsTxt: config.respectRobotsTxt ?? DEFAULTS.respectRobotsTxt,
    skipLlmsTxt: config.skipLlmsTxt ?? DEFAULTS.skipLlmsTxt,
    useSpa: config.useSpa ?? DEFAULTS.useSpa,
    spaOptions: config.spaOptions,
    includePatterns: config.includePatterns,
    excludePatterns: config.excludePatterns,
  };

  // Validate base URL
  validateWebUrl(cfg.baseUrl);
  const baseUrlNormalized = normalizeUrl(cfg.baseUrl);
  const { origin } = new URL(baseUrlNormalized);

  const pages: CrawledPage[] = [];
  const skipped: Array<{ url: string; reason: string }> = [];
  const visited = new Set<string>();

  // Fetch robots.txt if needed
  let robots: Robot | null = null;
  if (cfg.respectRobotsTxt) {
    onProgress?.({ phase: 'detecting', current: 0, total: 0, message: 'Checking robots.txt...' });
    robots = await fetchRobotsTxt(origin, { timeout: cfg.timeout, userAgent: cfg.userAgent });
  }

  // Helper to check if URL is allowed by robots.txt
  const isAllowedByRobots = (url: string): boolean => {
    if (!robots) return true;
    return robots.isAllowed(url, cfg.userAgent) !== false;
  };

  // Try llms.txt fast path
  let usedLlmsTxt = false;
  let llmsTxtVariant: CrawlResult['llmsTxtVariant'];
  let urlsToProcess: Array<{ url: string; depth: number }> = [];

  if (!cfg.skipLlmsTxt) {
    onProgress?.({ phase: 'detecting', current: 0, total: 0, message: 'Checking for llms.txt...' });

    const llmsTxt = await fetchAndParseLlmsTxt(baseUrlNormalized, {
      timeout: cfg.timeout,
      userAgent: cfg.userAgent,
      maxUrls: cfg.maxPages,
    });

    if (llmsTxt && llmsTxt.urls.length > 0) {
      usedLlmsTxt = true;
      llmsTxtVariant = llmsTxt.variant;
      urlsToProcess = llmsTxt.urls.map((url) => ({ url, depth: 0 }));
      onProgress?.({
        phase: 'detecting',
        current: 0,
        total: llmsTxt.urls.length,
        message: `Found ${llmsTxt.variant} with ${llmsTxt.urls.length} URLs`,
      });
    }
  }

  // If no llms.txt, start BFS from baseUrl
  if (urlsToProcess.length === 0) {
    urlsToProcess = [{ url: baseUrlNormalized, depth: 0 }];
  }

  // Create concurrency limiter
  const limit = pLimit(cfg.concurrency);

  // BFS queue
  const queue: Array<{ url: string; depth: number }> = [...urlsToProcess];
  let processedCount = 0;

  // Process queue
  while (queue.length > 0 && pages.length < cfg.maxPages) {
    // Take a batch of URLs
    const batchSize = Math.min(cfg.concurrency, cfg.maxPages - pages.length, queue.length);
    const batch = queue.splice(0, batchSize);

    // Process batch concurrently
    const results = await Promise.all(
      batch.map(({ url, depth }) =>
        limit(async () => {
          const normalized = normalizeUrl(url);

          // Skip if already visited
          if (visited.has(normalized)) {
            return { url: normalized, result: 'already_visited' as const };
          }
          visited.add(normalized);

          // Check robots.txt
          if (!isAllowedByRobots(normalized)) {
            skipped.push({ url: normalized, reason: 'blocked_by_robots_txt' });
            return { url: normalized, result: 'blocked' as const };
          }

          // Check patterns
          if (!matchesPatterns(normalized, { include: cfg.includePatterns, exclude: cfg.excludePatterns })) {
            skipped.push({ url: normalized, reason: 'pattern_mismatch' });
            return { url: normalized, result: 'pattern_mismatch' as const };
          }

          // Fetch URL
          const fetchResult = await fetchUrl(normalized, {
            timeout: cfg.timeout,
            userAgent: cfg.userAgent,
            useSpa: cfg.useSpa,
            spaOptions: cfg.spaOptions,
          });

          if ('error' in fetchResult) {
            skipped.push({ url: normalized, reason: fetchResult.error });
            return { url: normalized, result: 'fetch_error' as const, error: fetchResult.error };
          }

          // Extract content
          try {
            const page = extractPage(fetchResult.html, fetchResult.finalUrl);
            page.content = cleanMarkdown(page.content);

            // Mark finalUrl as visited too (handles redirects)
            const normalizedFinalUrl = normalizeUrl(fetchResult.finalUrl);
            if (normalizedFinalUrl !== normalized) {
              visited.add(normalizedFinalUrl);
            }

            // Add discovered links to queue (BFS)
            if (!usedLlmsTxt && depth < cfg.maxDepth) {
              for (const link of page.links) {
                const normalizedLink = normalizeUrl(link);
                if (!visited.has(normalizedLink)) {
                  queue.push({ url: normalizedLink, depth: depth + 1 });
                }
              }
            }

            return { url: normalized, result: 'success' as const, page, depth };
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            skipped.push({ url: normalized, reason: `extraction_error: ${errMsg}` });
            return { url: normalized, result: 'extraction_error' as const, error: errMsg };
          }
        })
      )
    );

    // Collect successful pages
    for (const r of results) {
      if (r.result === 'success' && r.page) {
        pages.push(r.page);
        processedCount++;
        onProgress?.({
          phase: 'crawling',
          current: processedCount,
          total: usedLlmsTxt ? urlsToProcess.length : cfg.maxPages,
          message: `Crawled: ${r.page.title || r.url}`,
        });
      }
    }

    // Rate limiting between batches
    if (queue.length > 0 && pages.length < cfg.maxPages) {
      await sleep(cfg.rateLimit);
    }
  }

  // Close browser if SPA mode was used
  if (cfg.useSpa) {
    await closeBrowser();
  }

  // Final stats
  const timeMs = Date.now() - startTime;

  return {
    domain: new URL(baseUrlNormalized).hostname,
    baseUrl: baseUrlNormalized,
    pages,
    skipped,
    stats: {
      totalUrls: visited.size,
      crawled: pages.length,
      skipped: skipped.length,
      timeMs,
    },
    usedLlmsTxt,
    llmsTxtVariant,
  };
}

/**
 * Crawl a list of specific URLs (for llms.txt fast path).
 *
 * @param urls - List of URLs to crawl
 * @param config - Partial config (userAgent, timeout, etc.)
 * @param onProgress - Progress callback
 */
export async function crawlUrls(
  urls: string[],
  config: Partial<WebCrawlConfig>,
  onProgress?: CrawlProgressCallback
): Promise<CrawlResult> {
  const startTime = Date.now();

  const cfg = {
    timeout: config.timeout ?? DEFAULTS.timeout,
    userAgent: config.userAgent ?? DEFAULTS.userAgent,
    rateLimit: config.rateLimit ?? DEFAULTS.rateLimit,
    concurrency: config.concurrency ?? DEFAULTS.concurrency,
    useSpa: config.useSpa ?? DEFAULTS.useSpa,
    spaOptions: config.spaOptions,
  };

  const pages: CrawledPage[] = [];
  const skipped: Array<{ url: string; reason: string }> = [];
  const visited = new Set<string>();

  const limit = pLimit(cfg.concurrency);

  let processedCount = 0;
  const totalUrls = urls.length;

  // Process all URLs
  const results = await Promise.all(
    urls.map((url) =>
      limit(async () => {
        try {
          validateWebUrl(url);
        } catch (err) {
          skipped.push({ url, reason: `invalid_url: ${err instanceof Error ? err.message : String(err)}` });
          return null;
        }

        const normalized = normalizeUrl(url);
        if (visited.has(normalized)) {
          return null;
        }
        visited.add(normalized);

        const fetchResult = await fetchUrl(normalized, {
          timeout: cfg.timeout,
          userAgent: cfg.userAgent,
          useSpa: cfg.useSpa,
          spaOptions: cfg.spaOptions,
        });

        if ('error' in fetchResult) {
          skipped.push({ url: normalized, reason: fetchResult.error });
          return null;
        }

        try {
          const page = extractPage(fetchResult.html, fetchResult.finalUrl);
          page.content = cleanMarkdown(page.content);

          processedCount++;
          onProgress?.({
            phase: 'crawling',
            current: processedCount,
            total: totalUrls,
            message: `Crawled: ${page.title || normalized}`,
          });

          // Rate limiting
          await sleep(cfg.rateLimit);

          return page;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          skipped.push({ url: normalized, reason: `extraction_error: ${errMsg}` });
          return null;
        }
      })
    )
  );

  // Collect results
  for (const page of results) {
    if (page) {
      pages.push(page);
    }
  }

  // Close browser if SPA mode was used
  if (cfg.useSpa) {
    await closeBrowser();
  }

  const timeMs = Date.now() - startTime;
  const baseUrl = urls[0] ?? '';
  let domain = '';
  try {
    domain = new URL(baseUrl).hostname;
  } catch {
    // ignore
  }

  return {
    domain,
    baseUrl,
    pages,
    skipped,
    stats: {
      totalUrls: urls.length,
      crawled: pages.length,
      skipped: skipped.length,
      timeMs,
    },
    usedLlmsTxt: true, // crawlUrls is typically used after llms.txt detection
  };
}

// ============================================================================
// Incremental Crawl
// ============================================================================

/**
 * Incremental crawl with multi-layer change detection.
 *
 * Layers:
 * 1. Sitemap lastmod - skip unchanged URLs
 * 2. HTTP conditional requests - 304 means unchanged
 * 3. Content hash - final verification after extraction
 *
 * Degrades to full crawl if:
 * - No previous state
 * - Too many changes (>50%)
 * - Too many errors (>30%)
 * - Periodic full crawl interval exceeded
 */
export async function crawlWebsiteIncremental(
  config: WebCrawlConfig,
  previousState: Map<string, PageState>,
  lastFullCrawlAt: string | null,
  onProgress?: CrawlProgressCallback
): Promise<IncrementalCrawlResult> {
  const startTime = Date.now();

  // Apply defaults
  const cfg = {
    baseUrl: config.baseUrl,
    maxPages: config.maxPages ?? DEFAULTS.maxPages,
    rateLimit: config.rateLimit ?? DEFAULTS.rateLimit,
    concurrency: config.concurrency ?? DEFAULTS.concurrency,
    timeout: config.timeout ?? DEFAULTS.timeout,
    userAgent: config.userAgent ?? DEFAULTS.userAgent,
    includePatterns: config.includePatterns,
    excludePatterns: config.excludePatterns,
    changedRatioThreshold:
      config.incrementalConfig?.changedRatioThreshold ?? INCREMENTAL_DEFAULTS.changedRatioThreshold,
    errorRatioThreshold:
      config.incrementalConfig?.errorRatioThreshold ?? INCREMENTAL_DEFAULTS.errorRatioThreshold,
    fullCrawlIntervalDays:
      config.incrementalConfig?.fullCrawlIntervalDays ?? INCREMENTAL_DEFAULTS.fullCrawlIntervalDays,
  };

  validateWebUrl(cfg.baseUrl);

  // Check if periodic full crawl is needed
  if (needsFullCrawl(lastFullCrawlAt, cfg.fullCrawlIntervalDays)) {
    return degradeToFullCrawl(config, onProgress, 'periodic_full_crawl_interval');
  }

  // Check if we have previous state
  if (previousState.size === 0) {
    return degradeToFullCrawl(config, onProgress, 'no_previous_state');
  }

  onProgress?.({ phase: 'checking', current: 0, total: 0, message: 'Discovering URLs...' });

  // Discover current URLs
  const { urls: currentUrls, sitemapEntries } = await discoverUrls(cfg.baseUrl, previousState, {
    timeout: cfg.timeout,
    userAgent: cfg.userAgent,
  });

  // Classify URLs
  const { added, toCheck, sitemapUnchanged, removed } = classifyUrls(
    currentUrls,
    sitemapEntries,
    previousState
  );

  onProgress?.({
    phase: 'checking',
    current: 0,
    total: currentUrls.size,
    message: `Found ${added.length} new, ${toCheck.length} to check, ${sitemapUnchanged.length} sitemap unchanged, ${removed.length} removed`,
  });

  // Results
  const addedPages: CrawledPage[] = [];
  const updatedPages: CrawledPage[] = [];
  const unchangedUrls: string[] = [];
  const newState = new Map<string, PageState>();
  let errorCount = 0;
  let fetchedCount = 0;

  const limit = pLimit(cfg.concurrency);

  // Process added URLs (full fetch)
  const addedResults = await Promise.all(
    added.slice(0, cfg.maxPages).map((url) =>
      limit(async () => {
        if (!matchesPatterns(url, { include: cfg.includePatterns, exclude: cfg.excludePatterns })) {
          return { url, result: 'skipped' as const };
        }

        const fetchResult = await conditionalFetch(url, {
          timeout: cfg.timeout,
          userAgent: cfg.userAgent,
        });

        fetchedCount++;

        if (fetchResult.status !== 'modified' || !fetchResult.html) {
          if (fetchResult.status === 'error') errorCount++;
          return { url, result: fetchResult.status };
        }

        try {
          const page = extractPage(fetchResult.html, fetchResult.finalUrl ?? url);
          page.content = cleanMarkdown(page.content);

          const state = createPageState({
            url,
            finalUrl: fetchResult.finalUrl,
            etag: fetchResult.etag,
            lastModified: fetchResult.lastModified,
            sitemapLastmod: sitemapEntries.get(url)?.lastmod,
            contentHash: page.contentHash,
          });

          await sleep(cfg.rateLimit);
          return { url, result: 'added' as const, page, state };
        } catch {
          // Page extraction failed - count as error
          errorCount++;
          return { url, result: 'error' as const };
        }
      })
    )
  );

  for (const r of addedResults) {
    if (r.result === 'added' && r.page && r.state) {
      addedPages.push(r.page);
      newState.set(r.url, r.state);
    }
  }

  // Process toCheck URLs (conditional fetch)
  const checkResults = await Promise.all(
    toCheck.map((url) =>
      limit(async () => {
        const prev = previousState.get(url)!;
        const fetchResult = await conditionalFetch(prev.finalUrl ?? url, {
          timeout: cfg.timeout,
          userAgent: cfg.userAgent,
          etag: prev.etag,
          lastModified: prev.lastModified,
        });

        fetchedCount++;

        if (fetchResult.status === 'not_modified') {
          // Keep previous state, just update fetchedAt
          newState.set(url, { ...prev, fetchedAt: new Date().toISOString() });
          return { url, result: 'unchanged' as const };
        }

        if (fetchResult.status === 'removed') {
          return { url, result: 'removed' as const };
        }

        if (fetchResult.status === 'error') {
          errorCount++;
          // Keep previous state on error
          newState.set(url, prev);
          return { url, result: 'error' as const };
        }

        // Modified - extract and compare hash
        try {
          const page = extractPage(fetchResult.html!, fetchResult.finalUrl ?? url);
          page.content = cleanMarkdown(page.content);

          const state = createPageState({
            url,
            finalUrl: fetchResult.finalUrl,
            etag: fetchResult.etag,
            lastModified: fetchResult.lastModified,
            sitemapLastmod: sitemapEntries.get(url)?.lastmod,
            contentHash: page.contentHash,
          });

          // Layer 3: Content hash comparison
          if (page.contentHash === prev.contentHash) {
            // Server said modified but content is same
            newState.set(url, state);
            return { url, result: 'unchanged' as const };
          }

          newState.set(url, state);
          await sleep(cfg.rateLimit);
          return { url, result: 'updated' as const, page, state };
        } catch {
          // Content extraction failed - keep previous state
          errorCount++;
          newState.set(url, prev);
          return { url, result: 'error' as const };
        }
      })
    )
  );

  for (const r of checkResults) {
    if (r.result === 'updated' && r.page) {
      updatedPages.push(r.page);
    } else if (r.result === 'unchanged') {
      unchangedUrls.push(r.url);
    }
  }

  // Process sitemapUnchanged URLs (verify with content hash)
  // These are URLs where sitemap lastmod suggests no change.
  // We trust the previous state and just carry it forward.
  for (const url of sitemapUnchanged) {
    const prev = previousState.get(url);
    if (prev) {
      newState.set(url, prev);
      unchangedUrls.push(url);
    }
  }

  // Check degradation thresholds
  const totalUrls = currentUrls.size;
  const changedCount = addedPages.length + updatedPages.length;

  const degradeCheck = shouldDegradeToFull({
    totalUrls,
    changedCount,
    errorCount,
    changedRatioThreshold: cfg.changedRatioThreshold,
    errorRatioThreshold: cfg.errorRatioThreshold,
  });

  if (degradeCheck.degrade) {
    return degradeToFullCrawl(config, onProgress, degradeCheck.reason!);
  }

  const timeMs = Date.now() - startTime;

  onProgress?.({
    phase: 'crawling',
    current: fetchedCount,
    total: totalUrls,
    message: `Done: ${addedPages.length} added, ${updatedPages.length} updated, ${unchangedUrls.length} unchanged, ${removed.length} removed`,
  });

  return {
    added: addedPages,
    updated: updatedPages,
    unchanged: unchangedUrls,
    removed,
    newState,
    degradedToFull: false,
    stats: {
      totalUrls,
      checked: toCheck.length + sitemapUnchanged.length,
      fetched: fetchedCount,
      errors: errorCount,
      timeMs,
    },
  };
}

/**
 * Helper: degrade incremental to full crawl.
 */
async function degradeToFullCrawl(
  config: WebCrawlConfig,
  onProgress: CrawlProgressCallback | undefined,
  reason: string
): Promise<IncrementalCrawlResult> {
  onProgress?.({
    phase: 'crawling',
    current: 0,
    total: 0,
    message: `Degrading to full crawl: ${reason}`,
  });

  const fullResult = await crawlWebsite(config, onProgress);

  // Convert full crawl result to incremental format
  const newState = new Map<string, PageState>();
  for (const page of fullResult.pages) {
    newState.set(normalizeUrl(page.url), createPageState({
      url: page.url,
      contentHash: page.contentHash,
    }));
  }

  return {
    added: fullResult.pages,
    updated: [],
    unchanged: [],
    removed: [],
    newState,
    degradedToFull: true,
    degradeReason: reason,
    stats: {
      totalUrls: fullResult.stats.totalUrls,
      checked: 0,
      fetched: fullResult.stats.crawled,
      errors: fullResult.stats.skipped,
      timeMs: fullResult.stats.timeMs,
    },
  };
}
