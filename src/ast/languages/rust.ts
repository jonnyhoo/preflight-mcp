/**
 * Tree-sitter AST - Rust Extractors
 *
 * @module ast/languages/rust
 */

import type { Node } from 'web-tree-sitter';
import type { ImportRef, SymbolOutline, ExtensionPoint } from '../types.js';
import { rangeFromNode } from '../utils.js';

// ============================================================================
// Import Extraction
// ============================================================================

export function extractImportsRust(root: Node): ImportRef[] {
  const out: ImportRef[] = [];

  for (const useDecl of root.descendantsOfType('use_declaration')) {
    const argument = useDecl.namedChild(0);
    if (!argument) continue;

    if (argument.type === 'scoped_identifier' || argument.type === 'identifier') {
      out.push({
        language: 'rust',
        kind: 'use',
        module: argument.text,
        range: rangeFromNode(argument),
      });
    }

    if (argument.type === 'use_wildcard' || argument.type === 'use_list') {
      const path = argument.childForFieldName('path') ?? argument.namedChild(0);
      if (path) {
        out.push({
          language: 'rust',
          kind: 'use',
          module: path.text,
          range: rangeFromNode(path),
        });
      }
    }

    if (argument.type === 'scoped_use_list') {
      const path = argument.childForFieldName('path');
      if (path) {
        out.push({
          language: 'rust',
          kind: 'use',
          module: path.text,
          range: rangeFromNode(path),
        });
      }
    }
  }

  for (const externCrate of root.descendantsOfType('extern_crate_declaration')) {
    const name = externCrate.childForFieldName('name');
    if (name) {
      out.push({
        language: 'rust',
        kind: 'externCrate',
        module: name.text,
        range: rangeFromNode(name),
      });
    }
  }

  return out;
}

// ============================================================================
// Export Extraction
// ============================================================================

export function extractExportsRust(root: Node): string[] {
  const out = new Set<string>();

  const isPublic = (node: Node): boolean => {
    for (const child of node.namedChildren) {
      if (child.type === 'visibility_modifier') {
        return child.text.startsWith('pub');
      }
    }
    return false;
  };

  for (const fn of root.descendantsOfType('function_item')) {
    if (!isPublic(fn)) continue;
    const name = fn.childForFieldName('name');
    if (name) out.add(name.text);
  }

  for (const st of root.descendantsOfType('struct_item')) {
    if (!isPublic(st)) continue;
    const name = st.childForFieldName('name');
    if (name) out.add(name.text);
  }

  for (const en of root.descendantsOfType('enum_item')) {
    if (!isPublic(en)) continue;
    const name = en.childForFieldName('name');
    if (name) out.add(name.text);
  }

  for (const tr of root.descendantsOfType('trait_item')) {
    if (!isPublic(tr)) continue;
    const name = tr.childForFieldName('name');
    if (name) out.add(name.text);
  }

  for (const ta of root.descendantsOfType('type_item')) {
    if (!isPublic(ta)) continue;
    const name = ta.childForFieldName('name');
    if (name) out.add(name.text);
  }

  for (const md of root.descendantsOfType('mod_item')) {
    if (!isPublic(md)) continue;
    const name = md.childForFieldName('name');
    if (name) out.add(name.text);
  }

  return Array.from(out);
}

// ============================================================================
// Outline Extraction
// ============================================================================

function extractFunctionSignatureRust(node: Node): string | undefined {
  const params = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('return_type');

  if (!params) return undefined;

  let sig = params.text;
  if (returnType) {
    sig += ` ${returnType.text}`;
  }

  return sig;
}

const isPublic = (node: Node): boolean => {
  for (const child of node.namedChildren) {
    if (child.type === 'visibility_modifier') {
      return child.text.startsWith('pub');
    }
  }
  return false;
};

export function extractOutlineRust(root: Node): SymbolOutline[] {
  const outline: SymbolOutline[] = [];

  for (const child of root.namedChildren) {
    if (child.type === 'function_item') {
      const name = child.childForFieldName('name');
      if (!name) continue;

      outline.push({
        kind: 'function',
        name: name.text,
        signature: extractFunctionSignatureRust(child),
        range: {
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        },
        exported: isPublic(child),
      });
    }

    if (child.type === 'struct_item') {
      const name = child.childForFieldName('name');
      if (!name) continue;

      outline.push({
        kind: 'class',
        name: name.text,
        range: {
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        },
        exported: isPublic(child),
      });
    }

    if (child.type === 'enum_item') {
      const name = child.childForFieldName('name');
      if (!name) continue;

      outline.push({
        kind: 'enum',
        name: name.text,
        range: {
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        },
        exported: isPublic(child),
      });
    }

    if (child.type === 'trait_item') {
      const name = child.childForFieldName('name');
      if (!name) continue;

      outline.push({
        kind: 'interface',
        name: name.text,
        range: {
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        },
        exported: isPublic(child),
      });
    }

    if (child.type === 'type_item') {
      const name = child.childForFieldName('name');
      if (!name) continue;

      outline.push({
        kind: 'type',
        name: name.text,
        range: {
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        },
        exported: isPublic(child),
      });
    }

    if (child.type === 'impl_item') {
      const typeName = child.childForFieldName('type');
      const traitName = child.childForFieldName('trait');
      if (!typeName) continue;

      const label = traitName ? `impl ${traitName.text} for ${typeName.text}` : `impl ${typeName.text}`;

      outline.push({
        kind: 'class',
        name: label,
        range: {
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        },
        exported: false,
      });
    }

    if (child.type === 'mod_item') {
      const name = child.childForFieldName('name');
      if (!name) continue;

      outline.push({
        kind: 'module',
        name: name.text,
        range: {
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        },
        exported: isPublic(child),
      });
    }
  }

  return outline;
}

// ============================================================================
// Extension Point Extraction
// ============================================================================

export function extractExtensionPointsRust(root: Node): ExtensionPoint[] {
  const points: ExtensionPoint[] = [];

  for (const child of root.namedChildren) {
    if (child.type !== 'trait_item') continue;

    const name = child.childForFieldName('name');
    if (!name) continue;

    const body = child.childForFieldName('body');
    const methods: ExtensionPoint['methods'] = [];
    const bases: string[] = [];

    const bounds = child.descendantsOfType('trait_bounds')[0];
    if (bounds) {
      for (const bound of bounds.namedChildren) {
        if (bound.type === 'type_identifier' || bound.type === 'scoped_type_identifier') {
          bases.push(bound.text);
        }
      }
    }

    if (body) {
      for (const member of body.namedChildren) {
        if (member.type === 'function_signature_item' || member.type === 'function_item') {
          const methodName = member.childForFieldName('name');
          if (!methodName) continue;

          const params = member.childForFieldName('parameters');
          const returnType = member.childForFieldName('return_type');
          const hasBody = member.type === 'function_item' && member.childForFieldName('body');

          methods.push({
            name: methodName.text,
            line: member.startPosition.row + 1,
            signature: params
              ? `${params.text}${returnType ? ` ${returnType.text}` : ''}`
              : undefined,
            isAbstract: !hasBody,
            isDefault: !!hasBody,
          });
        }

        if (member.type === 'associated_type') {
          const typeName = member.childForFieldName('name');
          if (typeName) {
            methods.push({
              name: typeName.text,
              line: member.startPosition.row + 1,
              signature: 'type',
              isAbstract: true,
            });
          }
        }
      }
    }

    points.push({
      kind: 'interface',
      name: name.text,
      line: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
      isPublic: isPublic(child),
      methods: methods.length > 0 ? methods : undefined,
      bases: bases.length > 0 ? bases : undefined,
    });
  }

  for (const child of root.namedChildren) {
    if (child.type !== 'type_item') continue;

    const name = child.childForFieldName('name');
    const typeNode = child.childForFieldName('type');

    if (!name || !typeNode) continue;

    if (typeNode.type === 'function_type') {
      const params = typeNode.descendantsOfType('parameters')[0];
      const returnType = typeNode.childForFieldName('return_type');

      points.push({
        kind: 'func-type',
        name: name.text,
        line: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
        isPublic: isPublic(child),
        methods: [
          {
            name: 'call',
            line: child.startPosition.row + 1,
            signature: params
              ? `${params.text}${returnType ? ` ${returnType.text}` : ''}`
              : undefined,
          },
        ],
      });
    }
  }

  return points;
}
