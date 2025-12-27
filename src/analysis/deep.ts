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
    /** Include OVERVIEW.md, START_HERE.md, AGENTS.md content (default: true) */
    includeOverview?: boolean;
    /** Include README.md content (default: true) */
    includeReadme?: boolean;
    /** Detect test directories and frameworks (default: true) */
    includeTests?: boolean;
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

/** Test detection result */
export type TestInfo = {
  detected: boolean;
  framework: 'jest' | 'vitest' | 'pytest' | 'go' | 'mocha' | 'unknown' | null;
  testDirs: string[];
  testFileCount: number;
  configFiles: string[];
  hint: string;
};

/** Overview content from bundle files */
export type OverviewContent = {
  overview?: string;      // OVERVIEW.md
  startHere?: string;     // START_HERE.md
  agents?: string;        // AGENTS.md
  readme?: string;        // First repo README.md
};

/** Copyable next command suggestion */
export type NextCommand = {
  tool: string;
  description: string;
  args: Record<string, unknown>;
};

export type DeepAnalysisResult = {
  bundleId: string;
  focus?: { path?: string; query?: string };
  
  tree?: TreeSummary;
  search?: SearchSummary;
  deps?: DepsSummary;
  traces?: TraceSummary;
  
  /** Overview content from bundle files */
  overviewContent?: OverviewContent;
  
  /** Test detection result */
  testInfo?: TestInfo;
  
  /** Auto-generated claims with evidence */
  claims: Claim[];
  
  /** Checklist of completed analysis steps */
  checklistStatus: ChecklistStatus;
  
  /** Questions that couldn't be answered due to missing evidence */
  openQuestions: OpenQuestion[];
  
  coverageReport: CoverageReport;
  
  /** LLM-formatted summary text */
  summary: string;
  
  /** Suggested next actions (human-readable) */
  nextSteps: string[];
  
  /** Copyable next commands for LLM/automation */
  nextCommands: NextCommand[];
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
    overviewContent?: OverviewContent;
    testInfo?: TestInfo;
    focusPath?: string;
    focusQuery?: string;
    errors?: string[];
  }
): DeepAnalysisResult {
  const { tree, search, deps, traces, overviewContent, testInfo, focusPath, focusQuery, errors = [] } = components;
  
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
  
  // Test detection summary
  if (testInfo) {
    summaryParts.push(`## Test Detection`);
    if (testInfo.detected) {
      summaryParts.push(`- Framework: ${testInfo.framework ?? 'unknown'}`);
      summaryParts.push(`- Test files: ${testInfo.testFileCount}`);
      if (testInfo.testDirs.length > 0) {
        summaryParts.push(`- Test directories: ${testInfo.testDirs.slice(0, 3).join(', ')}`);
      }
      if (testInfo.configFiles.length > 0) {
        summaryParts.push(`- Config files: ${testInfo.configFiles.join(', ')}`);
      }
    } else {
      summaryParts.push(`- No tests detected`);
    }
    summaryParts.push(`- 💡 ${testInfo.hint}`);
    summaryParts.push('');
  }
  
  // Build checklist status
  const checklistStatus: ChecklistStatus = {
    read_overview: !!(overviewContent?.overview || overviewContent?.startHere),
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
  
  // Build nextCommands (copyable JSON for LLM)
  const nextCommands: NextCommand[] = [];
  
  // Always suggest search as a useful next step
  nextCommands.push({
    tool: 'preflight_search_bundle',
    description: 'Search for specific code or concepts',
    args: { bundleId, query: '<填入关键词>', scope: 'all', limit: 30 },
  });
  
  // Suggest reading a specific entry point if identified
  if (deps && deps.topImported.length > 0) {
    const coreFile = deps.topImported[0]!.file;
    nextCommands.push({
      tool: 'preflight_read_file',
      description: `Read core module: ${coreFile}`,
      args: { bundleId, file: coreFile, withLineNumbers: true },
    });
  }
  
  // Suggest dependency analysis for a specific file if entry point identified
  if (deps && deps.topImporters.length > 0) {
    const entryFile = deps.topImporters[0]!.file;
    nextCommands.push({
      tool: 'preflight_evidence_dependency_graph',
      description: `Analyze dependencies of entry point: ${entryFile}`,
      args: { bundleId, target: { file: entryFile } },
    });
  }
  
  // Suggest trace discovery if no traces exist
  if (!traces || traces.totalLinks === 0) {
    nextCommands.push({
      tool: 'preflight_suggest_traces',
      description: 'Auto-discover test↔code relationships',
      args: { bundleId, edge_type: 'tested_by', scope: 'repo' },
    });
  }
  
  // Suggest focused tree if large directory detected
  if (tree) {
    const largeDir = tree.topDirs.find(d => d.fileCount > 50);
    if (largeDir) {
      nextCommands.push({
        tool: 'preflight_repo_tree',
        description: `Explore large directory: ${largeDir.path}`,
        args: { bundleId, focusDir: largeDir.path, depth: 6 },
      });
    }
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
    overviewContent,
    testInfo,
    claims,
    checklistStatus,
    openQuestions,
    coverageReport,
    summary: summaryParts.join('\n'),
    nextSteps,
    nextCommands,
  };
}

/**
 * Detect test setup from file tree statistics.
 * Scans for test directories, test files, and framework config files.
 */
export function detectTestInfo(
  stats: { byExtension: Record<string, number>; byTopDir?: Record<string, number> },
  filesFound?: Array<{ path: string; name: string }>
): TestInfo {
  const testDirs: string[] = [];
  let testFileCount = 0;
  const configFiles: string[] = [];
  let framework: TestInfo['framework'] = null;
  
  // Common test directory patterns
  const testDirPatterns = ['tests', 'test', '__tests__', 'spec', 'specs', 'e2e', 'integration'];
  
  // Check byTopDir for test directories
  if (stats.byTopDir) {
    for (const [dir, count] of Object.entries(stats.byTopDir)) {
      const dirLower = dir.toLowerCase();
      if (testDirPatterns.some(p => dirLower === p || dirLower.endsWith('/' + p))) {
        testDirs.push(dir);
        testFileCount += count;
      }
    }
  }
  
  // Framework detection from config files (if filesFound provided)
  const frameworkConfigs: Array<{ pattern: RegExp; framework: TestInfo['framework'] }> = [
    { pattern: /^jest\.config\.(js|ts|mjs|cjs|json)$/i, framework: 'jest' },
    { pattern: /^vitest\.config\.(js|ts|mjs|cjs)$/i, framework: 'vitest' },
    { pattern: /^pytest\.ini$/i, framework: 'pytest' },
    { pattern: /^pyproject\.toml$/i, framework: 'pytest' }, // May contain pytest config
    { pattern: /^setup\.cfg$/i, framework: 'pytest' },
    { pattern: /^\.mocharc\.(js|json|yml|yaml)$/i, framework: 'mocha' },
    { pattern: /^mocha\.opts$/i, framework: 'mocha' },
  ];
  
  if (filesFound) {
    for (const file of filesFound) {
      for (const cfg of frameworkConfigs) {
        if (cfg.pattern.test(file.name)) {
          configFiles.push(file.path);
          if (!framework) {
            framework = cfg.framework;
          }
        }
      }
    }
  }
  
  // Infer framework from file extensions if not detected from config
  if (!framework && stats.byExtension) {
    // Check for test file patterns in extensions
    const hasTs = (stats.byExtension['.ts'] ?? 0) > 0 || (stats.byExtension['.tsx'] ?? 0) > 0;
    const hasPy = (stats.byExtension['.py'] ?? 0) > 0;
    const hasGo = (stats.byExtension['.go'] ?? 0) > 0;
    
    if (testDirs.length > 0 || testFileCount > 0) {
      if (hasGo) framework = 'go';
      else if (hasPy) framework = 'pytest';
      else if (hasTs) framework = 'unknown'; // Could be jest/vitest/mocha
    }
  }
  
  // Count test files by pattern (approximate from extensions)
  // This is a heuristic - actual test files may vary
  if (testFileCount === 0 && stats.byExtension) {
    // If no test directories found, estimate based on common patterns
    // This is imprecise but gives a hint
  }
  
  const detected = testDirs.length > 0 || testFileCount > 0 || configFiles.length > 0;
  
  // Generate hint based on detection results
  let hint: string;
  if (detected) {
    if (testFileCount > 0) {
      hint = `Found ${testFileCount} test files. Run preflight_suggest_traces to map code↔test relationships.`;
    } else if (configFiles.length > 0) {
      hint = `Test config found (${configFiles[0]}). Run preflight_suggest_traces to discover test files.`;
    } else {
      hint = `Test directories found. Run preflight_suggest_traces to map code↔test relationships.`;
    }
  } else {
    hint = 'No tests detected. Consider adding tests or check if test files use non-standard naming.';
  }
  
  return {
    detected,
    framework,
    testDirs,
    testFileCount,
    configFiles,
    hint,
  };
}
