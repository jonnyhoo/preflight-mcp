/**
 * Dead Code Detection - Type Definitions
 *
 * @module analysis/check/deadcode/types
 */

import type { DeadCodeOptions } from '../types.js';

// ============================================================================
// Internal Types
// ============================================================================

/**
 * File node in the dependency graph.
 */
export interface FileNode {
  /** Relative file path */
  path: string;
  /** Files that import this file */
  importedBy: Set<string>;
  /** Files that this file imports */
  importsFrom: Set<string>;
  /** Exported symbol names */
  exports: Set<string>;
  /** Imported specifiers (module paths) */
  importPaths: Set<string>;
}

/**
 * Dependency graph for the project.
 */
export interface DependencyGraph {
  /** All file nodes */
  nodes: Map<string, FileNode>;
  /** Entry point files */
  entryPoints: Set<string>;
  /** Orphaned files (no imports, no importers) */
  orphans: Set<string>;
}

/**
 * Fine-grained deadcode issue (internal).
 */
export interface FineGrainedIssue {
  type: 'unused-private-field' | 'unused-local-variable' | 'unused-parameter';
  file: string;
  line: number;
  symbolName: string;
  className?: string;
}

/**
 * Dead code detection result (internal).
 */
export interface DeadCodeDetectionResult {
  /** Files not imported by any other file */
  orphanedFiles: string[];
  /** Files with exports that are never imported */
  unusedExports: Array<{
    file: string;
    exports: string[];
  }>;
  /** Test files (excluded from dead code) */
  testFiles: string[];
  /** Possibly dead (only imported by one file, no further imports) */
  possiblyDead: Array<{
    file: string;
    usedBy: string;
  }>;
  /** Fine-grained issues */
  fineGrained: FineGrainedIssue[];
}

/**
 * Options with defaults applied.
 */
export type ResolvedDeadCodeOptions = Required<DeadCodeOptions>;

/**
 * Default deadcode options.
 */
export const DEFAULT_DEADCODE_OPTIONS: ResolvedDeadCodeOptions = {
  includeTests: false,
  entryPatterns: ['index.*', 'main.*', 'app.*', 'server.*', 'cli.*', 'lib.*'],
  fineGrained: true,
  fineGrainedLanguages: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.java', '.rs'],
};
