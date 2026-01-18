/**
 * GoF Design Patterns Module
 *
 * Detects Gang of Four design patterns in source code.
 * Provides pattern analyzers and individual detectors.
 *
 * @module bundle/analyzers/gof-patterns
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { BaseAnalyzer, FileAnalysisError, getFileExtension } from '../base-analyzer.js';
import type { AnalyzerInput, AnalyzerOutput, AnalyzerErrorInfo, AnalyzerHighlight } from '../types.js';

import { BasePatternDetector, adaptForLanguage } from './base-detector.js';
import { SingletonDetector, createSingletonDetector } from './detectors/singleton.js';
import { FactoryDetector, createFactoryDetector } from './detectors/factory.js';
import { BuilderDetector, createBuilderDetector } from './detectors/builder.js';
import { DecoratorDetector, createDecoratorDetector } from './detectors/decorator.js';
import { AdapterDetector, createAdapterDetector } from './detectors/adapter.js';
import { ObserverDetector, createObserverDetector } from './detectors/observer.js';
import { StrategyDetector, createStrategyDetector } from './detectors/strategy.js';
import { CommandDetector, createCommandDetector } from './detectors/command.js';
import { TemplateMethodDetector, createTemplateMethodDetector } from './detectors/template-method.js';
import {
  ChainOfResponsibilityDetector,
  createChainOfResponsibilityDetector,
} from './detectors/chain-of-responsibility.js';

import {
  type PatternInstance,
  type PatternReport,
  type FilePatternReport,
  type PatternSummary,
  type CategorySummary,
  type ClassSignature,
  type MethodSignature,
  type GofPatternAnalyzerOptions,
  type GofPatternOutput,
  PatternCategory,
  DetectionDepth,
  DEFAULT_GOF_PATTERN_OPTIONS,
} from './types.js';

// ============================================================================
// Re-exports
// ============================================================================

export {
  // Types
  type PatternInstance,
  type PatternReport,
  type FilePatternReport,
  type PatternSummary,
  type CategorySummary,
  type ClassSignature,
  type MethodSignature,
  type GofPatternAnalyzerOptions,
  type GofPatternOutput,
  // Enums
  PatternCategory,
  DetectionDepth,
  // Constants
  DEFAULT_GOF_PATTERN_OPTIONS,
  // Base classes
  BasePatternDetector,
  adaptForLanguage,
  // Detector classes
  SingletonDetector,
  FactoryDetector,
  BuilderDetector,
  DecoratorDetector,
  AdapterDetector,
  ObserverDetector,
  StrategyDetector,
  CommandDetector,
  TemplateMethodDetector,
  ChainOfResponsibilityDetector,
  // Factory functions
  createSingletonDetector,
  createFactoryDetector,
  createBuilderDetector,
  createDecoratorDetector,
  createAdapterDetector,
  createObserverDetector,
  createStrategyDetector,
  createCommandDetector,
  createTemplateMethodDetector,
  createChainOfResponsibilityDetector,
};

// ============================================================================
// Language Detection
// ============================================================================

/** Map file extensions to language names */
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  // JavaScript/TypeScript
  js: 'JavaScript',
  jsx: 'JavaScript',
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  // Python
  py: 'Python',
  pyw: 'Python',
  // Java/Kotlin
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  // C/C++
  c: 'C',
  cpp: 'C++',
  cc: 'C++',
  cxx: 'C++',
  h: 'C',
  hpp: 'C++',
  // C#
  cs: 'C#',
  // Go
  go: 'Go',
  // Rust
  rs: 'Rust',
  // Ruby
  rb: 'Ruby',
  // PHP
  php: 'PHP',
  // Swift
  swift: 'Swift',
  // Scala
  scala: 'Scala',
};

/**
 * Gets language name from file extension.
 */
function getLanguageFromExtension(ext: string): string {
  return EXTENSION_TO_LANGUAGE[ext.toLowerCase()] ?? 'Unknown';
}

// ============================================================================
// Simple Code Parser (placeholder for full AST parsing)
// ============================================================================

/**
 * Simple regex-based code structure extractor.
 * This is a placeholder - a full implementation would use proper AST parsing.
 *
 * Note: This provides basic class/method detection for pattern analysis.
 * For production use, consider integrating tree-sitter or similar.
 */
function extractCodeStructure(
  content: string,
  language: string
): { classes: ClassSignature[]; functions: number } {
  const classes: ClassSignature[] = [];
  let functionCount = 0;

  // Language-specific patterns
  const classPatterns: Record<string, RegExp> = {
    Python: /class\s+(\w+)(?:\s*\(([\w\s,]+)\))?:/g,
    TypeScript: /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w\s,]+))?\s*{/g,
    JavaScript: /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?\s*{/g,
    Java: /(?:public|private|protected)?\s*(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w\s,]+))?\s*{/g,
    'C#': /(?:public|private|protected|internal)?\s*(?:abstract\s+)?class\s+(\w+)(?:\s*:\s*([\w\s,]+))?\s*{/g,
  };

  const methodPatterns: Record<string, RegExp> = {
    Python: /def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([\w\[\],\s]+))?:/g,
    TypeScript: /(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?(\w+)\s*\(([^)]*)\)(?:\s*:\s*([\w<>\[\],\s]+))?\s*{/g,
    JavaScript: /(?:static\s+)?(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*{/g,
    Java: /(?:public|private|protected)?\s*(?:static\s+)?(?:abstract\s+)?(?:<[\w\s,]+>\s+)?([\w<>\[\]]+)\s+(\w+)\s*\(([^)]*)\)/g,
    'C#': /(?:public|private|protected|internal)?\s*(?:static\s+)?(?:async\s+)?(?:virtual\s+)?(?:override\s+)?([\w<>\[\]]+)\s+(\w+)\s*\(([^)]*)\)/g,
  };

  // Default to TypeScript patterns for unknown languages
  const classRegex = classPatterns[language] ?? classPatterns.TypeScript!;
  const methodRegex = methodPatterns[language] ?? methodPatterns.TypeScript!;

  // Extract classes
  let classMatch: RegExpExecArray | null;
  while ((classMatch = classRegex.exec(content)) !== null) {
    const className = classMatch[1];
    if (!className) continue;

    const baseClassesStr = classMatch[2] ?? '';
    const interfacesStr = classMatch[3] ?? '';

    const baseClasses = baseClassesStr
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const interfaces = interfacesStr
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // Find line number
    const beforeMatch = content.substring(0, classMatch.index);
    const lineNumber = (beforeMatch.match(/\n/g) || []).length + 1;

    // Extract methods for this class (simplified)
    const methods: MethodSignature[] = [];

    // Reset method regex
    methodRegex.lastIndex = 0;
    let methodMatch: RegExpExecArray | null;

    while ((methodMatch = methodRegex.exec(content)) !== null) {
      const methodName = language === 'Java' || language === 'C#' ? methodMatch[2] : methodMatch[1];
      const paramsStr = language === 'Java' || language === 'C#' ? methodMatch[3] : methodMatch[2];
      const returnType = language === 'Java' || language === 'C#' ? methodMatch[1] : methodMatch[3];

      if (!methodName) continue;

      // Find method line number
      const beforeMethod = content.substring(0, methodMatch.index);
      const methodLineNumber = (beforeMethod.match(/\n/g) || []).length + 1;

      // Parse parameters (simplified)
      const parameters = (paramsStr ?? '')
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .map((p) => {
          const parts = p.split(':').map((s) => s.trim());
          return {
            name: (parts[0] ?? '').replace(/^(self|this|final|const|var|let)\s*/, ''),
            typeHint: parts[1],
          };
        });

      methods.push({
        name: methodName,
        parameters,
        returnType: returnType?.trim(),
        lineNumber: methodLineNumber,
        isAsync: methodMatch[0].includes('async'),
        isMethod: true,
        decorators: [],
        isStatic: methodMatch[0].includes('static'),
        visibility: methodMatch[0].includes('private')
          ? 'private'
          : methodMatch[0].includes('protected')
            ? 'protected'
            : 'public',
      });

      functionCount++;
    }

    classes.push({
      name: className,
      baseClasses,
      methods,
      lineNumber,
      isAbstract: classMatch[0].includes('abstract'),
      decorators: [],
      interfaces,
    });
  }

  return { classes, functions: functionCount };
}

// ============================================================================
// GoF Pattern Analyzer
// ============================================================================

/**
 * GoF Design Pattern Analyzer.
 *
 * Analyzes source code to detect Gang of Four design patterns.
 * Supports multiple detection depths and configurable pattern filtering.
 *
 * @example
 * ```ts
 * const analyzer = createGofPatternAnalyzer({
 *   detectionDepth: DetectionDepth.Deep,
 *   minConfidence: 0.6,
 * });
 *
 * const result = await analyzer.analyze({
 *   bundleRoot: '/path/to/bundle',
 *   files: ingestedFiles,
 *   manifest: bundleManifest,
 * });
 *
 * console.log(result.data?.totalPatterns);
 * ```
 */
export class GofPatternAnalyzer extends BaseAnalyzer<GofPatternOutput, GofPatternAnalyzerOptions> {
  readonly name = 'gof-pattern-analyzer';
  readonly version = '1.0.0';
  readonly description = 'Detects Gang of Four design patterns in source code';

  private readonly detectors: BasePatternDetector[];

  constructor(options?: Partial<GofPatternAnalyzerOptions>) {
    super(options);

    // Initialize detectors - Creational, Structural, and Behavioral patterns
    this.detectors = [
      // Creational patterns
      createSingletonDetector(),
      createFactoryDetector(),
      createBuilderDetector(),
      // Structural patterns
      createDecoratorDetector(),
      createAdapterDetector(),
      // Behavioral patterns
      createObserverDetector(),
      createStrategyDetector(),
      createCommandDetector(),
      createTemplateMethodDetector(),
      createChainOfResponsibilityDetector(),
    ];
  }

  protected getDefaultOptions(): Required<GofPatternAnalyzerOptions> {
    return DEFAULT_GOF_PATTERN_OPTIONS;
  }

  /**
   * Analyze files for GoF design patterns.
   */
  async analyze(input: AnalyzerInput): Promise<AnalyzerOutput<GofPatternOutput>> {
    const startTime = Date.now();
    const errors: AnalyzerErrorInfo[] = [];
    let filesAnalyzed = 0;

    // Validate input
    const validationErrors = this.validateInput(input);
    if (validationErrors.length > 0) {
      return this.createFailureOutput(validationErrors, this.createMetadata(startTime, 0));
    }

    const logger = this.getLogger();
    logger.info('Starting GoF pattern analysis', {
      bundleRoot: input.bundleRoot,
      fileCount: input.files.length,
      depth: this.options.detectionDepth,
    });

    try {
      // Filter files to analyze
      const files = this.filterFiles(input.files);
      const fileReports: FilePatternReport[] = [];
      const allPatterns: PatternInstance[] = [];

      // Analyze each file
      for (const file of files) {
        try {
          const report = await this.analyzeFile(file.bundleNormAbsPath, file.repoRelativePath);

          if (report) {
            fileReports.push(report);
            allPatterns.push(...report.patterns);
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

      // Build summary
      const patternSummary: PatternSummary = {};
      const categorySummary: CategorySummary = {};

      for (const pattern of allPatterns) {
        // Filter by minimum confidence
        if (pattern.confidence < this.options.minConfidence) continue;

        patternSummary[pattern.patternType] = (patternSummary[pattern.patternType] ?? 0) + 1;
        categorySummary[pattern.category] = (categorySummary[pattern.category] ?? 0) + 1;
      }

      // Filter patterns by confidence threshold
      const filteredPatterns = allPatterns.filter(
        (p) => p.confidence >= this.options.minConfidence
      );

      const report: PatternReport = {
        files: fileReports,
        allPatterns: filteredPatterns,
        patternSummary,
        categorySummary,
        totalFiles: filesAnalyzed,
        totalPatterns: filteredPatterns.length,
      };

      logger.info('GoF pattern analysis complete', {
        filesAnalyzed,
        patternsDetected: filteredPatterns.length,
        durationMs: Date.now() - startTime,
      });

      // Generate summary
      const summary = this.generateSummary(filteredPatterns, filesAnalyzed);

      // Generate highlights (only high-confidence patterns >= 0.7)
      const highlights = this.generateHighlights(filteredPatterns);

      return this.createSuccessOutput(
        report,
        this.createMetadata(startTime, filesAnalyzed),
        summary,
        highlights,
        errors
      );
    } catch (err) {
      logger.error('Pattern analysis failed', err instanceof Error ? err : new Error(String(err)));

      return this.createFailureOutput(
        [this.errorToInfo(err)],
        this.createMetadata(startTime, filesAnalyzed)
      );
    }
  }

  /**
   * Analyze a single file for patterns.
   */
  private async analyzeFile(
    absolutePath: string,
    relativePath: string
  ): Promise<FilePatternReport | null> {
    // Check if file is source code
    const ext = getFileExtension(relativePath);
    const language = getLanguageFromExtension(ext);

    if (language === 'Unknown') {
      return null; // Skip non-source files
    }

    // Read file content
    const content = await fs.readFile(absolutePath, 'utf-8');

    // Extract code structure
    const { classes, functions } = extractCodeStructure(content, language);

    if (classes.length === 0) {
      return {
        filePath: relativePath,
        language,
        patterns: [],
        totalClasses: 0,
        totalFunctions: functions,
        analysisDepth: this.options.detectionDepth,
      };
    }

    // Detect patterns for each class
    const patterns: PatternInstance[] = [];

    for (const classSig of classes) {
      const context = {
        currentClass: classSig,
        allClasses: classes,
        fileContent: this.options.detectionDepth === DetectionDepth.Full ? content : undefined,
        filePath: relativePath,
        language,
      };

      // Run all detectors
      for (const detector of this.detectors) {
        // Filter by pattern type if specified
        if (
          this.options.patternTypes.length > 0 &&
          !this.options.patternTypes.includes(detector.patternType)
        ) {
          continue;
        }

        // Filter by category if specified
        if (
          this.options.categories.length > 0 &&
          !this.options.categories.includes(detector.category)
        ) {
          continue;
        }

        const pattern = detector.detect(context, this.options.detectionDepth);

        if (pattern) {
          // Apply language-specific adaptations
          const adapted = adaptForLanguage(pattern, language);

          // Strip evidence if not requested
          if (!this.options.includeEvidence) {
            adapted.evidence = [];
          }

          patterns.push(adapted);
        }
      }
    }

    return {
      filePath: relativePath,
      language,
      patterns,
      totalClasses: classes.length,
      totalFunctions: functions,
      analysisDepth: this.options.detectionDepth,
    };
  }

  /**
   * Generate a brief summary of the analysis results.
   */
  private generateSummary(patterns: PatternInstance[], filesAnalyzed: number): string {
    if (patterns.length === 0) {
      return `No GoF design patterns detected in ${filesAnalyzed} analyzed files.`;
    }

    // Count by category
    const categories = new Map<string, number>();
    for (const p of patterns) {
      categories.set(p.category, (categories.get(p.category) ?? 0) + 1);
    }

    const categoryList = Array.from(categories.entries())
      .map(([cat, count]) => `${count} ${cat}`)
      .join(', ');

    return `Detected ${patterns.length} GoF design patterns (${categoryList}) in ${filesAnalyzed} files.`;
  }

  /**
   * Generate highlights from high-confidence patterns.
   * Only includes patterns with confidence >= 0.7.
   */
  private generateHighlights(patterns: PatternInstance[]): AnalyzerHighlight[] {
    // Filter to high-confidence patterns only
    const highConfidence = patterns.filter((p) => p.confidence >= 0.7);

    // Sort by confidence descending, then by pattern type
    const sorted = highConfidence.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return a.patternType.localeCompare(b.patternType);
    });

    // Convert to highlights (top 5)
    return sorted.slice(0, 5).map((p) => ({
      type: p.patternType,
      description: `${p.className ?? 'Class'} implements ${p.patternType} pattern (${p.category})`,
      confidence: p.confidence,
      file: p.location,
      line: p.lineNumber,
      context: {
        category: p.category,
        relatedClasses: p.relatedClasses,
      },
    }));
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new GofPatternAnalyzer instance.
 */
export function createGofPatternAnalyzer(
  options?: Partial<GofPatternAnalyzerOptions>
): GofPatternAnalyzer {
  return new GofPatternAnalyzer(options);
}
