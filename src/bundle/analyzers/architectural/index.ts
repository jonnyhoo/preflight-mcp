/**
 * Architectural Pattern Detection Module
 *
 * Detects high-level architectural patterns by analyzing directory structures
 * and file organization. Supports MVC, MVVM, Repository, Service Layer,
 * Layered Architecture, and Clean Architecture patterns.
 *
 * @module bundle/analyzers/architectural
 */

import * as path from 'node:path';

import { BaseAnalyzer } from '../base-analyzer.js';
import type { AnalyzerInput, AnalyzerOutput, AnalyzerErrorInfo, AnalyzerHighlight } from '../types.js';

import {
  createAllDetectors,
  MVCDetector,
  MVVMDetector,
  RepositoryDetector,
  ServiceLayerDetector,
  LayeredArchitectureDetector,
  CleanArchitectureDetector,
  createMVCDetector,
  createMVVMDetector,
  createRepositoryDetector,
  createServiceLayerDetector,
  createLayeredArchitectureDetector,
  createCleanArchitectureDetector,
} from './detectors.js';

import {
  type ArchitecturalPattern,
  type ArchitecturalReport,
  type ArchitecturalOutput,
  type ArchitecturalAnalyzerOptions,
  type ArchitecturalDetectionContext,
  type ArchitecturalPatternDetector,
  type DirectoryStructure,
  type FrameworkType,
  type ArchitecturalPatternType,
  DEFAULT_ARCHITECTURAL_OPTIONS,
  FRAMEWORK_MARKERS,
} from './types.js';

// ============================================================================
// Re-exports
// ============================================================================

export {
  // Types
  type ArchitecturalPattern,
  type ArchitecturalReport,
  type ArchitecturalOutput,
  type ArchitecturalAnalyzerOptions,
  type ArchitecturalDetectionContext,
  type ArchitecturalPatternDetector,
  type DirectoryStructure,
  type FrameworkType,
  type ArchitecturalPatternType,
  // Constants
  DEFAULT_ARCHITECTURAL_OPTIONS,
  FRAMEWORK_MARKERS,
  // Detector classes
  MVCDetector,
  MVVMDetector,
  RepositoryDetector,
  ServiceLayerDetector,
  LayeredArchitectureDetector,
  CleanArchitectureDetector,
  // Detector factory functions
  createMVCDetector,
  createMVVMDetector,
  createRepositoryDetector,
  createServiceLayerDetector,
  createLayeredArchitectureDetector,
  createCleanArchitectureDetector,
  createAllDetectors,
};

// Also re-export from types for convenience
export type {
  ArchitecturalEvidence,
  ComponentMap,
} from './types.js';

export {
  MVC_DIRECTORIES,
  MVVM_DIRECTORIES,
  LAYERED_DIRECTORIES,
  CLEAN_ARCH_DIRECTORIES,
  REPOSITORY_DIRECTORIES,
  SERVICE_DIRECTORIES,
} from './types.js';

// ============================================================================
// Architectural Analyzer
// ============================================================================

/**
 * Architectural Pattern Analyzer.
 *
 * Analyzes codebase structure to detect high-level architectural patterns.
 * Works at the directory and file organization level, not individual code content.
 *
 * @example
 * ```ts
 * const analyzer = createArchitecturalAnalyzer({
 *   minConfidence: 0.6,
 *   detectFrameworks: true,
 * });
 *
 * const result = await analyzer.analyze({
 *   bundleRoot: '/path/to/bundle',
 *   files: ingestedFiles,
 *   manifest: bundleManifest,
 * });
 *
 * console.log(result.data?.patterns);
 * console.log(result.data?.primaryArchitecture);
 * ```
 */
export class ArchitecturalAnalyzer extends BaseAnalyzer<
  ArchitecturalOutput,
  ArchitecturalAnalyzerOptions
> {
  readonly name = 'architectural-analyzer';
  readonly version = '1.0.0';
  readonly description = 'Detects high-level architectural patterns in codebase';

  private readonly detectors: ArchitecturalPatternDetector[];

  constructor(options?: Partial<ArchitecturalAnalyzerOptions>) {
    super(options);
    this.detectors = createAllDetectors();
  }

  protected getDefaultOptions(): Required<ArchitecturalAnalyzerOptions> {
    return DEFAULT_ARCHITECTURAL_OPTIONS;
  }

  /**
   * Analyze files for architectural patterns.
   */
  async analyze(input: AnalyzerInput): Promise<AnalyzerOutput<ArchitecturalOutput>> {
    const startTime = Date.now();
    const errors: AnalyzerErrorInfo[] = [];

    // Validate input
    const validationErrors = this.validateInput(input);
    if (validationErrors.length > 0) {
      return this.createFailureOutput(validationErrors, this.createMetadata(startTime, 0));
    }

    const logger = this.getLogger();
    logger.info('Starting architectural pattern analysis', {
      bundleRoot: input.bundleRoot,
      fileCount: input.files.length,
    });

    try {
      // Filter files
      const files = this.filterFiles(input.files);
      const filePaths = files.map((f) => f.repoRelativePath);

      // Analyze directory structure
      const directoryStructure = this.analyzeDirectoryStructure(filePaths);

      // Detect frameworks
      const frameworks = this.options.detectFrameworks
        ? this.detectFrameworks(filePaths)
        : [];

      // Build detection context
      const context: ArchitecturalDetectionContext = {
        directoryStructure,
        filePaths,
        frameworks,
      };

      // Run all detectors
      const patterns: ArchitecturalPattern[] = [];

      for (const detector of this.detectors) {
        // Filter by pattern type if specified
        if (
          this.options.patternTypes.length > 0 &&
          !this.options.patternTypes.includes(detector.patternType)
        ) {
          continue;
        }

        try {
          const pattern = detector.detect(context);

          if (pattern && pattern.confidence >= this.options.minConfidence) {
            // Strip evidence if not requested
            if (!this.options.includeEvidence) {
              pattern.evidence = [];
            }
            patterns.push(pattern);
          }
        } catch (err) {
          logger.warn('Pattern detector failed', {
            detector: detector.patternType,
            error: err instanceof Error ? err.message : String(err),
          });
          errors.push({
            code: 'DETECTOR_ERROR',
            message: `Detector ${detector.patternType} failed: ${err instanceof Error ? err.message : String(err)}`,
            recoverable: true,
          });
        }
      }

      // Sort patterns by confidence (highest first)
      patterns.sort((a, b) => b.confidence - a.confidence);

      // Determine primary architecture
      const primaryArchitecture = patterns[0]?.patternType;

      const report: ArchitecturalReport = {
        patterns,
        directoryStructure,
        totalFilesAnalyzed: files.length,
        frameworksDetected: frameworks,
        primaryArchitecture,
      };

      logger.info('Architectural pattern analysis complete', {
        filesAnalyzed: files.length,
        patternsDetected: patterns.length,
        primaryArchitecture,
        durationMs: Date.now() - startTime,
      });

      // Generate summary and highlights
      const summary = this.generateSummary(patterns, frameworks, files.length);
      const highlights = this.generateHighlights(patterns);

      return this.createSuccessOutput(
        report,
        this.createMetadata(startTime, files.length),
        summary,
        highlights,
        errors.length > 0 ? errors : undefined
      );
    } catch (err) {
      logger.error(
        'Architectural analysis failed',
        err instanceof Error ? err : new Error(String(err))
      );

      return this.createFailureOutput(
        [this.errorToInfo(err)],
        this.createMetadata(startTime, 0)
      );
    }
  }

  /**
   * Analyzes directory structure from file paths.
   * Returns a map of directory names (lowercase) to file counts.
   */
  private analyzeDirectoryStructure(filePaths: string[]): DirectoryStructure {
    const structure: DirectoryStructure = {};

    for (const fp of filePaths) {
      // Normalize path separators
      const normalized = fp.replace(/\\/g, '/');
      const parts = path.dirname(normalized).split('/').filter(Boolean);

      for (const part of parts) {
        const lower = part.toLowerCase();
        structure[lower] = (structure[lower] ?? 0) + 1;
      }
    }

    return structure;
  }

  /**
   * Detects frameworks based on file paths.
   */
  private detectFrameworks(filePaths: string[]): FrameworkType[] {
    const detected: FrameworkType[] = [];
    const allPathsLower = filePaths.map((fp) => fp.toLowerCase()).join(' ');

    const frameworkEntries = Object.entries(FRAMEWORK_MARKERS) as [FrameworkType, string[]][];

    for (const [framework, markers] of frameworkEntries) {
      if (framework === 'Unknown') continue;

      const matches = markers.filter((marker) =>
        allPathsLower.includes(marker.toLowerCase())
      ).length;

      // Require at least 2 markers for detection
      if (matches >= 2) {
        detected.push(framework);
        this.getLogger().debug('Framework detected', { framework, matches });
      }
    }

    return detected;
  }

  /**
   * Generate a brief summary of the analysis results.
   */
  private generateSummary(
    patterns: ArchitecturalPattern[],
    frameworks: FrameworkType[],
    filesAnalyzed: number
  ): string {
    const parts: string[] = [];

    if (patterns.length === 0) {
      parts.push(`No architectural patterns detected in ${filesAnalyzed} files.`);
    } else {
      const primary = patterns[0];
      if (primary) {
        parts.push(`Primary architecture: ${primary.patternType} (${Math.round(primary.confidence * 100)}% confidence).`);
      }
      if (patterns.length > 1) {
        parts.push(`Also detected: ${patterns.slice(1).map(p => p.patternType).join(', ')}.`);
      }
    }

    if (frameworks.length > 0) {
      parts.push(`Frameworks: ${frameworks.join(', ')}.`);
    }

    return parts.join(' ');
  }

  /**
   * Generate highlights from detected patterns.
   */
  private generateHighlights(patterns: ArchitecturalPattern[]): AnalyzerHighlight[] {
    return patterns.slice(0, 5).map((p) => ({
      type: p.patternType,
      description: p.description || `${p.patternType} architecture pattern detected`,
      confidence: p.confidence,
      context: {
        components: p.components,
        matchedDirectories: p.evidence?.slice(0, 3).map(e => e.type),
      },
    }));
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new ArchitecturalAnalyzer instance.
 *
 * @param options - Optional configuration options
 * @returns New analyzer instance
 *
 * @example
 * ```ts
 * const analyzer = createArchitecturalAnalyzer();
 * const result = await analyzer.analyze(input);
 * ```
 */
export function createArchitecturalAnalyzer(
  options?: Partial<ArchitecturalAnalyzerOptions>
): ArchitecturalAnalyzer {
  return new ArchitecturalAnalyzer(options);
}

/**
 * Convenience function to analyze architectural patterns.
 * Creates an analyzer instance and runs analysis in one call.
 *
 * @param input - Analyzer input
 * @param options - Optional configuration options
 * @returns Analysis result
 */
export async function analyzeArchitecture(
  input: AnalyzerInput,
  options?: Partial<ArchitecturalAnalyzerOptions>
): Promise<AnalyzerOutput<ArchitecturalOutput>> {
  const analyzer = createArchitecturalAnalyzer(options);
  return analyzer.analyze(input);
}
