/**
 * Dead Code Detection Module
 *
 * Detects unused code in a project:
 * - Orphaned files (not imported by any other file)
 * - Unused exports (exported but never imported)
 *
 * Uses tree-sitter for parsing imports/exports.
 *
 * @module analysis/check/deadcode
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { minimatch } from 'minimatch';

import { extractModuleSyntaxWasm, languageForFile } from '../../../ast/index.js';
import { createModuleLogger } from '../../../logging/logger.js';
import type { AnalysisContext } from '../../cache/index.js';
import type { DeadCodeIssue, SingleCheckResult, DeadCodeOptions } from '../types.js';
import { computeSummaryFromIssues, LANGUAGE_SUPPORT } from '../types.js';
import type { DependencyGraph, FileNode, DeadCodeDetectionResult, FineGrainedIssue } from './types.js';
import { DEFAULT_DEADCODE_OPTIONS } from './types.js';
import { analyzeFineGrained } from './fine-grained.js';

export type { DependencyGraph, FileNode, DeadCodeDetectionResult, FineGrainedIssue } from './types.js';

const logger = createModuleLogger('deadcode');

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Check for dead code in a directory.
 *
 * @param targetPath - Directory to check
 * @param options - DeadCode options
 * @param excludePatterns - File patterns to exclude
 * @param context - Optional AnalysisContext for shared caching
 */
export async function checkDeadCode(
  targetPath: string,
  options?: Partial<DeadCodeOptions>,
  excludePatterns?: string[],
  context?: AnalysisContext
): Promise<SingleCheckResult<DeadCodeIssue>> {
  const opts = { ...DEFAULT_DEADCODE_OPTIONS, ...options };
  const resolvedPath = path.resolve(targetPath);

  logger.info(`Checking dead code in: ${resolvedPath}`);

  try {
    // Collect supported files
    const files = await collectFiles(resolvedPath, excludePatterns ?? []);

    if (files.length === 0) {
      return {
        type: 'deadcode',
        success: true,
        issues: [],
        summary: computeSummaryFromIssues([], 0),
      };
    }

    // Build dependency graph (use context if available)
    const graph = await buildDependencyGraph(files, resolvedPath, context);

    // Detect dead code
    const deadCode = detectDeadCode(graph, opts);

    // Fine-grained analysis
    if (opts.fineGrained && context) {
      const fineGrainedIssues = await runFineGrainedAnalysis(
        files,
        opts.fineGrainedLanguages ?? LANGUAGE_SUPPORT.deadcode,
        context
      );
      deadCode.fineGrained = fineGrainedIssues;
    }

    // Convert to issues
    const issues = convertToIssues(deadCode, resolvedPath);

    return {
      type: 'deadcode',
      success: true,
      issues,
      summary: computeSummaryFromIssues(issues, files.length),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Dead code check failed: ${msg}`);
    return {
      type: 'deadcode',
      success: false,
      issues: [],
      summary: computeSummaryFromIssues([], 0),
      error: msg,
    };
  }
}

// ============================================================================
// File Collection
// ============================================================================

/**
 * Collect files to analyze.
 */
async function collectFiles(rootPath: string, excludePatterns: string[]): Promise<string[]> {
  const files: string[] = [];
  const supportedExts = new Set(LANGUAGE_SUPPORT.deadcode);

  await walkDir(rootPath, async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();

    // Check if supported
    if (!supportedExts.has(ext)) return;

    // Check exclude patterns
    const relativePath = path.relative(rootPath, filePath).replace(/\\/g, '/');
    if (excludePatterns.some((p) => minimatch(relativePath, p))) return;

    files.push(filePath);
  });

  return files;
}

/**
 * Walk a directory recursively.
 */
async function walkDir(dir: string, callback: (filePath: string) => Promise<void>): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip common non-source directories
      if (
        [
          'node_modules',
          '.git',
          '__pycache__',
          '.venv',
          'venv',
          'dist',
          'build',
          'coverage',
          '.next',
          'out',
          'vendor',
          'target',
        ].includes(entry.name)
      ) {
        continue;
      }
      await walkDir(fullPath, callback);
    } else if (entry.isFile()) {
      await callback(fullPath);
    }
  }
}

// ============================================================================
// Dependency Graph Building
// ============================================================================

/**
 * Build dependency graph from files.
 */
async function buildDependencyGraph(
  files: string[],
  rootPath: string,
  context?: AnalysisContext
): Promise<DependencyGraph> {
  const graph: DependencyGraph = {
    nodes: new Map(),
    entryPoints: new Set(),
    orphans: new Set(),
  };

  // First pass: collect all files and their imports/exports
  for (const filePath of files) {
    const relativePath = path.relative(rootPath, filePath).replace(/\\/g, '/');

    try {
      const lang = languageForFile(filePath);
      if (!lang) continue;

      // When context is provided, extractModuleSyntaxWasm reads file internally via withTree
      // When no context, we need to read the file first
      const normalizedContent = context
        ? '' // Content not needed - withTree handles file reading
        : (await fs.readFile(filePath, 'utf8')).replace(/\r\n/g, '\n');

      if (!context && !normalizedContent) continue;

      // Use context for AST caching if available
      const parsed = await extractModuleSyntaxWasm(filePath, normalizedContent, context);

      const node: FileNode = {
        path: relativePath,
        importedBy: new Set(),
        importsFrom: new Set(),
        exports: new Set(parsed?.exports ?? []),
        importPaths: new Set(parsed?.imports.map((i) => i.module) ?? []),
      };

      graph.nodes.set(relativePath, node);
    } catch {
      // Skip files that can't be read/parsed
    }
  }

  // Second pass: resolve imports and build edges
  for (const [fromPath, node] of graph.nodes) {
    const fromDir = path.dirname(fromPath);

    for (const importPath of node.importPaths) {
      const resolved = resolveImport(importPath, fromDir, graph.nodes);
      if (resolved) {
        node.importsFrom.add(resolved);
        const targetNode = graph.nodes.get(resolved);
        if (targetNode) {
          targetNode.importedBy.add(fromPath);
        }
      }
    }
  }

  // Identify entry points and orphans
  for (const [filePath, node] of graph.nodes) {
    if (node.importedBy.size === 0 && node.importsFrom.size > 0) {
      graph.entryPoints.add(filePath);
    }
    if (node.importedBy.size === 0 && node.importsFrom.size === 0) {
      graph.orphans.add(filePath);
    }
  }

  return graph;
}

/**
 * Resolve an import path to a file in the graph.
 */
function resolveImport(
  importPath: string,
  fromDir: string,
  nodes: Map<string, FileNode>
): string | null {
  // Skip external imports
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
    return null;
  }

  // Normalize the path
  const normalized = path.join(fromDir, importPath).replace(/\\/g, '/');
  const cleanPath = normalized.replace(/^\.\//, '');

  // Try exact match
  if (nodes.has(cleanPath)) return cleanPath;

  // Try with extensions
  const exts = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.go', '.java', '.rs'];
  for (const ext of exts) {
    const withExt = cleanPath.replace(/\.(js|ts|jsx|tsx|mjs|cjs|py|go|java|rs)$/, '') + ext;
    if (nodes.has(withExt)) return withExt;
  }

  // Try index files
  const indexExts = ['/index.js', '/index.ts', '/index.jsx', '/index.tsx'];
  for (const ext of indexExts) {
    const withIndex = cleanPath.replace(/\/$/, '') + ext;
    if (nodes.has(withIndex)) return withIndex;
  }

  return null;
}

// ============================================================================
// Dead Code Detection
// ============================================================================

/**
 * Detect dead code from dependency graph.
 */
function detectDeadCode(
  graph: DependencyGraph,
  options: Required<DeadCodeOptions>
): DeadCodeDetectionResult {
  const result: DeadCodeDetectionResult = {
    orphanedFiles: [],
    unusedExports: [],
    testFiles: [],
    possiblyDead: [],
    fineGrained: [],
  };

  // Build re-exporter set (index files that re-export other modules)
  const reExporters = new Set<string>();
  for (const [filePath, node] of graph.nodes) {
    if (node.importsFrom.size > 0 && node.exports.size > 0) {
      const fileName = path.basename(filePath);
      if (isReExporter(fileName)) {
        reExporters.add(filePath);
        // Mark imported files as re-exported
        for (const imported of node.importsFrom) {
          const targetNode = graph.nodes.get(imported);
          if (targetNode) {
            targetNode.importedBy.add(filePath + ':reexport');
          }
        }
      }
    }
  }

  for (const [filePath, node] of graph.nodes) {
    const fileName = path.basename(filePath);

    // Check if test file
    if (isTestFile(filePath)) {
      result.testFiles.push(filePath);
      continue;
    }

    // Skip entry points
    if (isEntryPoint(fileName, options.entryPatterns)) {
      continue;
    }

    // Skip config files
    if (isConfigFile(fileName)) {
      continue;
    }

    // Skip TypeScript declaration files (.d.ts) - they use ambient module declarations
    if (isTypeDeclarationFile(fileName)) {
      continue;
    }

    const realImporters = Array.from(node.importedBy).filter((i) => !i.includes(':reexport'));
    const hasReExporter = Array.from(node.importedBy).some((i) => i.includes(':reexport'));

    // Check for orphaned files (no imports and no importers)
    if (node.importedBy.size === 0 && node.importsFrom.size === 0) {
      result.orphanedFiles.push(filePath);
      continue;
    }

    // Check for unused exports (has exports but no one imports this file)
    if (realImporters.length === 0 && !hasReExporter && node.exports.size > 0) {
      result.unusedExports.push({
        file: filePath,
        exports: Array.from(node.exports).slice(0, 5),
      });
    }

    // Check for possibly dead (only one importer, no outgoing imports)
    if (realImporters.length === 1 && node.importsFrom.size === 0 && !hasReExporter) {
      result.possiblyDead.push({
        file: filePath,
        usedBy: realImporters[0]!,
      });
    }
  }

  return result;
}

/**
 * Check if file is a test file.
 */
function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.includes('.test.') ||
    lower.includes('.spec.') ||
    lower.includes('/test/') ||
    lower.includes('/tests/') ||
    lower.includes('/__tests__/')
  );
}

/**
 * Check if file is an entry point.
 */
function isEntryPoint(fileName: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(fileName, pattern));
}

/**
 * Check if file is a config file.
 */
function isConfigFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return (
    lower.includes('config') ||
    lower.endsWith('.config.ts') ||
    lower.endsWith('.config.js') ||
    lower.endsWith('.config.mjs')
  );
}

/**
 * Check if file is a re-exporter (barrel file).
 */
function isReExporter(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.startsWith('index.') || lower.startsWith('lib.') || lower.startsWith('main.');
}

/**
 * Check if file is a TypeScript declaration file.
 * These files use `declare module` for ambient type declarations
 * and are not imported directly but resolved by TypeScript compiler.
 */
function isTypeDeclarationFile(fileName: string): boolean {
  return fileName.endsWith('.d.ts');
}

// ============================================================================
// Fine-grained Analysis
// ============================================================================

/**
 * Run fine-grained analysis on all supported files.
 */
async function runFineGrainedAnalysis(
  files: string[],
  supportedExtensions: string[],
  context: AnalysisContext
): Promise<FineGrainedIssue[]> {
  const allIssues: FineGrainedIssue[] = [];
  const extSet = new Set(supportedExtensions.map((e) => e.toLowerCase()));

  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase();
    if (!extSet.has(ext)) continue;

    // Skip test files
    if (isTestFile(filePath)) continue;

    try {
      const issues = await context.ast.withTree(context.fileIndex, filePath, (tree, lang) => {
        return analyzeFineGrained(tree, lang, filePath);
      });
      if (issues) {
        allIssues.push(...issues);
      }
    } catch {
      // Skip files that can't be parsed
    }
  }

  return allIssues;
}

// ============================================================================
// Issue Conversion
// ============================================================================

/**
 * Convert dead code detection result to issues.
 */
function convertToIssues(deadCode: DeadCodeDetectionResult, rootPath: string): DeadCodeIssue[] {
  const issues: DeadCodeIssue[] = [];

  // Orphaned files are errors
  for (const file of deadCode.orphanedFiles) {
    issues.push({
      type: 'orphaned',
      severity: 'warning',
      file: path.join(rootPath, file),
      line: '1',
      message: `Orphaned file: not imported by any other file and has no imports`,
    });
  }

  // Unused exports are warnings
  for (const { file, exports } of deadCode.unusedExports) {
    issues.push({
      type: 'unused-export',
      severity: 'warning',
      file: path.join(rootPath, file),
      line: '1',
      message: `Unused exports: ${exports.join(', ')}${exports.length > 3 ? ' (and more)' : ''}`,
      exportName: exports[0],
    });
  }

  // Possibly dead are info
  for (const { file, usedBy } of deadCode.possiblyDead.slice(0, 10)) {
    issues.push({
      type: 'unreachable',
      severity: 'info',
      file: path.join(rootPath, file),
      line: '1',
      message: `Single-use file: only imported by ${path.basename(usedBy)}`,
    });
  }

  // Fine-grained issues
  for (const fg of deadCode.fineGrained ?? []) {
    const messageMap: Record<FineGrainedIssue['type'], string> = {
      'unused-private-field': `Unused private field '${fg.symbolName}'${fg.className ? ` in ${fg.className}` : ''}`,
      'unused-local-variable': `Unused local variable '${fg.symbolName}'`,
      'unused-parameter': `Unused parameter '${fg.symbolName}'`,
    };
    issues.push({
      type: fg.type,
      severity: fg.type === 'unused-parameter' ? 'info' : 'warning',
      file: fg.file,
      line: String(fg.line),
      message: messageMap[fg.type],
      symbolName: fg.symbolName,
      className: fg.className,
    });
  }

  return issues;
}
