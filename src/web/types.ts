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
  phase: 'detecting' | 'crawling' | 'extracting';
  current: number;
  total: number;
  message: string;
}) => void;
