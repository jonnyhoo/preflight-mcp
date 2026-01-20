/**
 * Page State Persistence Module
 *
 * Stores per-page state (ETag, Last-Modified, contentHash) for incremental updates.
 * Uses atomic write to prevent corruption on interruption.
 *
 * @module web/page-state
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { PageState, PageStateFile } from './types.js';

/** Current schema version */
const SCHEMA_VERSION = 1;

// ============================================================================
// Load / Save
// ============================================================================

/**
 * Load page state from file.
 * Returns empty state on missing/corrupted/incompatible file.
 */
export async function loadPageState(stateFile: string): Promise<{
  state: Map<string, PageState>;
  lastFullCrawlAt: string | null;
  siteRoot: string | null;
}> {
  try {
    const raw = await fs.readFile(stateFile, 'utf8');
    const data = JSON.parse(raw) as PageStateFile;

    // Schema version check
    if (data.schemaVersion !== SCHEMA_VERSION) {
      return { state: new Map(), lastFullCrawlAt: null, siteRoot: null };
    }

    const state = new Map<string, PageState>();
    for (const [url, page] of Object.entries(data.pages)) {
      state.set(url, page);
    }

    return {
      state,
      lastFullCrawlAt: data.lastFullCrawlAt,
      siteRoot: data.siteRoot,
    };
  } catch {
    // File doesn't exist or is corrupted
    return { state: new Map(), lastFullCrawlAt: null, siteRoot: null };
  }
}

/**
 * Save page state to file atomically.
 * Writes to temp file first, then renames to prevent corruption.
 */
export async function savePageState(
  stateFile: string,
  state: Map<string, PageState>,
  options: {
    siteRoot: string;
    lastFullCrawlAt: string;
  }
): Promise<void> {
  const pages: Record<string, PageState> = {};
  for (const [url, page] of state) {
    pages[url] = page;
  }

  const data: PageStateFile = {
    schemaVersion: SCHEMA_VERSION,
    siteRoot: options.siteRoot,
    generatedAt: new Date().toISOString(),
    lastFullCrawlAt: options.lastFullCrawlAt,
    pages,
  };

  const tmpFile = path.join(path.dirname(stateFile), `.page-state.json.tmp`);

  // Ensure directory exists
  await fs.mkdir(path.dirname(stateFile), { recursive: true });

  // Write to temp file, then rename (atomic on most filesystems)
  await fs.writeFile(tmpFile, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.rename(tmpFile, stateFile);
}

// ============================================================================
// State Helpers
// ============================================================================

/**
 * Check if full crawl is needed based on time interval.
 */
export function needsFullCrawl(
  lastFullCrawlAt: string | null,
  intervalDays: number
): boolean {
  if (intervalDays <= 0) return false;
  if (!lastFullCrawlAt) return true;

  const lastCrawl = new Date(lastFullCrawlAt).getTime();
  const now = Date.now();
  const daysSince = (now - lastCrawl) / (1000 * 60 * 60 * 24);

  return daysSince >= intervalDays;
}

/**
 * Create PageState from a crawled page result.
 */
export function createPageState(params: {
  url: string;
  finalUrl?: string;
  etag?: string;
  lastModified?: string;
  sitemapLastmod?: string;
  contentHash: string;
}): PageState {
  return {
    url: params.url,
    finalUrl: params.finalUrl,
    etag: params.etag,
    lastModified: params.lastModified,
    sitemapLastmod: params.sitemapLastmod,
    contentHash: params.contentHash,
    fetchedAt: new Date().toISOString(),
  };
}
