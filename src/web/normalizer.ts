/**
 * URL Normalizer and Security Module
 *
 * Provides URL normalization, safe ID generation, and SSRF protection.
 *
 * @module web/normalizer
 */

import crypto from 'node:crypto';

/**
 * SSRF protection: validate URL is safe to fetch.
 * Blocks internal IPs, localhost, and dangerous protocols.
 */
export function validateWebUrl(url: string): void {
  const parsed = new URL(url);

  // Only allow http/https
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Invalid protocol: ${parsed.protocol}. Only http and https are allowed.`);
  }

  // Block credentials in URL
  if (parsed.username || parsed.password) {
    throw new Error('URL must not contain credentials (username/password).');
  }

  const host = parsed.hostname.toLowerCase();

  // Block localhost variations
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    throw new Error('Access to localhost is not allowed.');
  }

  // Block private IP ranges (RFC 1918 / RFC 4193)
  const privateIpPatterns = [
    /^10\./,                          // 10.0.0.0/8
    /^192\.168\./,                    // 192.168.0.0/16
    /^172\.(1[6-9]|2[0-9]|3[01])\./,  // 172.16.0.0/12
    /^169\.254\./,                    // Link-local 169.254.0.0/16
    /^0\./,                           // 0.0.0.0/8
    /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // Carrier-grade NAT 100.64.0.0/10
    /^192\.0\.0\./,                   // IETF Protocol 192.0.0.0/24
    /^198\.1[89]\./,                  // Benchmark testing 198.18.0.0/15
  ];

  for (const pattern of privateIpPatterns) {
    if (pattern.test(host)) {
      throw new Error(`Access to private/internal IP ranges is not allowed: ${host}`);
    }
  }

  // Block common internal hostnames
  const internalHostPatterns = [
    /\.local$/,
    /\.internal$/,
    /\.lan$/,
    /^metadata\./,  // Cloud metadata services
    /^instance-data\./,
  ];

  for (const pattern of internalHostPatterns) {
    if (pattern.test(host)) {
      throw new Error(`Access to internal hostnames is not allowed: ${host}`);
    }
  }

  // Block AWS/GCP/Azure metadata endpoints
  const metadataIps = ['169.254.169.254', '169.254.170.2', 'fd00:ec2::254'];
  if (metadataIps.includes(host)) {
    throw new Error('Access to cloud metadata endpoints is not allowed.');
  }
}

/**
 * Check if a path has a file extension.
 */
function hasFileExtension(pathname: string): boolean {
  const lastSegment = pathname.split('/').pop() || '';
  return lastSegment.includes('.') && !lastSegment.startsWith('.');
}

/**
 * Normalize a URL for consistent comparison and storage.
 *
 * - Removes fragment (#)
 * - Removes credentials
 * - Lowercases host
 * - Removes default ports (80/443)
 * - Normalizes trailing slashes:
 *   - Root path (/): keep trailing slash
 *   - Paths with file extension: no trailing slash
 *   - Other paths: remove trailing slash (e.g., /docs/ → /docs)
 */
export function normalizeUrl(url: string): string {
  const parsed = new URL(url);

  // Remove fragment
  parsed.hash = '';

  // Remove credentials
  parsed.username = '';
  parsed.password = '';

  // Lowercase host
  parsed.hostname = parsed.hostname.toLowerCase();

  // Remove default ports
  if (
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    (parsed.protocol === 'https:' && parsed.port === '443')
  ) {
    parsed.port = '';
  }

  // Normalize trailing slash
  if (parsed.pathname === '/') {
    // Root URL - ensure trailing slash
    // (URL class already handles this)
  } else if (hasFileExtension(parsed.pathname)) {
    // Has file extension - no trailing slash
    if (parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
  } else {
    // No extension - remove trailing slash for consistency
    // /docs/ and /docs should be treated as the same URL
    if (parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
  }

  return parsed.href;
}

/**
 * Generate a safe filesystem ID from a URL.
 *
 * Preserves dots in hostname to prevent collisions:
 * - react.dev → 'react.dev'
 * - react-dev.com → 'react-dev.com'
 * - react.dev/learn → 'react.dev_learn'
 */
export function generateSafeId(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();

  // Clean up path
  let pathPart = parsed.pathname;

  // Remove leading slash
  if (pathPart.startsWith('/')) {
    pathPart = pathPart.slice(1);
  }

  // Remove trailing slash
  if (pathPart.endsWith('/')) {
    pathPart = pathPart.slice(0, -1);
  }

  // If path is empty or just '/', return just the host
  if (!pathPart) {
    return host;
  }

  // Replace unsafe characters with underscore (keep . - _)
  const safePath = pathPart.replace(/[^a-zA-Z0-9_.-]/g, '_');

  // If path is too long, hash it
  if (safePath.length > 50) {
    const hash = crypto.createHash('sha256').update(parsed.pathname).digest('hex').slice(0, 8);
    return `${host}_${hash}`;
  }

  return `${host}_${safePath}`;
}

/**
 * Check if URL matches include/exclude patterns.
 */
export function matchesPatterns(
  url: string,
  patterns: { include?: string[]; exclude?: string[] }
): boolean {
  const parsed = new URL(url);
  const fullPath = parsed.pathname + parsed.search;

  // If include patterns are specified, URL must match at least one
  if (patterns.include && patterns.include.length > 0) {
    const matchesInclude = patterns.include.some(
      (pattern) => fullPath.includes(pattern) || parsed.href.includes(pattern)
    );
    if (!matchesInclude) {
      return false;
    }
  }

  // If exclude patterns are specified, URL must not match any
  if (patterns.exclude && patterns.exclude.length > 0) {
    const matchesExclude = patterns.exclude.some(
      (pattern) => fullPath.includes(pattern) || parsed.href.includes(pattern)
    );
    if (matchesExclude) {
      return false;
    }
  }

  return true;
}

/**
 * Check if two URLs are from the same origin.
 */
export function isSameOrigin(url1: string, url2: string): boolean {
  try {
    const parsed1 = new URL(url1);
    const parsed2 = new URL(url2);
    return parsed1.origin === parsed2.origin;
  } catch {
    return false;
  }
}

/**
 * Resolve a potentially relative URL against a base URL.
 */
export function resolveUrl(href: string, baseUrl: string): string | null {
  try {
    const resolved = new URL(href, baseUrl);
    return normalizeUrl(resolved.href);
  } catch {
    return null;
  }
}

/**
 * Extract the path component for use as a filename.
 * Converts URL path to filesystem-safe filename.
 * Includes query parameter hash to prevent collisions (e.g., ?page=1 vs ?page=2).
 */
export function urlToFilename(url: string): string {
  const parsed = new URL(url);
  let filename = parsed.pathname;

  // Remove leading slash
  if (filename.startsWith('/')) {
    filename = filename.slice(1);
  }

  // If empty or just index, use 'index'
  if (!filename || filename === '/' || filename.endsWith('/')) {
    filename = filename ? filename.slice(0, -1) + '/index' : 'index';
  }

  // Remove or replace unsafe characters
  filename = filename.replace(/[<>:"|?*]/g, '_');

  // Add query hash suffix if query params exist (prevents collisions)
  if (parsed.search) {
    const queryHash = crypto.createHash('sha256').update(parsed.search).digest('hex').slice(0, 8);
    // Insert hash before extension or at end
    const extMatch = filename.match(/\.(html?|php|asp|aspx|jsp|md)$/i);
    if (extMatch) {
      filename = filename.slice(0, -extMatch[0].length) + `_${queryHash}` + extMatch[0];
    } else {
      filename += `_${queryHash}`;
    }
  }

  // Ensure it ends with .md
  if (!filename.endsWith('.md')) {
    // Remove existing extension if present
    filename = filename.replace(/\.(html?|php|asp|aspx|jsp)$/i, '');
    filename += '.md';
  }

  return filename;
}
