/**
 * Analysis tools - deep_analyze, dependency_graph, validate_report
 */

import fs from 'node:fs/promises';
import * as z from 'zod';

import type { ToolDependencies } from './types.js';
import {
  assertBundleComplete,
  findBundleStorageDir,
  getBundlePathsForId,
} from '../../bundle/service.js';
import { readManifest } from '../../bundle/manifest.js';
import { safeJoin, toBundleFileUri } from '../../mcp/uris.js';
import { wrapPreflightError } from '../../mcp/errorKinds.js';
import { BundleNotFoundError } from '../../errors.js';
import { generateRepoTree, formatTreeResult } from '../../bundle/tree.js';
import { DependencyGraphInputSchema, generateDependencyGraph } from '../../evidence/dependencyGraph.js';
import { searchIndexAdvanced } from '../../search/sqliteFts.js';
import { traceQuery } from '../../trace/service.js';
import { buildDeepAnalysis, detectTestInfo, type TreeSummary, type SearchSummary, type DepsSummary, type TraceSummary, type OverviewContent, type TestInfo } from '../../analysis/deep.js';
import { validateReport } from '../../analysis/validate.js';
import { type Claim, type EvidenceRef } from '../../types/evidence.js';

/**
 * Register all analysis-related tools.
 */
export function registerAnalysisTools({ server, cfg }: ToolDependencies): void {
  // ==========================================================================
  // preflight_dependency_graph
  // ==========================================================================
  server.registerTool(
    'preflight_dependency_graph',
    {
      title: 'Dependency graph',
      description:
        'Get or generate dependency graph for a bundle. ' +
        'Auto-generates if not cached, returns cached version if available. ' +
        'Use when: "show dependencies", "看依赖图", "import graph", "what does X depend on".\n\n' +
        '**Modes:**\n' +
        '- `scope: "global"` (default): Project-wide dependency graph\n' +
        '- `scope: "target"` with `targetFile`: Dependencies for a specific file\n\n' +
        '**Format:**\n' +
        '- `format: "summary"` (default): Top nodes, aggregated by directory, key edges only\n' +
        '- `format: "full"`: Complete graph data with coverage report',
      inputSchema: {
        bundleId: z.string().describe('Bundle ID. Use preflight_list_bundles to find available bundles.'),
        scope: z.enum(['global', 'target']).optional().default('global').describe('global=project-wide, target=single file.'),
        targetFile: z.string().optional().describe('Target file path (required when scope="target"). Use bundle-relative path: repos/{owner}/{repo}/norm/{path}.'),
        format: z.enum(['summary', 'full']).optional().default('summary').describe('summary=aggregated view (recommended), full=raw graph data.'),
        fresh: z.boolean().optional().default(false).describe('If true, regenerate graph even if cached version exists.'),
      },
      outputSchema: {
        bundleId: z.string(),
        scope: z.enum(['global', 'target']),
        format: z.enum(['summary', 'full']),
        summary: z.object({
          totalNodes: z.number(),
          totalEdges: z.number(),
          topImporters: z.array(z.object({
            file: z.string(),
            importCount: z.number(),
          })),
          topImported: z.array(z.object({
            file: z.string(),
            importedByCount: z.number(),
          })),
          byDirectory: z.record(z.string(), z.number()),
        }).optional(),
        facts: z.any().optional(),
        coverageReport: z.any().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        await assertBundleComplete(cfg, args.bundleId);
        
        const depGraphArgs: any = {
          bundleId: args.bundleId,
          options: {
            timeBudgetMs: 30000,
            maxFiles: 500,
            maxNodes: 1000,
            maxEdges: 5000,
          },
        };
        
        if (args.scope === 'target' && args.targetFile) {
          depGraphArgs.target = { file: args.targetFile };
        }
        
        if (args.fresh) {
          depGraphArgs.options.force = true;
        }
        
        const rawResult = await generateDependencyGraph(cfg, depGraphArgs);
        
        if (args.format === 'summary') {
          const edges = rawResult.facts?.edges ?? [];
          const nodes = rawResult.facts?.nodes ?? [];
          
          const importCounts: Record<string, number> = {};
          const importedByCounts: Record<string, number> = {};
          const dirCounts: Record<string, number> = {};
          
          for (const edge of edges) {
            if (edge.type === 'imports' || edge.type === 'imports_resolved') {
              const from = typeof edge.from === 'string' ? edge.from.replace(/^file:/, '') : '';
              const to = typeof edge.to === 'string' ? edge.to.replace(/^(file:|module:)/, '') : '';
              
              if (from) {
                importCounts[from] = (importCounts[from] ?? 0) + 1;
                const dir = from.split('/').slice(0, -1).join('/') || '(root)';
                dirCounts[dir] = (dirCounts[dir] ?? 0) + 1;
              }
              if (to && !to.startsWith('.')) {
                importedByCounts[to] = (importedByCounts[to] ?? 0) + 1;
              }
            }
          }
          
          const topImporters = Object.entries(importCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([file, count]) => ({ file, importCount: count }));
          
          const topImported = Object.entries(importedByCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([file, count]) => ({ file, importedByCount: count }));
          
          const out = {
            bundleId: args.bundleId,
            scope: args.scope ?? 'global',
            format: 'summary' as const,
            summary: {
              totalNodes: nodes.length,
              totalEdges: edges.length,
              topImporters,
              topImported,
              byDirectory: dirCounts,
            },
          };
          
          let text = `## Dependency Graph Summary (${args.scope ?? 'global'})\n\n`;
          text += `- Total nodes: ${nodes.length}\n`;
          text += `- Total edges: ${edges.length}\n\n`;
          text += `### Top Importers (files with most imports)\n`;
          for (const item of topImporters.slice(0, 5)) {
            text += `- ${item.file}: ${item.importCount} imports\n`;
          }
          text += `\n### Most Imported (files imported by others)\n`;
          for (const item of topImported.slice(0, 5)) {
            text += `- ${item.file}: imported by ${item.importedByCount} files\n`;
          }
          text += `\n💡 For full graph data, use format="full"`;
          
          return {
            content: [{ type: 'text', text }],
            structuredContent: out,
          };
        }
        
        const out = {
          bundleId: args.bundleId,
          scope: args.scope ?? 'global',
          format: 'full' as const,
          facts: rawResult.facts,
          coverageReport: rawResult.coverageReport,
        };
        
        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );

  // ==========================================================================
  // preflight_deep_analyze_bundle
  // ==========================================================================
  server.registerTool(
    'preflight_deep_analyze_bundle',
    {
      title: 'Deep analyze bundle (EDDA macro)',
      description:
        'One-call deep analysis that aggregates tree, search, dependencies, and traces. ' +
        'Returns a unified evidence pack with LLM-friendly summary.\n\n' +
        '**Use when:** Starting analysis of unfamiliar codebase, need quick overview, or want comprehensive context.\n\n' +
        '**Components (all optional, enabled by default):**\n' +
        '- tree: File structure summary\n' +
        '- search: Query results (if focus.query provided)\n' +
        '- deps: Dependency graph summary\n' +
        '- traces: Test coverage links',
      inputSchema: {
        bundleId: z.string().describe('Bundle ID to analyze.'),
        focus: z.object({
          path: z.string().optional().describe('Focus on specific directory or file path.'),
          query: z.string().optional().describe('Search query to include in analysis.'),
          depth: z.number().int().min(1).max(10).optional().describe('Tree depth for focused path (default: 3).'),
        }).optional().describe('Optional focus parameters to narrow analysis.'),
        options: z.object({
          includeTree: z.boolean().optional().default(true).describe('Include file tree summary.'),
          includeSearch: z.boolean().optional().default(true).describe('Include search results (requires focus.query).'),
          includeDeps: z.boolean().optional().default(true).describe('Include dependency analysis.'),
          includeTraces: z.boolean().optional().default(true).describe('Include trace link summary.'),
          includeOverview: z.boolean().optional().default(true).describe('Include OVERVIEW.md, START_HERE.md, AGENTS.md content.'),
          includeReadme: z.boolean().optional().default(true).describe('Include README.md content from repos.'),
          includeTests: z.boolean().optional().default(true).describe('Detect test directories and frameworks.'),
          tokenBudget: z.number().int().optional().describe('Soft limit on output tokens (reduces detail if exceeded).'),
          maxFiles: z.number().int().min(10).max(1000).optional().default(500).describe('Max files to scan for tree/deps.'),
        }).optional().describe('Analysis options.'),
      },
      outputSchema: {
        bundleId: z.string(),
        focus: z.object({ path: z.string().optional(), query: z.string().optional() }).optional(),
        tree: z.object({
          totalFiles: z.number(),
          totalDirs: z.number(),
          byExtension: z.record(z.string(), z.number()),
          topDirs: z.array(z.object({ path: z.string(), fileCount: z.number() })),
          focusedTree: z.string().optional(),
        }).optional(),
        search: z.object({
          query: z.string(),
          totalHits: z.number(),
          topFiles: z.array(z.object({ path: z.string(), hitCount: z.number(), snippet: z.string().optional() })),
          byDirectory: z.record(z.string(), z.number()),
        }).optional(),
        deps: z.object({
          totalNodes: z.number(),
          totalEdges: z.number(),
          topImporters: z.array(z.object({ file: z.string(), count: z.number() })),
          topImported: z.array(z.object({ file: z.string(), count: z.number() })),
          cycles: z.array(z.string()).optional(),
        }).optional(),
        traces: z.object({
          totalLinks: z.number(),
          byType: z.record(z.string(), z.number()),
          coverageEstimate: z.number(),
        }).optional(),
        overviewContent: z.object({
          overview: z.string().optional(),
          startHere: z.string().optional(),
          agents: z.string().optional(),
          readme: z.string().optional(),
        }).optional(),
        testInfo: z.object({
          detected: z.boolean(),
          framework: z.enum(['jest', 'vitest', 'pytest', 'go', 'mocha', 'unknown']).nullable(),
          testDirs: z.array(z.string()),
          testFiles: z.array(z.string()),
          testFileCount: z.number(),
          configFiles: z.array(z.string()),
          hint: z.string(),
        }).optional(),
        claims: z.array(z.object({
          id: z.string(),
          text: z.string(),
          confidence: z.number(),
          kind: z.string(),
          status: z.enum(['supported', 'inferred', 'unknown']),
          evidence: z.array(z.any()),
          whyInferred: z.string().optional(),
        })),
        checklistStatus: z.object({
          read_overview: z.boolean(),
          repo_tree: z.boolean(),
          search_focus: z.boolean(),
          dependency_graph_global: z.boolean(),
          entrypoints_identified: z.boolean(),
          core_modules_identified: z.boolean(),
          one_deep_dive_done: z.boolean(),
          tests_or_trace_checked: z.boolean(),
        }),
        openQuestions: z.array(z.object({
          question: z.string(),
          whyUnknown: z.string(),
          nextEvidenceToFetch: z.array(z.string()),
        })),
        coverageReport: z.any(),
        summary: z.string(),
        nextSteps: z.array(z.string()),
        nextCommands: z.array(z.object({
          tool: z.string(),
          description: z.string(),
          args: z.record(z.string(), z.unknown()),
        })),
        evidence: z.array(
          z.object({
            path: z.string(),
            range: z.object({
              startLine: z.number(),
              endLine: z.number(),
            }).optional(),
            uri: z.string().optional(),
            snippet: z.string().optional(),
          })
        ).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        await assertBundleComplete(cfg, args.bundleId);

        const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
        if (!storageDir) {
          throw new BundleNotFoundError(args.bundleId);
        }

        const paths = getBundlePathsForId(storageDir, args.bundleId);
        const opts = args.options ?? {} as {
          includeTree?: boolean;
          includeSearch?: boolean;
          includeDeps?: boolean;
          includeTraces?: boolean;
          includeOverview?: boolean;
          includeReadme?: boolean;
          includeTests?: boolean;
          tokenBudget?: number;
          maxFiles?: number;
        };
        const focus = args.focus ?? {};
        const errors: string[] = [];

        let tree: TreeSummary | undefined;
        let search: SearchSummary | undefined;
        let deps: DepsSummary | undefined;
        let traces: TraceSummary | undefined;
        let overviewContent: OverviewContent | undefined;
        let testInfo: TestInfo | undefined;

        // 1. Tree
        if (opts.includeTree ?? true) {
          try {
            const treeResult = await generateRepoTree(paths.rootDir, args.bundleId, {
              depth: focus.depth ?? 4,
              focusDir: focus.path,
              showFileCountPerDir: true,
            });
            tree = {
              totalFiles: treeResult.stats.totalFiles,
              totalDirs: treeResult.stats.totalDirs,
              byExtension: treeResult.stats.byExtension,
              topDirs: Object.entries(treeResult.stats.byDir ?? {})
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([p, count]) => ({ path: p, fileCount: count })),
              focusedTree: focus.path ? formatTreeResult(treeResult) : undefined,
            };
          } catch (e) {
            errors.push(`Tree: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // 2. Search (only if query provided)
        if ((opts.includeSearch ?? true) && focus.query) {
          try {
            const searchResult = await searchIndexAdvanced(paths.searchDbPath, focus.query, {
              scope: 'all',
              limit: 50,
              groupByFile: true,
              includeScore: true,
            });
            const byDir: Record<string, number> = {};
            for (const hit of searchResult.hits) {
              const dir = hit.path.split('/').slice(0, -1).join('/') || '(root)';
              byDir[dir] = (byDir[dir] ?? 0) + 1;
            }
            search = {
              query: focus.query,
              totalHits: searchResult.hits.length,
              topFiles: searchResult.grouped?.slice(0, 10).map(g => ({
                path: g.path,
                hitCount: g.hitCount,
                snippet: g.topSnippet,
              })) ?? searchResult.hits.slice(0, 10).map(h => ({
                path: h.path,
                hitCount: 1,
                snippet: h.snippet,
              })),
              byDirectory: byDir,
            };
          } catch (e) {
            errors.push(`Search: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // 3. Dependencies
        if (opts.includeDeps ?? true) {
          try {
            const depResult = await generateDependencyGraph(cfg, {
              bundleId: args.bundleId,
              options: {
                timeBudgetMs: 15000,
                maxNodes: (opts as any).maxFiles ?? 500,
                maxEdges: 2000,
              },
            });
            const edges = depResult.facts?.edges ?? [];
            const nodes = depResult.facts?.nodes ?? [];
            const importCounts: Record<string, number> = {};
            const importedByCounts: Record<string, number> = {};
            for (const edge of edges) {
              if (edge.type === 'imports' || edge.type === 'imports_resolved') {
                const from = typeof edge.from === 'string' ? edge.from.replace(/^file:/, '') : '';
                const to = typeof edge.to === 'string' ? edge.to.replace(/^(file:|module:)/, '') : '';
                if (from) importCounts[from] = (importCounts[from] ?? 0) + 1;
                if (to) importedByCounts[to] = (importedByCounts[to] ?? 0) + 1;
              }
            }
            deps = {
              totalNodes: nodes.length,
              totalEdges: edges.length,
              topImporters: Object.entries(importCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([file, count]) => ({ file, count })),
              topImported: Object.entries(importedByCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([file, count]) => ({ file, count })),
            };
          } catch (e) {
            errors.push(`Deps: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // 4. Traces
        if (opts.includeTraces ?? true) {
          try {
            const traceResult = await traceQuery(cfg, {
              bundleId: args.bundleId,
              limit: 500,
            });
            const byType: Record<string, number> = {};
            for (const edge of traceResult.edges) {
              byType[edge.type] = (byType[edge.type] ?? 0) + 1;
            }
            const testedFiles = new Set(traceResult.edges.filter(e => e.type === 'tested_by').map(e => e.source.id));
            const totalSourceFiles = tree?.totalFiles ?? 100;
            traces = {
              totalLinks: traceResult.edges.length,
              byType,
              coverageEstimate: testedFiles.size / Math.max(totalSourceFiles, 1),
            };
          } catch {
            traces = { totalLinks: 0, byType: {}, coverageEstimate: 0 };
          }
        }

        // 5. Overview content
        if (opts.includeOverview ?? true) {
          overviewContent = {};
          const readFile = async (filename: string): Promise<string | undefined> => {
            try {
              const absPath = safeJoin(paths.rootDir, filename);
              return await fs.readFile(absPath, 'utf8');
            } catch {
              return undefined;
            }
          };
          overviewContent.overview = await readFile('OVERVIEW.md');
          overviewContent.startHere = await readFile('START_HERE.md');
          overviewContent.agents = await readFile('AGENTS.md');
        }

        // 6. README content
        if (opts.includeReadme ?? true) {
          if (!overviewContent) overviewContent = {};
          try {
            const manifest = await readManifest(paths.manifestPath);
            for (const repo of manifest.repos ?? []) {
              if (!repo.id) continue;
              const [owner, repoName] = repo.id.split('/');
              if (!owner || !repoName) continue;
              
              const readmeNames = ['README.md', 'readme.md', 'Readme.md'];
              for (const readmeName of readmeNames) {
                const readmePath = `repos/${owner}/${repoName}/norm/${readmeName}`;
                try {
                  const absPath = safeJoin(paths.rootDir, readmePath);
                  overviewContent.readme = await fs.readFile(absPath, 'utf8');
                  break;
                } catch {
                  // Try next
                }
              }
              if (overviewContent.readme) break;
            }
          } catch {
            // Ignore manifest read errors
          }
        }

        // 7. Test detection
        if ((opts.includeTests ?? true) && tree) {
          const filesFound: Array<{ path: string; name: string }> = [];
          
          const scanDir = async (dir: string, relPath: string, maxDepth: number): Promise<void> => {
            if (maxDepth <= 0) return;
            try {
              const entries = await fs.readdir(dir, { withFileTypes: true });
              for (const entry of entries) {
                if (entry.name.startsWith('.') || ['node_modules', '__pycache__', 'venv', '.venv', 'dist', 'build'].includes(entry.name)) continue;
                const fullPath = safeJoin(dir, entry.name);
                const entryRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;
                
                if (entry.isFile()) {
                  filesFound.push({ path: entryRelPath, name: entry.name });
                } else if (entry.isDirectory()) {
                  await scanDir(fullPath, entryRelPath, maxDepth - 1);
                }
              }
            } catch {
              // Ignore directory access errors
            }
          };
          
          try {
            const configPatterns = [
              'jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.json',
              'vitest.config.js', 'vitest.config.ts',
              'pytest.ini', 'pyproject.toml', 'setup.cfg',
              '.mocharc.js', '.mocharc.json', '.mocharc.yml',
            ];
            for (const cfgFile of configPatterns) {
              try {
                const cfgPath = safeJoin(paths.rootDir, cfgFile);
                await fs.access(cfgPath);
                filesFound.push({ path: cfgFile, name: cfgFile });
              } catch {
                // Config file doesn't exist
              }
            }
            
            await scanDir(paths.reposDir, 'repos', 8);
          } catch {
            // Ignore errors during scanning
          }
          
          testInfo = detectTestInfo(
            { byExtension: tree.byExtension, byTopDir: tree.topDirs.reduce((acc, d) => ({ ...acc, [d.path]: d.fileCount }), {} as Record<string, number>) },
            filesFound.length > 0 ? filesFound : undefined
          );
        }

        const result = buildDeepAnalysis(args.bundleId, {
          tree,
          search,
          deps,
          traces,
          overviewContent,
          testInfo,
          focusPath: focus.path,
          focusQuery: focus.query,
          errors,
        }, {
          maxOverviewChars: cfg.deepAnalysisMaxOverviewChars,
        });

        // Aggregate evidence from all claims
        const evidence: Array<{ path: string; range?: { startLine: number; endLine: number }; uri?: string; snippet?: string }> = [];
        const seenPaths = new Set<string>();
        for (const claim of result.claims ?? []) {
          for (const ev of claim.evidence ?? []) {
            const evRef = ev as EvidenceRef;
            if (evRef.file && !seenPaths.has(evRef.file)) {
              seenPaths.add(evRef.file);
              evidence.push({
                path: evRef.file,
                range: evRef.range ? { startLine: evRef.range.startLine, endLine: evRef.range.endLine } : undefined,
                uri: toBundleFileUri({ bundleId: args.bundleId, relativePath: evRef.file }),
                snippet: evRef.snippet,
              });
            }
          }
        }

        return {
          content: [{ type: 'text', text: result.summary }],
          structuredContent: { ...result, evidence },
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );

  // ==========================================================================
  // preflight_validate_report
  // ==========================================================================
  server.registerTool(
    'preflight_validate_report',
    {
      title: 'Validate claims and evidence',
      description:
        'Validate a report containing claims with evidence chains. ' +
        'Checks for: missing evidence, invalid file references, broken snippet hashes, etc.\n\n' +
        '**Use when:** Before finalizing analysis output, after generating claims, for audit compliance.',
      inputSchema: {
        bundleId: z.string().describe('Bundle ID for file verification.'),
        claims: z.array(z.object({
          id: z.string().describe('Unique claim identifier.'),
          text: z.string().describe('The claim text.'),
          confidence: z.number().min(0).max(1).describe('Confidence score (0-1).'),
          kind: z.enum(['feature', 'entrypoint', 'module', 'dependency', 'test_coverage', 'behavior', 'architecture', 'unknown']),
          status: z.enum(['supported', 'inferred', 'unknown']),
          evidence: z.array(z.object({
            file: z.string(),
            range: z.object({
              startLine: z.number().int().min(1),
              startCol: z.number().int().min(1),
              endLine: z.number().int().min(1),
              endCol: z.number().int().min(1),
            }),
            uri: z.string().optional(),
            snippet: z.string().optional(),
            snippetSha256: z.string().optional(),
            note: z.string().optional(),
          })),
          whyInferred: z.string().optional(),
        })).describe('Claims to validate.'),
        options: z.object({
          verifySnippets: z.boolean().optional().default(true).describe('Verify snippet SHA256 hashes.'),
          verifyFileExists: z.boolean().optional().default(true).describe('Verify evidence files exist in bundle.'),
          strictMode: z.boolean().optional().default(false).describe('Treat warnings as errors.'),
        }).optional(),
      },
      outputSchema: {
        bundleId: z.string(),
        totalClaims: z.number(),
        validClaims: z.number(),
        invalidClaims: z.number(),
        issues: z.array(z.object({
          severity: z.enum(['error', 'warning', 'info']),
          code: z.string(),
          message: z.string(),
          claimId: z.string().optional(),
          evidenceIndex: z.number().optional(),
          file: z.string().optional(),
        })),
        summary: z.string(),
        passed: z.boolean(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        await assertBundleComplete(cfg, args.bundleId);

        const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
        if (!storageDir) {
          throw new BundleNotFoundError(args.bundleId);
        }

        const paths = getBundlePathsForId(storageDir, args.bundleId);

        const result = await validateReport(paths.rootDir, {
          bundleId: args.bundleId,
          claims: args.claims as Claim[],
          options: args.options,
        });

        return {
          content: [{ type: 'text', text: result.summary }],
          structuredContent: {
            bundleId: result.bundleId,
            totalClaims: result.totalClaims,
            validClaims: result.validClaims,
            invalidClaims: result.invalidClaims,
            issues: result.issues,
            summary: result.summary,
            passed: result.passed,
          },
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );
}
