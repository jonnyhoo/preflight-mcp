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
} from './crawler.js';
