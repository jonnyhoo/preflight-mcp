/**
 * Python Documentation Checker
 *
 * Uses tree-sitter to extract function signatures and parses
 * Google/NumPy/Sphinx style docstrings to detect inconsistencies.
 *
 * @module analysis/doccheck/python/checker
 */

import * as fs from 'node:fs/promises';
import { createModuleLogger } from '../../../logging/logger.js';
import { parseFileWasm } from '../../../ast/index.js';
import type { AnalysisContext } from '../../cache/index.js';
import type { DocIssue, DocCheckOptions, FileCheckResult } from '../types.js';
import { DEFAULT_DOCCHECK_OPTIONS, ISSUE_SEVERITY } from '../types.js';
import type { PyFunctionDocInfo } from './types.js';

// Import modular checkers
import { extractFunctions, extractClasses } from './extractor.js';
import { checkParams } from './param-checker.js';
import { checkReturns, checkYields } from './return-checker.js';
import { checkRaises } from './raises-checker.js';
import { checkClass } from './class-checker.js';
import { isIssueSuppressed } from './noqa.js';

const logger = createModuleLogger('doccheck:py');

// ============================================================================
// Python Checker Class
// ============================================================================

/**
 * Python documentation checker.
 */
export class PythonDocChecker {
  private options: Required<DocCheckOptions>;
  private context?: AnalysisContext;

  constructor(options?: Partial<DocCheckOptions>, context?: AnalysisContext) {
    this.options = { ...DEFAULT_DOCCHECK_OPTIONS, ...options };
    this.context = context;
  }

  /**
   * Check a single file for documentation issues.
   *
   * @param filePath - File path to check
   * @param context - Optional AnalysisContext (overrides constructor context)
   */
  async checkFile(filePath: string, context?: AnalysisContext): Promise<FileCheckResult> {
    const ctx = context ?? this.context;

    // Use AstCache if context available
    if (ctx) {
      return this.checkFileWithContext(filePath, ctx);
    }

    // Fallback: direct parsing (legacy path)
    return this.checkFileDirect(filePath);
  }

  /**
   * Check file using AstCache for tree lifecycle management.
   */
  private async checkFileWithContext(
    filePath: string,
    context: AnalysisContext
  ): Promise<FileCheckResult> {
    const issues: DocIssue[] = [];
    let functionsChecked = 0;
    let functionsDocumented = 0;

    try {
      const content = await context.fileIndex.readNormalized(filePath);
      if (!content) {
        logger.warn(`Failed to read ${filePath}`);
        return {
          file: filePath,
          language: 'python',
          issues: [],
          functionsChecked: 0,
          functionsDocumented: 0,
        };
      }

      const result = await context.ast.withTree(context.fileIndex, filePath, (tree) => {
        const functions = extractFunctions(tree.rootNode, filePath, content, this.options);
        const classes = extractClasses(tree.rootNode, filePath, content, this.options);

        // Check classes for attribute documentation
        for (const classDoc of classes) {
          if (this.options.onlyExported && !classDoc.cls.isPublic) {
            continue;
          }
          const classIssues = checkClass(classDoc, this.options);
          issues.push(...classIssues);
        }

        for (const funcDoc of functions) {
          // Skip non-public if option is set
          if (this.options.onlyExported && !funcDoc.func.isExported) {
            continue;
          }

          functionsChecked++;
          if (funcDoc.doc.exists) {
            functionsDocumented++;
          }

          const funcIssues = this.checkFunction(funcDoc);
          issues.push(...funcIssues);
        }

        return { functionsChecked, functionsDocumented };
      });

      if (result) {
        functionsChecked = result.functionsChecked;
        functionsDocumented = result.functionsDocumented;
      }
    } catch (err) {
      logger.warn(`Failed to check file ${filePath}`, { error: String(err) });
    }

    return {
      file: filePath,
      language: 'python',
      issues,
      functionsChecked,
      functionsDocumented,
    };
  }

  /**
   * Check file with direct parsing (legacy path).
   */
  private async checkFileDirect(filePath: string): Promise<FileCheckResult> {
    const issues: DocIssue[] = [];
    let functionsChecked = 0;
    let functionsDocumented = 0;

    try {
      const content = await fs.readFile(filePath, 'utf8');
      const tree = await parseFileWasm(filePath, content);

      if (!tree) {
        logger.warn(`Failed to parse ${filePath}`);
        return {
          file: filePath,
          language: 'python',
          issues: [],
          functionsChecked: 0,
          functionsDocumented: 0,
        };
      }

      try {
        const functions = extractFunctions(tree.rootNode, filePath, content, this.options);
        const classes = extractClasses(tree.rootNode, filePath, content, this.options);

        // Check classes for attribute documentation
        for (const classDoc of classes) {
          if (this.options.onlyExported && !classDoc.cls.isPublic) {
            continue;
          }
          const classIssues = checkClass(classDoc, this.options);
          issues.push(...classIssues);
        }

        for (const funcDoc of functions) {
          // Skip non-public if option is set
          if (this.options.onlyExported && !funcDoc.func.isExported) {
            continue;
          }

          functionsChecked++;
          if (funcDoc.doc.exists) {
            functionsDocumented++;
          }

          const funcIssues = this.checkFunction(funcDoc);
          issues.push(...funcIssues);
        }
      } finally {
        // Always delete the tree to avoid memory leaks
        tree.delete();
      }
    } catch (err) {
      logger.warn(`Failed to check file ${filePath}`, { error: String(err) });
    }

    return {
      file: filePath,
      language: 'python',
      issues,
      functionsChecked,
      functionsDocumented,
    };
  }

  /**
   * Check multiple files.
   *
   * @param filePaths - File paths to check
   * @param context - Optional AnalysisContext for shared caching
   */
  async checkFiles(filePaths: string[], context?: AnalysisContext): Promise<FileCheckResult[]> {
    const ctx = context ?? this.context;
    return Promise.all(filePaths.map((fp) => this.checkFile(fp, ctx)));
  }

  // ============================================================================
  // Issue Detection
  // ============================================================================

  /**
   * Check a function for documentation issues.
   */
  private checkFunction(funcDoc: PyFunctionDocInfo): DocIssue[] {
    const allIssues: DocIssue[] = [];
    const { func, doc, node, noqaCodes } = funcDoc;
    const fullName = func.className ? `${func.className}.${func.name}` : func.name;

    // Check if documentation is missing
    if (!doc.exists) {
      if (this.options.requireDocs) {
        const issue: DocIssue = {
          type: 'missing_doc',
          severity: ISSUE_SEVERITY.missing_doc,
          file: func.file,
          line: func.line,
          name: fullName,
          message: `Function '${fullName}' has no docstring`,
        };
        if (!isIssueSuppressed(issue.type, noqaCodes)) {
          allIssues.push(issue);
        }
      }
      return allIssues;
    }

    // Delegate to specialized checkers
    allIssues.push(...checkParams(func, doc, noqaCodes, this.options));
    allIssues.push(...checkReturns(func, doc, node, noqaCodes, this.options));
    allIssues.push(...checkYields(func, doc, node, noqaCodes));
    allIssues.push(...checkRaises(func, doc, node, noqaCodes));

    return allIssues;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new Python documentation checker.
 *
 * @param options - Documentation check options
 * @param context - Optional AnalysisContext for AST caching
 */
export function createPythonDocChecker(
  options?: Partial<DocCheckOptions>,
  context?: AnalysisContext
): PythonDocChecker {
  return new PythonDocChecker(options, context);
}
