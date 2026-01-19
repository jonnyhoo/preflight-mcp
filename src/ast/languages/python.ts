/**
 * Tree-sitter AST - Python Extractors
 *
 * @module ast/languages/python
 */

import type { Node } from 'web-tree-sitter';
import type { ImportRef, SymbolOutline, ExtensionPoint } from '../types.js';
import { rangeFromNode, firstOfTypes } from '../utils.js';

// ============================================================================
// Import Extraction
// ============================================================================

export function extractImportsPython(root: Node): ImportRef[] {
  const out: ImportRef[] = [];
  const seen = new Set<string>();

  for (const st of root.descendantsOfType('import_statement')) {
    const moduleNode = st.childForFieldName('name') ?? st.namedChild(0);
    if (!moduleNode) continue;

    if (moduleNode.type === 'dotted_name') {
      out.push({
        language: 'python',
        kind: 'import',
        module: moduleNode.text,
        range: rangeFromNode(moduleNode),
      });
    } else if (moduleNode.type === 'aliased_import') {
      const dn = firstOfTypes(moduleNode, ['dotted_name']);
      if (dn) {
        out.push({
          language: 'python',
          kind: 'import',
          module: dn.text,
          range: rangeFromNode(dn),
        });
      }
    }
  }

  for (const st of root.descendantsOfType('import_from_statement')) {
    const moduleNode = st.childForFieldName('module_name');
    const moduleText = moduleNode?.text ?? '';
    const relativeNode = st.descendantsOfType('relative_import')[0];
    let relativePrefix = relativeNode?.text ?? '';

    // If module text is only dots (e.g. "." or ".."), treat it as the relative prefix
    if (!relativePrefix && moduleText && /^\.+$/.test(moduleText)) {
      relativePrefix = moduleText;
    }

    const hasExplicitModule = moduleText.length > 0 && !/^\.+$/.test(moduleText);

    if (hasExplicitModule) {
      let module = moduleText;
      if (relativePrefix && !module.startsWith('.')) {
        module = `${relativePrefix}${module}`;
      }

      if (!seen.has(module)) {
        seen.add(module);
        out.push({
          language: 'python',
          kind: 'from',
          module,
          range: rangeFromNode(moduleNode ?? st),
        });
      }
      continue;
    }

    // No explicit module name; use imported names with relative prefix
    const dottedNames = st.descendantsOfType('dotted_name');
    for (const dn of dottedNames) {
      if (moduleNode && dn.id === moduleNode.id) continue;
      const module = `${relativePrefix}${dn.text}`;
      if (!module || seen.has(module)) continue;
      seen.add(module);
      out.push({
        language: 'python',
        kind: 'from',
        module,
        range: rangeFromNode(dn),
      });
    }
  }

  return out;
}

// ============================================================================
// Export Extraction
// ============================================================================

export function extractExportsPython(root: Node): string[] {
  const out = new Set<string>();
  const addStringLiteral = (node: Node) => {
    const inner = node.namedChild(0);
    if (inner?.type === 'string_content') {
      out.add(inner.text);
      return;
    }
    const raw = node.text;
    const trimmed = raw.replace(/^([rubfRUBF]+)?(['"])(.*)\2$/s, '$3');
    if (trimmed) out.add(trimmed);
  };

  for (const asn of root.descendantsOfType('assignment')) {
    const left = asn.childForFieldName('left');
    const right = asn.childForFieldName('right');
    if (left?.type === 'identifier' && left.text === '__all__') {
      const listNode =
        right && (right.type === 'list' || right.type === 'tuple' || right.type === 'set')
          ? right
          : null;
      if (listNode) {
        for (const item of listNode.namedChildren) {
          if (item.type === 'string') {
            addStringLiteral(item);
          }
        }
      } else if (right) {
        for (const str of right.descendantsOfType('string')) {
          addStringLiteral(str);
        }
      }
    }
  }

  if (out.size === 0) {
    for (const fn of root.descendantsOfType('function_definition')) {
      const name = fn.childForFieldName('name');
      if (name && !name.text.startsWith('_')) {
        out.add(name.text);
      }
    }

    for (const cls of root.descendantsOfType('class_definition')) {
      const name = cls.childForFieldName('name');
      if (name && !name.text.startsWith('_')) {
        out.add(name.text);
      }
    }
  }

  return Array.from(out);
}

// ============================================================================
// Outline Extraction
// ============================================================================

function extractFunctionSignaturePython(node: Node): string | undefined {
  const params = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('return_type');

  if (!params) return undefined;

  let sig = params.text;
  if (returnType) {
    sig += ` -> ${returnType.text}`;
  }

  return sig;
}

function extractMethodSignaturePython(node: Node): string | undefined {
  const params = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('return_type');

  if (!params) return undefined;

  let sig = params.text;
  if (returnType) {
    sig += ` -> ${returnType.text}`;
  }

  return sig;
}

function extractClassMethodsPython(classNode: Node): SymbolOutline[] {
  const methods: SymbolOutline[] = [];
  const body = classNode.childForFieldName('body');
  if (!body) return methods;

  for (const child of body.namedChildren) {
    if (child.type === 'function_definition') {
      const name = child.childForFieldName('name');
      if (!name) continue;

      methods.push({
        kind: 'method',
        name: name.text,
        signature: extractMethodSignaturePython(child),
        range: {
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        },
        exported: !name.text.startsWith('_'),
      });
    }
  }

  return methods;
}

export function extractOutlinePython(root: Node): SymbolOutline[] {
  const outline: SymbolOutline[] = [];
  const exportedNames = new Set(extractExportsPython(root));

  for (const child of root.namedChildren) {
    if (child.type === 'function_definition') {
      const name = child.childForFieldName('name');
      if (!name) continue;

      outline.push({
        kind: 'function',
        name: name.text,
        signature: extractFunctionSignaturePython(child),
        range: {
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        },
        exported: exportedNames.has(name.text),
      });
    }

    if (child.type === 'class_definition') {
      const name = child.childForFieldName('name');
      if (!name) continue;

      const children = extractClassMethodsPython(child);
      outline.push({
        kind: 'class',
        name: name.text,
        range: {
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        },
        exported: exportedNames.has(name.text),
        children: children.length > 0 ? children : undefined,
      });
    }
  }

  return outline;
}

// ============================================================================
// Extension Point Extraction
// ============================================================================

export function extractExtensionPointsPython(root: Node): ExtensionPoint[] {
  const points: ExtensionPoint[] = [];

  for (const child of root.namedChildren) {
    if (child.type !== 'class_definition') continue;

    const name = child.childForFieldName('name');
    if (!name) continue;

    const body = child.childForFieldName('body');
    if (!body) continue;

    const bases: string[] = [];
    const superclass = child.childForFieldName('superclasses');
    if (superclass) {
      for (const argNode of superclass.namedChildren) {
        if (argNode.type === 'identifier' || argNode.type === 'attribute') {
          bases.push(argNode.text);
        }
      }
    }

    const isABC = bases.some((b) => b === 'ABC' || b.endsWith('.ABC'));
    const isProtocol = bases.some((b) => b === 'Protocol' || b.endsWith('.Protocol'));

    const methods: ExtensionPoint['methods'] = [];
    let hasAbstractMethods = false;

    for (const member of body.namedChildren) {
      if (member.type === 'decorated_definition') {
        const decorators = member.descendantsOfType('decorator');
        let isAbstract = isProtocol;

        for (const dec of decorators) {
          const decName = dec.namedChild(0);
          if (
            decName &&
            (decName.text === 'abstractmethod' ||
              decName.text === 'abstractproperty' ||
              decName.text.includes('abstractmethod'))
          ) {
            isAbstract = true;
            hasAbstractMethods = true;
            break;
          }
        }

        const funcDef = member.descendantsOfType('function_definition')[0];
        if (funcDef) {
          const methodName = funcDef.childForFieldName('name');
          if (!methodName) continue;

          const params = funcDef.childForFieldName('parameters');
          const returnType = funcDef.childForFieldName('return_type');

          methods.push({
            name: methodName.text,
            line: funcDef.startPosition.row + 1,
            signature: params
              ? `${params.text}${returnType ? ` -> ${returnType.text}` : ''}`
              : undefined,
            isAbstract,
            isDefault: !isAbstract,
          });
        }
      }

      if (member.type === 'function_definition') {
        const methodName = member.childForFieldName('name');
        if (!methodName) continue;

        const params = member.childForFieldName('parameters');
        const returnType = member.childForFieldName('return_type');
        const isAbstract = isProtocol;

        methods.push({
          name: methodName.text,
          line: member.startPosition.row + 1,
          signature: params
            ? `${params.text}${returnType ? ` -> ${returnType.text}` : ''}`
            : undefined,
          isAbstract,
          isDefault: !isAbstract,
        });
      }
    }

    if (isProtocol) {
      points.push({
        kind: 'protocol',
        name: name.text,
        line: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
        isPublic: !name.text.startsWith('_'),
        methods: methods.length > 0 ? methods : undefined,
        bases: bases.length > 0 ? bases : undefined,
      });
    } else if (isABC || hasAbstractMethods) {
      points.push({
        kind: 'abstract-class',
        name: name.text,
        line: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
        isPublic: !name.text.startsWith('_'),
        methods: methods.length > 0 ? methods : undefined,
        bases: bases.length > 0 ? bases : undefined,
      });
    }
  }

  for (const child of root.namedChildren) {
    if (child.type !== 'class_definition') continue;

    const name = child.childForFieldName('name');
    if (!name) continue;

    const superclass = child.childForFieldName('superclasses');
    const bases: string[] = [];

    if (superclass) {
      for (const argNode of superclass.namedChildren) {
        if (argNode.type === 'identifier' || argNode.type === 'attribute') {
          bases.push(argNode.text);
        }
        if (argNode.type === 'keyword_argument') {
          const kwName = argNode.childForFieldName('name');
          const kwValue = argNode.childForFieldName('value');
          if (kwName?.text === 'metaclass' && kwValue?.text === 'ABCMeta') {
            const body = child.childForFieldName('body');
            if (body) {
              const methods: ExtensionPoint['methods'] = [];
              for (const member of body.namedChildren) {
                if (member.type === 'decorated_definition') {
                  const funcDef = member.descendantsOfType('function_definition')[0];
                  if (funcDef) {
                    const methodName = funcDef.childForFieldName('name');
                    if (methodName) {
                      const params = funcDef.childForFieldName('parameters');
                      const returnType = funcDef.childForFieldName('return_type');
                      methods.push({
                        name: methodName.text,
                        line: funcDef.startPosition.row + 1,
                        signature: params
                          ? `${params.text}${returnType ? ` -> ${returnType.text}` : ''}`
                          : undefined,
                        isAbstract: true,
                      });
                    }
                  }
                }
              }

              points.push({
                kind: 'abstract-class',
                name: name.text,
                line: child.startPosition.row + 1,
                endLine: child.endPosition.row + 1,
                isPublic: !name.text.startsWith('_'),
                methods: methods.length > 0 ? methods : undefined,
                bases: bases.length > 0 ? bases : undefined,
              });
            }
          }
        }
      }
    }
  }

  return points;
}
