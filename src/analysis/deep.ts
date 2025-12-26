/**
 * Deep analysis bundle for EDDA.
 * Aggregates tree, search, and dependency data into a single LLM-friendly output.
 */

import {
  type CoverageReport,
  type Claim,
  type EvidenceRef,
  type ChecklistStatus,
  type OpenQuestion,
  createEmptyCoverageReport,
  isCoverageSufficient,
} from '../types/evidence.js';

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
  
  /** Auto-generated claims with evidence */
  claims: Claim[];
  
  /** Checklist of completed analysis steps */
  checklistStatus: ChecklistStatus;
  
  /** Questions that couldn't be answered due to missing evidence */
  openQuestions: OpenQuestion[];
  
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
  
  // Build checklist status
  const checklistStatus: ChecklistStatus = {
    read_overview: false, // Would need OVERVIEW.md read - caller should set
    repo_tree: !!tree && tree.totalFiles > 0,
    search_focus: !!search && search.totalHits > 0,
    dependency_graph_global: !!deps && deps.totalNodes > 0,
    entrypoints_identified: false,
    core_modules_identified: false,
    one_deep_dive_done: false,
    tests_or_trace_checked: !!traces && traces.totalLinks > 0,
  };
  
  // Identify entrypoints from deps
  if (deps && deps.topImported.length > 0) {
    checklistStatus.entrypoints_identified = true;
  }
  
  // Identify core modules from deps
  if (deps && deps.topImporters.length > 0) {
    checklistStatus.core_modules_identified = true;
  }
  
  // Generate claims from analysis data
  const claims: Claim[] = [];
  let claimId = 0;
  const nextClaimId = () => `claim_${++claimId}`;
  
  // Claim: Project structure
  if (tree && tree.totalFiles > 0) {
    const topExt = Object.entries(tree.byExtension)
      .sort((a, b) => b[1] - a[1])[0];
    if (topExt) {
      claims.push({
        id: nextClaimId(),
        text: `Project contains ${tree.totalFiles} files, primarily ${topExt[0]} (${topExt[1]} files)`,
        confidence: 0.95,
        kind: 'architecture',
        status: 'supported',
        evidence: tree.topDirs.slice(0, 3).map(d => ({
          file: d.path,
          range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
          note: `Directory contains ${d.fileCount} files`,
        })),
      });
    }
  }
  
  // Claim: Core module (most imported)
  if (deps && deps.topImported.length > 0) {
    const core = deps.topImported[0]!;
    claims.push({
      id: nextClaimId(),
      text: `${core.file} is a core module (imported by ${core.count} other files)`,
      confidence: 0.9,
      kind: 'module',
      status: 'supported',
      evidence: [{
        file: core.file,
        range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
        note: `Referenced by ${core.count} imports`,
      }],
    });
  }
  
  // Claim: Entry point (most importing)
  if (deps && deps.topImporters.length > 0) {
    const entry = deps.topImporters[0]!;
    claims.push({
      id: nextClaimId(),
      text: `${entry.file} is likely an entry point (imports ${entry.count} modules)`,
      confidence: 0.85,
      kind: 'entrypoint',
      status: 'inferred',
      evidence: [{
        file: entry.file,
        range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
        note: `Has ${entry.count} import statements`,
      }],
      whyInferred: 'Based on import count heuristic - files with many imports often orchestrate functionality',
    });
  }
  
  // Claim: Test coverage
  if (traces && traces.coverageEstimate > 0) {
    const pct = (traces.coverageEstimate * 100).toFixed(0);
    claims.push({
      id: nextClaimId(),
      text: `Approximately ${pct}% of source files have associated tests`,
      confidence: traces.coverageEstimate > 0.5 ? 0.85 : 0.7,
      kind: 'test_coverage',
      status: 'inferred',
      evidence: [],
      whyInferred: `Based on ${traces.totalLinks} trace links between source and test files`,
    });
  }
  
  // Claim: Search results
  if (search && search.totalHits > 0 && search.topFiles.length > 0) {
    const topFile = search.topFiles[0]!;
    claims.push({
      id: nextClaimId(),
      text: `"${search.query}" is most relevant to ${topFile.path} (${topFile.hitCount} matches)`,
      confidence: 0.9,
      kind: 'feature',
      status: 'supported',
      evidence: [{
        file: topFile.path,
        range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
        snippet: topFile.snippet,
        note: `${topFile.hitCount} search hits`,
      }],
    });
  }
  
  // Generate open questions
  const openQuestions: OpenQuestion[] = [];
  
  if (!tree || tree.totalFiles === 0) {
    openQuestions.push({
      question: 'What is the project structure?',
      whyUnknown: 'File tree data not available',
      nextEvidenceToFetch: ['preflight_repo_tree'],
    });
  }
  
  if (!deps || deps.totalNodes === 0) {
    openQuestions.push({
      question: 'What are the module dependencies?',
      whyUnknown: 'Dependency graph not generated',
      nextEvidenceToFetch: ['preflight_evidence_dependency_graph'],
    });
  }
  
  if (!traces || traces.totalLinks === 0) {
    openQuestions.push({
      question: 'What is the test coverage?',
      whyUnknown: 'No trace links between source and test files',
      nextEvidenceToFetch: ['preflight_suggest_traces', 'preflight_trace_query'],
    });
  }
  
  if (focusQuery && (!search || search.totalHits === 0)) {
    openQuestions.push({
      question: `Where is "${focusQuery}" implemented?`,
      whyUnknown: 'Search returned no results',
      nextEvidenceToFetch: ['preflight_search_bundle with different query'],
    });
  }
  
  // Build context-aware next steps
  const nextSteps: string[] = [];
  
  // Basic checklist-based suggestions
  if (!checklistStatus.repo_tree) {
    nextSteps.push('Run preflight_repo_tree to explore structure');
  }
  if (!checklistStatus.search_focus && focusQuery) {
    nextSteps.push('Use preflight_search_bundle to find specific code');
  }
  if (!checklistStatus.dependency_graph_global) {
    nextSteps.push('Run preflight_evidence_dependency_graph for module relationships');
  }
  if (!checklistStatus.tests_or_trace_checked) {
    nextSteps.push('Run preflight_suggest_traces to discover test relationships');
  }
  
  // Context-aware suggestions based on analysis results
  
  // Trace links suggestion
  if (traces && traces.totalLinks === 0) {
    nextSteps.push('⚠️ 0 trace links detected → Run preflight_suggest_traces to auto-generate test-code mappings');
  }
  
  // Large file detection
  if (tree) {
    const largeFilesHint = tree.topDirs.find(d => d.fileCount > 100);
    if (largeFilesHint) {
      nextSteps.push(`📁 Large directory detected (${largeFilesHint.path}: ${largeFilesHint.fileCount} files) → Consider using focusDir parameter to narrow scope`);
    }
  }
  
  // High coupling detection
  if (deps && deps.topImported.length > 0) {
    const highCoupling = deps.topImported.filter(m => m.count > 15);
    if (highCoupling.length > 0) {
      const files = highCoupling.slice(0, 2).map(m => m.file).join(', ');
      nextSteps.push(`🔗 High coupling detected (${files} imported >15 times) → Review for potential refactoring`);
    }
  }
  
  // Circular dependencies
  if (deps && deps.cycles && deps.cycles.length > 0) {
    nextSteps.push(`⚠️ ${deps.cycles.length} circular dependencies detected → Review deps.cycles for details`);
  }
  
  // Many exports suggestion
  if (deps && deps.topImporters.length > 0) {
    const manyImports = deps.topImporters.filter(m => m.count > 30);
    if (manyImports.length > 0) {
      nextSteps.push(`📦 ${manyImports[0]!.file} imports ${manyImports[0]!.count} modules → Consider splitting this file`);
    }
  }
  
  // Skipped files in coverage report
  if (coverageReport.skippedFiles.length > 0) {
    const largeSkipped = coverageReport.skippedFiles.filter(s => s.reason === 'too_large');
    if (largeSkipped.length > 0) {
      nextSteps.push(`⚠️ ${largeSkipped.length} large file(s) skipped → Use showSkippedFiles in preflight_repo_tree to see details`);
    }
  }
  
  // Validation suggestion
  if (claims.length > 0 && openQuestions.length === 0) {
    nextSteps.push('✅ Use preflight_validate_report to verify claims before finalizing');
  }
  
  // Completion status
  if (isCoverageSufficient(coverageReport) && openQuestions.length === 0 && claims.length > 0) {
    nextSteps.push('🎉 Analysis complete - all key areas covered. Ready for detailed review.');
  }
  
  // Add checklist and claims to summary
  summaryParts.push(`## Analysis Checklist`);
  const checklistItems = [
    ['repo_tree', 'Project structure explored'],
    ['dependency_graph_global', 'Dependencies analyzed'],
    ['entrypoints_identified', 'Entry points identified'],
    ['core_modules_identified', 'Core modules identified'],
    ['tests_or_trace_checked', 'Test coverage checked'],
  ] as const;
  for (const [key, label] of checklistItems) {
    const done = checklistStatus[key];
    summaryParts.push(`- [${done ? 'x' : ' '}] ${label}`);
  }
  summaryParts.push('');
  
  if (claims.length > 0) {
    summaryParts.push(`## Key Findings (${claims.length} claims)`);
    for (const claim of claims.slice(0, 5)) {
      const status = claim.status === 'supported' ? '✓' : '~';
      summaryParts.push(`- ${status} ${claim.text}`);
    }
    summaryParts.push('');
  }
  
  if (openQuestions.length > 0) {
    summaryParts.push(`## Open Questions (${openQuestions.length})`);
    for (const q of openQuestions) {
      summaryParts.push(`- ❓ ${q.question}`);
    }
    summaryParts.push('');
  }
  
  return {
    bundleId,
    focus: (focusPath || focusQuery) ? { path: focusPath, query: focusQuery } : undefined,
    tree,
    search,
    deps,
    traces,
    claims,
    checklistStatus,
    openQuestions,
    coverageReport,
    summary: summaryParts.join('\n'),
    nextSteps,
  };
}
