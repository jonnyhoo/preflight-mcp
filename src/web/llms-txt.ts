/**
 * llms.txt Detection and Parsing Module
 *
 * Implements the llms.txt fast path for web crawling.
 * Many documentation sites provide llms.txt files listing important URLs.
 *
 * Priority order: llms-full.txt > llms.txt > llms-small.txt
 *
 * @module web/llms-txt
 */

import type { LlmsTxtResult } from './types.js';

/** Variants to check in priority order */
const LLMS_TXT_VARIANTS = ['llms-full.txt', 'llms.txt', 'llms-small.txt'] as const;

/** Maximum size for llms.txt file (to prevent abuse) */
const MAX_LLMS_TXT_SIZE = 512 * 1024; // 512KB

/** Maximum URLs to extract from llms.txt */
const MAX_URLS_FROM_LLMS_TXT = 1000;

/**
 * Detect if the site has a llms.txt file.
 * Checks variants in priority order: llms-full.txt > llms.txt > llms-small.txt
 *
 * @param baseUrl - Base URL of the site
 * @param options - Fetch options (timeout, user agent)
 * @returns Detection result or null if not found
 */
export async function detectLlmsTxt(
  baseUrl: string,
  options: {
    timeout?: number;
    userAgent?: string;
  } = {}
): Promise<{ url: string; variant: typeof LLMS_TXT_VARIANTS[number] } | null> {
  const { origin } = new URL(baseUrl);
  const timeout = options.timeout ?? 5000;
  const userAgent = options.userAgent ?? 'Preflight-Web-Crawler/1.0';

  for (const variant of LLMS_TXT_VARIANTS) {
    const url = `${origin}/${variant}`;
    try {
      // Try HEAD first (faster, less bandwidth)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        let response = await fetch(url, {
          method: 'HEAD',
          signal: controller.signal,
          headers: { 'User-Agent': userAgent },
          redirect: 'follow',
        });

        // If HEAD fails or returns non-2xx, try GET with Range
        if (!response.ok) {
          response = await fetch(url, {
            method: 'GET',
            signal: controller.signal,
            headers: {
              'User-Agent': userAgent,
              'Range': 'bytes=0-1024', // Just peek at the start
            },
            redirect: 'follow',
          });
        }

        clearTimeout(timeoutId);

        if (response.ok || response.status === 206) {
          return { url, variant };
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      // Continue to next variant
    }
  }

  return null;
}

/**
 * Download the content of a llms.txt file.
 *
 * @param url - URL of the llms.txt file
 * @param options - Fetch options
 * @returns Content as string
 */
export async function downloadLlmsTxt(
  url: string,
  options: {
    timeout?: number;
    userAgent?: string;
  } = {}
): Promise<string> {
  const timeout = options.timeout ?? 30000;
  const userAgent = options.userAgent ?? 'Preflight-Web-Crawler/1.0';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': userAgent },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`Failed to download llms.txt: ${response.status} ${response.statusText}`);
    }

    // Check content length
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_LLMS_TXT_SIZE) {
      throw new Error(`llms.txt file too large: ${contentLength} bytes (max ${MAX_LLMS_TXT_SIZE})`);
    }

    const text = await response.text();

    // Double-check size after download
    if (text.length > MAX_LLMS_TXT_SIZE) {
      throw new Error(`llms.txt content too large: ${text.length} bytes`);
    }

    return text;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Parse llms.txt content and extract URLs.
 *
 * Supports:
 * - Markdown links: [text](url)
 * - Bare URLs: https://...
 *
 * Only returns URLs from the same origin.
 *
 * @param content - Raw llms.txt content
 * @param baseUrl - Base URL for resolving relative URLs and filtering
 * @returns Array of normalized, same-origin URLs
 */
export function parseLlmsTxt(content: string, baseUrl: string): string[] {
  const { origin } = new URL(baseUrl);
  const urls = new Set<string>();

  // Extract Markdown links: [text](url)
  const mdLinkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = mdLinkRegex.exec(content)) !== null) {
    const href = match[2];
    if (href) {
      try {
        const resolved = new URL(href, baseUrl).href.split('#')[0]; // Remove fragment
        if (resolved) {
          urls.add(resolved);
        }
      } catch {
        // Invalid URL, skip
      }
    }
  }

  // Extract bare URLs
  const bareUrlRegex = /https?:\/\/[^\s)\]<>"']+/g;
  while ((match = bareUrlRegex.exec(content)) !== null) {
    let url = match[0]!;
    // Clean trailing punctuation
    url = url.replace(/[.,;:]+$/, '');
    // Remove fragment
    url = url.split('#')[0] ?? url;
    urls.add(url);
  }

  // Filter to same-origin URLs only and limit count
  const sameOriginUrls = [...urls]
    .filter((url) => {
      try {
        return new URL(url).origin === origin;
      } catch {
        return false;
      }
    })
    .slice(0, MAX_URLS_FROM_LLMS_TXT);

  return sameOriginUrls;
}

/**
 * Complete llms.txt detection, download, and parsing.
 *
 * @param baseUrl - Base URL of the site
 * @param options - Options for detection and download
 * @returns LlmsTxtResult if found and valid, null otherwise
 */
export async function fetchAndParseLlmsTxt(
  baseUrl: string,
  options: {
    timeout?: number;
    userAgent?: string;
    /** Skip if URL count is below this threshold (signals incomplete llms.txt) */
    minUrls?: number;
    /** Skip if URL count exceeds this (too large, fall back to BFS) */
    maxUrls?: number;
  } = {}
): Promise<LlmsTxtResult | null> {
  const detection = await detectLlmsTxt(baseUrl, options);
  if (!detection) {
    return null;
  }

  const content = await downloadLlmsTxt(detection.url, options);
  const urls = parseLlmsTxt(content, baseUrl);

  // Check URL count thresholds
  const minUrls = options.minUrls ?? 1;
  const maxUrls = options.maxUrls ?? MAX_URLS_FROM_LLMS_TXT;

  if (urls.length < minUrls) {
    // llms.txt exists but has too few URLs - might be incomplete
    return null;
  }

  if (urls.length > maxUrls) {
    // Too many URLs - fall back to BFS with patterns
    return null;
  }

  return {
    url: detection.url,
    variant: detection.variant,
    content,
    urls,
  };
}
