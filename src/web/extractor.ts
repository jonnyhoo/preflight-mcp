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

function extractLanguageFromClass(className: string | null | undefined): string {
  if (!className) return '';
  const match = className.match(/(?:language|lang)-([\w-]+)/i);
  return match?.[1] ?? '';
}
function extractLanguageFromNode(node: Element | null): string {
  if (!node) return '';
  const dataLang = node.getAttribute?.('data-language');
  if (dataLang) return dataLang;
  return extractLanguageFromClass(node.getAttribute?.('class'));
}

function normalizeCodeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
}

function extractCodeText(node: Element): string {
  const lineNodes = node.querySelectorAll?.('span.line, div.line, div.ec-line');
  if (lineNodes && lineNodes.length > 0) {
    const lines = Array.from(lineNodes).map((line) => line.textContent ?? '');
    return normalizeCodeText(lines.join('\n'));
  }

  const html = (node as Element).innerHTML ?? '';
  if (html) {
    const withBreaks = html.replace(/<br\s*\/?>/gi, '\n');
    const $ = cheerio.load(`<code>${withBreaks}</code>`);
    const ecLines = $('div.ec-line');
    if (ecLines.length > 0) {
      const lines: string[] = [];
      ecLines.each((_, el) => {
        lines.push($(el).text());
      });
      return normalizeCodeText(lines.join('\n'));
    }

    const lineSpans = $('span.line, div.line');
    if (lineSpans.length > 0) {
      const lines: string[] = [];
      lineSpans.each((_, el) => {
        lines.push($(el).text());
      });
      return normalizeCodeText(lines.join('\n'));
    }

    const text = $('code').text();
    return normalizeCodeText(text);
  }

  return normalizeCodeText(node.textContent ?? '');
}

function escapeTableCell(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n+/g, '<br>')
    .replace(/\|/g, '\\|')
    .trim();
}

function tableToMarkdown(table: Element): string {
  const extractCells = (row: Element): string[] => {
    const cells = Array.from(row.querySelectorAll('th, td'));
    return cells.map((cell) => {
      const html = cell.innerHTML ?? '';
      const markdown = html ? turndown.turndown(html) : (cell.textContent ?? '');
      return escapeTableCell(markdown);
    });
  };

  let headerCells: string[] = [];
  let bodyRows: Element[] = [];

  const thead = table.querySelector('thead');
  if (thead) {
    const headerRow = thead.querySelector('tr');
    if (headerRow) headerCells = extractCells(headerRow);
    bodyRows = Array.from(table.querySelectorAll('tbody tr'));
    if (bodyRows.length === 0) {
      bodyRows = Array.from(table.querySelectorAll('tr')).filter((row) => !row.closest('thead'));
    }
  } else {
    const allRows = Array.from(table.querySelectorAll('tr'));
    if (allRows.length > 0) {
      const firstRow = allRows.shift();
      if (firstRow) headerCells = extractCells(firstRow);
      bodyRows = allRows;
    }
  }

  if (headerCells.length === 0 && bodyRows.length > 0) {
    const firstRow = bodyRows.shift();
    if (firstRow) headerCells = extractCells(firstRow);
  }

  const rowCells = bodyRows.map((row) => extractCells(row));
  const columnCount = Math.max(
    headerCells.length,
    ...rowCells.map((cells) => cells.length)
  );

  if (columnCount === 0) return '';

  const padRow = (cells: string[]): string[] => {
    const out = [...cells];
    while (out.length < columnCount) out.push('');
    return out.slice(0, columnCount);
  };

  const header = padRow(headerCells);
  const headerLine = `| ${header.join(' | ')} |`;
  const separatorLine = `| ${new Array(columnCount).fill('---').join(' | ')} |`;
  const bodyLines = rowCells.map((cells) => `| ${padRow(cells).join(' | ')} |`);

  return `\n${headerLine}\n${separatorLine}${bodyLines.length > 0 ? `\n${bodyLines.join('\n')}` : ''}\n`;
}

// Add custom rules for better code block handling
turndown.addRule('fencedCodeBlock', {
  filter: (node) => {
    return node.nodeName === 'PRE';
  },
  replacement: (_content, node) => {
    const preNode = node as Element;
    const firstChild = preNode.firstElementChild;
    const codeNode = firstChild?.nodeName === 'CODE' ? (firstChild as Element) : preNode;
    const lang =
      extractLanguageFromNode(codeNode) ||
      extractLanguageFromNode(preNode);
    const code = extractCodeText(codeNode);
    return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
  },
});
turndown.addRule('table', {
  filter: (node) => node.nodeName === 'TABLE',
  replacement: (_content, node) => {
    return tableToMarkdown(node as Element);
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
