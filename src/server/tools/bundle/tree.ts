/**
 * preflight_repo_tree - Get repository structure overview.
 */

import * as z from 'zod';

import type { ToolDependencies } from '../types.js';
import { shouldRegisterTool } from './types.js';
import { findBundleStorageDir, getBundlePathsForId } from '../../../bundle/service.js';
import { readManifest } from '../../../bundle/manifest.js';
import { toBundleFileUri } from '../../../mcp/uris.js';
import { wrapPreflightError } from '../../../mcp/errorKinds.js';
import { BundleNotFoundError } from '../../../errors.js';
import { generateRepoTree, formatTreeResult } from '../../../bundle/tree.js';

// ==========================================================================
// preflight_repo_tree
// ==========================================================================

/**
 * Register preflight_repo_tree tool.
 */
export function registerRepoTreeTool({ server, cfg }: ToolDependencies, coreOnly: boolean): void {
  if (!shouldRegisterTool('preflight_repo_tree', coreOnly)) return;

  server.registerTool(
    'preflight_repo_tree',
    {
      title: 'Repository tree & statistics',
      description:
        'Get repository structure overview with directory tree, file statistics, and entry point candidates. ' +
        'Use this BEFORE deep analysis to understand project layout without wasting tokens on search. ' +
        'Use when: "show project structure", "what files are in this repo", "项目结构", "文件分布", "show tree".',
      inputSchema: {
        bundleId: z.string().describe('Bundle ID to analyze.'),
        depth: z.number().int().min(1).max(10).default(4).describe('Maximum directory depth to traverse. Default 4.'),
        include: z.array(z.string()).optional().describe('Glob patterns to include (e.g., ["*.ts", "*.py"]). If omitted, includes all files.'),
        exclude: z.array(z.string()).optional().describe('Patterns to exclude (e.g., ["node_modules", "*.pyc"]). Defaults include common excludes.'),
        focusDir: z.string().optional().describe('Focus directory path - expand deeper within this path (e.g., "owner/repo/norm/src"). Gets +3 extra depth levels.'),
        focusDepthBonus: z.number().int().min(1).max(6).optional().describe('Extra depth levels for focusDir. Default 3.'),
        showFileCountPerDir: z.boolean().optional().describe('If true, include file count per directory in stats.byDir.'),
        showSkippedFiles: z.boolean().optional().describe('If true, include list of files that were skipped during indexing (too large, binary, etc.). Helps understand what content is NOT searchable.'),
      },
      outputSchema: {
        bundleId: z.string(),
        tree: z.string(),
        stats: z.object({
          totalFiles: z.number(),
          totalDirs: z.number(),
          byExtension: z.record(z.string(), z.number()),
          byTopDir: z.record(z.string(), z.number()),
          byDir: z.record(z.string(), z.number()).optional(),
        }),
        entryPointCandidates: z.array(
          z.object({
            path: z.string(),
            type: z.enum(['readme', 'main', 'index', 'cli', 'server', 'app', 'test', 'config']),
            priority: z.number(),
          })
        ),
        skippedFiles: z.array(
          z.object({
            path: z.string(),
            reason: z.string(),
            size: z.number().optional(),
          })
        ).optional(),
        autoFocused: z.object({
          enabled: z.boolean(),
          path: z.string().optional(),
        }).optional(),
        evidence: z.array(
          z.object({
            path: z.string(),
            range: z.object({ startLine: z.number(), endLine: z.number() }).optional(),
            uri: z.string().optional(),
            snippet: z.string().optional(),
          })
        ).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
        if (!storageDir) {
          throw new BundleNotFoundError(args.bundleId);
        }

        const paths = getBundlePathsForId(storageDir, args.bundleId);
        const result = await generateRepoTree(paths.rootDir, args.bundleId, {
          depth: args.depth,
          include: args.include,
          exclude: args.exclude,
          focusDir: args.focusDir,
          focusDepthBonus: args.focusDepthBonus,
          showFileCountPerDir: args.showFileCountPerDir,
        });

        let skippedFiles: Array<{ path: string; reason: string; size?: number }> | undefined;
        if (args.showSkippedFiles) {
          try {
            const manifest = await readManifest(paths.manifestPath);
            if (manifest.skippedFiles && manifest.skippedFiles.length > 0) {
              const reasonLabels: Record<string, string> = {
                too_large: 'too large',
                binary: 'binary file',
                non_utf8: 'non-UTF8 encoding',
                max_total_reached: 'bundle size limit reached',
              };
              skippedFiles = manifest.skippedFiles.map(s => ({
                path: s.path,
                reason: reasonLabels[s.reason] ?? s.reason,
                size: s.size,
              }));
            }
          } catch {
            // Ignore manifest read errors
          }
        }

        const evidence = result.entryPointCandidates
          .slice(0, 5)
          .map((ep) => ({
            path: ep.path,
            uri: toBundleFileUri({ bundleId: args.bundleId, relativePath: ep.path }),
          }));

        const textOutput = formatTreeResult(result);
        let fullTextOutput = textOutput;
        if (skippedFiles && skippedFiles.length > 0) {
          fullTextOutput += `\n\n## Skipped Files (${skippedFiles.length} files not searchable)\n`;
          for (const sf of skippedFiles.slice(0, 20)) {
            const sizeStr = sf.size ? ` (${(sf.size / 1024).toFixed(0)}KB)` : '';
            fullTextOutput += `- ${sf.path}: ${sf.reason}${sizeStr}\n`;
          }
          if (skippedFiles.length > 20) {
            fullTextOutput += `... and ${skippedFiles.length - 20} more\n`;
          }
        }

        const structuredResult = { ...result, skippedFiles, evidence };
        return {
          content: [{ type: 'text', text: fullTextOutput }],
          structuredContent: structuredResult,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );
}
