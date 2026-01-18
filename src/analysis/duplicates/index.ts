/**
 * Code Duplication Check Module
 *
 * Provides tools for detecting copy-paste code patterns.
 * Uses jscpd for multi-language duplication detection (150+ formats).
 *
 * @module analysis/duplicates
 */

import type { IClone } from '@jscpd/core';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Load CJS build to avoid ESM subpath import issues (colors/safe)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { detectClones } = require('jscpd') as { detectClones: (opts: Record<string, unknown>) => Promise<IClone[]> };
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createModuleLogger } from '../../logging/logger.js';
import type {
  Clone,
  CloneFragment,
  DuplicateIssue,
  DuplicateCheckResult,
  DuplicateSummary,
  FileDuplicateStats,
  DuplicateCheckOptions,
  DuplicateSeverity,
} from './types.js';
import { DEFAULT_DUPLICATE_OPTIONS, getSeverityForClone } from './types.js';

// ============================================================================
// Re-exports from types
// ============================================================================

export {
  type Clone,
  type CloneFragment,
  type CloneSourceLocation,
  type DuplicateIssue,
  type DuplicateCheckResult,
  type DuplicateSummary,
  type FileDuplicateStats,
  type DuplicateCheckOptions,
  type DuplicateSeverity,
  type DetectionMode,
  DEFAULT_DUPLICATE_OPTIONS,
  getSeverityForClone,
} from './types.js';

const logger = createModuleLogger('duplicates');

// ============================================================================
// Main Check Function
// ============================================================================

/**
 * Check code duplication for a directory or file.
 */
export async function checkDuplicates(
  targetPath: string,
  options?: Partial<DuplicateCheckOptions>
): Promise<DuplicateCheckResult> {
  const opts = { ...DEFAULT_DUPLICATE_OPTIONS, ...options };
  const resolvedPath = path.resolve(targetPath);

  logger.info(`Checking duplicates in: ${resolvedPath}`);

  // Verify path exists
  const stat = await fs.stat(resolvedPath);
  const pathsToCheck = stat.isFile() ? [path.dirname(resolvedPath)] : [resolvedPath];

  // Build jscpd options
  const jscpdOptions: Record<string, unknown> = {
    path: pathsToCheck,
    minTokens: opts.minTokens,
    minLines: opts.minLines,
    maxLines: opts.maxLines,
    maxSize: opts.maxSize,
    mode: opts.mode,
    ignore: opts.excludePatterns,
    ignoreCase: opts.ignoreCase,
    skipLocal: opts.skipLocal,
    silent: true,
    reporters: [], // We handle reporting ourselves
    absolute: true, // Get absolute paths
  };

  // Add format filter if specified
  if (opts.formats && opts.formats.length > 0) {
    jscpdOptions.format = opts.formats;
  }

  // Run jscpd detection
  const jscpdClones = await detectClones(jscpdOptions);

  // Convert jscpd clones to our format
  const clones = jscpdClones.map(convertClone);

  // If checking a single file, filter clones to only those involving that file
  if (stat.isFile()) {
    const filteredClones = clones.filter(
      (clone) =>
        clone.fragmentA.location.file === resolvedPath ||
        clone.fragmentB.location.file === resolvedPath
    );
    return buildResult(filteredClones);
  }

  return buildResult(clones);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert jscpd clone to our Clone type.
 */
function convertClone(jscpdClone: IClone): Clone {
  return {
    fragmentA: {
      location: {
        file: jscpdClone.duplicationA.sourceId,
        startLine: jscpdClone.duplicationA.start.line,
        endLine: jscpdClone.duplicationA.end.line,
        startColumn: jscpdClone.duplicationA.start.column,
        endColumn: jscpdClone.duplicationA.end.column,
      },
      lines: jscpdClone.duplicationA.end.line - jscpdClone.duplicationA.start.line + 1,
      tokens: jscpdClone.duplicationA.range?.[1] ?? 0,
      preview: jscpdClone.duplicationA.fragment?.slice(0, 200),
    },
    fragmentB: {
      location: {
        file: jscpdClone.duplicationB.sourceId,
        startLine: jscpdClone.duplicationB.start.line,
        endLine: jscpdClone.duplicationB.end.line,
        startColumn: jscpdClone.duplicationB.start.column,
        endColumn: jscpdClone.duplicationB.end.column,
      },
      lines: jscpdClone.duplicationB.end.line - jscpdClone.duplicationB.start.line + 1,
      tokens: jscpdClone.duplicationB.range?.[1] ?? 0,
      preview: jscpdClone.duplicationB.fragment?.slice(0, 200),
    },
    format: jscpdClone.format,
    linesCount: jscpdClone.duplicationA.end.line - jscpdClone.duplicationA.start.line + 1,
    tokensCount: jscpdClone.duplicationA.range?.[1] ?? 0,
  };
}

/**
 * Build the full result from clones.
 */
function buildResult(clones: Clone[]): DuplicateCheckResult {
  // Build issues from clones
  const issues: DuplicateIssue[] = [];
  for (const clone of clones) {
    const severity = getSeverityForClone(clone);
    const fileA = clone.fragmentA.location.file;
    const fileB = clone.fragmentB.location.file;
    const rangeA = `${clone.fragmentA.location.startLine}-${clone.fragmentA.location.endLine}`;
    const rangeB = `${clone.fragmentB.location.startLine}-${clone.fragmentB.location.endLine}`;

    // Create issue for the first occurrence
    issues.push({
      severity,
      file: fileA,
      lineRange: rangeA,
      message: `Duplicated ${clone.linesCount} lines with ${path.basename(fileB)} (${rangeB})`,
      clone,
    });
  }

  // Build per-file statistics
  const fileStatsMap = new Map<string, FileDuplicateStats>();

  for (const clone of clones) {
    for (const fragment of [clone.fragmentA, clone.fragmentB]) {
      const file = fragment.location.file;
      if (!fileStatsMap.has(file)) {
        fileStatsMap.set(file, {
          file,
          format: clone.format,
          totalLines: 0, // Will be estimated
          duplicatedLines: 0,
          duplicationPercent: 0,
          cloneCount: 0,
        });
      }
      const stats = fileStatsMap.get(file)!;
      stats.duplicatedLines += fragment.lines;
      stats.cloneCount++;
    }
  }

  const files = Array.from(fileStatsMap.values());

  // Build summary
  const summary = computeSummary(clones, issues, files);

  return {
    issues,
    clones,
    files,
    summary,
  };
}

/**
 * Compute summary statistics.
 */
function computeSummary(
  clones: Clone[],
  issues: DuplicateIssue[],
  files: FileDuplicateStats[]
): DuplicateSummary {
  const totalDuplicatedLines = files.reduce((sum, f) => sum + f.duplicatedLines, 0);

  // Count by format
  const clonesByFormat: Record<string, number> = {};
  for (const clone of clones) {
    clonesByFormat[clone.format] = (clonesByFormat[clone.format] || 0) + 1;
  }

  // Count by severity
  const issuesBySeverity: Record<DuplicateSeverity, number> = {
    error: 0,
    warning: 0,
    info: 0,
  };
  for (const issue of issues) {
    issuesBySeverity[issue.severity]++;
  }

  return {
    totalFiles: files.length,
    totalLines: 0, // Would need to count actual file lines
    duplicatedLines: totalDuplicatedLines,
    duplicationPercent: 0, // Would need total lines to calculate
    totalClones: clones.length,
    issuesBySeverity,
    clonesByFormat,
  };
}
