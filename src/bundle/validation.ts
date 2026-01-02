/**
 * Bundle validation utilities.
 * Ensures bundle completeness and integrity.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

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
  reason: 'too_large' | 'binary' | 'non_utf8' | 'max_total_reached' | 'unknown';
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
