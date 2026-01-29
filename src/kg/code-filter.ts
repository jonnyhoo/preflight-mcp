/**
 * Code Filter - Intelligent filtering for code indexing.
 * Determines which files/functions should be indexed based on quality heuristics.
 * 
 * @module kg/code-filter
 */

import * as path from 'node:path';
import type { AstGraphNode } from './types.js';

// ============================================================================
// Filter Options
// ============================================================================

export interface CodeFilterOptions {
  /** Maximum file size in bytes (default: 100KB) */
  maxFileSize?: number;
  /** Maximum functions to index per bundle (default: 500) */
  maxFunctions?: number;
  /** Skip test files (default: true) */
  skipTests?: boolean;
  /** Skip generated files (default: true) */
  skipGenerated?: boolean;
  /** Minimum function lines to index (default: 3) */
  minFunctionLines?: number;
  /** Maximum content length for a single node (default: 2000) */
  maxContentLength?: number;
}

export const DEFAULT_CODE_FILTER_OPTIONS: Required<CodeFilterOptions> = {
  maxFileSize: 100 * 1024, // 100KB
  maxFunctions: 500,
  skipTests: true,
  skipGenerated: true,
  minFunctionLines: 3,
  maxContentLength: 2000,
};

// ============================================================================
// File Patterns
// ============================================================================

/** Test file patterns */
const TEST_PATTERNS = [
  /[_.]test\.[jt]sx?$/i,
  /[_.]spec\.[jt]sx?$/i,
  /_test\.py$/i,
  /_test\.go$/i,
  /test_.*\.py$/i,
  /\.test\.[jt]sx?$/i,
  /__tests__\//i,
  /\/tests?\//i,
  /\/spec\//i,
];

/** Generated file patterns */
const GENERATED_PATTERNS = [
  /\.pb\.go$/,
  /\.pb\.ts$/,
  /\.generated\.[^.]+$/,
  /_generated\.[^.]+$/,
  /\.g\.dart$/,
  /\.freezed\.dart$/,
  /\.min\.[jt]s$/,
  /\.bundle\.[jt]s$/,
];

/** Lock and config files to skip */
const SKIP_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'go.sum',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'composer.lock',
  'Gemfile.lock',
]);

/** Directories to always skip */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.git',
  '.svn',
  '.hg',
  '__pycache__',
  '.pytest_cache',
  '.tox',
  'venv',
  '.venv',
  'vendor',
  'target',  // Rust
  'coverage',
]);

// ============================================================================
// File Filtering
// ============================================================================

/**
 * Check if a file path matches any pattern in the list.
 */
function matchesAnyPattern(filePath: string, patterns: RegExp[]): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return patterns.some(p => p.test(normalized));
}

/**
 * Check if file is in a skipped directory.
 */
function isInSkippedDir(filePath: string): boolean {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts.some(part => SKIP_DIRS.has(part));
}

/**
 * Determine if a file should be indexed.
 * 
 * @param filePath - Relative or absolute file path
 * @param fileSize - Optional file size in bytes
 * @param options - Filter options
 * @returns true if the file should be indexed
 */
export function shouldIndexFile(
  filePath: string,
  fileSize?: number,
  options?: CodeFilterOptions
): boolean {
  const opts = { ...DEFAULT_CODE_FILTER_OPTIONS, ...options };
  const fileName = path.basename(filePath);

  // Skip files in excluded directories
  if (isInSkippedDir(filePath)) {
    return false;
  }

  // Skip lock/config files
  if (SKIP_FILES.has(fileName)) {
    return false;
  }

  // Skip oversized files
  if (fileSize !== undefined && fileSize > opts.maxFileSize) {
    return false;
  }

  // Skip test files
  if (opts.skipTests && matchesAnyPattern(filePath, TEST_PATTERNS)) {
    return false;
  }

  // Skip generated files
  if (opts.skipGenerated && matchesAnyPattern(filePath, GENERATED_PATTERNS)) {
    return false;
  }

  return true;
}

// ============================================================================
// Function Filtering
// ============================================================================

/** Getter/setter patterns */
const GETTER_SETTER_PATTERNS = [
  /^get[A-Z]/,
  /^set[A-Z]/,
  /^is[A-Z]/,
  /^has[A-Z]/,
];

/** Simple wrapper/passthrough patterns in function names */
const WRAPPER_PATTERNS = [
  /^_/,  // Private helpers often trivial
  /^__(?!init__|call__|new__)/,  // Dunder methods except important ones
];

/** Entry point function names (high priority) */
const ENTRY_POINT_NAMES = new Set([
  'main',
  'run',
  'execute',
  'start',
  'init',
  'setup',
  'bootstrap',
  'handleRequest',
  'handler',
  'serve',
]);

/**
 * Determine if a function/method node should be indexed.
 * 
 * @param node - AST graph node
 * @param options - Filter options
 * @returns true if the function should be indexed
 */
export function shouldIndexFunction(
  node: AstGraphNode,
  options?: CodeFilterOptions
): boolean {
  const opts = { ...DEFAULT_CODE_FILTER_OPTIONS, ...options };

  // Only filter function/method nodes
  if (node.kind !== 'function' && node.kind !== 'method') {
    return true; // Don't filter classes, interfaces, etc.
  }

  // Check line count if available
  if (node.startLine !== undefined && node.endLine !== undefined) {
    const lineCount = node.endLine - node.startLine + 1;
    
    // Skip very short functions (likely getters/setters)
    if (lineCount < opts.minFunctionLines) {
      // Unless they have documentation (author thinks they're important)
      if (!node.description) {
        return false;
      }
    }
  }

  // Always index exported functions
  if (node.isExported) {
    return true;
  }

  // Always index entry points
  if (ENTRY_POINT_NAMES.has(node.name.toLowerCase())) {
    return true;
  }

  // Always index documented functions
  if (node.description && node.description.length > 20) {
    return true;
  }

  // Skip likely trivial getters/setters without docs
  if (GETTER_SETTER_PATTERNS.some(p => p.test(node.name))) {
    if (!node.description && node.startLine && node.endLine) {
      const lineCount = node.endLine - node.startLine + 1;
      if (lineCount < 5) {
        return false;
      }
    }
  }

  // Skip obvious private wrappers without docs
  if (WRAPPER_PATTERNS.some(p => p.test(node.name))) {
    if (!node.description && !node.isExported) {
      return false;
    }
  }

  return true;
}

// ============================================================================
// Importance Calculation
// ============================================================================

/**
 * Calculate importance score for a node (0-1).
 * Higher scores indicate more valuable code for indexing.
 * 
 * Factors considered:
 * - Has documentation (author thinks it's important)
 * - Is exported/public (part of API)
 * - Is entry point
 * - Code length (longer = more logic)
 * - Has type annotations
 * 
 * @param node - AST graph node
 * @returns Importance score between 0 and 1
 */
export function calculateImportance(node: AstGraphNode): number {
  let score = 0.3; // Base score

  // Exported symbols are more important (API surface)
  if (node.isExported) {
    score += 0.25;
  }

  // Documented code is intentionally highlighted
  if (node.description) {
    score += 0.2;
    // Longer docs = more important
    if (node.description.length > 50) {
      score += 0.05;
    }
  }

  // Entry point functions are critical
  if (ENTRY_POINT_NAMES.has(node.name.toLowerCase())) {
    score += 0.2;
  }

  // Longer functions typically contain more logic
  if (node.startLine !== undefined && node.endLine !== undefined) {
    const lineCount = node.endLine - node.startLine + 1;
    if (lineCount > 20) {
      score += 0.1;
    } else if (lineCount > 50) {
      score += 0.15;
    }
  }

  // Classes and interfaces are structural - slightly boost
  if (node.kind === 'class' || node.kind === 'interface') {
    score += 0.1;
  }

  // Cap at 1.0
  return Math.min(score, 1.0);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Truncate content to maximum length, preserving complete lines.
 * 
 * @param content - Original content
 * @param maxLength - Maximum length
 * @returns Truncated content
 */
export function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }

  // Find last newline before maxLength
  const truncated = content.slice(0, maxLength);
  const lastNewline = truncated.lastIndexOf('\n');
  
  if (lastNewline > maxLength * 0.8) {
    // Truncate at newline if it's not too far back
    return truncated.slice(0, lastNewline) + '\n// ... truncated';
  }

  return truncated + '...';
}

/**
 * Sort nodes by importance for quota enforcement.
 * 
 * @param nodes - Array of nodes to sort
 * @returns Sorted array (highest importance first)
 */
export function sortByImportance(nodes: AstGraphNode[]): AstGraphNode[] {
  return [...nodes].sort((a, b) => {
    const importanceA = a.importance ?? calculateImportance(a);
    const importanceB = b.importance ?? calculateImportance(b);
    return importanceB - importanceA;
  });
}

/**
 * Apply quota to nodes, keeping only the most important ones.
 * 
 * @param nodes - Array of nodes
 * @param maxCount - Maximum nodes to keep
 * @returns Filtered array respecting quota
 */
export function applyQuota(nodes: AstGraphNode[], maxCount: number): AstGraphNode[] {
  if (nodes.length <= maxCount) {
    return nodes;
  }

  const sorted = sortByImportance(nodes);
  return sorted.slice(0, maxCount);
}
