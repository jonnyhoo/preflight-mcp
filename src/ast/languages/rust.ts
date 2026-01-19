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
  const pushUse = (module: string, node: Node, kind: ImportRef['kind'] = 'use') => {
    out.push({
      language: 'rust',
      kind,
      module,
      range: rangeFromNode(node),
    });
  };

  const collectUseList = (pathText: string | null, listNode: Node): boolean => {
    let added = false;
    for (const item of listNode.namedChildren) {
      let nameText: string | null = null;
      let nameNode: Node | null = null;

      if (item.type === 'identifier' || item.type === 'scoped_identifier') {
        nameText = item.text;
        nameNode = item;
      } else if (item.type === 'use_as_clause') {
        const name =
          item.childForFieldName('name') ?? item.childForFieldName('path') ?? item.namedChild(0);
        if (name) {
          nameText = name.text;
          nameNode = name;
        }
      } else if (item.type === 'use_wildcard') {
        nameText = '*';
        nameNode = item;
      } else if (item.type === 'scoped_use_list') {
        const nestedPath = item.childForFieldName('path') ?? item.namedChild(0);
        const nestedList = item.childForFieldName('list') ?? item.descendantsOfType('use_list')[0];
        if (nestedPath && nestedList) {
          const nextPath = pathText ? `${pathText}::${nestedPath.text}` : nestedPath.text;
          if (collectUseList(nextPath, nestedList)) {
            added = true;
          }
        }
        continue;
      }

      if (!nameText || !nameNode) continue;
      const module =
        nameText === '*'
          ? pathText
            ? `${pathText}::*`
            : '*'
          : pathText
            ? `${pathText}::${nameText}`
            : nameText;
      pushUse(module, nameNode);
      added = true;
    }
    return added;
  };

  for (const useDecl of root.descendantsOfType('use_declaration')) {
    const argument = useDecl.namedChild(0);
    if (!argument) continue;
    if (argument.type === 'scoped_use_list') {
      const pathNode = argument.childForFieldName('path') ?? argument.namedChild(0);
      const listNode = argument.childForFieldName('list') ?? argument.descendantsOfType('use_list')[0];
      if (pathNode && listNode) {
        const added = collectUseList(pathNode.text, listNode);
        if (added) continue;
      }
      if (pathNode) {
        pushUse(pathNode.text, pathNode);
        continue;
      }
    }

    if (argument.type === 'use_list') {
      collectUseList(null, argument);
      continue;
    }

    if (argument.type === 'scoped_identifier' || argument.type === 'identifier') {
      pushUse(argument.text, argument);
    }

    if (argument.type === 'use_wildcard' || argument.type === 'use_list') {
      const path = argument.childForFieldName('path') ?? argument.namedChild(0);
      if (path) {
        pushUse(path.text, path);
      }
    }

  }

  for (const externCrate of root.descendantsOfType('extern_crate_declaration')) {
    const name = externCrate.childForFieldName('name');
    if (name) {
      pushUse(name.text, name, 'externCrate');
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

function extractImplMethodsRust(implNode: Node): SymbolOutline[] {
  const methods: SymbolOutline[] = [];
  const body =
    implNode.childForFieldName('body') ||
    implNode.namedChildren.find((n) => n.type === 'declaration_list');

  const members = body ? body.namedChildren : implNode.namedChildren;

  for (const member of members) {
    if (member.type !== 'function_item' && member.type !== 'function_signature_item') continue;
    const name = member.childForFieldName('name');
    if (!name) continue;

    methods.push({
      kind: 'method',
      name: name.text,
      signature: extractFunctionSignatureRust(member),
      range: {
        startLine: member.startPosition.row + 1,
        endLine: member.endPosition.row + 1,
      },
      exported: isPublic(member),
    });
  }

  return methods;
}

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
      const children = extractImplMethodsRust(child);

      outline.push({
        kind: 'class',
        name: label,
        range: {
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        },
        exported: false,
        children: children.length > 0 ? children : undefined,
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
      kind: 'trait',
      name: name.text,
      line: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
      isPublic: isPublic(child),
      methods: methods.length > 0 ? methods : undefined,
      bases: bases.length > 0 ? bases : undefined,
      supertraits: bases.length > 0 ? bases : undefined,
    });
  }

  for (const child of root.namedChildren) {
    if (child.type !== 'enum_item') continue;

    const name = child.childForFieldName('name');
    if (!name) continue;

    const variants: string[] = [];
    for (const variant of child.descendantsOfType('enum_variant')) {
      const variantName = variant.childForFieldName('name') ?? variant.namedChild(0);
      if (variantName) variants.push(variantName.text);
    }

    points.push({
      kind: 'enum',
      name: name.text,
      line: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
      isPublic: isPublic(child),
      variants: variants.length > 0 ? variants : undefined,
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
