/**
 * Tree-sitter AST Module - Utility Functions
 *
 * @module ast/utils
 */

import type { Node } from 'web-tree-sitter';

/**
 * Convert tree-sitter node position to our range format.
 */
export function rangeFromNode(n: Node): {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
} {
  return {
    startLine: n.startPosition.row + 1,
    startCol: n.startPosition.column + 1,
    endLine: n.endPosition.row + 1,
    endCol: n.endPosition.column + 1,
  };
}

/**
 * Get the first string_fragment descendant.
 */
export function firstStringFragment(node: Node): Node | null {
  const frags = node.descendantsOfType('string_fragment');
  return frags[0] ?? null;
}

/**
 * Get the first descendant matching any of the given types.
 */
export function firstOfTypes(node: Node, types: string[]): Node | null {
  for (const t of types) {
    const found = node.descendantsOfType(t);
    if (found[0]) return found[0];
  }
  return null;
}

/**
 * Unquote a Python/JS string literal.
 */
export function unquoteStringLiteral(raw: string): string | null {
  let t = raw.trim();
  t = t.replace(/^[rRuUbBfF]+/, '');

  const q = t[0];
  if (q !== '"' && q !== "'") return null;
  if (t.length < 2 || t[t.length - 1] !== q) return null;

  return t.slice(1, -1);
}
