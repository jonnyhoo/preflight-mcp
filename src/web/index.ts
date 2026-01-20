/**
 * Web Crawling Module
 *
 * Provides web document crawling functionality for the "Bundle Anything" initiative.
 * Web is a native input source alongside github and local.
 *
 * @module web
 */

// Types
export type {
  WebCrawlConfig,
  CrawledPage,
  CrawlResult,
  LlmsTxtResult,
  CrawlProgressCallback,
  // Incremental update types
  IncrementalConfig,
  PageState,
  PageStateFile,
  ConditionalFetchResult,
  IncrementalCrawlResult,
  SitemapEntry,
} from './types.js';

// URL utilities
export {
  validateWebUrl,
  normalizeUrl,
  generateSafeId,
  matchesPatterns,
  isSameOrigin,
  resolveUrl,
  urlToFilename,
} from './normalizer.js';

// llms.txt support
export {
  detectLlmsTxt,
  downloadLlmsTxt,
  parseLlmsTxt,
  fetchAndParseLlmsTxt,
} from './llms-txt.js';

// Content extraction
export {
  extractPage,
  extractInternalLinks,
  cleanMarkdown,
  isHtmlContentType,
  isTextContentType,
  shouldSkipContentType,
} from './extractor.js';

// Crawler
export {
  crawlWebsite,
  crawlUrls,
  crawlWebsiteIncremental,
} from './crawler.js';

// Sitemap
export {
  fetchSitemap,
  fetchSitemapWithIndex,
  filterChangedBySitemap,
} from './sitemap.js';

// Incremental update
export {
  conditionalFetch,
  quickCheckForChanges,
  discoverUrls,
  classifyUrls,
  shouldDegradeToFull,
  INCREMENTAL_DEFAULTS,
} from './incremental.js';

// Page state
export {
  loadPageState,
  savePageState,
  needsFullCrawl,
  createPageState,
} from './page-state.js';
