/**
 * Circular Dependency Detection Module
 *
 * Detects circular import dependencies in a project using DFS traversal.
 *
 * @module analysis/check/circular
 */

import * as path from 'node:path';

import { createModuleLogger } from '../../../logging/logger.js';
import type { CircularIssue, SingleCheckResult, CircularOptions } from '../types.js';
import { computeSummaryFromIssues, DEFAULT_CHECK_OPTIONS } from '../types.js';
import type { DependencyGraph } from '../deadcode/types.js';
import { checkDeadCode } from '../deadcode/index.js';

const logger = createModuleLogger('circular');

// ============================================================================
// Types
// ============================================================================

/**
 * Default circular options.
 */
const DEFAULT_CIRCULAR_OPTIONS: Required<CircularOptions> = {
  maxCycleLength: DEFAULT_CHECK_OPTIONS.circular.maxCycleLength!,
  maxCycles: DEFAULT_CHECK_OPTIONS.circular.maxCycles!,
};

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Check for circular dependencies in a directory.
 */
export async function checkCircular(
  targetPath: string,
  options?: Partial<CircularOptions>,
  excludePatterns?: string[]
): Promise<SingleCheckResult<CircularIssue>> {
  const opts = { ...DEFAULT_CIRCULAR_OPTIONS, ...options };
  const resolvedPath = path.resolve(targetPath);

  logger.info(`Checking circular dependencies in: ${resolvedPath}`);

  try {
    // Build dependency graph using deadcode module
    // We run deadcode check just to get the graph, then do our own cycle detection
    const deadcodeResult = await checkDeadCode(targetPath, {}, excludePatterns);

    // Get the graph from the deadcode module by re-running the analysis
    // This is a bit wasteful but keeps modules independent
    const graph = await buildGraphForCircular(targetPath, excludePatterns ?? []);

    if (graph.nodes.size === 0) {
      return {
        type: 'circular',
        success: true,
        issues: [],
        summary: computeSummaryFromIssues([], 0),
      };
    }

    // Detect cycles
    const cycles = detectCycles(graph, opts);

    // Convert to issues
    const issues = convertToIssues(cycles, resolvedPath);

    return {
      type: 'circular',
      success: true,
      issues,
      summary: computeSummaryFromIssues(issues, graph.nodes.size),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Circular dependency check failed: ${msg}`);
    return {
      type: 'circular',
      success: false,
      issues: [],
      summary: computeSummaryFromIssues([], 0),
      error: msg,
    };
  }
}

// ============================================================================
// Graph Building (reuses deadcode logic)
// ============================================================================

import * as fs from 'node:fs/promises';
import { minimatch } from 'minimatch';
import { extractModuleSyntaxWasm, languageForFile } from '../../../ast/index.js';
import { LANGUAGE_SUPPORT } from '../types.js';
import type { FileNode } from '../deadcode/types.js';

/**
 * Build dependency graph for circular detection.
 */
async function buildGraphForCircular(
  rootPath: string,
  excludePatterns: string[]
): Promise<DependencyGraph> {
  const graph: DependencyGraph = {
    nodes: new Map(),
    entryPoints: new Set(),
    orphans: new Set(),
  };

  const files: string[] = [];
  const supportedExts = new Set(LANGUAGE_SUPPORT.circular);

  // Collect files
  await walkDir(rootPath, async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!supportedExts.has(ext)) return;

    const relativePath = path.relative(rootPath, filePath).replace(/\\/g, '/');
    if (excludePatterns.some((p) => minimatch(relativePath, p))) return;

    files.push(filePath);
  });

  // First pass: collect imports/exports
  for (const filePath of files) {
    const relativePath = path.relative(rootPath, filePath).replace(/\\/g, '/');

    try {
      const content = await fs.readFile(filePath, 'utf8');
      const normalizedContent = content.replace(/\r\n/g, '\n');

      const lang = languageForFile(filePath);
      if (!lang) continue;

      const parsed = await extractModuleSyntaxWasm(filePath, normalizedContent);

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

  // Second pass: resolve imports
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

  return graph;
}

/**
 * Walk directory recursively.
 */
async function walkDir(dir: string, callback: (filePath: string) => Promise<void>): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
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

/**
 * Resolve import path.
 */
function resolveImport(
  importPath: string,
  fromDir: string,
  nodes: Map<string, FileNode>
): string | null {
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
    return null;
  }

  const normalized = path.join(fromDir, importPath).replace(/\\/g, '/');
  const cleanPath = normalized.replace(/^\.\//, '');

  if (nodes.has(cleanPath)) return cleanPath;

  const exts = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.go', '.java', '.rs'];
  for (const ext of exts) {
    const withExt = cleanPath.replace(/\.(js|ts|jsx|tsx|mjs|cjs|py|go|java|rs)$/, '') + ext;
    if (nodes.has(withExt)) return withExt;
  }

  const indexExts = ['/index.js', '/index.ts', '/index.jsx', '/index.tsx'];
  for (const ext of indexExts) {
    const withIndex = cleanPath.replace(/\/$/, '') + ext;
    if (nodes.has(withIndex)) return withIndex;
  }

  return null;
}

// ============================================================================
// Cycle Detection (DFS)
// ============================================================================

/**
 * Detect cycles in the dependency graph using DFS.
 */
function detectCycles(graph: DependencyGraph, options: Required<CircularOptions>): string[][] {
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function dfs(node: string, path: string[]): void {
    // Stop if we've found enough cycles
    if (cycles.length >= options.maxCycles) return;

    if (visiting.has(node)) {
      // Found a cycle
      const cycleStart = path.indexOf(node);
      if (cycleStart !== -1) {
        const cycle = path.slice(cycleStart).concat(node);
        // Only report if within max length
        if (cycle.length <= options.maxCycleLength + 1) {
          cycles.push(cycle);
        }
      }
      return;
    }

    if (visited.has(node)) return;

    visiting.add(node);
    path.push(node);

    const nodeData = graph.nodes.get(node);
    if (nodeData) {
      for (const dep of nodeData.importsFrom) {
        dfs(dep, [...path]);
      }
    }

    visiting.delete(node);
    visited.add(node);
  }

  // Start DFS from each node
  for (const node of graph.nodes.keys()) {
    if (!visited.has(node) && cycles.length < options.maxCycles) {
      dfs(node, []);
    }
  }

  return cycles;
}

// ============================================================================
// Issue Conversion
// ============================================================================

/**
 * Convert cycles to issues.
 */
function convertToIssues(cycles: string[][], rootPath: string): CircularIssue[] {
  const issues: CircularIssue[] = [];

  for (const cycle of cycles) {
    const firstFile = cycle[0] ?? '';
    const cycleStr = cycle.map((f) => path.basename(f)).join(' → ');

    issues.push({
      type: 'circular',
      severity: 'error',
      file: path.join(rootPath, firstFile),
      line: '1',
      message: `Circular dependency: ${cycleStr}`,
      cycle: cycle.map((f) => path.join(rootPath, f)),
    });
  }

  return issues;
}
