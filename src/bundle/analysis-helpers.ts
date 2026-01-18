/**
 * Bundle Analysis Helpers Module
 *
 * Helper functions for bundle analysis including language detection,
 * file grouping, and static fact generation.
 *
 * This module was extracted from service.ts to follow Single Responsibility Principle.
 *
 * @module bundle/analysis-helpers
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { PreflightConfig } from '../config.js';
import { logger } from '../logging/logger.js';
import { type IngestedFile, classifyIngestedFileKind } from './ingest.js';
import { analyzeBundleStatic, type AnalysisMode } from './analysis.js';
import { runAllAnalyzers, type RunAllAnalyzersOptions, type AllAnalyzersResult } from './analyzers/index.js';
import { type BundleManifestV1 } from './manifest.js';
import {
  statOrNull,
  readUtf8OrNull,
  sha256Text,
  walkFilesNoIgnore,
} from './utils.js';

// ============================================================================
// Language Detection
// ============================================================================

const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.rb': 'Ruby',
  '.php': 'PHP',
};

/**
 * Detect the primary programming language from ingested files.
 */
export function detectPrimaryLanguage(files: IngestedFile[]): string | undefined {
  const langCounts = new Map<string, number>();
  for (const file of files) {
    if (file.kind !== 'code') continue;
    const ext = path.extname(file.repoRelativePath).toLowerCase();
    const lang = EXT_TO_LANG[ext];
    if (lang) {
      langCounts.set(lang, (langCounts.get(lang) || 0) + 1);
    }
  }

  if (langCounts.size === 0) return undefined;

  // Return the most common language
  let maxLang: string | undefined;
  let maxCount = 0;
  for (const [lang, count] of langCounts) {
    if (count > maxCount) {
      maxCount = count;
      maxLang = lang;
    }
  }
  return maxLang;
}

// ============================================================================
// File Grouping
// ============================================================================

/**
 * Group ingested files by repository ID.
 */
export function groupFilesByRepoId(files: IngestedFile[]): Array<{ repoId: string; files: IngestedFile[] }> {
  const byRepo = new Map<string, IngestedFile[]>();
  for (const f of files) {
    const arr = byRepo.get(f.repoId);
    if (arr) {
      arr.push(f);
    } else {
      byRepo.set(f.repoId, [f]);
    }
  }
  return Array.from(byRepo.entries()).map(([repoId, repoFiles]) => ({ repoId, files: repoFiles }));
}

// ============================================================================
// Static Facts Generation
// ============================================================================

/**
 * Generate static analysis facts (FACTS.json) best-effort.
 * Does not throw on failure - logs and continues.
 */
export async function generateFactsBestEffort(params: {
  bundleId: string;
  bundleRoot: string;
  files: IngestedFile[];
  mode: AnalysisMode;
}): Promise<void> {
  if (params.mode === 'none') return;

  try {
    const repos = groupFilesByRepoId(params.files);
    const result = await analyzeBundleStatic({
      bundleId: params.bundleId,
      bundleRoot: params.bundleRoot,
      repos,
      mode: params.mode,
    });

    if (result.error) {
      logger.warn('Static analysis error', { error: result.error });
    }
  } catch (err) {
    logger.error('Static analysis exception', err instanceof Error ? err : undefined);
  }
}

/**
 * Run all advanced analyzers on the bundle (best-effort).
 * 
 * This includes:
 * - GoF design pattern detection
 * - Architectural pattern detection  
 * - Test example extraction
 * - Configuration extraction
 * - Doc-code conflict detection
 * 
 * Results are written to analysis/*.json files.
 */
export async function runAdvancedAnalyzersBestEffort(params: {
  bundleId: string;
  bundleRoot: string;
  files: IngestedFile[];
  manifest: BundleManifestV1;
  mode: AnalysisMode;
  options?: RunAllAnalyzersOptions;
}): Promise<AllAnalyzersResult | null> {
  // Skip if analysis mode is 'none'
  if (params.mode === 'none') {
    logger.debug('Skipping advanced analyzers (mode=none)');
    return null;
  }

  // Only run in 'full' mode (advanced analyzers are expensive)
  if (params.mode !== 'full') {
    logger.debug('Skipping advanced analyzers (mode != full)');
    return null;
  }

  try {
    logger.info('Starting advanced analyzers', {
      bundleId: params.bundleId,
      fileCount: params.files.length,
    });

    const result = await runAllAnalyzers(
      params.bundleRoot,
      params.files,
      params.manifest,
      params.options
    );

    if (result.errors.length > 0) {
      logger.warn('Some advanced analyzers had errors', { 
        errors: result.errors,
      });
    }

    logger.info('Advanced analyzers complete', {
      bundleId: params.bundleId,
      timing: result.timing,
      gofPatterns: result.gofPatterns?.data?.totalPatterns ?? 0,
      architectural: result.architectural?.data?.patterns?.length ?? 0,
    });

    return result;
  } catch (err) {
    logger.error('Advanced analyzers failed', err instanceof Error ? err : undefined);
    return null;
  }
}

// Re-export types for convenience
export type { RunAllAnalyzersOptions, AllAnalyzersResult };

// ============================================================================
// Bundle File Scanning
// ============================================================================

/**
 * Scan a bundle for indexable files.
 * Returns files from repos/.
 */
export async function scanBundleIndexableFiles(params: {
  cfg: PreflightConfig;
  bundleRootDir: string;
  reposDir: string;
  librariesDir: string;
}): Promise<{ files: IngestedFile[]; totalBytes: number; skipped: string[] }> {
  const files: IngestedFile[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;

  const pushFile = async (f: {
    repoId: string;
    kind: 'doc' | 'code';
    repoRelativePath: string;
    bundleRelPosix: string;
    absPath: string;
  }) => {
    const st = await statOrNull(f.absPath);
    if (!st?.isFile()) return;

    if (st.size > params.cfg.maxFileBytes) {
      skipped.push(`${f.bundleRelPosix} (too large: ${st.size} bytes)`);
      return;
    }

    if (totalBytes + st.size > params.cfg.maxTotalBytes) {
      skipped.push(`(bundle maxTotalBytes reached) stopped before: ${f.bundleRelPosix}`);
      return;
    }

    const text = await readUtf8OrNull(f.absPath);
    if (text === null) {
      skipped.push(`${f.bundleRelPosix} (unreadable utf8)`);
      return;
    }

    const normalized = text.replace(/\r\n/g, '\n');
    const sha256 = sha256Text(normalized);

    totalBytes += st.size;

    files.push({
      repoId: f.repoId,
      kind: f.kind,
      repoRelativePath: f.repoRelativePath,
      bundleNormRelativePath: f.bundleRelPosix,
      bundleNormAbsPath: f.absPath,
      sha256,
      bytes: st.size,
    });
  };

  // 1) repos/<owner>/<repo>/norm/** (github/local)
  try {
    const owners = await fs.readdir(params.reposDir, { withFileTypes: true });
    for (const ownerEnt of owners) {
      if (!ownerEnt.isDirectory()) continue;
      const owner = ownerEnt.name;
      const ownerDir = path.join(params.reposDir, owner);

      const repos = await fs.readdir(ownerDir, { withFileTypes: true });
      for (const repoEnt of repos) {
        if (!repoEnt.isDirectory()) continue;
        const repo = repoEnt.name;
        const normDir = path.join(ownerDir, repo, 'norm');
        const normSt = await statOrNull(normDir);
        if (!normSt?.isDirectory()) continue;

        for await (const wf of walkFilesNoIgnore(normDir)) {
          const repoRel = wf.relPosix;
          const kind = classifyIngestedFileKind(repoRel);
          const bundleRel = `repos/${owner}/${repo}/norm/${repoRel}`;
          await pushFile({
            repoId: `${owner}/${repo}`,
            kind,
            repoRelativePath: repoRel,
            bundleRelPosix: bundleRel,
            absPath: wf.absPath,
          });
        }
      }
    }
  } catch {
    // ignore missing repos dir
  }

  return { files, totalBytes, skipped };
}
