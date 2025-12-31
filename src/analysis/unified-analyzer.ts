/**
 * Unified Analyzer - Orchestration layer for multi-layer code analysis.
 *
 * Combines:
 * - TypeSemanticAnalyzer (ts-morph): Deep type analysis
 * - PatternAnalyzer: Design comment and pattern detection
 *
 * @module analysis/unified-analyzer
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TypeSemanticAnalyzer, createTypeSemanticAnalyzer } from './type-semantic-analyzer.js';
import { PatternAnalyzer, createPatternAnalyzer } from './pattern-analyzer.js';
import { PythonAnalyzer, createPythonAnalyzer, GoAnalyzer, createGoAnalyzer, RustAnalyzer, createRustAnalyzer } from './languages/index.js';
import type {
  ExtensionPointInfo,
  TypeSemantics,
  UnifiedAnalysisResult,
  UnifiedAnalyzerConfig,
  ExtensionPointKind,
  InferredPurpose,
  FileAnalysisResult,
} from './types.js';
import { DEFAULT_ANALYZER_CONFIG } from './types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('unified-analyzer');

// ============================================================================
// Unified Analyzer
// ============================================================================

/**
 * Unified analyzer that orchestrates multiple analysis layers.
 */
export class UnifiedAnalyzer {
  private config: Required<UnifiedAnalyzerConfig>;
  private typeAnalyzer: TypeSemanticAnalyzer;
  private patternAnalyzer: PatternAnalyzer;
  private pythonAnalyzer: PythonAnalyzer;
  private goAnalyzer: GoAnalyzer;
  private rustAnalyzer: RustAnalyzer;

  constructor(config: UnifiedAnalyzerConfig = {}) {
    this.config = { ...DEFAULT_ANALYZER_CONFIG, ...config };
    this.typeAnalyzer = createTypeSemanticAnalyzer(this.config.tsConfigPath || undefined);
    this.patternAnalyzer = createPatternAnalyzer();
    this.pythonAnalyzer = createPythonAnalyzer();
    this.goAnalyzer = createGoAnalyzer();
    this.rustAnalyzer = createRustAnalyzer();
  }

  /**
   * Analyze a single file using all analysis layers.
   */
  async analyzeFile(absPath: string, relativePath?: string): Promise<FileAnalysisResult> {
    const startTime = Date.now();
    const filePath = relativePath || absPath;
    const errors: string[] = [];

    const extensionPoints: ExtensionPointInfo[] = [];
    const typeSemantics: TypeSemantics = {
      unionTypes: [],
      optionalCallbacks: [],
      genericParams: [],
      designHints: [],
    };

    try {
      // Read file content once
      const content = await fs.readFile(absPath, 'utf8');

      // Layer 1: Type semantic analysis (ts-morph for TS/JS, custom for Python)
      if (this.isTypeScriptOrJsFile(absPath)) {
        try {
          const tsResult = this.typeAnalyzer.analyzeFile(absPath, filePath);

          typeSemantics.unionTypes = tsResult.unionTypes;
          typeSemantics.optionalCallbacks = tsResult.optionalCallbacks;
          typeSemantics.genericParams = tsResult.genericParams;

          // Convert to extension points
          if (this.config.analyzeUnionTypes) {
            for (const union of tsResult.unionTypes) {
              extensionPoints.push({
                kind: 'union-type',
                name: union.name,
                file: union.file,
                line: union.line,
                semantics: `${union.members.length} members: ${union.members.slice(0, 5).join(', ')}${union.members.length > 5 ? '...' : ''}`,
                values: union.members,
                inferredPurpose: union.inferredPurpose,
                extensibilityScore: this.scoreUnionType(union),
              });
            }
          }

          if (this.config.analyzeOptionalCallbacks) {
            for (const callback of tsResult.optionalCallbacks) {
              extensionPoints.push({
                kind: 'optional-callback',
                name: callback.name,
                file: callback.file,
                line: callback.line,
                semantics: `Injectable callback: ${callback.signature}`,
                inferredPurpose: 'callback-injection',
                extensibilityScore: this.scoreCallback(callback),
              });
            }
          }

          if (this.config.analyzeGenerics) {
            for (const generic of tsResult.genericParams) {
              if (generic.constraint) {
                extensionPoints.push({
                  kind: 'generic-param',
                  name: `${generic.parent}<${generic.name}>`,
                  file: generic.file,
                  line: generic.line,
                  semantics: `Generic constraint: ${generic.constraint}`,
                  values: [generic.constraint],
                  inferredPurpose: 'plugin-type',
                  extensibilityScore: 50,
                });
              }
            }
          }
        } catch (err) {
          errors.push(`TypeScript/JS analysis failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (this.isPythonFile(absPath)) {
        // Python analysis using custom analyzer (now with tree-sitter)
        try {
          const pyResult = await this.pythonAnalyzer.analyzeContent(content, filePath);

          typeSemantics.unionTypes.push(...pyResult.typeSemantics.unionTypes);
          typeSemantics.optionalCallbacks.push(...pyResult.typeSemantics.optionalCallbacks);
          extensionPoints.push(...pyResult.extensionPoints);
        } catch (err) {
          errors.push(`Python analysis failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (this.isGoFile(absPath)) {
        // Go analysis using custom analyzer (now with tree-sitter)
        try {
          const goResult = await this.goAnalyzer.analyzeContent(content, filePath);

          typeSemantics.unionTypes.push(...goResult.typeSemantics.unionTypes);
          typeSemantics.optionalCallbacks.push(...goResult.typeSemantics.optionalCallbacks);
          extensionPoints.push(...goResult.extensionPoints);
        } catch (err) {
          errors.push(`Go analysis failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (this.isRustFile(absPath)) {
        // Rust analysis using custom analyzer (now with tree-sitter)
        try {
          const rustResult = await this.rustAnalyzer.analyzeContent(content, filePath);

          typeSemantics.unionTypes.push(...rustResult.typeSemantics.unionTypes);
          typeSemantics.optionalCallbacks.push(...rustResult.typeSemantics.optionalCallbacks);
          extensionPoints.push(...rustResult.extensionPoints);
        } catch (err) {
          errors.push(`Rust analysis failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Layer 2: Pattern analysis
      if (this.config.analyzeDesignHints) {
        try {
          const patternResult = await this.patternAnalyzer.analyzeFileForExtensionPoints(
            filePath,
            content
          );

          typeSemantics.designHints = patternResult.designHints;
          extensionPoints.push(...patternResult.extensionPoints);
        } catch (err) {
          errors.push(`Pattern analysis failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Deduplicate extension points
      const dedupedPoints = this.deduplicateExtensionPoints(extensionPoints);

      // Filter by minimum score
      const filteredPoints = dedupedPoints.filter(
        (p) => (p.extensibilityScore ?? 0) >= this.config.minExtensibilityScore
      );

      return {
        file: filePath,
        extensionPoints: filteredPoints,
        typeSemantics,
        analysisTimeMs: Date.now() - startTime,
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (error) {
      return {
        file: filePath,
        extensionPoints: [],
        typeSemantics,
        analysisTimeMs: Date.now() - startTime,
        errors: [`File read failed: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  }

  /**
   * Analyze multiple files and aggregate results.
   */
  async analyzeFiles(
    files: Array<{ absPath: string; relativePath: string }>
  ): Promise<UnifiedAnalysisResult> {
    const startTime = Date.now();
    const allExtensionPoints: ExtensionPointInfo[] = [];
    const aggregatedSemantics: TypeSemantics = {
      unionTypes: [],
      optionalCallbacks: [],
      genericParams: [],
      designHints: [],
    };

    let filesAnalyzed = 0;

    for (const file of files) {
      // Skip excluded patterns
      if (this.shouldExclude(file.relativePath)) {
        continue;
      }

      // Only analyze included patterns
      if (!this.shouldInclude(file.relativePath)) {
        continue;
      }

      const result = await this.analyzeFile(file.absPath, file.relativePath);

      allExtensionPoints.push(...result.extensionPoints);
      aggregatedSemantics.unionTypes.push(...result.typeSemantics.unionTypes);
      aggregatedSemantics.optionalCallbacks.push(...result.typeSemantics.optionalCallbacks);
      aggregatedSemantics.genericParams.push(...result.typeSemantics.genericParams);
      aggregatedSemantics.designHints.push(...result.typeSemantics.designHints);

      filesAnalyzed++;
    }

    // Build summary
    const summary = this.buildSummary(allExtensionPoints, filesAnalyzed, Date.now() - startTime);

    logger.info('Unified analysis complete', {
      filesAnalyzed,
      extensionPoints: allExtensionPoints.length,
      timeMs: Date.now() - startTime,
    });

    return {
      extensionPoints: allExtensionPoints,
      typeSemantics: aggregatedSemantics,
      summary,
    };
  }

  /**
   * Analyze a directory recursively.
   */
  async analyzeDirectory(dirPath: string, bundleRelativeBase = ''): Promise<UnifiedAnalysisResult> {
    const files = await this.collectFiles(dirPath, bundleRelativeBase);
    return this.analyzeFiles(files);
  }

  // ============================================================================
  // Scoring Functions
  // ============================================================================

  /**
   * Score a union type's extensibility.
   */
  private scoreUnionType(union: TypeSemantics['unionTypes'][0]): number {
    let score = 30; // Base score

    // More members = more extensible
    if (union.members.length >= 4) score += 20;
    else if (union.members.length >= 3) score += 10;

    // Format/mode types are more valuable
    if (union.inferredPurpose === 'format-support') score += 20;
    if (union.inferredPurpose === 'mode-selector') score += 15;
    if (union.inferredPurpose === 'content-type') score += 15;
    if (union.inferredPurpose === 'plugin-type') score += 25;

    return Math.min(score, 100);
  }

  /**
   * Score an optional callback's extensibility.
   */
  private scoreCallback(callback: TypeSemantics['optionalCallbacks'][0]): number {
    let score = 50; // Base score for callbacks

    // Async callbacks are more valuable (Promise return type)
    if (callback.returnType?.includes('Promise')) score += 15;

    // Callbacks with parameters are more flexible
    if (callback.paramTypes && callback.paramTypes.length > 0) score += 10;

    // Common injection patterns
    const name = callback.name.toLowerCase();
    if (name.includes('func') || name.includes('handler') || name.includes('callback')) {
      score += 10;
    }
    if (name.includes('model') || name.includes('process') || name.includes('transform')) {
      score += 15;
    }

    return Math.min(score, 100);
  }

  // ============================================================================
  // Helper Functions
  // ============================================================================

  /**
   * Check if file is a TypeScript or JavaScript file.
   */
  private isTypeScriptOrJsFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext);
  }

  /**
   * Check if file is a Python file.
   */
  private isPythonFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ext === '.py';
  }

  /**
   * Check if file is a Go file.
   */
  private isGoFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ext === '.go';
  }

  /**
   * Check if file is a Rust file.
   */
  private isRustFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ext === '.rs';
  }

  /**
   * Check if path should be excluded.
   */
  private shouldExclude(relativePath: string): boolean {
    return this.config.excludePatterns.some((pattern) => {
      const regex = this.globToRegex(pattern);
      return regex.test(relativePath);
    });
  }

  /**
   * Check if path should be included.
   */
  private shouldInclude(relativePath: string): boolean {
    return this.config.includePatterns.some((pattern) => {
      const regex = this.globToRegex(pattern);
      return regex.test(relativePath);
    });
  }

  /**
   * Convert glob pattern to regex.
   */
  private globToRegex(glob: string): RegExp {
    const escaped = glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/{{GLOBSTAR}}/g, '.*');
    return new RegExp(`^${escaped}$`);
  }

  /**
   * Collect files from directory recursively.
   */
  private async collectFiles(
    dirPath: string,
    bundleRelativeBase: string
  ): Promise<Array<{ absPath: string; relativePath: string }>> {
    const files: Array<{ absPath: string; relativePath: string }> = [];

    const scan = async (currentPath: string, relativeBase: string) => {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const absPath = path.join(currentPath, entry.name);
        const relativePath = path.join(relativeBase, entry.name).replace(/\\/g, '/');

        if (entry.isDirectory()) {
          // Skip common non-source directories
          if (!['node_modules', '.git', 'dist', 'build', 'coverage'].includes(entry.name)) {
            await scan(absPath, relativePath);
          }
        } else if (entry.isFile()) {
          files.push({ absPath, relativePath });
        }
      }
    };

    await scan(dirPath, bundleRelativeBase);
    return files;
  }

  /**
   * Deduplicate extension points by file+line+name.
   */
  private deduplicateExtensionPoints(points: ExtensionPointInfo[]): ExtensionPointInfo[] {
    const seen = new Set<string>();
    const result: ExtensionPointInfo[] = [];

    for (const point of points) {
      const key = `${point.file}:${point.line}:${point.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(point);
      }
    }

    return result;
  }

  /**
   * Build analysis summary.
   */
  private buildSummary(
    extensionPoints: ExtensionPointInfo[],
    filesAnalyzed: number,
    totalTimeMs: number
  ): UnifiedAnalysisResult['summary'] {
    // Count by kind
    const byKind: Partial<Record<ExtensionPointKind, number>> = {};
    for (const point of extensionPoints) {
      byKind[point.kind] = (byKind[point.kind] || 0) + 1;
    }

    // Count by purpose
    const byPurpose: Partial<Record<InferredPurpose, number>> = {};
    for (const point of extensionPoints) {
      if (point.inferredPurpose) {
        byPurpose[point.inferredPurpose] = (byPurpose[point.inferredPurpose] || 0) + 1;
      }
    }

    // Top extension points by score
    const topExtensionPoints = [...extensionPoints]
      .sort((a, b) => (b.extensibilityScore ?? 0) - (a.extensibilityScore ?? 0))
      .slice(0, 10)
      .map((p) => ({
        name: p.name,
        score: p.extensibilityScore ?? 0,
        file: p.file,
      }));

    return {
      totalExtensionPoints: extensionPoints.length,
      byKind,
      byPurpose,
      topExtensionPoints,
      filesAnalyzed,
      totalAnalysisTimeMs: totalTimeMs,
    };
  }

  /**
   * Clear analyzer caches.
   */
  clearCache(): void {
    this.typeAnalyzer.clearCache();
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new unified analyzer.
 */
export function createUnifiedAnalyzer(config?: UnifiedAnalyzerConfig): UnifiedAnalyzer {
  return new UnifiedAnalyzer(config);
}
