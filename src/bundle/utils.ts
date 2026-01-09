/**
 * Bundle Utilities Module
 *
 * Common utility functions used across bundle operations.
 *
 * This module was extracted from service.ts to follow Single Responsibility Principle.
 *
 * @module bundle/utils
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// ============================================================================
// Time Utilities
// ============================================================================

/**
 * Get the current time as an ISO string.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Convert a path to POSIX format (forward slashes).
 */
export function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}

// ============================================================================
// Hash Utilities
// ============================================================================

/**
 * Compute SHA256 hash of text content.
 */
export function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ============================================================================
// File System Utilities
// ============================================================================

/**
 * Stat a file, returning null if it doesn't exist or on error.
 */
export async function statOrNull(p: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

/**
 * Read a file as UTF-8, returning null if it doesn't exist or on error.
 */
export async function readUtf8OrNull(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Ensure a directory exists, creating it if necessary.
 */
export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

/**
 * Remove a file or directory if it exists.
 */
export async function rmIfExists(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

/**
 * Check if a path is accessible.
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
 * Copy a directory recursively.
 */
export async function copyDir(src: string, dest: string): Promise<void> {
  await fs.cp(src, dest, { recursive: true, force: true });
}

// ============================================================================
// File Walking
// ============================================================================

/**
 * Walk all files in a directory recursively (no ignore rules).
 * Yields absolute path and POSIX-style relative path for each file.
 */
export async function* walkFilesNoIgnore(rootDir: string): AsyncGenerator<{ absPath: string; relPosix: string }> {
  const stack: string[] = [rootDir];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = toPosix(path.relative(rootDir, abs));
      if (ent.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      yield { absPath: abs, relPosix: rel };
    }
  }
}
