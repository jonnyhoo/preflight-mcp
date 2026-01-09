/**
 * Bundle Listing and Lookup Module
 *
 * Provides functions for listing and finding bundles across storage directories.
 *
 * This module was extracted from service.ts to follow Single Responsibility Principle.
 *
 * @module bundle/list
 */

import fs from 'node:fs/promises';

import { getBundlePaths } from './paths.js';

// ============================================================================
// Validation
// ============================================================================

/**
 * Check if a string is a valid UUID (v4 format).
 * Bundle IDs should be UUIDs with dashes.
 */
function isValidBundleId(id: string): boolean {
  // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}

// ============================================================================
// Listing Functions
// ============================================================================

/**
 * List bundles from a single storage directory.
 */
export async function listBundles(storageDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(storageDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && isValidBundleId(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * List bundles from multiple storage directories (deduped).
 */
export async function listBundlesMulti(storageDirs: string[]): Promise<string[]> {
  const all = await Promise.all(storageDirs.map((d) => listBundles(d)));
  return [...new Set(all.flat())];
}

// ============================================================================
// Existence Checks
// ============================================================================

/**
 * Check if bundle exists in a single storage directory.
 */
export async function bundleExists(storageDir: string, bundleId: string): Promise<boolean> {
  const paths = getBundlePaths(storageDir, bundleId);
  try {
    await fs.stat(paths.manifestPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find which storage directory contains the bundle.
 * Returns null if not found in any directory.
 */
export async function findBundleStorageDir(storageDirs: string[], bundleId: string): Promise<string | null> {
  for (const dir of storageDirs) {
    if (await bundleExists(dir, bundleId)) {
      return dir;
    }
  }
  return null;
}

/**
 * Check if bundle exists in any of the storage directories.
 */
export async function bundleExistsMulti(storageDirs: string[], bundleId: string): Promise<boolean> {
  return (await findBundleStorageDir(storageDirs, bundleId)) !== null;
}
