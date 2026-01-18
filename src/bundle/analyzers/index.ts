/**
 * Analyzers Module
 *
 * Provides code analysis tools for bundle processing.
 * All analyzers implement the unified Analyzer interface.
 *
 * @module bundle/analyzers
 */

// ============================================================================
// Infrastructure Exports
// ============================================================================

export {
  BaseAnalyzer,
  AnalyzerError,
  AnalyzerTimeoutError,
  FileAnalysisError,
  InputValidationError,
  getFileExtension,
  isSourceCodeFile,
} from './base-analyzer.js';

export type * from './types.js';
export { DEFAULT_ANALYZER_OPTIONS } from './types.js';

// ============================================================================
// GoF Pattern Analyzers
// ============================================================================

export {
  // Factory functions
  createSingletonDetector,
  createFactoryDetector,
  createBuilderDetector,
  createDecoratorDetector,
  createGofPatternAnalyzer,
  // Types
  type PatternInstance,
  type PatternReport,
  type GofPatternAnalyzerOptions,
  type GofPatternOutput,
  PatternCategory,
  DetectionDepth,
} from './gof-patterns/index.js';

// ============================================================================
// Architectural Pattern Analyzers
// ============================================================================

export {
  // Factory functions
  createArchitecturalAnalyzer,
  analyzeArchitecture,
  createMVCDetector,
  createMVVMDetector,
  createRepositoryDetector,
  createServiceLayerDetector,
  createLayeredArchitectureDetector,
  createCleanArchitectureDetector,
  // Types
  type ArchitecturalPattern,
  type ArchitecturalReport,
  type ArchitecturalOutput,
  type ArchitecturalAnalyzerOptions,
  type ArchitecturalPatternType,
  type FrameworkType,
  type DirectoryStructure,
  // Constants
  DEFAULT_ARCHITECTURAL_OPTIONS,
  FRAMEWORK_MARKERS,
  MVC_DIRECTORIES,
  MVVM_DIRECTORIES,
  LAYERED_DIRECTORIES,
  CLEAN_ARCH_DIRECTORIES,
  REPOSITORY_DIRECTORIES,
  SERVICE_DIRECTORIES,
} from './architectural/index.js';

// ============================================================================
// Test Example Analyzers
// ============================================================================

export {
  // Factory functions
  createTestExampleAnalyzer,
  extractTestExamples,
  createPythonTestAnalyzer,
  createTypeScriptTestAnalyzer,
  createGoTestAnalyzer,
  createQualityFilter,
  // Classes
  TestExampleAnalyzer,
  PythonTestAnalyzer,
  TypeScriptTestAnalyzer,
  GoTestAnalyzer,
  QualityFilter,
  // Types
  type TestExample,
  type TestExampleReport,
  type FileExampleReport,
  type TestExampleOutput,
  type TestExampleAnalyzerOptions,
  type LanguageTestAnalyzer,
  type QualityFilterOptions,
  // Enums
  ExampleCategory,
  TestLanguage,
  // Constants
  DEFAULT_TEST_EXAMPLE_OPTIONS,
  DEFAULT_QUALITY_FILTER_OPTIONS,
  // Utilities
  getLanguageFromExtension,
  isTestFile,
  sortByValue,
  groupByCategory,
  groupByLanguage,
  getTopExamples,
} from './test-examples/index.js';

// ============================================================================
// Conflict Detection Analyzers
// ============================================================================

export {
  // Factory functions
  createConflictDetector,
  detectConflicts,
  // Classes
  ConflictDetector,
  // Types
  type ConflictType,
  type ConflictSeverity,
  type APIParameter,
  type APIInfo,
  type Conflict,
  type DocsData,
  type DocsPage,
  type DocsPageContent,
  type CodeData,
  type CodeFile,
  type CodeClass,
  type CodeFunction,
  type ConflictSummary,
  type ConflictReport,
  type ConflictOutput,
  type ConflictAnalyzerOptions,
  // Constants
  DEFAULT_CONFLICT_OPTIONS,
} from './conflicts/index.js';

// ============================================================================
// Config Extraction Analyzers
// ============================================================================

export {
  // Factory functions
  createConfigAnalyzer,
  extractConfig,
  ConfigAnalyzer,
  // Types
  type ConfigType,
  type ConfigPurpose,
  type ConfigValueType,
  type ConfigSetting,
  type ConfigFile,
  type ConfigExtractionReport,
  type ConfigOutput,
  type ConfigAnalyzerOptions,
  // Constants
  DEFAULT_CONFIG_OPTIONS,
} from './config/index.js';

// ============================================================================
// Unified Analyzer Runner
// ============================================================================

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AnalyzerInput, AnalyzerOutput, IngestedFile, BundleManifest, AnalyzerHighlight } from './types.js';
import { createGofPatternAnalyzer, type GofPatternOutput } from './gof-patterns/index.js';
import { createArchitecturalAnalyzer, type ArchitecturalOutput } from './architectural/index.js';
import { createTestExampleAnalyzer, type TestExampleOutput } from './test-examples/index.js';
import { createConfigAnalyzer, type ConfigOutput } from './config/index.js';
import { createConflictDetector, type ConflictOutput } from './conflicts/index.js';
import { createModuleLogger } from '../../logging/logger.js';

const logger = createModuleLogger('analyzers:runner');

/**
 * Summary entry for a single analyzer.
 */
export type AnalyzerSummaryEntry = {
  analyzerName: string;
  summary: string;
  highlights: AnalyzerHighlight[];
};

/**
 * Combined summaries from all analyzers.
 */
export type AnalysisSummary = {
  /** Overall summary text */
  overall: string;
  /** Individual analyzer summaries */
  analyzers: AnalyzerSummaryEntry[];
  /** Total analysis time in ms */
  totalMs: number;
};

/**
 * Result of running all analyzers.
 */
export type AllAnalyzersResult = {
  gofPatterns?: AnalyzerOutput<GofPatternOutput>;
  architectural?: AnalyzerOutput<ArchitecturalOutput>;
  testExamples?: AnalyzerOutput<TestExampleOutput>;
  config?: AnalyzerOutput<ConfigOutput>;
  conflicts?: AnalyzerOutput<ConflictOutput>;
  /** Combined summaries for easy access */
  summaries: AnalysisSummary;
  /** Execution timing */
  timing: {
    totalMs: number;
    gofPatternsMs?: number;
    architecturalMs?: number;
    testExamplesMs?: number;
    configMs?: number;
    conflictsMs?: number;
  };
  /** Errors that occurred but didn't prevent completion */
  errors: string[];
};

/**
 * Options for running all analyzers.
 */
export type RunAllAnalyzersOptions = {
  /** Enable GoF pattern detection (default: true) */
  enableGofPatterns?: boolean;
  /** Enable architectural pattern detection (default: true) */
  enableArchitectural?: boolean;
  /** Enable test example extraction (default: true) */
  enableTestExamples?: boolean;
  /** Enable config extraction (default: true) */
  enableConfig?: boolean;
  /** Enable conflict detection (default: true) */
  enableConflicts?: boolean;
  /** Write results to analysis/ directory (default: true) */
  writeResults?: boolean;
};

const DEFAULT_RUN_OPTIONS: Required<RunAllAnalyzersOptions> = {
  enableGofPatterns: true,
  enableArchitectural: true,
  enableTestExamples: true,
  enableConfig: true,
  enableConflicts: true,
  writeResults: true,
};

/**
 * Runs all configured analyzers on the bundle.
 * 
 * This is the unified entry point for bundle analysis during bundle creation.
 * Results are written to the `analysis/` directory within the bundle.
 * 
 * @param bundleRoot - Absolute path to bundle root directory
 * @param files - List of ingested files to analyze
 * @param manifest - Bundle manifest
 * @param options - Options to control which analyzers run
 * @returns Combined results from all analyzers
 * 
 * @example
 * ```ts
 * const result = await runAllAnalyzers(
 *   '/path/to/bundle',
 *   ingestedFiles,
 *   manifest,
 *   { enableConflicts: false }
 * );
 * console.log(`Found ${result.gofPatterns?.data?.totalPatterns} patterns`);
 * ```
 */
export async function runAllAnalyzers(
  bundleRoot: string,
  files: IngestedFile[],
  manifest: BundleManifest,
  options?: RunAllAnalyzersOptions
): Promise<AllAnalyzersResult> {
  const opts = { ...DEFAULT_RUN_OPTIONS, ...options };
  const startTime = Date.now();
  const errors: string[] = [];
  const timing: AllAnalyzersResult['timing'] = { totalMs: 0 };

  const input: AnalyzerInput = {
    bundleRoot,
    files,
    manifest,
  };

  logger.info('Starting all analyzers', {
    bundleRoot,
    fileCount: files.length,
    options: opts,
  });

  // Ensure analysis directory exists
  const analysisDir = path.join(bundleRoot, 'analysis');
  await fs.mkdir(analysisDir, { recursive: true });

  const result: AllAnalyzersResult = {
    timing,
    errors,
    summaries: {
      overall: '',
      analyzers: [],
      totalMs: 0,
    },
  };

  // Helper to write JSON result
  const writeJson = async (filename: string, data: unknown): Promise<void> => {
    if (!opts.writeResults) return;
    const filePath = path.join(analysisDir, filename);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    logger.debug('Wrote analysis result', { filename });
  };

  // Run analyzers in parallel where possible
  const tasks: Array<Promise<void>> = [];

  // 1. GoF Patterns
  if (opts.enableGofPatterns) {
    tasks.push(
      (async () => {
        const t0 = Date.now();
        try {
          const analyzer = createGofPatternAnalyzer({
            minConfidence: 0.5,
            includeEvidence: true,
          });
          result.gofPatterns = await analyzer.analyze(input);
          timing.gofPatternsMs = Date.now() - t0;
          await writeJson('gof-patterns.json', result.gofPatterns);
        } catch (err) {
          timing.gofPatternsMs = Date.now() - t0;
          const msg = `GoF patterns analyzer failed: ${err instanceof Error ? err.message : String(err)}`;
          logger.warn(msg);
          errors.push(msg);
        }
      })()
    );
  }

  // 2. Architectural Patterns
  if (opts.enableArchitectural) {
    tasks.push(
      (async () => {
        const t0 = Date.now();
        try {
          const analyzer = createArchitecturalAnalyzer({
            minConfidence: 0.5,
            detectFrameworks: true,
            includeEvidence: true,
          });
          result.architectural = await analyzer.analyze(input);
          timing.architecturalMs = Date.now() - t0;
          await writeJson('architectural.json', result.architectural);
        } catch (err) {
          timing.architecturalMs = Date.now() - t0;
          const msg = `Architectural analyzer failed: ${err instanceof Error ? err.message : String(err)}`;
          logger.warn(msg);
          errors.push(msg);
        }
      })()
    );
  }

  // 3. Test Examples
  if (opts.enableTestExamples) {
    tasks.push(
      (async () => {
        const t0 = Date.now();
        try {
          const analyzer = createTestExampleAnalyzer({
            maxPerFile: 10,
            minConfidence: 0.5,
          });
          result.testExamples = await analyzer.analyze(input);
          timing.testExamplesMs = Date.now() - t0;
          await writeJson('test-examples.json', result.testExamples);
        } catch (err) {
          timing.testExamplesMs = Date.now() - t0;
          const msg = `Test examples analyzer failed: ${err instanceof Error ? err.message : String(err)}`;
          logger.warn(msg);
          errors.push(msg);
        }
      })()
    );
  }

  // 4. Config Extraction
  if (opts.enableConfig) {
    tasks.push(
      (async () => {
        const t0 = Date.now();
        try {
          const analyzer = createConfigAnalyzer({
            maxConfigFiles: 50,
            detectPatterns: true,
          });
          result.config = await analyzer.analyze(input);
          timing.configMs = Date.now() - t0;
          await writeJson('config.json', result.config);
        } catch (err) {
          timing.configMs = Date.now() - t0;
          const msg = `Config analyzer failed: ${err instanceof Error ? err.message : String(err)}`;
          logger.warn(msg);
          errors.push(msg);
        }
      })()
    );
  }

  // 5. Conflict Detection
  if (opts.enableConflicts) {
    tasks.push(
      (async () => {
        const t0 = Date.now();
        try {
          const detector = createConflictDetector({
            maxFiles: 100,
          });
          result.conflicts = await detector.analyze(input);
          timing.conflictsMs = Date.now() - t0;
          await writeJson('doc-conflicts.json', result.conflicts);
        } catch (err) {
          timing.conflictsMs = Date.now() - t0;
          const msg = `Conflict detector failed: ${err instanceof Error ? err.message : String(err)}`;
          logger.warn(msg);
          errors.push(msg);
        }
      })()
    );
  }

  // Wait for all analyzers to complete
  await Promise.all(tasks);

  timing.totalMs = Date.now() - startTime;

  // Collect summaries from all analyzers
  const analyzerEntries: AnalyzerSummaryEntry[] = [];

  if (result.gofPatterns) {
    analyzerEntries.push({
      analyzerName: 'GoF Design Patterns',
      summary: result.gofPatterns.summary,
      highlights: result.gofPatterns.highlights,
    });
  }

  if (result.architectural) {
    analyzerEntries.push({
      analyzerName: 'Architectural Patterns',
      summary: result.architectural.summary,
      highlights: result.architectural.highlights,
    });
  }

  if (result.testExamples) {
    analyzerEntries.push({
      analyzerName: 'Test Examples',
      summary: result.testExamples.summary,
      highlights: result.testExamples.highlights,
    });
  }

  if (result.config) {
    analyzerEntries.push({
      analyzerName: 'Configuration',
      summary: result.config.summary,
      highlights: result.config.highlights,
    });
  }

  if (result.conflicts) {
    analyzerEntries.push({
      analyzerName: 'Doc/Code Conflicts',
      summary: result.conflicts.summary,
      highlights: result.conflicts.highlights,
    });
  }

  // Generate overall summary
  const overallSummary = generateOverallSummary(analyzerEntries);

  result.summaries = {
    overall: overallSummary,
    analyzers: analyzerEntries,
    totalMs: timing.totalMs,
  };

  // Write SUMMARY.json
  if (opts.writeResults) {
    await writeJson('SUMMARY.json', result.summaries);
  }

  logger.info('All analyzers complete', {
    totalMs: timing.totalMs,
    gofPatterns: result.gofPatterns?.data?.totalPatterns ?? 0,
    architectural: result.architectural?.data?.patterns.length ?? 0,
    testExamples: result.testExamples?.data?.totalExamples ?? 0,
    configFiles: result.config?.data?.totalFiles ?? 0,
    conflicts: result.conflicts?.data?.summary?.total ?? 0,
    errors: errors.length,
  });

  return result;
}

/**
 * Generate an overall summary from all analyzer entries.
 */
function generateOverallSummary(entries: AnalyzerSummaryEntry[]): string {
  if (entries.length === 0) {
    return 'No analysis results available.';
  }

  const summaryParts = entries.map((e) => e.summary).filter(Boolean);
  return summaryParts.join(' ');
}
