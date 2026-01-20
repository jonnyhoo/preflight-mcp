/**
 * Java Documentation Checker
 *
 * Uses tree-sitter to extract Java declarations and Javadoc,
 * then compares them to detect inconsistencies.
 *
 * @module analysis/doccheck/java/checker
 */

import * as fs from 'node:fs/promises';
import { createModuleLogger } from '../../../logging/logger.js';
import { parseFileWasm } from '../../../ast/index.js';
import type { AnalysisContext } from '../../cache/index.js';
import type { DocIssue, DocCheckOptions, FileCheckResult } from '../types.js';
import { DEFAULT_DOCCHECK_OPTIONS, ISSUE_SEVERITY } from '../types.js';
import type { JavaFunctionDocInfo, JavaTypeDocInfo, JavaDocInfo } from './types.js';
import { extractMethods, extractTypes } from './extractor.js';

const logger = createModuleLogger('doccheck:java');

// ============================================================================
// Java Checker Class
// ============================================================================

/**
 * Java documentation checker.
 */
export class JavaDocChecker {
  private options: Required<DocCheckOptions>;
  private context?: AnalysisContext;

  constructor(options?: Partial<DocCheckOptions>, context?: AnalysisContext) {
    this.options = { ...DEFAULT_DOCCHECK_OPTIONS, ...options };
    this.context = context;
  }

  /**
   * Check a single file for documentation issues.
   */
  async checkFile(filePath: string, context?: AnalysisContext): Promise<FileCheckResult> {
    const ctx = context ?? this.context;

    if (ctx) {
      return this.checkFileWithContext(filePath, ctx);
    }

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
        return this.emptyResult(filePath);
      }

      const result = await context.ast.withTree(context.fileIndex, filePath, (tree) => {
        const methods = extractMethods(tree.rootNode, filePath, content, this.options);
        const types = extractTypes(tree.rootNode, filePath, content, this.options);

        // Check type-level docs
        for (const typeDoc of types) {
          if (this.options.onlyExported && !typeDoc.type.isExported) continue;

          const typeIssues = this.checkType(typeDoc);
          issues.push(...typeIssues);
        }

        // Check methods/constructors
        for (const methodDoc of methods) {
          if (this.options.onlyExported && !methodDoc.func.isExported) continue;

          functionsChecked++;
          if (methodDoc.doc.exists) {
            functionsDocumented++;
          }

          const methodIssues = this.checkMethod(methodDoc);
          issues.push(...methodIssues);
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
      language: 'java',
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
        return this.emptyResult(filePath);
      }

      try {
        const methods = extractMethods(tree.rootNode, filePath, content, this.options);
        const types = extractTypes(tree.rootNode, filePath, content, this.options);

        // Check type-level docs
        for (const typeDoc of types) {
          if (this.options.onlyExported && !typeDoc.type.isExported) continue;

          const typeIssues = this.checkType(typeDoc);
          issues.push(...typeIssues);
        }

        // Check methods/constructors
        for (const methodDoc of methods) {
          if (this.options.onlyExported && !methodDoc.func.isExported) continue;

          functionsChecked++;
          if (methodDoc.doc.exists) {
            functionsDocumented++;
          }

          const methodIssues = this.checkMethod(methodDoc);
          issues.push(...methodIssues);
        }
      } finally {
        tree.delete();
      }
    } catch (err) {
      logger.warn(`Failed to check file ${filePath}`, { error: String(err) });
    }

    return {
      file: filePath,
      language: 'java',
      issues,
      functionsChecked,
      functionsDocumented,
    };
  }

  /**
   * Check multiple files.
   */
  async checkFiles(filePaths: string[], context?: AnalysisContext): Promise<FileCheckResult[]> {
    const ctx = context ?? this.context;
    return Promise.all(filePaths.map((fp) => this.checkFile(fp, ctx)));
  }

  // ============================================================================
  // Type-Level Checking
  // ============================================================================

  /**
   * Check type-level documentation (class, interface, enum, annotation).
   */
  private checkType(typeDoc: JavaTypeDocInfo): DocIssue[] {
    const issues: DocIssue[] = [];
    const { type, doc } = typeDoc;

    if (!doc.exists && this.options.requireDocs) {
      issues.push({
        type: 'missing_doc',
        severity: ISSUE_SEVERITY.missing_doc,
        file: type.file,
        line: type.line,
        name: type.name,
        message: `${capitalize(type.kind)} '${type.name}' has no Javadoc documentation`,
      });
    }

    return issues;
  }

  // ============================================================================
  // Method-Level Checking
  // ============================================================================

  /**
   * Check method/constructor documentation.
   */
  private checkMethod(methodDoc: JavaFunctionDocInfo): DocIssue[] {
    const issues: DocIssue[] = [];
    const { func, doc, kind, throwsTypes } = methodDoc;
    const fullName = func.className ? `${func.className}.${func.name}` : func.name;
    const javaDoc = doc as JavaDocInfo;

    // Check if documentation is missing
    if (!doc.exists) {
      if (this.options.requireDocs) {
        issues.push({
          type: 'missing_doc',
          severity: ISSUE_SEVERITY.missing_doc,
          file: func.file,
          line: func.line,
          name: fullName,
          message: `${capitalize(kind)} '${fullName}' has no Javadoc documentation`,
        });
      }
      return issues;
    }

    // Note: @inheritDoc means doc.exists=true, but we still check (don't skip)
    // This is the default behavior as per spec

    // Check parameters
    issues.push(...this.checkParams(methodDoc, fullName));

    // Check return (only for methods, not constructors)
    if (kind === 'method') {
      issues.push(...this.checkReturn(methodDoc, fullName));
    }

    // Check throws
    issues.push(...this.checkThrows(methodDoc, fullName, throwsTypes, javaDoc));

    return issues;
  }

  /**
   * Check parameter documentation.
   */
  private checkParams(methodDoc: JavaFunctionDocInfo, fullName: string): DocIssue[] {
    const issues: DocIssue[] = [];
    const { func, doc } = methodDoc;

    const codeParamNames = new Set(func.params.map((p) => p.name));
    const docParamNames = new Set(doc.params.map((p) => p.name));

    // Check for missing @param (param in code but not in doc)
    for (const param of func.params) {
      if (!docParamNames.has(param.name)) {
        issues.push({
          type: 'param_missing',
          severity: ISSUE_SEVERITY.param_missing,
          file: func.file,
          line: func.line,
          name: fullName,
          message: `Parameter '${param.name}' is not documented in Javadoc`,
          expected: param.name,
        });
      }
    }

    // Check for extra @param (param in doc but not in code)
    for (const docParam of doc.params) {
      if (!codeParamNames.has(docParam.name)) {
        issues.push({
          type: 'param_extra',
          severity: ISSUE_SEVERITY.param_extra,
          file: func.file,
          line: func.line,
          name: fullName,
          message: `Javadoc documents parameter '${docParam.name}' which does not exist`,
          actual: docParam.name,
        });
      }
    }

    // Check param name mismatches (typos)
    const missingInDoc = func.params.filter((p) => !docParamNames.has(p.name));
    const extraInDoc = doc.params.filter((p) => !codeParamNames.has(p.name));

    for (const missing of missingInDoc) {
      for (const extra of extraInDoc) {
        if (this.areSimilar(missing.name, extra.name)) {
          issues.push({
            type: 'param_name_mismatch',
            severity: ISSUE_SEVERITY.param_name_mismatch,
            file: func.file,
            line: func.line,
            name: fullName,
            message: `Possible typo: parameter '${missing.name}' in code, '${extra.name}' in Javadoc`,
            expected: missing.name,
            actual: extra.name,
          });
        }
      }
    }

    // Check param order
    if (
      func.params.length === doc.params.length &&
      func.params.every((p) => docParamNames.has(p.name)) &&
      doc.params.every((p) => codeParamNames.has(p.name))
    ) {
      for (let i = 0; i < func.params.length; i++) {
        if (func.params[i]!.name !== doc.params[i]!.name) {
          const codeOrder = func.params.map((p) => p.name).join(', ');
          const docOrder = doc.params.map((p) => p.name).join(', ');
          issues.push({
            type: 'param_order_mismatch',
            severity: ISSUE_SEVERITY.param_order_mismatch,
            file: func.file,
            line: func.line,
            name: fullName,
            message: `Parameter order mismatch: code has (${codeOrder}), Javadoc has (${docOrder})`,
            expected: codeOrder,
            actual: docOrder,
          });
          break;
        }
      }
    }

    return issues;
  }

  /**
   * Check return documentation.
   */
  private checkReturn(methodDoc: JavaFunctionDocInfo, fullName: string): DocIssue[] {
    const issues: DocIssue[] = [];
    const { func, doc } = methodDoc;

    const hasReturnType = func.returnType && func.returnType !== 'void';
    const hasReturnDoc = doc.returns !== undefined;

    if (hasReturnType && !hasReturnDoc) {
      issues.push({
        type: 'return_missing',
        severity: ISSUE_SEVERITY.return_missing,
        file: func.file,
        line: func.line,
        name: fullName,
        message: `Method returns '${func.returnType}' but Javadoc has no @return`,
        expected: func.returnType,
      });
    }

    if (!hasReturnType && hasReturnDoc) {
      issues.push({
        type: 'return_extra',
        severity: ISSUE_SEVERITY.return_extra,
        file: func.file,
        line: func.line,
        name: fullName,
        message: `Javadoc has @return but method returns void`,
      });
    }

    return issues;
  }

  /**
   * Check throws documentation.
   */
  private checkThrows(
    methodDoc: JavaFunctionDocInfo,
    fullName: string,
    throwsTypes: string[],
    doc: JavaDocInfo
  ): DocIssue[] {
    const issues: DocIssue[] = [];
    const { func } = methodDoc;

    const codeThrowsSet = new Set(throwsTypes.map(normalizeTypeName));
    const docThrows = doc.throws ?? [];
    const docThrowsSet = new Set(docThrows.map((t) => normalizeTypeName(t.exception)));

    // Check for missing @throws (in code but not in doc)
    for (const codeThrow of throwsTypes) {
      const normalized = normalizeTypeName(codeThrow);
      if (!docThrowsSet.has(normalized)) {
        issues.push({
          type: 'raises_missing',
          severity: ISSUE_SEVERITY.raises_missing,
          file: func.file,
          line: func.line,
          name: fullName,
          message: `Throws '${codeThrow}' but not documented in @throws`,
          expected: codeThrow,
        });
      }
    }

    // Check for extra @throws (in doc but not in code)
    for (const docThrow of docThrows) {
      const normalized = normalizeTypeName(docThrow.exception);
      if (!codeThrowsSet.has(normalized)) {
        issues.push({
          type: 'raises_extra',
          severity: ISSUE_SEVERITY.raises_extra,
          file: func.file,
          line: func.line,
          name: fullName,
          message: `Javadoc documents @throws '${docThrow.exception}' but not in throws clause`,
          actual: docThrow.exception,
        });
      }
    }

    return issues;
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private emptyResult(filePath: string): FileCheckResult {
    return {
      file: filePath,
      language: 'java',
      issues: [],
      functionsChecked: 0,
      functionsDocumented: 0,
    };
  }

  /**
   * Check if two strings are similar enough to suggest a name mismatch.
   */
  private areSimilar(a: string, b: string): boolean {
    if (a === b) return false;
    if (a.toLowerCase() === b.toLowerCase()) return true;

    const distance = this.levenshteinDistance(a.toLowerCase(), b.toLowerCase());
    const maxLen = Math.max(a.length, b.length);

    // More lenient for short names (e.g., typos like valeu/value)
    return distance <= 2 && distance / maxLen <= 0.4;
  }

  /**
   * Calculate Levenshtein edit distance between two strings.
   */
  private levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array(m + 1)
      .fill(null)
      .map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i]![0] = i;
    for (let j = 0; j <= n; j++) dp[0]![j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i]![j] = dp[i - 1]![j - 1]!;
        } else {
          dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + 1);
        }
      }
    }

    return dp[m]![n]!;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new Java documentation checker.
 */
export function createJavaDocChecker(
  options?: Partial<DocCheckOptions>,
  context?: AnalysisContext
): JavaDocChecker {
  return new JavaDocChecker(options, context);
}

// ============================================================================
// Utilities
// ============================================================================

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Normalize type name for comparison (handle qualified names).
 */
function normalizeTypeName(name: string): string {
  // Get simple name from qualified name (e.g., java.io.IOException -> IOException)
  const parts = name.split('.');
  return parts[parts.length - 1]!;
}
