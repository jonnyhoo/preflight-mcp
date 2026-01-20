/**
 * Java Documentation Checker - AST Extractor
 *
 * Extracts declarations and binds Javadoc comments from Java AST.
 *
 * @module analysis/doccheck/java/extractor
 */

import type { Node } from 'web-tree-sitter';
import type { FunctionInfo, ParamInfo, DocCheckOptions } from '../types.js';
import type {
  JavaFunctionDocInfo,
  JavaTypeDocInfo,
  JavaTypeInfo,
  JavaDocInfo,
  JavaDeclKind,
  JavaVisibility,
} from './types.js';
import { parseJavadoc } from './javadoc-parser.js';

// ============================================================================
// Type Declarations
// ============================================================================

const TYPE_DECL_KINDS: Record<string, JavaDeclKind> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  annotation_type_declaration: 'annotation',
};

/**
 * Extract all type-level declarations (class, interface, enum, annotation).
 */
export function extractTypes(
  root: Node,
  filePath: string,
  content: string,
  options: Required<DocCheckOptions>
): JavaTypeDocInfo[] {
  const result: JavaTypeDocInfo[] = [];
  const lines = content.split('\n');

  for (const [nodeType, kind] of Object.entries(TYPE_DECL_KINDS)) {
    for (const node of root.descendantsOfType(nodeType)) {
      const typeInfo = extractTypeInfo(node, filePath, kind);
      if (!typeInfo) continue;

      const doc = findJavadoc(node, lines);
      result.push({ type: typeInfo, doc, node });
    }
  }

  return result;
}

/**
 * Extract type info from a type declaration node.
 */
function extractTypeInfo(node: Node, filePath: string, kind: JavaDeclKind): JavaTypeInfo | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;

  const visibility = getVisibility(node, kind);
  const isExported = visibility === 'public' || visibility === 'protected';

  // Check for parent type (inner class)
  let parentType: string | undefined;
  let parent = node.parent;
  while (parent) {
    if (parent.type in TYPE_DECL_KINDS) {
      const parentName = parent.childForFieldName('name');
      if (parentName) {
        parentType = parentName.text;
        break;
      }
    }
    parent = parent.parent;
  }

  return {
    name: nameNode.text,
    file: filePath,
    line: node.startPosition.row + 1,
    kind,
    isExported,
    parentType,
  };
}

// ============================================================================
// Method/Constructor Extraction
// ============================================================================

/**
 * Extract all methods and constructors from the AST.
 */
export function extractMethods(
  root: Node,
  filePath: string,
  content: string,
  options: Required<DocCheckOptions>
): JavaFunctionDocInfo[] {
  const result: JavaFunctionDocInfo[] = [];
  const lines = content.split('\n');

  // Find all methods
  for (const node of root.descendantsOfType('method_declaration')) {
    const funcInfo = extractMethodInfo(node, filePath);
    if (!funcInfo) continue;

    const doc = findJavadoc(node, lines);
    const throwsTypes = extractThrowsClause(node);

    result.push({
      func: funcInfo,
      doc,
      node,
      kind: 'method',
      throwsTypes,
    });
  }

  // Find all constructors
  for (const node of root.descendantsOfType('constructor_declaration')) {
    const funcInfo = extractConstructorInfo(node, filePath);
    if (!funcInfo) continue;

    const doc = findJavadoc(node, lines);
    const throwsTypes = extractThrowsClause(node);

    result.push({
      func: funcInfo,
      doc,
      node,
      kind: 'constructor',
      throwsTypes,
    });
  }

  return result;
}

/**
 * Extract function info from a method declaration.
 */
function extractMethodInfo(node: Node, filePath: string): FunctionInfo | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;

  const params = extractParams(node);
  const returnType = extractReturnType(node);
  const { visibility, isExported, className } = getMethodContext(node);

  return {
    name: nameNode.text,
    file: filePath,
    line: node.startPosition.row + 1,
    params,
    returnType,
    isExported,
    className,
  };
}

/**
 * Extract function info from a constructor declaration.
 */
function extractConstructorInfo(node: Node, filePath: string): FunctionInfo | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;

  const params = extractParams(node);
  const { visibility, isExported, className } = getMethodContext(node);

  return {
    name: nameNode.text,
    file: filePath,
    line: node.startPosition.row + 1,
    params,
    returnType: undefined, // Constructors have no return type
    isExported,
    className,
  };
}

/**
 * Extract parameters from method/constructor node.
 */
function extractParams(node: Node): ParamInfo[] {
  const params: ParamInfo[] = [];
  const paramsNode = node.childForFieldName('parameters');
  if (!paramsNode) return params;

  for (const child of paramsNode.namedChildren) {
    if (child.type === 'formal_parameter' || child.type === 'spread_parameter') {
      const nameNode = child.childForFieldName('name');
      const typeNode = child.childForFieldName('type');

      if (nameNode) {
        params.push({
          name: nameNode.text,
          type: typeNode?.text,
        });
      }
    }
  }

  return params;
}

/**
 * Extract return type from method node.
 */
function extractReturnType(node: Node): string | undefined {
  const typeNode = node.childForFieldName('type');
  return typeNode?.text;
}

/**
 * Extract throws clause types from method/constructor node.
 */
function extractThrowsClause(node: Node): string[] {
  const types: string[] = [];

  // Look for throws clause in children
  for (const child of node.namedChildren) {
    if (child.type === 'throws') {
      // Throws clause contains type_identifier or generic_type nodes
      for (const typeChild of child.namedChildren) {
        if (typeChild.type === 'type_identifier' || typeChild.type === 'generic_type') {
          types.push(typeChild.text);
        }
      }
    }
  }

  return types;
}

/**
 * Get method context: visibility, exported status, and containing class.
 */
function getMethodContext(node: Node): {
  visibility: JavaVisibility;
  isExported: boolean;
  className?: string;
} {
  // Find containing type
  let className: string | undefined;
  let containingType: Node | null = null;
  let parent = node.parent;

  while (parent) {
    if (parent.type === 'class_body' || parent.type === 'interface_body' ||
        parent.type === 'enum_body' || parent.type === 'annotation_type_body') {
      const typeDecl = parent.parent;
      if (typeDecl) {
        const nameNode = typeDecl.childForFieldName('name');
        if (nameNode) {
          className = nameNode.text;
          containingType = typeDecl;
        }
      }
      break;
    }
    parent = parent.parent;
  }

  // Check if containing type is exported
  const containingTypeVisibility = containingType
    ? getVisibility(containingType, 'class')
    : 'package';
  const isContainingTypeExported =
    containingTypeVisibility === 'public' || containingTypeVisibility === 'protected';

  // Determine visibility
  const containingKind = containingType?.type;
  const isInterfaceOrAnnotation =
    containingKind === 'interface_declaration' ||
    containingKind === 'annotation_type_declaration';

  // Interface/annotation members are implicitly public, but only exported if containing type is
  if (isInterfaceOrAnnotation) {
    return {
      visibility: 'public',
      isExported: isContainingTypeExported,
      className,
    };
  }

  const visibility = getVisibility(node, 'method');
  const memberExported = visibility === 'public' || visibility === 'protected';

  // Member is only exported if both the containing type and the member are exported
  return { visibility, isExported: isContainingTypeExported && memberExported, className };
}

// ============================================================================
// Visibility Helpers
// ============================================================================

/**
 * Get visibility from a node's modifiers.
 *
 * Note: This is for type declarations. Interface/annotation MEMBERS
 * are handled separately in getMethodContext() where they are implicitly public.
 */
function getVisibility(node: Node, kind: JavaDeclKind | 'method'): JavaVisibility {
  const modifiersNode =
    node.childForFieldName('modifiers') ??
    node.namedChildren.find((n) => n.type === 'modifiers');

  if (!modifiersNode) {
    // No modifier = package-private for all type declarations and methods
    return 'package';
  }

  const text = modifiersNode.text;
  if (text.includes('public')) return 'public';
  if (text.includes('protected')) return 'protected';
  if (text.includes('private')) return 'private';

  return 'package';
}

// ============================================================================
// Javadoc Binding
// ============================================================================

/**
 * Find and parse Javadoc immediately preceding a declaration.
 *
 * Rules:
 * - Only the last Javadoc block before the declaration is bound
 * - If any non-annotation/modifier content appears between Javadoc and
 *   declaration, the binding is broken
 */
function findJavadoc(declNode: Node, lines: string[]): JavaDocInfo {
  const noDoc: JavaDocInfo = { exists: false, params: [] };

  // Walk backwards through siblings to find preceding Javadoc
  let current: Node | null = declNode.previousNamedSibling;
  let lastJavadoc: Node | null = null;

  while (current) {
    const type = current.type;

    // Skip annotations and modifiers
    if (type === 'annotation' || type === 'modifiers' || type === 'marker_annotation') {
      current = current.previousNamedSibling;
      continue;
    }

    // Found a Javadoc comment
    if (type === 'block_comment') {
      const text = current.text;
      if (text.startsWith('/**')) {
        lastJavadoc = current;
        break;
      }
    }

    // Any other content breaks the binding
    break;
  }

  // Also check for Javadoc in leading comments via source position
  if (!lastJavadoc) {
    lastJavadoc = findJavadocByPosition(declNode, lines);
  }

  if (!lastJavadoc) return noDoc;

  return parseJavadoc(lastJavadoc.text);
}

/**
 * Find Javadoc by examining source lines before the declaration.
 *
 * This handles cases where tree-sitter doesn't expose the comment as a sibling.
 */
function findJavadocByPosition(declNode: Node, lines: string[]): Node | null {
  const declLine = declNode.startPosition.row;

  // Walk backwards from declaration line
  let javadocEndLine = -1;
  let javadocStartLine = -1;

  for (let i = declLine - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? '';

    // Skip empty lines and annotations
    if (!line || line.startsWith('@') || line.startsWith('//')) {
      continue;
    }

    // Check for Javadoc end
    if (line.endsWith('*/')) {
      javadocEndLine = i;
      continue;
    }

    // If we found end, look for start
    if (javadocEndLine !== -1) {
      if (line.startsWith('/**')) {
        javadocStartLine = i;
        break;
      }
      // Continuation of Javadoc
      if (line.startsWith('*')) {
        continue;
      }
      // Non-Javadoc content - break binding
      javadocEndLine = -1;
      break;
    }

    // Non-whitespace, non-annotation content before finding Javadoc - stop
    break;
  }

  if (javadocStartLine === -1 || javadocEndLine === -1) {
    return null;
  }

  // We found a Javadoc range, but we need to return the Node
  // Since we don't have the node, return null and rely on the text-based approach
  // Actually, let's search in the tree for a block_comment at this position
  return findCommentNodeAtLine(declNode.tree.rootNode, javadocStartLine);
}

/**
 * Find a block_comment node at the given line.
 */
function findCommentNodeAtLine(root: Node, line: number): Node | null {
  for (const comment of root.descendantsOfType('block_comment')) {
    if (comment.startPosition.row === line && comment.text.startsWith('/**')) {
      return comment;
    }
  }
  return null;
}
