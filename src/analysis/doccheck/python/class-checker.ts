/**
 * Python Documentation Checker - Class Checker
 *
 * Checks class attribute documentation consistency.
 *
 * @module analysis/doccheck/python/class-checker
 */

import type { DocIssue, DocCheckOptions } from '../types.js';
import { ISSUE_SEVERITY } from '../types.js';
import type { ClassDocInfo } from './types.js';
import { typesMatch } from './utils.js';
import { isIssueSuppressed } from './noqa.js';

// ============================================================================
// Class Attribute Checks
// ============================================================================

/**
 * Check a class for attribute documentation issues.
 */
export function checkClass(
  classDoc: ClassDocInfo,
  options: Required<DocCheckOptions>
): DocIssue[] {
  const issues: DocIssue[] = [];
  const { cls, doc, noqaCodes } = classDoc;

  // Helper to add issue with noqa filtering
  const addIssue = (issue: DocIssue) => {
    if (!isIssueSuppressed(issue.type, noqaCodes)) {
      issues.push(issue);
    }
  };

  // If no docstring, we can't check attributes
  if (!doc.exists) {
    return issues;
  }

  // If no attributes documented and no code attributes, nothing to check
  const docAttrs = doc.attributes || [];
  const codeAttrs = cls.attributes;

  if (docAttrs.length === 0 && codeAttrs.length === 0) {
    return issues;
  }

  // Build sets for comparison
  const codeAttrNames = new Set(codeAttrs.map(a => a.name));
  const docAttrNames = new Set(docAttrs.map(a => a.name));

  // Check for missing attributes in docs (DOC601)
  for (const attr of codeAttrs) {
    if (!docAttrNames.has(attr.name)) {
      addIssue({
        type: 'attr_missing',
        severity: ISSUE_SEVERITY.attr_missing,
        file: cls.file,
        line: cls.line,
        name: cls.name,
        message: `Class attribute '${attr.name}' is not documented in Attributes section`,
        expected: attr.name,
      });
    }
  }

  // Check for extra attributes in docs (DOC602)
  for (const docAttr of docAttrs) {
    if (!codeAttrNames.has(docAttr.name)) {
      addIssue({
        type: 'attr_extra',
        severity: ISSUE_SEVERITY.attr_extra,
        file: cls.file,
        line: cls.line,
        name: cls.name,
        message: `Docstring documents attribute '${docAttr.name}' which does not exist in class`,
        actual: docAttr.name,
      });
    }
  }

  // Check for attribute type mismatch (DOC603)
  if (options.checkParamTypes) {
    for (const attr of codeAttrs) {
      const docAttr = docAttrs.find(a => a.name === attr.name);
      if (docAttr?.type && attr.type) {
        if (!typesMatch(docAttr.type, attr.type)) {
          addIssue({
            type: 'attr_type_mismatch',
            severity: ISSUE_SEVERITY.attr_type_mismatch,
            file: cls.file,
            line: cls.line,
            name: cls.name,
            message: `Attribute '${attr.name}' type mismatch: docstring says '${docAttr.type}', code has '${attr.type}'`,
            expected: attr.type,
            actual: docAttr.type,
          });
        }
      }
    }
  }

  return issues;
}
