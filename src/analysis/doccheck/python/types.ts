/**
 * Python Documentation Checker - Internal Types
 *
 * @module analysis/doccheck/python/types
 */

import type { Node } from 'web-tree-sitter';
import type { FunctionDocInfo } from '../types.js';

// ============================================================================
// Internal Types
// ============================================================================

/**
 * Extended function doc info with AST node for Python-specific checks.
 */
export interface PyFunctionDocInfo extends FunctionDocInfo {
  /** AST node for yield/raise detection */
  node: Node;
  /** noqa codes to suppress (e.g., ['DOC101', 'DOC102']) */
  noqaCodes?: string[];
}

/**
 * Class attribute information extracted from code.
 */
export interface ClassAttributeInfo {
  /** Attribute name */
  name: string;
  /** Attribute type (from annotation) */
  type?: string;
  /** Whether it's a @property */
  isProperty?: boolean;
}

/**
 * Class information for attribute checking.
 */
export interface ClassInfo {
  /** Class name */
  name: string;
  /** File path */
  file: string;
  /** Line number */
  line: number;
  /** Class attributes from code */
  attributes: ClassAttributeInfo[];
  /** Whether class is public */
  isPublic: boolean;
}

/**
 * Combined class and documentation info for analysis.
 */
export interface ClassDocInfo {
  /** Class information */
  cls: ClassInfo;
  /** Documentation information (with Attributes section) */
  doc: import('../types.js').DocInfo;
  /** noqa codes to suppress (e.g., ['DOC601', 'DOC602']) */
  noqaCodes?: string[];
}
