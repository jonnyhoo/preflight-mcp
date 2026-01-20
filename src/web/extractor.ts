/**
 * Web Content Extractor Module
 *
 * Extracts main content from HTML pages using:
 * - @mozilla/readability for article extraction
 * - cheerio for HTML parsing
 * - turndown for HTML→Markdown conversion
 *
 * @module web/extractor
 */

import crypto from 'node:crypto';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { resolveUrl, isSameOrigin } from './normalizer.js';
import type { CrawledPage } from './types.js';

/** Turndown instance with optimized settings */
const turndown = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
  strongDelimiter: '**',
  linkStyle: 'inlined',
});

// Add custom rules for better code block handling
turndown.addRule('fencedCodeBlock', {
  filter: (node) => {
    return (
      node.nodeName === 'PRE' &&
      node.firstChild !== null &&
      node.firstChild.nodeName === 'CODE'
    );
  },
  replacement: (content, node) => {
    const codeNode = node.firstChild as Element;
    const className = codeNode.getAttribute?.('class') || '';
    const langMatch = className.match(/language-(\w+)/);
    const lang = langMatch?.[1] || '';
    const code = codeNode.textContent || '';
    return `\n\`\`\`${lang}\n${code.trim()}\n\`\`\`\n`;
  },
});

/**
 * SHA256 hash of text content.
 */
function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Extract internal links from HTML.
 *
 * @param $ - Cheerio instance
 * @param pageUrl - Current page URL for resolving relative links
 * @returns Array of normalized, same-origin URLs
 */
export function extractInternalLinks($: cheerio.CheerioAPI, pageUrl: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    // Skip javascript:, mailto:, tel:, etc.
    if (href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) {
      return;
    }

    // Skip anchors to same page
    if (href.startsWith('#')) {
      return;
    }

    // Resolve relative URL
    const resolved = resolveUrl(href, pageUrl);
    if (!resolved) return;

    // Only include same-origin links
    if (!isSameOrigin(resolved, pageUrl)) return;

    // Skip if already seen
    if (seen.has(resolved)) return;
    seen.add(resolved);

    links.push(resolved);
  });

  return links;
}

/**
 * Extract headings from content.
 */
function extractHeadings($: cheerio.CheerioAPI): Array<{ level: number; text: string }> {
  const headings: Array<{ level: number; text: string }> = [];

  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const tagName = (el as any).tagName?.toLowerCase() ?? 'h6';
    const level = parseInt(tagName.charAt(1), 10);
    const text = $(el).text().trim();
    if (text) {
      headings.push({ level, text });
    }
  });

  return headings;
}

/**
 * Extract code blocks from content.
 */
function extractCodeBlocks($: cheerio.CheerioAPI): Array<{ code: string; language?: string }> {
  const codeBlocks: Array<{ code: string; language?: string }> = [];

  $('pre code, pre').each((_, el) => {
    const $el = $(el);
    const code = $el.text().trim();

    // Skip very short code blocks (likely inline code)
    if (code.length < 10) return;

    // Try to detect language from class
    const className = $el.attr('class') || $el.parent().attr('class') || '';
    const langMatch = className.match(/language-(\w+)/);
    const language = langMatch?.[1];

    codeBlocks.push({ code, language });
  });

  return codeBlocks;
}

/**
 * Extract page content using Readability.
 *
 * Falls back to manual extraction if Readability fails.
 */
export function extractPage(html: string, url: string): CrawledPage {
  const $ = cheerio.load(html);

  // First, extract all internal links from the full HTML (before content extraction)
  const links = extractInternalLinks($, url);

  // Try Readability first (best for article/doc content)
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  let article = reader.parse();

  // Get content HTML - fallback to manual extraction if Readability fails
  let contentHtml = article?.content;
  if (!contentHtml) {
    // Readability failed - try semantic containers
    contentHtml =
      $('main').html() ??
      $('article').html() ??
      $('[role="main"]').html() ??
      $('.content').html() ??
      $('.post').html() ??
      $('.documentation').html() ??
      $('body').html() ??
      html;
  }

  // Parse the extracted content for structure
  const $content = cheerio.load(contentHtml ?? '');

  // Extract structural elements from content
  const headings = extractHeadings($content);
  const codeBlocks = extractCodeBlocks($content);

  // Convert to Markdown
  const markdown = turndown.turndown(contentHtml ?? '');

  // Get title - prefer Readability title, fall back to <title>
  const title = article?.title ?? $('title').first().text().trim() ?? '';

  // Compute content hash
  const contentHash = sha256(markdown);

  return {
    url,
    title,
    content: markdown,
    headings,
    codeBlocks,
    links,
    fetchedAt: new Date().toISOString(),
    contentHash,
  };
}

/**
 * Clean and normalize extracted markdown.
 *
 * - Removes excessive whitespace
 * - Normalizes line endings
 * - Removes empty sections
 */
export function cleanMarkdown(markdown: string): string {
  return markdown
    // Normalize line endings
    .replace(/\r\n/g, '\n')
    // Remove excessive blank lines (more than 2)
    .replace(/\n{3,}/g, '\n\n')
    // Trim lines
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    // Trim whole document
    .trim();
}

/**
 * Check if content type is HTML.
 */
export function isHtmlContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return lower.includes('text/html') || lower.includes('application/xhtml+xml');
}

/**
 * Check if content type is plain text (for llms.txt).
 */
export function isTextContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return lower.includes('text/plain');
}

/**
 * Check if content type should be skipped.
 */
export function shouldSkipContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();

  // Skip binary/media types
  const skipPatterns = [
    'application/pdf',
    'application/octet-stream',
    'image/',
    'video/',
    'audio/',
    'application/zip',
    'application/gzip',
    'application/x-tar',
    'font/',
    'application/font',
  ];

  return skipPatterns.some((pattern) => lower.includes(pattern));
}
