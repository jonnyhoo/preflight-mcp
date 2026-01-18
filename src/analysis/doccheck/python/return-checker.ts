/**
 * Python Documentation Checker - Return/Yields Checker
 *
 * Checks return and yields documentation consistency.
 *
 * @module analysis/doccheck/python/return-checker
 */

import type { Node } from 'web-tree-sitter';
import type { DocIssue, FunctionInfo, DocInfo, DocCheckOptions } from '../types.js';
import { ISSUE_SEVERITY } from '../types.js';
import { typesMatch } from './utils.js';
import { isIssueSuppressed } from './noqa.js';

// ============================================================================
// Yield Detection Helpers
// ============================================================================

/**
 * Extract yield type from Generator/Iterator/Iterable annotations.
 * Returns the yield type if present, undefined otherwise.
 */
export function extractYieldTypeFromAnnotation(returnType: string | undefined): string | undefined {
  if (!returnType) return undefined;

  // Generator[YieldType, SendType, ReturnType] -> YieldType
  const generatorMatch = returnType.match(/^Generator\[([^,\]]+)/i);
  if (generatorMatch) {
    return generatorMatch[1]!.trim();
  }

  // Iterator[T] -> T
  const iteratorMatch = returnType.match(/^Iterator\[([^\]]+)\]/i);
  if (iteratorMatch) {
    return iteratorMatch[1]!.trim();
  }

  // Iterable[T] -> T
  const iterableMatch = returnType.match(/^Iterable\[([^\]]+)\]/i);
  if (iterableMatch) {
    return iterableMatch[1]!.trim();
  }

  // AsyncGenerator[YieldType, SendType] -> YieldType
  const asyncGenMatch = returnType.match(/^AsyncGenerator\[([^,\]]+)/i);
  if (asyncGenMatch) {
    return asyncGenMatch[1]!.trim();
  }

  // AsyncIterator[T] -> T
  const asyncIterMatch = returnType.match(/^AsyncIterator\[([^\]]+)\]/i);
  if (asyncIterMatch) {
    return asyncIterMatch[1]!.trim();
  }

  return undefined;
}

/**
 * Check if function body contains yield statements (excluding nested functions).
 */
export function hasYieldStatements(funcNode: Node): boolean {
  const body = funcNode.childForFieldName('body');
  if (!body) return false;

  // Find all yield/yield_from in body, excluding nested functions
  const stack: Node[] = [body];
  while (stack.length > 0) {
    const node = stack.pop()!;

    if (node.type === 'yield' || node.type === 'yield_from') {
      return true;
    }

    // Don't descend into nested functions/lambdas
    if (node.type === 'function_definition' || node.type === 'lambda') {
      continue;
    }

    for (const child of node.namedChildren) {
      stack.push(child);
    }
  }
  return false;
}

// ============================================================================
// Return Checks
// ============================================================================

/**
 * Check return value documentation.
 */
export function checkReturns(
  func: FunctionInfo,
  doc: DocInfo,
  node: Node,
  noqaCodes: string[] | undefined,
  options: Required<DocCheckOptions>
): DocIssue[] {
  const issues: DocIssue[] = [];
  const fullName = func.className ? `${func.className}.${func.name}` : func.name;
  const isInitMethod = func.name === '__init__';

  // Helper to add issue with noqa filtering
  const addIssue = (issue: DocIssue) => {
    if (!isIssueSuppressed(issue.type, noqaCodes)) {
      issues.push(issue);
    }
  };

  // Check return type (skip for __init__)
  const hasReturnType = func.returnType && func.returnType !== 'None';
  const hasReturnDoc = doc.returns !== undefined;

  if (!isInitMethod && hasReturnType && !hasReturnDoc) {
    addIssue({
      type: 'return_missing',
      severity: ISSUE_SEVERITY.return_missing,
      file: func.file,
      line: func.line,
      name: fullName,
      message: `Function returns '${func.returnType}' but docstring has no Returns section`,
      expected: func.returnType,
    });
  }

  // Check for return_extra (has Returns doc but function returns None, or __init__ with Returns)
  if (!hasReturnType && hasReturnDoc && doc.returns?.type && doc.returns.type !== 'None') {
    addIssue({
      type: 'return_extra',
      severity: ISSUE_SEVERITY.return_extra,
      file: func.file,
      line: func.line,
      name: fullName,
      message: isInitMethod
        ? `Constructor __init__ should not have Returns section`
        : `Docstring has Returns section '${doc.returns.type}' but function returns None`,
      actual: doc.returns.type,
    });
  }

  // Check return type match if enabled (DOC203, skip for __init__)
  if (!isInitMethod && options.checkReturnTypes && hasReturnType && hasReturnDoc && doc.returns?.type) {
    if (!typesMatch(doc.returns.type, func.returnType!)) {
      addIssue({
        type: 'return_type_mismatch',
        severity: ISSUE_SEVERITY.return_type_mismatch,
        file: func.file,
        line: func.line,
        name: fullName,
        message: `Return type mismatch: docstring says '${doc.returns.type}', code has '${func.returnType}'`,
        expected: func.returnType,
        actual: doc.returns.type,
      });
    }
  }

  return issues;
}

// ============================================================================
// Yields Checks
// ============================================================================

/**
 * Check yields documentation.
 */
export function checkYields(
  func: FunctionInfo,
  doc: DocInfo,
  node: Node,
  noqaCodes: string[] | undefined
): DocIssue[] {
  const issues: DocIssue[] = [];
  const fullName = func.className ? `${func.className}.${func.name}` : func.name;
  const isInitMethod = func.name === '__init__';

  // Helper to add issue with noqa filtering
  const addIssue = (issue: DocIssue) => {
    if (!isIssueSuppressed(issue.type, noqaCodes)) {
      issues.push(issue);
    }
  };

  // Check yields (Python-specific, skip for __init__)
  const hasYield = hasYieldStatements(node);
  const hasYieldsDoc = doc.yields !== undefined;

  if (!isInitMethod && hasYield && !hasYieldsDoc) {
    addIssue({
      type: 'yield_missing',
      severity: ISSUE_SEVERITY.yield_missing,
      file: func.file,
      line: func.line,
      name: fullName,
      message: `Function has yield statement but docstring has no Yields section`,
    });
  }

  // __init__ should not have Yields section (DOC306/307)
  if (!hasYield && hasYieldsDoc) {
    addIssue({
      type: 'yield_extra',
      severity: ISSUE_SEVERITY.yield_extra,
      file: func.file,
      line: func.line,
      name: fullName,
      message: isInitMethod
        ? `Constructor __init__ should not have Yields section`
        : `Docstring has Yields section but function has no yield statement`,
      actual: doc.yields?.type,
    });
  }

  // Check yield type mismatch (DOC404, skip for __init__)
  if (hasYield && hasYieldsDoc && doc.yields?.type) {
    const annotationYieldType = extractYieldTypeFromAnnotation(func.returnType);
    if (annotationYieldType) {
      if (!typesMatch(doc.yields.type, annotationYieldType)) {
        addIssue({
          type: 'yield_type_mismatch',
          severity: ISSUE_SEVERITY.yield_type_mismatch,
          file: func.file,
          line: func.line,
          name: fullName,
          message: `Yields type mismatch: docstring says '${doc.yields.type}', annotation has '${annotationYieldType}'`,
          expected: annotationYieldType,
          actual: doc.yields.type,
        });
      }
    }
  }

  return issues;
}
