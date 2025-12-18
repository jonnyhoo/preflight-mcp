/**
 * Common utility functions used across the preflight-mcp codebase.
 * Centralizes repeated helper functions to reduce code duplication.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

/**
 * Remove a file or directory if it exists.
 * Does nothing if the path doesn't exist.
 */
export async function rmIfExists(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

/**
 * Get current timestamp in ISO format.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Convert a path to POSIX format (forward slashes).
 */
export function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}

/**
 * Calculate SHA256 hash of a buffer and return as hex string.
 */
export function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Calculate SHA256 hash of a UTF-8 string and return as hex string.
 */
export function sha256HexString(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Check if a path is accessible (exists and can be read).
 */
export async function isPathAvailable(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a path's parent directory is accessible.
 */
export async function isParentAvailable(p: string): Promise<boolean> {
  const parent = path.dirname(p);
  return isPathAvailable(parent);
}

/**
 * Copy directory recursively.
 */
export async function copyDir(src: string, dest: string): Promise<void> {
  await fs.cp(src, dest, { recursive: true, force: true });
}

/**
 * Write JSON to a file with pretty formatting.
 */
export async function writeJson(targetPath: string, obj: unknown): Promise<void> {
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/**
 * Clip UTF-8 text to a maximum byte size.
 * Returns the clipped text and a flag indicating if truncation occurred.
 */
export function clipUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const normalized = text.replace(/\r\n/g, '\n');
  const buf = Buffer.from(normalized, 'utf8');
  if (buf.length <= maxBytes) return { text: normalized, truncated: false };
  // Cutting at a byte boundary may split a multi-byte codepoint; Node will replace invalid sequences.
  const clipped = buf.subarray(0, maxBytes).toString('utf8');
  return { text: `${clipped}\n\n[TRUNCATED]\n`, truncated: true };
}

/**
 * Create a URL-safe slug from a string.
 */
export function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}
