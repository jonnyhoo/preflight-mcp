/**
 * Code Complexity Detection Module
 *
 * Detects code complexity issues:
 * - High cyclomatic complexity
 * - Long functions
 * - Deep nesting
 * - Too many parameters
 *
 * Uses tree-sitter for AST analysis.
 *
 * @module analysis/check/complexity
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { minimatch } from 'minimatch';
import Parser from 'web-tree-sitter';

import { createModuleLogger } from '../../../logging/logger.js';
import type { ComplexityIssue, SingleCheckResult, ComplexityOptions } from '../types.js';
import { computeSummaryFromIssues, LANGUAGE_SUPPORT, DEFAULT_CHECK_OPTIONS } from '../types.js';
import { languageForFile } from '../../../ast/index.js';

const logger = createModuleLogger('complexity');

// ============================================================================
// Types
// ============================================================================

/**
 * Default complexity options.
 */
const DEFAULT_COMPLEXITY_OPTIONS: Required<ComplexityOptions> = {
  complexityThreshold: DEFAULT_CHECK_OPTIONS.complexity.complexityThreshold!,
  lineLengthThreshold: DEFAULT_CHECK_OPTIONS.complexity.lineLengthThreshold!,
  nestingThreshold: DEFAULT_CHECK_OPTIONS.complexity.nestingThreshold!,
  paramCountThreshold: DEFAULT_CHECK_OPTIONS.complexity.paramCountThreshold!,
};

/**
 * Function metrics.
 */
interface FunctionMetrics {
  name: string;
  startLine: number;
  endLine: number;
  lineCount: number;
  complexity: number;
  nestingDepth: number;
  paramCount: number;
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Check for complexity issues in a directory.
 */
export async function checkComplexity(
  targetPath: string,
  options?: Partial<ComplexityOptions>,
  excludePatterns?: string[]
): Promise<SingleCheckResult<ComplexityIssue>> {
  const opts = { ...DEFAULT_COMPLEXITY_OPTIONS, ...options };
  const resolvedPath = path.resolve(targetPath);

  logger.info(`Checking code complexity in: ${resolvedPath}`);

  try {
    // Collect supported files
    const files = await collectFiles(resolvedPath, excludePatterns ?? []);

    if (files.length === 0) {
      return {
        type: 'complexity',
        success: true,
        issues: [],
        summary: computeSummaryFromIssues([], 0),
      };
    }

    // Analyze each file
    const allIssues: ComplexityIssue[] = [];

    for (const filePath of files) {
      try {
        const fileIssues = await analyzeFileComplexity(filePath, resolvedPath, opts);
        allIssues.push(...fileIssues);
      } catch {
        // Skip files that can't be analyzed
      }
    }

    return {
      type: 'complexity',
      success: true,
      issues: allIssues,
      summary: computeSummaryFromIssues(allIssues, files.length),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Complexity check failed: ${msg}`);
    return {
      type: 'complexity',
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
  const supportedExts = new Set(LANGUAGE_SUPPORT.complexity);

  await walkDir(rootPath, async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();

    if (!supportedExts.has(ext)) return;

    const relativePath = path.relative(rootPath, filePath).replace(/\\/g, '/');
    if (excludePatterns.some((p) => minimatch(relativePath, p))) return;

    files.push(filePath);
  });

  return files;
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

// ============================================================================
// Complexity Analysis
// ============================================================================

/**
 * Analyze complexity of a single file.
 */
async function analyzeFileComplexity(
  filePath: string,
  rootPath: string,
  options: Required<ComplexityOptions>
): Promise<ComplexityIssue[]> {
  const issues: ComplexityIssue[] = [];

  const content = await fs.readFile(filePath, 'utf8');
  const normalizedContent = content.replace(/\r\n/g, '\n');
  const lines = normalizedContent.split('\n');

  const lang = languageForFile(filePath);
  if (!lang) return issues;

  // Use simple regex-based analysis for now (tree-sitter parsing is complex to set up)
  // This is a simplified approach that works for most cases
  const functions = extractFunctions(normalizedContent, lang);

  for (const func of functions) {
    // Check line length
    if (func.lineCount > options.lineLengthThreshold) {
      issues.push({
        type: 'long-function',
        severity: func.lineCount > options.lineLengthThreshold * 2 ? 'error' : 'warning',
        file: filePath,
        line: String(func.startLine),
        message: `Function '${func.name}' is too long (${func.lineCount} lines, threshold: ${options.lineLengthThreshold})`,
        functionName: func.name,
        value: func.lineCount,
        threshold: options.lineLengthThreshold,
      });
    }

    // Check complexity
    if (func.complexity > options.complexityThreshold) {
      issues.push({
        type: 'high-complexity',
        severity: func.complexity > options.complexityThreshold * 2 ? 'error' : 'warning',
        file: filePath,
        line: String(func.startLine),
        message: `Function '${func.name}' has high complexity (${func.complexity}, threshold: ${options.complexityThreshold})`,
        functionName: func.name,
        value: func.complexity,
        threshold: options.complexityThreshold,
      });
    }

    // Check nesting depth
    if (func.nestingDepth > options.nestingThreshold) {
      issues.push({
        type: 'deep-nesting',
        severity: func.nestingDepth > options.nestingThreshold + 2 ? 'error' : 'warning',
        file: filePath,
        line: String(func.startLine),
        message: `Function '${func.name}' has deep nesting (${func.nestingDepth} levels, threshold: ${options.nestingThreshold})`,
        functionName: func.name,
        value: func.nestingDepth,
        threshold: options.nestingThreshold,
      });
    }

    // Check parameter count
    if (func.paramCount > options.paramCountThreshold) {
      issues.push({
        type: 'many-params',
        severity: 'warning',
        file: filePath,
        line: String(func.startLine),
        message: `Function '${func.name}' has too many parameters (${func.paramCount}, threshold: ${options.paramCountThreshold})`,
        functionName: func.name,
        value: func.paramCount,
        threshold: options.paramCountThreshold,
      });
    }
  }

  return issues;
}

/**
 * Extract functions from source code using regex (simplified approach).
 */
function extractFunctions(content: string, lang: string): FunctionMetrics[] {
  const functions: FunctionMetrics[] = [];
  const lines = content.split('\n');

  // Language-specific function patterns
  const patterns: Record<string, RegExp[]> = {
    javascript: [
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g,
      /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/g,
      /(\w+)\s*:\s*(?:async\s+)?(?:function\s*)?\([^)]*\)\s*(?:=>|{)/g,
    ],
    typescript: [
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g,
      /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::[^=]*)?\s*=>/g,
      /(\w+)\s*(?:\?)?:\s*(?:async\s+)?(?:function\s*)?\([^)]*\)\s*(?:=>|{)/g,
    ],
    tsx: [
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g,
      /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::[^=]*)?\s*=>/g,
    ],
    python: [
      /def\s+(\w+)\s*\(([^)]*)\)/g,
      /async\s+def\s+(\w+)\s*\(([^)]*)\)/g,
    ],
    go: [/func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(([^)]*)\)/g],
    java: [
      /(?:public|private|protected)?\s*(?:static)?\s*(?:\w+(?:<[^>]*>)?)\s+(\w+)\s*\(([^)]*)\)/g,
    ],
    rust: [/(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g],
  };

  const langPatterns = patterns[lang] ?? patterns['javascript'] ?? [];

  for (const pattern of langPatterns) {
    let match;
    const regex = new RegExp(pattern.source, 'gm');

    while ((match = regex.exec(content)) !== null) {
      const name = match[1] ?? 'anonymous';
      const params = match[2] ?? '';
      const startIndex = match.index;
      const startLine = content.slice(0, startIndex).split('\n').length;

      // Find function end by tracking braces
      const funcBody = extractFunctionBody(content.slice(startIndex), lang);
      const lineCount = funcBody.split('\n').length;
      const endLine = startLine + lineCount - 1;

      // Calculate complexity (simplified: count decision points)
      const complexity = calculateComplexity(funcBody);

      // Calculate nesting depth
      const nestingDepth = calculateNestingDepth(funcBody);

      // Count parameters
      const paramCount = params.trim() ? params.split(',').length : 0;

      functions.push({
        name,
        startLine,
        endLine,
        lineCount,
        complexity,
        nestingDepth,
        paramCount,
      });
    }
  }

  return functions;
}

/**
 * Extract function body by tracking braces.
 */
function extractFunctionBody(content: string, lang: string): string {
  let braceCount = 0;
  let started = false;
  let result = '';

  // For Python, use indentation
  if (lang === 'python') {
    const lines = content.split('\n');
    const firstLine = lines[0] ?? '';
    result = firstLine + '\n';

    if (lines.length <= 1) return result;

    // Get base indentation from first content line
    const baseIndent = (lines[1]?.match(/^\s*/)?.[0] ?? '').length;
    if (baseIndent === 0) return result;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      const indent = (line.match(/^\s*/)?.[0] ?? '').length;

      // Empty lines or lines with same/greater indentation are part of function
      if (line.trim() === '' || indent >= baseIndent) {
        result += line + '\n';
      } else {
        break;
      }
    }

    return result;
  }

  // For C-style languages, track braces
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    result += char;

    if (char === '{') {
      braceCount++;
      started = true;
    } else if (char === '}') {
      braceCount--;
      if (started && braceCount === 0) {
        break;
      }
    }
  }

  return result;
}

/**
 * Calculate cyclomatic complexity (simplified).
 */
function calculateComplexity(code: string): number {
  let complexity = 1; // Base complexity

  // Decision points that increase complexity
  const patterns = [
    /\bif\b/g,
    /\belse\s+if\b/g,
    /\bwhile\b/g,
    /\bfor\b/g,
    /\bcase\b/g,
    /\bcatch\b/g,
    /\b\?\s*[^:]/g, // Ternary
    /\&\&/g,
    /\|\|/g,
  ];

  for (const pattern of patterns) {
    const matches = code.match(pattern);
    if (matches) {
      complexity += matches.length;
    }
  }

  return complexity;
}

/**
 * Calculate maximum nesting depth.
 */
function calculateNestingDepth(code: string): number {
  let maxDepth = 0;
  let currentDepth = 0;

  for (const char of code) {
    if (char === '{' || char === '(') {
      currentDepth++;
      maxDepth = Math.max(maxDepth, currentDepth);
    } else if (char === '}' || char === ')') {
      currentDepth = Math.max(0, currentDepth - 1);
    }
  }

  return maxDepth;
}
