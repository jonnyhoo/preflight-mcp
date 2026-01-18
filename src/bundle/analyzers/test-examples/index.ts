/**
 * Test Example Extraction Module
 *
 * Extracts meaningful usage examples from test files across multiple languages.
 * Provides high-value examples showing API usage, configuration, and workflows.
 *
 * @module bundle/analyzers/test-examples
 */

import * as fs from 'node:fs/promises';

import { BaseAnalyzer, FileAnalysisError, getFileExtension } from '../base-analyzer.js';
import type { AnalyzerInput, AnalyzerOutput, AnalyzerErrorInfo, AnalyzerHighlight } from '../types.js';

import { PythonTestAnalyzer, createPythonTestAnalyzer } from './python-analyzer.js';
import { TypeScriptTestAnalyzer, createTypeScriptTestAnalyzer } from './typescript-analyzer.js';
import { GoTestAnalyzer, createGoTestAnalyzer } from './go-analyzer.js';
import { QualityFilter, createQualityFilter, sortByValue } from './quality-filter.js';

import {
  type TestExample,
  type TestExampleReport,
  type FileExampleReport,
  type CategoryCount,
  type LanguageCount,
  type TestExampleAnalyzerOptions,
  type TestExampleOutput,
  type LanguageTestAnalyzer,
  ExampleCategory,
  TestLanguage,
  DEFAULT_TEST_EXAMPLE_OPTIONS,
  getLanguageFromExtension,
  isTestFile,
} from './types.js';

// ============================================================================
// Re-exports
// ============================================================================

export {
  // Types
  type TestExample,
  type TestExampleReport,
  type FileExampleReport,
  type CategoryCount,
  type LanguageCount,
  type TestExampleAnalyzerOptions,
  type TestExampleOutput,
  type LanguageTestAnalyzer,
  // Enums
  ExampleCategory,
  TestLanguage,
  // Constants
  DEFAULT_TEST_EXAMPLE_OPTIONS,
  // Helper functions
  getLanguageFromExtension,
  isTestFile,
  // Analyzers
  PythonTestAnalyzer,
  TypeScriptTestAnalyzer,
  GoTestAnalyzer,
  createPythonTestAnalyzer,
  createTypeScriptTestAnalyzer,
  createGoTestAnalyzer,
  // Quality filter
  QualityFilter,
  createQualityFilter,
  sortByValue,
};

export {
  type QualityFilterOptions,
  DEFAULT_QUALITY_FILTER_OPTIONS,
  DEFAULT_TRIVIAL_PATTERNS,
  groupByCategory,
  groupByLanguage,
  getTopExamples,
} from './quality-filter.js';

// ============================================================================
// Test Example Analyzer
// ============================================================================

/**
 * Test Example Analyzer.
 *
 * Analyzes test files to extract meaningful usage examples.
 * Supports Python, TypeScript, and JavaScript with language-specific analysis.
 *
 * @example
 * ```ts
 * const analyzer = createTestExampleAnalyzer({
 *   minConfidence: 0.7,
 *   maxPerFile: 5,
 * });
 *
 * const result = await analyzer.analyze({
 *   bundleRoot: '/path/to/bundle',
 *   files: ingestedFiles,
 *   manifest: bundleManifest,
 * });
 *
 * console.log(result.data?.totalExamples);
 * ```
 */
export class TestExampleAnalyzer extends BaseAnalyzer<TestExampleOutput, TestExampleAnalyzerOptions> {
  readonly name = 'test-example-analyzer';
  readonly version = '1.0.0';
  readonly description = 'Extracts usage examples from test files';

  private readonly languageAnalyzers: Map<TestLanguage, LanguageTestAnalyzer>;
  private readonly qualityFilter: QualityFilter;

  constructor(options?: Partial<TestExampleAnalyzerOptions>) {
    super(options);

    // Initialize language analyzers
    this.languageAnalyzers = new Map();

    const pythonAnalyzer = createPythonTestAnalyzer();
    this.languageAnalyzers.set(TestLanguage.Python, pythonAnalyzer);

    const tsAnalyzer = createTypeScriptTestAnalyzer();
    this.languageAnalyzers.set(TestLanguage.TypeScript, tsAnalyzer);
    this.languageAnalyzers.set(TestLanguage.JavaScript, tsAnalyzer);

    const goAnalyzer = createGoTestAnalyzer();
    this.languageAnalyzers.set(TestLanguage.Go, goAnalyzer);

    // Initialize quality filter
    this.qualityFilter = createQualityFilter({
      minConfidence: this.options.minConfidence,
      minCodeLength: this.options.minCodeLength,
    });
  }

  protected getDefaultOptions(): Required<TestExampleAnalyzerOptions> {
    return DEFAULT_TEST_EXAMPLE_OPTIONS;
  }

  /**
   * Analyze files for test examples.
   */
  async analyze(input: AnalyzerInput): Promise<AnalyzerOutput<TestExampleOutput>> {
    const startTime = Date.now();
    const errors: AnalyzerErrorInfo[] = [];
    let filesAnalyzed = 0;

    // Validate input
    const validationErrors = this.validateInput(input);
    if (validationErrors.length > 0) {
      return this.createFailureOutput(validationErrors, this.createMetadata(startTime, 0));
    }

    const logger = this.getLogger();
    logger.info('Starting test example extraction', {
      bundleRoot: input.bundleRoot,
      fileCount: input.files.length,
    });

    try {
      // Filter files to analyze
      const files = this.filterFiles(input.files);
      const fileReports: FileExampleReport[] = [];
      const allExamples: TestExample[] = [];

      // Analyze each file
      for (const file of files) {
        try {
          const report = await this.analyzeFile(file.bundleNormAbsPath, file.repoRelativePath);

          if (report) {
            fileReports.push(report);
            allExamples.push(...report.examples);
            filesAnalyzed++;
          }
        } catch (err) {
          const error = new FileAnalysisError(
            file.repoRelativePath,
            err instanceof Error ? err.message : String(err),
            err instanceof Error ? err : undefined
          );

          errors.push(this.errorToInfo(error, file.repoRelativePath));
          logger.warn('File analysis failed, skipping', {
            file: file.repoRelativePath,
            error: error.message,
          });
        }
      }

      // Apply quality filter
      const filteredExamples = this.qualityFilter.filter(allExamples);

      // Apply per-file limits
      const limitedExamples = this.applyPerFileLimits(filteredExamples, fileReports);

      // Build report
      const report = this.buildReport(limitedExamples, fileReports, filesAnalyzed);

      logger.info('Test example extraction complete', {
        filesAnalyzed,
        totalExamples: report.totalExamples,
        highValueCount: report.highValueCount,
        durationMs: Date.now() - startTime,
      });

      // Generate summary and highlights
      const summary = this.generateSummary(report);
      const highlights = this.generateHighlights(limitedExamples);

      return this.createSuccessOutput(
        report,
        this.createMetadata(startTime, filesAnalyzed),
        summary,
        highlights,
        errors
      );
    } catch (err) {
      logger.error('Test example extraction failed', err instanceof Error ? err : new Error(String(err)));

      return this.createFailureOutput(
        [this.errorToInfo(err)],
        this.createMetadata(startTime, filesAnalyzed)
      );
    }
  }

  /**
   * Analyze a single file for test examples.
   */
  private async analyzeFile(
    absolutePath: string,
    relativePath: string
  ): Promise<FileExampleReport | null> {
    // Get language from extension
    const ext = getFileExtension(relativePath);
    const language = getLanguageFromExtension(ext);

    // Skip unsupported languages
    if (language === TestLanguage.Unknown) {
      return null;
    }

    // Filter by configured languages
    if (this.options.languages.length > 0 && !this.options.languages.includes(language)) {
      return null;
    }

    // Check if it's a test file
    if (!isTestFile(relativePath, language)) {
      return null;
    }

    // Get analyzer for language
    const analyzer = this.languageAnalyzers.get(language);
    if (!analyzer) {
      return null;
    }

    // Read file content
    const content = await fs.readFile(absolutePath, 'utf-8');

    // Extract examples
    const examples = analyzer.extract(relativePath, content);

    // Filter by configured categories
    let filteredExamples = examples;
    if (this.options.categories.length > 0) {
      filteredExamples = examples.filter((ex) => this.options.categories.includes(ex.category));
    }

    // Count test functions (approximate)
    const totalTests = this.countTestFunctions(content, language);

    return {
      filePath: relativePath,
      language,
      examples: filteredExamples,
      totalTests,
      totalExamples: filteredExamples.length,
    };
  }

  /**
   * Count test functions in file content.
   */
  private countTestFunctions(content: string, language: TestLanguage): number {
    let pattern: RegExp;

    switch (language) {
      case TestLanguage.Python:
        pattern = /def\s+test_\w+\s*\(/g;
        break;
      case TestLanguage.TypeScript:
      case TestLanguage.JavaScript:
        pattern = /(?:it|test)\s*\(\s*['"`]/g;
        break;
      default:
        return 0;
    }

    const matches = content.match(pattern);
    return matches?.length ?? 0;
  }

  /**
   * Apply per-file limits to examples.
   */
  private applyPerFileLimits(
    examples: TestExample[],
    fileReports: FileExampleReport[]
  ): TestExample[] {
    if (this.options.maxPerFile <= 0) {
      return examples;
    }

    const limited: TestExample[] = [];
    const byFile = new Map<string, TestExample[]>();

    // Group by file
    for (const example of examples) {
      if (!byFile.has(example.filePath)) {
        byFile.set(example.filePath, []);
      }
      byFile.get(example.filePath)!.push(example);
    }

    // Sort each file's examples and take top N
    for (const [_, fileExamples] of byFile) {
      const sorted = sortByValue(fileExamples);
      limited.push(...sorted.slice(0, this.options.maxPerFile));
    }

    // Update file reports
    for (const report of fileReports) {
      const fileExamples = limited.filter((ex) => ex.filePath === report.filePath);
      report.examples = fileExamples;
      report.totalExamples = fileExamples.length;
    }

    return limited;
  }

  /**
   * Build the final report.
   */
  private buildReport(
    examples: TestExample[],
    fileReports: FileExampleReport[],
    filesAnalyzed: number
  ): TestExampleReport {
    // Count by category
    const examplesByCategory: CategoryCount = {};
    for (const example of examples) {
      examplesByCategory[example.category] = (examplesByCategory[example.category] ?? 0) + 1;
    }

    // Count by language
    const examplesByLanguage: LanguageCount = {};
    for (const example of examples) {
      examplesByLanguage[example.language] = (examplesByLanguage[example.language] ?? 0) + 1;
    }

    // Calculate averages
    const avgComplexity =
      examples.length > 0
        ? Math.round((examples.reduce((sum, ex) => sum + ex.complexityScore, 0) / examples.length) * 100) / 100
        : 0;

    const highValueCount = examples.filter((ex) => ex.confidence > 0.7).length;

    return {
      files: fileReports,
      allExamples: examples,
      examplesByCategory,
      examplesByLanguage,
      totalFiles: filesAnalyzed,
      totalExamples: examples.length,
      avgComplexity,
      highValueCount,
    };
  }

  /**
   * Generate a brief summary of the analysis results.
   */
  private generateSummary(report: TestExampleReport): string {
    if (report.totalExamples === 0) {
      return `No test examples extracted from ${report.totalFiles} test files.`;
    }

    const languageList = Object.entries(report.examplesByLanguage)
      .map(([lang, count]) => `${count} ${lang}`)
      .join(', ');

    return `Extracted ${report.totalExamples} test examples (${languageList}) with average complexity ${report.avgComplexity.toFixed(2)}. ${report.highValueCount} high-value examples identified.`;
  }

  /**
   * Generate highlights from high-complexity examples.
   * Only includes examples with complexityScore >= 0.8.
   */
  private generateHighlights(examples: TestExample[]): AnalyzerHighlight[] {
    // Filter to high-complexity examples only
    const highComplexity = examples.filter((ex) => ex.complexityScore >= 0.8);

    // Sort by complexity descending
    const sorted = highComplexity.sort((a, b) => b.complexityScore - a.complexityScore);

    // Convert to highlights (top 5)
    return sorted.slice(0, 5).map((ex) => ({
      type: ex.category,
      description: `${ex.testName}: ${ex.description}`,
      confidence: ex.confidence,
      file: ex.filePath,
      line: ex.lineStart,
      context: {
        language: ex.language,
        complexityScore: ex.complexityScore,
        className: ex.className,
        methodName: ex.methodName,
      },
    }));
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new TestExampleAnalyzer instance.
 */
export function createTestExampleAnalyzer(
  options?: Partial<TestExampleAnalyzerOptions>
): TestExampleAnalyzer {
  return new TestExampleAnalyzer(options);
}

/**
 * Convenience function to extract test examples.
 * Creates an analyzer and runs analysis in one call.
 */
export async function extractTestExamples(
  input: AnalyzerInput,
  options?: Partial<TestExampleAnalyzerOptions>
): Promise<AnalyzerOutput<TestExampleOutput>> {
  const analyzer = createTestExampleAnalyzer(options);
  return analyzer.analyze(input);
}
