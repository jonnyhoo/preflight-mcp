/**
 * Python Documentation Checker - Parameter Checker
 *
 * Checks parameter documentation consistency.
 *
 * @module analysis/doccheck/python/param-checker
 */

import type { DocIssue, FunctionInfo, DocInfo, DocCheckOptions } from '../types.js';
import { ISSUE_SEVERITY } from '../types.js';
import { areSimilar, typesMatch } from './utils.js';
import { isIssueSuppressed } from './noqa.js';

// ============================================================================
// Parameter Issue Types
// ============================================================================

export type ParamIssueType =
  | 'param_missing'
  | 'param_extra'
  | 'param_name_mismatch'
  | 'param_order_mismatch'
  | 'param_type_mismatch'
  | 'type_in_both'
  | 'type_in_docstring_only'
  | 'default_missing'
  | 'default_mismatch';

// ============================================================================
// Parameter Checks
// ============================================================================

/**
 * Check function parameters against docstring documentation.
 */
export function checkParams(
  func: FunctionInfo,
  doc: DocInfo,
  noqaCodes: string[] | undefined,
  options: Required<DocCheckOptions>
): DocIssue[] {
  const issues: DocIssue[] = [];
  const fullName = func.className ? `${func.className}.${func.name}` : func.name;

  // Helper to add issue with noqa filtering
  const addIssue = (issue: DocIssue) => {
    if (!isIssueSuppressed(issue.type, noqaCodes)) {
      issues.push(issue);
    }
  };

  // Build sets for comparison
  const codeParamNames = new Set(func.params.map((p) => p.name));
  const docParamNames = new Set(doc.params.map((p) => p.name));

  // Check for missing params in docs
  for (const param of func.params) {
    if (!docParamNames.has(param.name)) {
      addIssue({
        type: 'param_missing',
        severity: ISSUE_SEVERITY.param_missing,
        file: func.file,
        line: func.line,
        name: fullName,
        message: `Parameter '${param.name}' is not documented in docstring`,
        expected: param.name,
      });
    }
  }

  // Check for extra params in docs
  for (const docParam of doc.params) {
    if (!codeParamNames.has(docParam.name)) {
      addIssue({
        type: 'param_extra',
        severity: ISSUE_SEVERITY.param_extra,
        file: func.file,
        line: func.line,
        name: fullName,
        message: `Docstring documents parameter '${docParam.name}' which does not exist in function signature`,
        actual: docParam.name,
      });
    }
  }

  // Check for param_name_mismatch (DOC103) - similar names suggest typos
  const missingInDoc = func.params.filter(p => !docParamNames.has(p.name));
  const extraInDoc = doc.params.filter(p => !codeParamNames.has(p.name));

  for (const missing of missingInDoc) {
    for (const extra of extraInDoc) {
      if (areSimilar(missing.name, extra.name)) {
        addIssue({
          type: 'param_name_mismatch',
          severity: ISSUE_SEVERITY.param_name_mismatch,
          file: func.file,
          line: func.line,
          name: fullName,
          message: `Possible typo: parameter '${missing.name}' in code, '${extra.name}' in docstring`,
          expected: missing.name,
          actual: extra.name,
        });
      }
    }
  }

  // Check param order (DOC104) - only when all params match
  if (func.params.length === doc.params.length &&
      func.params.every(p => docParamNames.has(p.name)) &&
      doc.params.every(p => codeParamNames.has(p.name))) {
    for (let i = 0; i < func.params.length; i++) {
      if (func.params[i]!.name !== doc.params[i]!.name) {
        const codeOrder = func.params.map(p => p.name).join(', ');
        const docOrder = doc.params.map(p => p.name).join(', ');
        addIssue({
          type: 'param_order_mismatch',
          severity: ISSUE_SEVERITY.param_order_mismatch,
          file: func.file,
          line: func.line,
          name: fullName,
          message: `Parameter order mismatch: code has (${codeOrder}), docstring has (${docOrder})`,
          expected: codeOrder,
          actual: docOrder,
        });
        break; // Only report once
      }
    }
  }

  // Check param types if enabled (DOC105)
  if (options.checkParamTypes) {
    for (const param of func.params) {
      const docParam = doc.params.find((p) => p.name === param.name);
      if (docParam?.type && param.type) {
        if (!typesMatch(docParam.type, param.type)) {
          addIssue({
            type: 'param_type_mismatch',
            severity: ISSUE_SEVERITY.param_type_mismatch,
            file: func.file,
            line: func.line,
            name: fullName,
            message: `Parameter '${param.name}' type mismatch: docstring says '${docParam.type}', code has '${param.type}'`,
            expected: param.type,
            actual: docParam.type,
          });
        }
      }
    }
  }

  // Check type hint location (DOC106/107)
  // argTypeHintsInSignature=true means types should be in signature, not docstring
  // argTypeHintsInDocstring=false means types should NOT be in docstring
  if (options.argTypeHintsInSignature && !options.argTypeHintsInDocstring) {
    for (const param of func.params) {
      const docParam = doc.params.find((p) => p.name === param.name);
      const hasTypeInSignature = !!param.type;
      const hasTypeInDocstring = !!docParam?.type;

      if (hasTypeInSignature && hasTypeInDocstring) {
        // DOC106: Type appears in both places
        addIssue({
          type: 'type_in_both',
          severity: ISSUE_SEVERITY.type_in_both,
          file: func.file,
          line: func.line,
          name: fullName,
          message: `Parameter '${param.name}' has type in both signature and docstring (prefer signature only)`,
          expected: param.type,
          actual: docParam?.type,
        });
      } else if (!hasTypeInSignature && hasTypeInDocstring) {
        // DOC107: Type only in docstring but should be in signature
        addIssue({
          type: 'type_in_docstring_only',
          severity: ISSUE_SEVERITY.type_in_docstring_only,
          file: func.file,
          line: func.line,
          name: fullName,
          message: `Parameter '${param.name}' has type in docstring but should be in signature`,
          actual: docParam?.type,
        });
      }
    }
  }

  // Check default value documentation (DOC301/302)
  for (const param of func.params) {
    const docParam = doc.params.find((p) => p.name === param.name);
    const hasDefaultInCode = param.optional && param.defaultValue !== undefined;
    const hasDefaultInDoc = docParam?.optional || docParam?.defaultValue !== undefined;

    if (hasDefaultInCode && !hasDefaultInDoc) {
      // DOC301: Parameter has default but not documented as optional
      addIssue({
        type: 'default_missing',
        severity: ISSUE_SEVERITY.default_missing,
        file: func.file,
        line: func.line,
        name: fullName,
        message: `Parameter '${param.name}' has default value '${param.defaultValue}' but not documented as optional`,
        expected: `optional, default=${param.defaultValue}`,
      });
    } else if (hasDefaultInCode && docParam?.defaultValue && param.defaultValue && param.defaultValue !== docParam.defaultValue) {
      // DOC302: Default value mismatch
      // Normalize values for comparison (remove quotes, whitespace)
      const codeDefault = param.defaultValue.replace(/["']/g, '').trim();
      const docDefault = docParam.defaultValue.replace(/["']/g, '').trim();
      if (codeDefault !== docDefault) {
        addIssue({
          type: 'default_mismatch',
          severity: ISSUE_SEVERITY.default_mismatch,
          file: func.file,
          line: func.line,
          name: fullName,
          message: `Parameter '${param.name}' default value mismatch: code has '${param.defaultValue}', docstring has '${docParam.defaultValue}'`,
          expected: param.defaultValue,
          actual: docParam.defaultValue,
        });
      }
    }
  }

  return issues;
}
