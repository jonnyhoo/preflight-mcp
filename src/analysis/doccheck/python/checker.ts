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

  constructor(options?: Partial<DocCheckOptions>) {
    this.options = { ...DEFAULT_DOCCHECK_OPTIONS, ...options };
  }

  /**
   * Check a single file for documentation issues.
   */
  async checkFile(filePath: string): Promise<FileCheckResult> {
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
   */
  async checkFiles(filePaths: string[]): Promise<FileCheckResult[]> {
    return Promise.all(filePaths.map((fp) => this.checkFile(fp)));
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
 */
export function createPythonDocChecker(options?: Partial<DocCheckOptions>): PythonDocChecker {
  return new PythonDocChecker(options);
}
