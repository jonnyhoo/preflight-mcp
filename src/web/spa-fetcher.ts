/**
 * SPA Fetcher Module
 *
 * Renders JavaScript-heavy pages using puppeteer-extra with stealth plugin.
 * Handles SPA (Single Page Application) content that cannot be fetched with plain HTTP.
 *
 * @module web/spa-fetcher
 */

import type { SpaOptions } from './types.js';

/** Puppeteer-extra interface for type safety */
interface PuppeteerExtra {
  use(plugin: unknown): this;
  launch(options?: Record<string, unknown>): Promise<BrowserLike>;
}

interface BrowserLike {
  connected: boolean;
  close(): Promise<void>;
  newPage(): Promise<PageLike>;
}

interface PageLike {
  setViewport(viewport: { width: number; height: number }): Promise<void>;
  setUserAgent(ua: string): Promise<void>;
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<ResponseLike | null>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<void>;
  content(): Promise<string>;
  url(): string;
  close(): Promise<void>;
}

interface ResponseLike {
  status(): number;
}

/** Singleton browser instance for reuse across requests */
let browserInstance: BrowserLike | null = null;

/** Default SPA options */
const SPA_DEFAULTS = {
  waitAfterLoad: 2000,
  headless: true,
} as const;

/**
 * Launch browser with stealth plugin.
 */
async function launchBrowser(options: SpaOptions = {}) {
  // Dynamic imports to avoid loading when not needed
  const puppeteerExtraModule = await import('puppeteer-extra');
  const stealthModule = await import('puppeteer-extra-plugin-stealth');

  // Cast to interface - puppeteer-extra types don't export well in ESM
  const puppeteer = puppeteerExtraModule.default as unknown as PuppeteerExtra;
  const StealthPlugin = stealthModule.default;

  // Apply stealth plugin
  puppeteer.use(StealthPlugin());

  return puppeteer.launch({
    headless: options.headless ?? SPA_DEFAULTS.headless,
    executablePath: options.executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080',
    ],
  });
}

/**
 * Get or create a browser instance.
 *
 * Reuses existing browser to avoid startup overhead on each request.
 */
async function getBrowser(options: SpaOptions = {}): Promise<BrowserLike> {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }

  browserInstance = await launchBrowser(options);
  return browserInstance;
}

/**
 * Close the shared browser instance.
 *
 * Call this when crawling is complete to free resources.
 */
export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

/**
 * Fetch a URL using headless browser with stealth mode.
 *
 * @param url - URL to fetch
 * @param options - Fetch and rendering options
 * @returns HTML content and final URL after redirects
 */
export async function fetchUrlWithBrowser(
  url: string,
  options: {
    timeout?: number;
    userAgent?: string;
    spaOptions?: SpaOptions;
  } = {}
): Promise<{ html: string; finalUrl: string } | { error: string }> {
  const { timeout = 30000, userAgent, spaOptions = {} } = options;

  let page: PageLike | null = null;

  try {
    const browser = await getBrowser(spaOptions);
    page = await browser.newPage();

    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });

    // Set user agent if provided
    if (userAgent) {
      await page.setUserAgent(userAgent);
    }

    // Navigate to URL with timeout
    const response = await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout,
    });

    if (!response) {
      return { error: 'No response received' };
    }

    const status = response.status();
    if (status >= 400) {
      return { error: `HTTP ${status}` };
    }

    // Wait for specific selector if provided
    if (spaOptions.waitForSelector) {
      try {
        await page.waitForSelector(spaOptions.waitForSelector, {
          timeout: timeout / 2,
        });
      } catch {
        // Selector not found, but continue anyway
      }
    }

    // Additional wait for JS rendering
    const waitTime = spaOptions.waitAfterLoad ?? SPA_DEFAULTS.waitAfterLoad;
    if (waitTime > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    // Get rendered HTML
    const html = await page.content();
    const finalUrl = page.url();

    return { html, finalUrl };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('timeout') || message.includes('Timeout')) {
      return { error: 'timeout' };
    }
    return { error: message };
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

/**
 * Check if a URL likely requires SPA rendering.
 *
 * Heuristic based on common SPA patterns.
 */
export function looksLikeSpa(html: string): boolean {
  // Check for common SPA indicators in static HTML
  const spaIndicators = [
    // React
    '<div id="root"></div>',
    '<div id="app"></div>',
    // Vue
    '<div id="__nuxt">',
    // Angular
    '<app-root>',
    // Generic empty body
    '<body></body>',
    // noscript warnings
    'enable JavaScript',
    'JavaScript is required',
    'JavaScript must be enabled',
  ];

  const lowerHtml = html.toLowerCase();
  return spaIndicators.some((indicator) => lowerHtml.includes(indicator.toLowerCase()));
}
