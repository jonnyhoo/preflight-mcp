/**
 * Documentation Check Module
 *
 * Provides tools for checking documentation-code consistency.
 * Supports TypeScript/JavaScript JSDoc and Python docstrings.
 *
 * @module analysis/doccheck
 */

// ============================================================================
// Re-exports from types
// ============================================================================

export {
  type DocIssueType,
  type DocIssueSeverity,
  type DocCheckLanguage,
  type DocIssue,
  type ParamInfo,
  type DocParamInfo,
  type FunctionInfo,
  type DocInfo,
  type FunctionDocInfo,
  type FileCheckResult,
  type DocCheckResult,
  type DocCheckSummary,
  type DocCheckOptions,
  DEFAULT_DOCCHECK_OPTIONS,
  ISSUE_SEVERITY,
} from './types.js';

// ============================================================================
// Re-exports from checkers
// ============================================================================

export { TypeScriptDocChecker, createTypeScriptDocChecker } from './ts-checker.js';
export { PythonDocChecker, createPythonDocChecker } from './python/index.js';

// ============================================================================
// Unified Checker
// ============================================================================

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { minimatch } from 'minimatch';
import { createModuleLogger } from '../../logging/logger.js';
import { createTypeScriptDocChecker } from './ts-checker.js';
import { createPythonDocChecker } from './python/index.js';
import type {
  DocCheckOptions,
  DocCheckResult,
  DocCheckSummary,
  FileCheckResult,
  DocIssue,
  DocIssueType,
  DocIssueSeverity,
  DocCheckLanguage,
} from './types.js';
import { DEFAULT_DOCCHECK_OPTIONS } from './types.js';

const logger = createModuleLogger('doccheck');

/**
 * File extension to language mapping.
 */
const EXT_TO_LANGUAGE: Record<string, DocCheckLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
};

/**
 * Check documentation for a directory.
 */
export async function checkDocumentation(
  targetPath: string,
  options?: Partial<DocCheckOptions>
): Promise<DocCheckResult> {
  const opts = { ...DEFAULT_DOCCHECK_OPTIONS, ...options };
  const files = await collectFiles(targetPath, opts);

  // Group files by language
  const tsFiles: string[] = [];
  const pyFiles: string[] = [];

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const lang = EXT_TO_LANGUAGE[ext];

    if (lang === 'typescript' || lang === 'javascript') {
      tsFiles.push(file);
    } else if (lang === 'python') {
      pyFiles.push(file);
    }
  }

  const allResults: FileCheckResult[] = [];

  // Check TypeScript/JavaScript files
  if (tsFiles.length > 0) {
    const tsChecker = createTypeScriptDocChecker(opts);
    const tsResults = tsChecker.checkFiles(tsFiles);
    allResults.push(...tsResults);
    tsChecker.clearCache();
  }

  // Check Python files
  if (pyFiles.length > 0) {
    const pyChecker = createPythonDocChecker(opts);
    const pyResults = await pyChecker.checkFiles(pyFiles);
    allResults.push(...pyResults);
  }

  // Aggregate results
  const allIssues: DocIssue[] = [];
  for (const result of allResults) {
    allIssues.push(...result.issues);
  }

  const summary = computeSummary(allResults, allIssues);

  return {
    issues: allIssues,
    files: allResults,
    summary,
  };
}

/**
 * Collect files to check from a directory.
 */
async function collectFiles(targetPath: string, options: Required<DocCheckOptions>): Promise<string[]> {
  const files: string[] = [];

  const stat = await fs.stat(targetPath);

  if (stat.isFile()) {
    const ext = path.extname(targetPath).toLowerCase();
    if (EXT_TO_LANGUAGE[ext]) {
      return [targetPath];
    }
    return [];
  }

  // Walk directory
  await walkDir(targetPath, async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();

    // Check if supported language
    if (!EXT_TO_LANGUAGE[ext]) return;

    // Check include patterns
    if (options.includePatterns.length > 0) {
      const matches = options.includePatterns.some((p) => minimatch(filePath, p));
      if (!matches) return;
    }

    // Check exclude patterns
    if (options.excludePatterns.length > 0) {
      const matches = options.excludePatterns.some((p) => minimatch(filePath, p));
      if (matches) return;
    }

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
      if (['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build'].includes(entry.name)) {
        continue;
      }
      await walkDir(fullPath, callback);
    } else if (entry.isFile()) {
      await callback(fullPath);
    }
  }
}

/**
 * Compute summary statistics.
 */
function computeSummary(files: FileCheckResult[], issues: DocIssue[]): DocCheckSummary {
  const totalFunctions = files.reduce((sum, f) => sum + f.functionsChecked, 0);
  const documentedFunctions = files.reduce((sum, f) => sum + f.functionsDocumented, 0);

  const issuesByType: Record<DocIssueType, number> = {
    // Parameter issues
    param_missing: 0,
    param_extra: 0,
    param_name_mismatch: 0,
    param_order_mismatch: 0,
    param_type_mismatch: 0,
    // Return issues
    return_missing: 0,
    return_extra: 0,
    return_type_mismatch: 0,
    // Yields issues (Python only)
    yield_missing: 0,
    yield_extra: 0,
    yield_type_mismatch: 0,
    // Raises issues (Python only)
    raises_missing: 0,
    raises_extra: 0,
    raises_type_mismatch: 0,
    // Attribute issues (Python only)
    attr_missing: 0,
    attr_extra: 0,
    attr_type_mismatch: 0,
    // Type hint location issues (Python only)
    type_in_both: 0,
    type_in_docstring_only: 0,
    // Default value issues (Python only)
    default_missing: 0,
    default_mismatch: 0,
    // General issues
    missing_doc: 0,
    style_mismatch: 0,
  };

  const issuesBySeverity: Record<DocIssueSeverity, number> = {
    error: 0,
    warning: 0,
    info: 0,
  };

  const issuesByLanguage: Record<DocCheckLanguage, number> = {
    typescript: 0,
    javascript: 0,
    python: 0,
  };

  for (const issue of issues) {
    issuesByType[issue.type]++;
    issuesBySeverity[issue.severity]++;
  }

  for (const file of files) {
    issuesByLanguage[file.language] += file.issues.length;
  }

  return {
    totalFiles: files.length,
    totalFunctions,
    documentedFunctions,
    coveragePercent: totalFunctions > 0 ? Math.round((documentedFunctions / totalFunctions) * 100) : 100,
    issuesByType,
    issuesBySeverity,
    issuesByLanguage,
  };
}
