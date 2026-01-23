/**
 * Web Crawling Types
 *
 * Type definitions for web document crawling functionality.
 * Part of the "Bundle Anything" initiative - web as a native input source.
 *
 * @module web/types
 */

/**
 * Configuration for web crawling.
 */
export interface WebCrawlConfig {
  /** Starting URL for crawling */
  baseUrl: string;
  /** Maximum pages to crawl (default: 500) */
  maxPages?: number;
  /** Maximum crawl depth from baseUrl (default: 5) */
  maxDepth?: number;
  /** URL patterns to include (e.g., ['/docs/', '/api/']) */
  includePatterns?: string[];
  /** URL patterns to exclude (e.g., ['/blog/', '/changelog/']) */
  excludePatterns?: string[];
  /** Delay between requests in ms (default: 200) */
  rateLimit?: number;
  /** Concurrent requests (default: 3) */
  concurrency?: number;
  /** Single page timeout in ms (default: 30000) */
  timeout?: number;
  /** Custom User-Agent string */
  userAgent?: string;
  /** Skip llms.txt detection (default: false) */
  skipLlmsTxt?: boolean;
  /** Respect robots.txt rules (default: true) */
  respectRobotsTxt?: boolean;
  /** Use headless browser for SPA rendering (default: false) */
  useSpa?: boolean;
  /** SPA rendering options */
  spaOptions?: SpaOptions;
  /** Incremental update settings */
  incrementalConfig?: IncrementalConfig;
}

/**
 * Options for SPA (Single Page Application) rendering.
 */
export interface SpaOptions {
  /** Wait for specific selector before extracting (e.g., '#content') */
  waitForSelector?: string;
  /** Wait time after page load in ms (default: 2000) */
  waitAfterLoad?: number;
  /** Path to Chrome/Chromium executable (uses bundled by default) */
  executablePath?: string;
  /** Run browser in headless mode (default: true) */
  headless?: boolean;
}

/**
 * A single crawled page with extracted content.
 */
export interface CrawledPage {
  /** Full URL of the page */
  url: string;
  /** Page title from <title> or Readability */
  title: string;
  /** Extracted content as markdown */
  content: string;
  /** Extracted headings */
  headings: Array<{ level: number; text: string }>;
  /** Extracted code blocks */
  codeBlocks: Array<{ code: string; language?: string }>;
  /** Discovered internal links (for BFS queue) */
  links: string[];
  /** Timestamp when page was fetched */
  fetchedAt: string;
  /** SHA256 hash of the markdown content */
  contentHash: string;
}

/**
 * Result of a complete crawl operation.
 */
export interface CrawlResult {
  /** Domain of the crawled site */
  domain: string;
  /** Base URL used for crawling */
  baseUrl: string;
  /** All successfully crawled pages */
  pages: CrawledPage[];
  /** URLs that were skipped with reasons */
  skipped: Array<{ url: string; reason: string }>;
  /** Crawl statistics */
  stats: {
    totalUrls: number;
    crawled: number;
    skipped: number;
    timeMs: number;
  };
  /** Whether llms.txt fast path was used */
  usedLlmsTxt: boolean;
  /** Which llms.txt variant was used (if any) */
  llmsTxtVariant?: 'llms-full.txt' | 'llms.txt' | 'llms-small.txt';
}

/**
 * llms.txt detection result.
 */
export interface LlmsTxtResult {
  /** URL of the found llms.txt file */
  url: string;
  /** Which variant was found */
  variant: 'llms-full.txt' | 'llms.txt' | 'llms-small.txt';
  /** Raw content of the llms.txt file */
  content: string;
  /** Parsed URLs from the file */
  urls: string[];
}

/**
 * Progress callback for reporting crawl progress.
 */
export type CrawlProgressCallback = (params: {
  phase: 'detecting' | 'checking' | 'crawling' | 'extracting';
  current: number;
  total: number;
  message: string;
}) => void;

// ============================================================================
// Incremental Update Types
// ============================================================================

/**
 * Incremental update configuration.
 */
export interface IncrementalConfig {
  /** Ratio of changed pages that triggers full re-crawl (default: 0.5) */
  changedRatioThreshold?: number;
  /** Ratio of failed requests that triggers full re-crawl (default: 0.3) */
  errorRatioThreshold?: number;
  /** Days between forced full crawls for verification (default: 7, 0=disable) */
  fullCrawlIntervalDays?: number;
}

/**
 * Single page state for incremental updates.
 */
export interface PageState {
  /** Original URL */
  url: string;
  /** Final URL after redirects (used for conditional requests) */
  finalUrl?: string;
  /** HTTP ETag header */
  etag?: string;
  /** HTTP Last-Modified header */
  lastModified?: string;
  /** sitemap.xml lastmod value (for debugging) */
  sitemapLastmod?: string;
  /** SHA256 of normalized markdown content */
  contentHash: string;
  /** ISO timestamp when fetched */
  fetchedAt: string;
}

/**
 * Top-level state file structure.
 */
export interface PageStateFile {
  /** Schema version for forward compatibility */
  schemaVersion: 1;
  /** Site root URL */
  siteRoot: string;
  /** Last update timestamp */
  generatedAt: string;
  /** Last full crawl timestamp (for periodic verification) */
  lastFullCrawlAt: string;
  /** Page states keyed by normalized URL */
  pages: Record<string, PageState>;
}

/**
 * Result of a conditional HTTP request.
 */
export interface ConditionalFetchResult {
  /** Request outcome */
  status: 'modified' | 'not_modified' | 'removed' | 'error';
  /** New ETag from response */
  etag?: string;
  /** New Last-Modified from response */
  lastModified?: string;
  /** HTML content (only if modified) */
  html?: string;
  /** Final URL after redirects */
  finalUrl?: string;
  /** Error message (only if error) */
  error?: string;
}

/**
 * Result of incremental crawl operation.
 */
export interface IncrementalCrawlResult {
  /** Newly discovered pages */
  added: CrawledPage[];
  /** Pages with content changes */
  updated: CrawledPage[];
  /** URLs confirmed unchanged */
  unchanged: string[];
  /** URLs no longer present */
  removed: string[];
  /** Updated page state map */
  newState: Map<string, PageState>;
  /** Whether full crawl was triggered (degradation) */
  degradedToFull: boolean;
  /** Degradation reason if applicable */
  degradeReason?: string;
  /** Crawl statistics */
  stats: {
    totalUrls: number;
    checked: number;
    fetched: number;
    errors: number;
    timeMs: number;
  };
}

/**
 * Sitemap entry from sitemap.xml.
 */
export interface SitemapEntry {
  /** Page URL */
  url: string;
  /** Last modification date (ISO format) */
  lastmod?: string;
}
