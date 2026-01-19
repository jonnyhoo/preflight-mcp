/**
 * Tree-sitter AST - Go Extractors
 *
 * @module ast/languages/go
 */

import type { Node } from 'web-tree-sitter';
import type { ImportRef, SymbolOutline, ExtensionPoint } from '../types.js';
import { rangeFromNode, unquoteStringLiteral } from '../utils.js';

// ============================================================================
// Import Extraction
// ============================================================================

export function extractImportsGo(root: Node): ImportRef[] {
  const out: ImportRef[] = [];

  for (const decl of root.descendantsOfType('import_declaration')) {
    for (const spec of decl.descendantsOfType('import_spec')) {
      const path = spec.childForFieldName('path');
      if (!path) continue;

      const module = unquoteStringLiteral(path.text);
      if (!module) continue;

      out.push({
        language: 'go',
        kind: 'import',
        module,
        range: rangeFromNode(path),
      });
    }
  }

  return out;
}

// ============================================================================
// Export Extraction
// ============================================================================

export function extractExportsGo(root: Node): string[] {
  const out = new Set<string>();

  const isExported = (name: string) => /^[A-Z]/.test(name);

  for (const fn of root.descendantsOfType('function_declaration')) {
    const name = fn.childForFieldName('name');
    if (name && isExported(name.text)) {
      out.add(name.text);
    }
  }

  for (const method of root.descendantsOfType('method_declaration')) {
    const name = method.childForFieldName('name');
    if (name && isExported(name.text)) {
      out.add(name.text);
    }
  }

  for (const typeDecl of root.descendantsOfType('type_declaration')) {
    for (const spec of typeDecl.descendantsOfType('type_spec')) {
      const name = spec.childForFieldName('name');
      if (name && isExported(name.text)) {
        out.add(name.text);
      }
    }
  }

  for (const varDecl of root.descendantsOfType('var_declaration')) {
    for (const spec of varDecl.descendantsOfType('var_spec')) {
      for (const name of spec.descendantsOfType('identifier')) {
        if (isExported(name.text)) {
          out.add(name.text);
        }
        break;
      }
    }
  }

  for (const constDecl of root.descendantsOfType('const_declaration')) {
    for (const spec of constDecl.descendantsOfType('const_spec')) {
      for (const name of spec.descendantsOfType('identifier')) {
        if (isExported(name.text)) {
          out.add(name.text);
        }
        break;
      }
    }
  }

  return Array.from(out);
}

// ============================================================================
// Outline Extraction
// ============================================================================

function extractFunctionSignatureGo(node: Node): string | undefined {
  const params = node.childForFieldName('parameters');
  const result = node.childForFieldName('result');

  if (!params) return undefined;

  let sig = params.text;
  if (result) {
    sig += ` ${result.text}`;
  }

  return sig;
}

function extractMethodSignatureGo(node: Node): string | undefined {
  const params = node.childForFieldName('parameters');
  const result = node.childForFieldName('result');

  if (!params) return undefined;

  let sig = params.text;
  if (result) {
    sig += ` ${result.text}`;
  }

  return sig;
}

export function extractOutlineGo(root: Node): SymbolOutline[] {
  const outline: SymbolOutline[] = [];
  const isExported = (name: string) => /^[A-Z]/.test(name);

  for (const child of root.namedChildren) {
    if (child.type === 'function_declaration') {
      const name = child.childForFieldName('name');
      if (!name) continue;

      outline.push({
        kind: 'function',
        name: name.text,
        signature: extractFunctionSignatureGo(child),
        range: {
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        },
        exported: isExported(name.text),
      });
    }

    if (child.type === 'method_declaration') {
      const name = child.childForFieldName('name');
      if (!name) continue;
      outline.push({
        kind: 'method',
        name: name.text,
        signature: extractMethodSignatureGo(child),
        range: {
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        },
        exported: isExported(name.text),
      });
    }

    if (child.type === 'type_declaration') {
      for (const spec of child.descendantsOfType('type_spec')) {
        const name = spec.childForFieldName('name');
        const typeNode = spec.childForFieldName('type');
        if (!name) continue;

        const isStruct = typeNode?.type === 'struct_type';
        const isInterface = typeNode?.type === 'interface_type';

        outline.push({
          kind: isStruct ? 'class' : isInterface ? 'interface' : 'type',
          name: name.text,
          range: {
            startLine: spec.startPosition.row + 1,
            endLine: spec.endPosition.row + 1,
          },
          exported: isExported(name.text),
        });
      }
    }

    if (child.type === 'var_declaration') {
      for (const spec of child.descendantsOfType('var_spec')) {
        const names = spec.descendantsOfType('identifier');
        for (const name of names) {
          outline.push({
            kind: 'variable',
            name: name.text,
            range: {
              startLine: spec.startPosition.row + 1,
              endLine: spec.endPosition.row + 1,
            },
            exported: isExported(name.text),
          });
          break;
        }
      }
    }

    if (child.type === 'const_declaration') {
      for (const spec of child.descendantsOfType('const_spec')) {
        const names = spec.descendantsOfType('identifier');
        for (const name of names) {
          outline.push({
            kind: 'variable',
            name: name.text,
            range: {
              startLine: spec.startPosition.row + 1,
              endLine: spec.endPosition.row + 1,
            },
            exported: isExported(name.text),
          });
          break;
        }
      }
    }
  }

  return outline;
}

// ============================================================================
// Extension Point Extraction
// ============================================================================

export function extractExtensionPointsGo(root: Node): ExtensionPoint[] {
  const points: ExtensionPoint[] = [];
  const isExported = (name: string) => /^[A-Z]/.test(name);

  for (const child of root.namedChildren) {
    if (child.type !== 'type_declaration') continue;

    for (const spec of child.descendantsOfType('type_spec')) {
      const name = spec.childForFieldName('name');
      const typeNode = spec.childForFieldName('type');
      if (!name || !typeNode) continue;

      if (typeNode.type === 'interface_type') {
        const methods: ExtensionPoint['methods'] = [];
        const bases: string[] = [];

        for (const member of typeNode.namedChildren) {
          if (member.type === 'method_spec') {
            const methodName = member.childForFieldName('name');
            const params = member.childForFieldName('parameters');
            const result = member.childForFieldName('result');

            if (methodName) {
              methods.push({
                name: methodName.text,
                line: member.startPosition.row + 1,
                signature: params
                  ? `${params.text}${result ? ` ${result.text}` : ''}`
                  : undefined,
              });
            }
          }

          if (member.type === 'type_identifier' || member.type === 'qualified_type') {
            bases.push(member.text);
          }
        }

        points.push({
          kind: 'interface',
          name: name.text,
          line: spec.startPosition.row + 1,
          endLine: spec.endPosition.row + 1,
          isPublic: isExported(name.text),
          methods: methods.length > 0 ? methods : undefined,
          bases: bases.length > 0 ? bases : undefined,
        });
      }

      if (typeNode.type === 'function_type') {
        const params = typeNode.childForFieldName('parameters');
        const result = typeNode.childForFieldName('result');

        points.push({
          kind: 'func-type',
          name: name.text,
          line: spec.startPosition.row + 1,
          endLine: spec.endPosition.row + 1,
          isPublic: isExported(name.text),
          methods: [
            {
              name: 'call',
              line: spec.startPosition.row + 1,
              signature: params ? `${params.text}${result ? ` ${result.text}` : ''}` : undefined,
            },
          ],
        });
      }
    }
  }

  return points;
}
