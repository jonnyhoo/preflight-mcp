/**
 * Python Documentation Checker - Raises Checker
 *
 * Checks raises/exception documentation consistency.
 *
 * @module analysis/doccheck/python/raises-checker
 */

import type { Node } from 'web-tree-sitter';
import type { DocIssue, FunctionInfo, DocInfo } from '../types.js';
import { ISSUE_SEVERITY } from '../types.js';
import { normalizeExceptionName } from './utils.js';
import { isIssueSuppressed } from './noqa.js';

// ============================================================================
// Exception Detection Helpers
// ============================================================================

/**
 * Check if function body contains raise statements (excluding nested functions).
 * Returns list of raised exception class names.
 * Also detects assert statements (which implicitly raise AssertionError).
 */
export function getRaisedExceptions(funcNode: Node): string[] {
  const body = funcNode.childForFieldName('body');
  if (!body) return [];

  const exceptions: Set<string> = new Set();
  const stack: Node[] = [body];

  while (stack.length > 0) {
    const node = stack.pop()!;

    if (node.type === 'raise_statement') {
      // Extract exception class name
      const exprNode = node.namedChild(0);
      if (exprNode) {
        const exName = extractExceptionName(exprNode);
        if (exName) {
          exceptions.add(exName);
        }
      }
      // Note: bare "raise" in except block is re-raise, we skip it
    }

    // DOC504: assert statements implicitly raise AssertionError
    if (node.type === 'assert_statement') {
      exceptions.add('AssertionError');
    }

    // Don't descend into nested functions/lambdas
    if (node.type === 'function_definition' || node.type === 'lambda') {
      continue;
    }

    for (const child of node.namedChildren) {
      stack.push(child);
    }
  }

  return Array.from(exceptions);
}

/**
 * Extract exception class name from raise expression.
 */
export function extractExceptionName(exprNode: Node): string | null {
  // raise Exception(...) -> call expression
  if (exprNode.type === 'call') {
    const funcNode = exprNode.childForFieldName('function');
    if (funcNode) {
      return extractExceptionName(funcNode);
    }
  }

  // raise Exception -> identifier
  if (exprNode.type === 'identifier') {
    return exprNode.text;
  }

  // raise module.Exception -> attribute
  if (exprNode.type === 'attribute') {
    const attrNode = exprNode.childForFieldName('attribute');
    return attrNode?.text || null;
  }

  return null;
}

// ============================================================================
// Raises Checks
// ============================================================================

/**
 * Check raises documentation.
 */
export function checkRaises(
  func: FunctionInfo,
  doc: DocInfo,
  node: Node,
  noqaCodes: string[] | undefined
): DocIssue[] {
  const issues: DocIssue[] = [];
  const fullName = func.className ? `${func.className}.${func.name}` : func.name;

  // Helper to add issue with noqa filtering
  const addIssue = (issue: DocIssue) => {
    if (!isIssueSuppressed(issue.type, noqaCodes)) {
      issues.push(issue);
    }
  };

  // Check raises (Python-specific)
  const raisedExceptions = getRaisedExceptions(node);
  const hasRaise = raisedExceptions.length > 0;
  const hasRaisesDoc = doc.raises !== undefined && doc.raises.length > 0;

  if (hasRaise && !hasRaisesDoc) {
    addIssue({
      type: 'raises_missing',
      severity: ISSUE_SEVERITY.raises_missing,
      file: func.file,
      line: func.line,
      name: fullName,
      message: `Function raises ${raisedExceptions.join(', ')} but docstring has no Raises section`,
      expected: raisedExceptions.join(', '),
    });
  }

  if (!hasRaise && hasRaisesDoc) {
    const docExceptions = doc.raises!.map(r => r.exception).join(', ');
    addIssue({
      type: 'raises_extra',
      severity: ISSUE_SEVERITY.raises_extra,
      file: func.file,
      line: func.line,
      name: fullName,
      message: `Docstring documents Raises section (${docExceptions}) but function has no raise statement`,
      actual: docExceptions,
    });
  }

  // Check raises type mismatch (DOC503) - compare code exceptions vs documented
  if (hasRaise && hasRaisesDoc) {
    const docExceptionSet = new Set(doc.raises!.map(r => normalizeExceptionName(r.exception)));
    const codeExceptionSet = new Set(raisedExceptions.map(e => normalizeExceptionName(e)));

    // Exceptions in code but not in docs
    for (const ex of raisedExceptions) {
      const normalizedEx = normalizeExceptionName(ex);
      if (!docExceptionSet.has(normalizedEx)) {
        addIssue({
          type: 'raises_type_mismatch',
          severity: ISSUE_SEVERITY.raises_type_mismatch,
          file: func.file,
          line: func.line,
          name: fullName,
          message: `Function raises '${ex}' but it's not documented in Raises section`,
          expected: ex,
        });
      }
    }

    // Exceptions in docs but not in code
    for (const docEx of doc.raises!) {
      const normalizedDocEx = normalizeExceptionName(docEx.exception);
      if (!codeExceptionSet.has(normalizedDocEx)) {
        addIssue({
          type: 'raises_type_mismatch',
          severity: ISSUE_SEVERITY.raises_type_mismatch,
          file: func.file,
          line: func.line,
          name: fullName,
          message: `Docstring documents '${docEx.exception}' but function doesn't raise it`,
          actual: docEx.exception,
        });
      }
    }
  }

  return issues;
}
