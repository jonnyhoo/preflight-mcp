/**
 * Bundle Validation Module
 *
 * Validates bundle completeness and integrity.
 *
 * This module was extracted from service.ts to follow Single Responsibility Principle.
 *
 * @module bundle/validation
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { PreflightConfig } from '../config.js';
import { BundleNotFoundError } from '../errors.js';
import { getBundlePaths } from './paths.js';
import { findBundleStorageDir } from './list.js';

export interface ValidationResult {
  isValid: boolean;
  missingComponents: string[];
}

/**
 * Required files for a complete bundle.
 */
const REQUIRED_FILES = [
  'manifest.json',
  'START_HERE.md',
  'AGENTS.md',
  'OVERVIEW.md',
];

/**
 * Validate bundle completeness after creation.
 * Ensures all critical files exist and have meaningful content.
 */
export async function validateBundleCompleteness(bundleRoot: string): Promise<ValidationResult> {
  const missingComponents: string[] = [];

  // Check required files
  for (const file of REQUIRED_FILES) {
    const filePath = path.join(bundleRoot, file);
    try {
      const stats = await fs.stat(filePath);
      // Check if file has meaningful content (not empty)
      if (stats.size === 0) {
        missingComponents.push(`${file} (empty)`);
      } else if (file === 'manifest.json' && stats.size < 50) {
        // Manifest should be at least 50 bytes
        missingComponents.push(`${file} (too small, likely incomplete)`);
      }
    } catch {
      missingComponents.push(`${file} (missing)`);
    }
  }

  // Check repos directory exists
  const reposDir = path.join(bundleRoot, 'repos');
  try {
    const reposStats = await fs.stat(reposDir);
    if (!reposStats.isDirectory()) {
      missingComponents.push('repos (not a directory)');
    }
  } catch {
    // repos directory is optional for library-only bundles
  }

  return {
    isValid: missingComponents.length === 0,
    missingComponents,
  };
}

/**
 * Parse a skipped file string (from ingest) into structured format.
 * 
 * Formats:
 * - "path/to/file (too large: 12345 bytes)"
 * - "path/to/file (binary)"
 * - "path/to/file (non-utf8)"
 * - "(bundle maxTotalBytes reached) stopped before: path/to/file"
 */
export interface SkippedFileInfo {
  path: string;
  reason: 'too_large' | 'binary' | 'non_utf8' | 'max_total_reached';
  size?: number;
}

export function parseSkippedString(s: string, repoId: string): SkippedFileInfo | null {
  // Pattern: "path (too large: 12345 bytes)"
  const tooLargeMatch = s.match(/^(.+?) \(too large: (\d+) bytes\)$/);
  if (tooLargeMatch) {
    return {
      path: `${repoId}/${tooLargeMatch[1]}`,
      reason: 'too_large',
      size: parseInt(tooLargeMatch[2]!, 10),
    };
  }

  // Pattern: "path (binary)"
  const binaryMatch = s.match(/^(.+?) \(binary\)$/);
  if (binaryMatch) {
    return {
      path: `${repoId}/${binaryMatch[1]}`,
      reason: 'binary',
    };
  }

  // Pattern: "path (non-utf8)"
  const nonUtf8Match = s.match(/^(.+?) \(non-utf8\)$/);
  if (nonUtf8Match) {
    return {
      path: `${repoId}/${nonUtf8Match[1]}`,
      reason: 'non_utf8',
    };
  }

  // Pattern: "(bundle maxTotalBytes reached) stopped before: path"
  const maxTotalMatch = s.match(/^\(bundle maxTotalBytes reached\) stopped before: (.+)$/);
  if (maxTotalMatch) {
    return {
      path: `${repoId}/${maxTotalMatch[1]}`,
      reason: 'max_total_reached',
    };
  }

  return null;
}

/**
 * Assert that a bundle is complete and ready for operations.
 * Throws an error with helpful guidance if the bundle is incomplete.
 * Should be called at the entry point of tools that require a complete bundle
 * (e.g., dependency graph, trace links, search).
 */
export async function assertBundleComplete(
  cfg: PreflightConfig,
  bundleId: string
): Promise<void> {
  const storageDir = await findBundleStorageDir(cfg.storageDirs, bundleId);
  if (!storageDir) {
    throw new BundleNotFoundError(bundleId);
  }

  const bundleRoot = getBundlePaths(storageDir, bundleId).rootDir;
  const { isValid, missingComponents } = await validateBundleCompleteness(bundleRoot);

  if (!isValid) {
    const issues = missingComponents.join('\n  - ');
    throw new Error(
      `Bundle is incomplete and cannot be used for this operation.\n\n` +
      `Bundle ID: ${bundleId}\n` +
      `Missing components:\n  - ${issues}\n\n` +
      `This usually happens when:\n` +
      `1. Bundle creation was interrupted (timeout, network error, etc.)\n` +
      `2. Bundle download is still in progress\n\n` +
      `Suggested actions:\n` +
      `- Use preflight_update_bundle with force:true to re-download the repository\n` +
      `- Or use preflight_delete_bundle and preflight_create_bundle to start fresh\n` +
      `- Check preflight_get_task_status if creation might still be in progress`
    );
  }
}
