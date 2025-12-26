/**
 * Deep analysis bundle for EDDA.
 * Aggregates tree, search, and dependency data into a single LLM-friendly output.
 */

import { type CoverageReport, createEmptyCoverageReport, isCoverageSufficient } from '../types/evidence.js';

export type DeepAnalysisInput = {
  bundleId: string;
  focus?: {
    path?: string;
    query?: string;
    depth?: number;
  };
  options?: {
    includeTree?: boolean;
    includeSearch?: boolean;
    includeDeps?: boolean;
    includeTraces?: boolean;
    tokenBudget?: number;
    maxFiles?: number;
  };
};

export type TreeSummary = {
  totalFiles: number;
  totalDirs: number;
  byExtension: Record<string, number>;
  topDirs: Array<{ path: string; fileCount: number }>;
  focusedTree?: string; // ASCII tree for focused path
};

export type SearchSummary = {
  query: string;
  totalHits: number;
  topFiles: Array<{ path: string; hitCount: number; snippet?: string }>;
  byDirectory: Record<string, number>;
};

export type DepsSummary = {
  totalNodes: number;
  totalEdges: number;
  topImporters: Array<{ file: string; count: number }>;
  topImported: Array<{ file: string; count: number }>;
  cycles?: string[];
};

export type TraceSummary = {
  totalLinks: number;
  byType: Record<string, number>;
  coverageEstimate: number; // 0-1
};

export type DeepAnalysisResult = {
  bundleId: string;
  focus?: { path?: string; query?: string };
  
  tree?: TreeSummary;
  search?: SearchSummary;
  deps?: DepsSummary;
  traces?: TraceSummary;
  
  coverageReport: CoverageReport;
  
  /** LLM-formatted summary text */
  summary: string;
  
  /** Suggested next actions */
  nextSteps: string[];
};

/**
 * Build a deep analysis result from individual component results.
 * This is called by the server after gathering data from each source.
 */
export function buildDeepAnalysis(
  bundleId: string,
  components: {
    tree?: TreeSummary;
    search?: SearchSummary;
    deps?: DepsSummary;
    traces?: TraceSummary;
    focusPath?: string;
    focusQuery?: string;
    errors?: string[];
  }
): DeepAnalysisResult {
  const { tree, search, deps, traces, focusPath, focusQuery, errors = [] } = components;
  
  // Build coverage report
  const coverageReport = createEmptyCoverageReport();
  
  if (tree) {
    coverageReport.scannedFilesCount = tree.totalFiles;
    coverageReport.parsedFilesCount = tree.totalFiles; // Assume all scanned files are parsed
  }
  if (errors.length > 0) {
    coverageReport.skippedFiles.push(...errors.map(e => ({
      path: 'unknown',
      reason: 'parse_error' as const,
    })));
  }
  
  // Build summary text
  const summaryParts: string[] = [];
  
  if (focusPath || focusQuery) {
    summaryParts.push(`## Analysis Focus`);
    if (focusPath) summaryParts.push(`- Path: \`${focusPath}\``);
    if (focusQuery) summaryParts.push(`- Query: "${focusQuery}"`);
    summaryParts.push('');
  }
  
  if (tree) {
    summaryParts.push(`## Structure`);
    summaryParts.push(`- ${tree.totalFiles} files in ${tree.totalDirs} directories`);
    const topExts = Object.entries(tree.byExtension)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ext, count]) => `${ext}(${count})`)
      .join(', ');
    if (topExts) summaryParts.push(`- Top extensions: ${topExts}`);
    if (tree.focusedTree) {
      summaryParts.push('```');
      summaryParts.push(tree.focusedTree);
      summaryParts.push('```');
    }
    summaryParts.push('');
  }
  
  if (search && search.totalHits > 0) {
    summaryParts.push(`## Search: "${search.query}"`);
    summaryParts.push(`- ${search.totalHits} hits across ${search.topFiles.length} files`);
    for (const f of search.topFiles.slice(0, 3)) {
      summaryParts.push(`- \`${f.path}\`: ${f.hitCount} hits`);
    }
    summaryParts.push('');
  }
  
  if (deps) {
    summaryParts.push(`## Dependencies`);
    summaryParts.push(`- ${deps.totalNodes} modules, ${deps.totalEdges} edges`);
    if (deps.topImporters.length > 0) {
      summaryParts.push(`- Top importers: ${deps.topImporters.slice(0, 3).map(d => d.file).join(', ')}`);
    }
    if (deps.cycles && deps.cycles.length > 0) {
      summaryParts.push(`- ⚠️ ${deps.cycles.length} circular dependencies detected`);
    }
    summaryParts.push('');
  }
  
  if (traces) {
    summaryParts.push(`## Traceability`);
    summaryParts.push(`- ${traces.totalLinks} trace links`);
    if (traces.coverageEstimate > 0) {
      summaryParts.push(`- Estimated test coverage: ${(traces.coverageEstimate * 100).toFixed(0)}%`);
    }
    summaryParts.push('');
  }
  
  // Build next steps
  const nextSteps: string[] = [];
  
  if (!tree || tree.totalFiles === 0) {
    nextSteps.push('Run preflight_repo_tree to explore structure');
  }
  if (!search) {
    nextSteps.push('Use preflight_search_bundle to find specific code');
  }
  if (!deps || deps.totalNodes === 0) {
    nextSteps.push('Run preflight_evidence_dependency_graph for module relationships');
  }
  if (!traces || traces.totalLinks === 0) {
    nextSteps.push('Run preflight_suggest_traces to discover test relationships');
  }
  if (isCoverageSufficient(coverageReport)) {
    nextSteps.push('Coverage is sufficient. Ready for detailed analysis.');
  }
  
  return {
    bundleId,
    focus: (focusPath || focusQuery) ? { path: focusPath, query: focusQuery } : undefined,
    tree,
    search,
    deps,
    traces,
    coverageReport,
    summary: summaryParts.join('\n'),
    nextSteps,
  };
}
