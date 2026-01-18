/**
 * Python Documentation Checker - noqa Support
 *
 * @module analysis/doccheck/python/noqa
 */

import type { Node } from 'web-tree-sitter';
import type { DocIssue } from '../types.js';
import { ISSUE_TO_DOC_CODE } from '../types.js';

// ============================================================================
// noqa Support
// ============================================================================

/**
 * Extract noqa codes from comments near a function/class definition.
 * Supports formats:
 *   # noqa           - suppress all checks
 *   # noqa: DOC101   - suppress specific code
 *   # noqa: DOC101, DOC102 - suppress multiple codes
 *   # noqa: DOC1     - suppress DOC1xx series
 */
export function extractNoqaCodes(node: Node, lines: string[]): string[] | undefined {
  const lineNum = node.startPosition.row;  // 0-indexed

  // Check current line and previous line for noqa comments
  const linesToCheck: string[] = [];
  if (lineNum > 0 && lines[lineNum - 1]) {
    linesToCheck.push(lines[lineNum - 1]!);
  }
  if (lines[lineNum]) {
    linesToCheck.push(lines[lineNum]!);
  }

  for (const line of linesToCheck) {
    // Match # noqa or # noqa: CODE1, CODE2
    const noqaMatch = line.match(/#\s*noqa(?:\s*:\s*([\w,\s]+))?/i);
    if (noqaMatch) {
      if (!noqaMatch[1]) {
        // # noqa without codes = suppress all
        return ['*'];
      }
      // Parse comma-separated codes
      const codes = noqaMatch[1].split(',').map(c => c.trim().toUpperCase()).filter(c => c);
      if (codes.length > 0) {
        return codes;
      }
    }
  }

  return undefined;
}

/**
 * Check if an issue should be suppressed by noqa codes.
 */
export function isIssueSuppressed(issueType: DocIssue['type'], noqaCodes?: string[]): boolean {
  if (!noqaCodes || noqaCodes.length === 0) {
    return false;
  }

  // '*' means suppress all
  if (noqaCodes.includes('*')) {
    return true;
  }

  const docCode = ISSUE_TO_DOC_CODE[issueType];
  if (!docCode) {
    return false;
  }

  for (const noqaCode of noqaCodes) {
    // Exact match: DOC101 === DOC101
    if (noqaCode === docCode) {
      return true;
    }
    // Prefix match: DOC1 matches DOC101, DOC102, etc.
    if (docCode.startsWith(noqaCode)) {
      return true;
    }
  }

  return false;
}
