/**
 * Java Documentation Checker - Internal Types
 *
 * @module analysis/doccheck/java/types
 */

import type { Node } from 'web-tree-sitter';
import type { FunctionDocInfo, DocInfo } from '../types.js';

// ============================================================================
// Declaration Types
// ============================================================================

/** Java declaration kind */
export type JavaDeclKind =
  | 'class'
  | 'interface'
  | 'enum'
  | 'annotation'
  | 'method'
  | 'constructor';

/** Visibility modifier */
export type JavaVisibility = 'public' | 'protected' | 'package' | 'private';

// ============================================================================
// Function/Method Types
// ============================================================================

/**
 * Extended function doc info with AST node for Java-specific checks.
 */
export interface JavaFunctionDocInfo extends FunctionDocInfo {
  /** AST node for throws detection */
  node: Node;
  /** Declaration kind */
  kind: 'method' | 'constructor';
  /** Throws clause types from signature */
  throwsTypes: string[];
}

/**
 * Java class/interface/enum info for type-level documentation.
 */
export interface JavaTypeInfo {
  /** Type name */
  name: string;
  /** File path */
  file: string;
  /** Line number */
  line: number;
  /** Declaration kind */
  kind: JavaDeclKind;
  /** Whether exported (public/protected) */
  isExported: boolean;
  /** Parent type name (for inner types) */
  parentType?: string;
}

/**
 * Combined type and documentation info for analysis.
 */
export interface JavaTypeDocInfo {
  /** Type information */
  type: JavaTypeInfo;
  /** Documentation information */
  doc: DocInfo;
  /** AST node */
  node: Node;
}

// ============================================================================
// Javadoc Types
// ============================================================================

/**
 * Parsed @throws/@exception tag.
 */
export interface JavaDocThrowsInfo {
  /** Exception type (simple or qualified name) */
  exception: string;
  /** Description */
  description?: string;
}

/**
 * Extended DocInfo with Java-specific fields.
 */
export interface JavaDocInfo extends DocInfo {
  /** @throws tags from Javadoc */
  throws?: JavaDocThrowsInfo[];
  /** Whether @inheritDoc is present */
  hasInheritDoc?: boolean;
}
