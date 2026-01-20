/**
 * Sitemap Parser Module
 *
 * Fetches and parses sitemap.xml files for URL discovery and lastmod detection.
 * Supports both urlset and sitemapindex formats.
 *
 * @module web/sitemap
 */

import * as cheerio from 'cheerio';
import type { SitemapEntry } from './types.js';
import { normalizeUrl, isSameOrigin } from './normalizer.js';

// ============================================================================
// Sitemap Fetching
// ============================================================================

/**
 * Fetch sitemap from a URL.
 * Returns null on failure (404, timeout, parse error).
 */
export async function fetchSitemap(
  baseUrl: string,
  options: { timeout: number; userAgent: string }
): Promise<SitemapEntry[] | null> {
  const sitemapUrls = getSitemapUrls(baseUrl);

  for (const url of sitemapUrls) {
    try {
      const entries = await fetchAndParseSitemap(url, options, baseUrl);
      if (entries && entries.length > 0) {
        return entries;
      }
    } catch {
      // Try next sitemap location
    }
  }

  return null;
}

/**
 * Get potential sitemap URLs to try.
 */
function getSitemapUrls(baseUrl: string): string[] {
  const { origin } = new URL(baseUrl);
  return [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap-index.xml`,
  ];
}

/**
 * Fetch and parse a single sitemap URL.
 */
async function fetchAndParseSitemap(
  url: string,
  options: { timeout: number; userAgent: string },
  baseUrl: string
): Promise<SitemapEntry[] | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': options.userAgent },
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const xml = await response.text();
    return parseSitemap(xml, options, baseUrl);
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

// ============================================================================
// Sitemap Parsing
// ============================================================================

/**
 * Parse sitemap XML content.
 * Handles both urlset and sitemapindex formats.
 */
function parseSitemap(
  xml: string,
  options: { timeout: number; userAgent: string },
  baseUrl: string
): SitemapEntry[] | null {
  const $ = cheerio.load(xml, { xml: true });

  // Check for sitemap index
  const sitemapLocs = $('sitemapindex > sitemap > loc');
  if (sitemapLocs.length > 0) {
    // This is a sitemap index - we'll return null here
    // and let the caller handle recursive fetching if needed
    // For simplicity, we'll try to fetch the first few sub-sitemaps synchronously
    return null; // Will be handled by fetchSitemapIndex
  }

  // Parse urlset
  const entries: SitemapEntry[] = [];
  $('urlset > url').each((_, el) => {
    const loc = $(el).find('loc').text().trim();
    const lastmod = $(el).find('lastmod').text().trim() || undefined;

    if (!loc) return;

    // Only include same-origin URLs
    if (!isSameOrigin(loc, baseUrl)) return;

    try {
      entries.push({
        url: normalizeUrl(loc),
        lastmod,
      });
    } catch {
      // Invalid URL, skip
    }
  });

  return entries.length > 0 ? entries : null;
}

/**
 * Fetch sitemap with support for sitemap index (recursive).
 * Limits depth to prevent infinite recursion.
 */
export async function fetchSitemapWithIndex(
  baseUrl: string,
  options: { timeout: number; userAgent: string; maxSitemaps?: number }
): Promise<SitemapEntry[] | null> {
  const maxSitemaps = options.maxSitemaps ?? 10;
  const sitemapUrls = getSitemapUrls(baseUrl);

  for (const url of sitemapUrls) {
    try {
      const entries = await fetchSitemapRecursive(url, options, baseUrl, maxSitemaps);
      if (entries && entries.length > 0) {
        return entries;
      }
    } catch {
      // Try next sitemap location
    }
  }

  return null;
}

/**
 * Recursively fetch sitemap, handling sitemap index.
 */
async function fetchSitemapRecursive(
  url: string,
  options: { timeout: number; userAgent: string },
  baseUrl: string,
  remainingSitemaps: number
): Promise<SitemapEntry[] | null> {
  if (remainingSitemaps <= 0) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': options.userAgent },
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const xml = await response.text();
    const $ = cheerio.load(xml, { xml: true });

    // Check for sitemap index
    const sitemapLocs = $('sitemapindex > sitemap > loc');
    if (sitemapLocs.length > 0) {
      // Recursively fetch sub-sitemaps
      const allEntries: SitemapEntry[] = [];
      const subUrls: string[] = [];

      sitemapLocs.each((_, el) => {
        const loc = $(el).text().trim();
        if (loc) subUrls.push(loc);
      });

      // Limit sub-sitemaps to fetch
      const toFetch = subUrls.slice(0, remainingSitemaps);
      for (const subUrl of toFetch) {
        const subEntries = await fetchSitemapRecursive(
          subUrl,
          options,
          baseUrl,
          remainingSitemaps - toFetch.indexOf(subUrl) - 1
        );
        if (subEntries) {
          allEntries.push(...subEntries);
        }
      }

      return allEntries.length > 0 ? allEntries : null;
    }

    // Parse urlset
    return parseSitemap(xml, options, baseUrl);
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

// ============================================================================
// Sitemap Change Detection
// ============================================================================

/**
 * Compare sitemap lastmod with stored state.
 * Returns URLs that may have changed based on lastmod.
 */
export function filterChangedBySitemap(
  sitemapEntries: SitemapEntry[],
  previousState: Map<string, { fetchedAt: string; sitemapLastmod?: string }>
): { maybeChanged: SitemapEntry[]; unchanged: string[] } {
  const maybeChanged: SitemapEntry[] = [];
  const unchanged: string[] = [];

  for (const entry of sitemapEntries) {
    const prev = previousState.get(entry.url);

    if (!prev) {
      // New URL
      maybeChanged.push(entry);
      continue;
    }

    if (!entry.lastmod) {
      // No lastmod in sitemap - must check via HTTP
      maybeChanged.push(entry);
      continue;
    }

    // Compare lastmod
    const sitemapDate = new Date(entry.lastmod).getTime();
    const fetchedDate = new Date(prev.fetchedAt).getTime();

    if (isNaN(sitemapDate)) {
      // Invalid lastmod format - must check via HTTP
      maybeChanged.push(entry);
      continue;
    }

    if (sitemapDate > fetchedDate) {
      // Sitemap says it's newer
      maybeChanged.push(entry);
    } else {
      // Sitemap says unchanged (but still need content hash verification)
      unchanged.push(entry.url);
    }
  }

  return { maybeChanged, unchanged };
}
