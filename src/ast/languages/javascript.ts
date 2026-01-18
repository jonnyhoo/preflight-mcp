/**
 * Tree-sitter AST - JavaScript/TypeScript Extractors
 *
 * @module ast/languages/javascript
 */

import type { Node } from 'web-tree-sitter';
import type { TreeSitterLanguageId, ImportRef, SymbolOutline, ExtensionPoint } from '../types.js';
import { rangeFromNode, firstStringFragment } from '../utils.js';

// ============================================================================
// Import Extraction
// ============================================================================

export function extractImportsJsTs(root: Node, lang: TreeSitterLanguageId): ImportRef[] {
  const out: ImportRef[] = [];

  for (const st of root.descendantsOfType(['import_statement', 'export_statement'])) {
    const source = st.childForFieldName('source');
    if (!source) continue;

    const frag = firstStringFragment(source);
    if (!frag) continue;

    out.push({
      language: lang,
      kind: st.type === 'export_statement' ? 'exportFrom' : 'import',
      module: frag.text,
      range: rangeFromNode(frag),
    });
  }

  for (const call of root.descendantsOfType('call_expression')) {
    const fn = call.childForFieldName('function');
    if (!fn) continue;

    const args = call.childForFieldName('arguments');
    const arg0 = args?.namedChild(0);
    if (!arg0 || arg0.type !== 'string') continue;

    const frag = firstStringFragment(arg0);
    if (!frag) continue;

    if (fn.type === 'import') {
      out.push({
        language: lang,
        kind: 'dynamicImport',
        module: frag.text,
        range: rangeFromNode(frag),
      });
      continue;
    }

    if (fn.type === 'identifier' && fn.text === 'require') {
      out.push({
        language: lang,
        kind: 'require',
        module: frag.text,
        range: rangeFromNode(frag),
      });
    }
  }

  return out;
}

// ============================================================================
// Export Extraction
// ============================================================================

export function extractExportsJsTs(root: Node): string[] {
  const out = new Set<string>();

  for (const st of root.descendantsOfType('export_statement')) {
    if (/^\s*export\s+default\b/.test(st.text)) {
      out.add('default');
    }

    const clause = st.descendantsOfType('export_clause')[0];
    if (clause) {
      for (const spec of clause.descendantsOfType('export_specifier')) {
        const alias = spec.childForFieldName('alias');
        const name = alias ?? spec.childForFieldName('name');
        if (name) out.add(name.text);
      }
      continue;
    }

    const direct = st.namedChildren;
    for (const child of direct) {
      if (
        child.type === 'function_declaration' ||
        child.type === 'class_declaration' ||
        child.type === 'interface_declaration' ||
        child.type === 'type_alias_declaration' ||
        child.type === 'enum_declaration'
      ) {
        const name = child.childForFieldName('name');
        if (name) out.add(name.text);
      }

      if (child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
        for (const decl of child.descendantsOfType('variable_declarator')) {
          const name = decl.childForFieldName('name');
          if (name && name.type === 'identifier') out.add(name.text);
        }
      }
    }
  }

  for (const asn of root.descendantsOfType('assignment_expression')) {
    const left = asn.childForFieldName('left');
    if (!left) continue;

    if (left.type === 'member_expression') {
      const obj = left.childForFieldName('object');
      const prop = left.childForFieldName('property');
      if (obj?.type === 'identifier' && obj.text === 'exports' && prop) {
        out.add(prop.text);
        continue;
      }

      if (obj?.type === 'identifier' && obj.text === 'module' && prop && prop.text === 'exports') {
        out.add('default');
        continue;
      }

      if (obj?.type === 'member_expression' && prop) {
        const obj2 = obj.childForFieldName('object');
        const prop2 = obj.childForFieldName('property');
        if (obj2?.type === 'identifier' && obj2.text === 'module' && prop2?.text === 'exports') {
          out.add(prop.text);
        }
      }
    }
  }

  return Array.from(out);
}

// ============================================================================
// Outline Extraction
// ============================================================================

function extractFunctionSignatureJsTs(node: Node): string | undefined {
  const params = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('return_type');

  if (!params) return undefined;

  let sig = params.text;
  if (returnType) {
    sig += `: ${returnType.text}`;
  }

  return sig;
}

function extractMethodSignatureJsTs(node: Node): string | undefined {
  const params = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('return_type');

  if (!params) return undefined;

  let sig = params.text;
  if (returnType) {
    sig += `: ${returnType.text}`;
  }

  return sig;
}

function extractClassMethodsJsTs(classNode: Node): SymbolOutline[] {
  const methods: SymbolOutline[] = [];
  const body = classNode.childForFieldName('body');
  if (!body) return methods;

  for (const child of body.namedChildren) {
    if (child.type === 'method_definition' || child.type === 'public_field_definition') {
      const name = child.childForFieldName('name');
      if (!name) continue;

      const isMethod = child.type === 'method_definition';

      methods.push({
        kind: isMethod ? 'method' : 'variable',
        name: name.text,
        signature: isMethod ? extractMethodSignatureJsTs(child) : undefined,
        range: {
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        },
        exported: true,
      });
    }
  }

  return methods;
}

export function extractOutlineJsTs(root: Node, lang: TreeSitterLanguageId): SymbolOutline[] {
  const outline: SymbolOutline[] = [];

  const exportedNames = new Set<string>();
  for (const st of root.descendantsOfType('export_statement')) {
    const clause = st.descendantsOfType('export_clause')[0];
    if (clause) {
      for (const spec of clause.descendantsOfType('export_specifier')) {
        const name = spec.childForFieldName('name');
        if (name) exportedNames.add(name.text);
      }
    }
  }

  for (const child of root.namedChildren) {
    let actualNode = child;
    let isExported = false;

    if (child.type === 'export_statement') {
      isExported = true;
      const decl = child.namedChildren.find(
        (n) => n.type !== 'export_clause' && n.type !== 'string' && n.type !== 'comment'
      );
      if (decl) {
        actualNode = decl;
      } else {
        continue;
      }
    }

    const name = actualNode.childForFieldName('name');

    switch (actualNode.type) {
      case 'function_declaration': {
        if (!name) continue;
        outline.push({
          kind: 'function',
          name: name.text,
          signature: extractFunctionSignatureJsTs(actualNode),
          range: {
            startLine: actualNode.startPosition.row + 1,
            endLine: actualNode.endPosition.row + 1,
          },
          exported: isExported || exportedNames.has(name.text),
        });
        break;
      }

      case 'class_declaration': {
        if (!name) continue;
        const children = extractClassMethodsJsTs(actualNode);
        outline.push({
          kind: 'class',
          name: name.text,
          range: {
            startLine: actualNode.startPosition.row + 1,
            endLine: actualNode.endPosition.row + 1,
          },
          exported: isExported || exportedNames.has(name.text),
          children: children.length > 0 ? children : undefined,
        });
        break;
      }

      case 'interface_declaration': {
        if (!name) continue;
        outline.push({
          kind: 'interface',
          name: name.text,
          range: {
            startLine: actualNode.startPosition.row + 1,
            endLine: actualNode.endPosition.row + 1,
          },
          exported: isExported || exportedNames.has(name.text),
        });
        break;
      }

      case 'type_alias_declaration': {
        if (!name) continue;
        outline.push({
          kind: 'type',
          name: name.text,
          range: {
            startLine: actualNode.startPosition.row + 1,
            endLine: actualNode.endPosition.row + 1,
          },
          exported: isExported || exportedNames.has(name.text),
        });
        break;
      }

      case 'enum_declaration': {
        if (!name) continue;
        outline.push({
          kind: 'enum',
          name: name.text,
          range: {
            startLine: actualNode.startPosition.row + 1,
            endLine: actualNode.endPosition.row + 1,
          },
          exported: isExported || exportedNames.has(name.text),
        });
        break;
      }

      case 'lexical_declaration':
      case 'variable_declaration': {
        for (const decl of actualNode.descendantsOfType('variable_declarator')) {
          const varName = decl.childForFieldName('name');
          if (!varName || varName.type !== 'identifier') continue;

          const value = decl.childForFieldName('value');
          const isArrowFn = value?.type === 'arrow_function';

          outline.push({
            kind: isArrowFn ? 'function' : 'variable',
            name: varName.text,
            signature: isArrowFn ? extractFunctionSignatureJsTs(value) : undefined,
            range: {
              startLine: decl.startPosition.row + 1,
              endLine: decl.endPosition.row + 1,
            },
            exported: isExported || exportedNames.has(varName.text),
          });
        }
        break;
      }
    }
  }

  return outline;
}

// ============================================================================
// Extension Point Extraction
// ============================================================================

export function extractExtensionPointsJsTs(root: Node, lang: TreeSitterLanguageId): ExtensionPoint[] {
  const points: ExtensionPoint[] = [];

  const exportedNames = new Set<string>();
  for (const st of root.descendantsOfType('export_statement')) {
    const clause = st.descendantsOfType('export_clause')[0];
    if (clause) {
      for (const spec of clause.descendantsOfType('export_specifier')) {
        const name = spec.childForFieldName('name');
        if (name) exportedNames.add(name.text);
      }
    }
  }

  for (const child of root.namedChildren) {
    let actualNode = child;
    let isExported = false;

    if (child.type === 'export_statement') {
      isExported = true;
      const decl = child.namedChildren.find(
        (n) => n.type !== 'export_clause' && n.type !== 'string' && n.type !== 'comment'
      );
      if (decl) {
        actualNode = decl;
      } else {
        continue;
      }
    }

    if (actualNode.type === 'interface_declaration') {
      const name = actualNode.childForFieldName('name');
      if (!name) continue;

      const bases: string[] = [];
      const extendsClause = actualNode.descendantsOfType('extends_type_clause')[0];
      if (extendsClause) {
        for (const typeNode of extendsClause.namedChildren) {
          if (typeNode.type === 'type_identifier' || typeNode.type === 'generic_type') {
            bases.push(typeNode.text);
          }
        }
      }

      const methods: ExtensionPoint['methods'] = [];
      const body = actualNode.childForFieldName('body');
      if (body) {
        for (const member of body.namedChildren) {
          if (member.type === 'method_signature' || member.type === 'property_signature') {
            const memberName = member.childForFieldName('name');
            if (!memberName) continue;

            const params = member.childForFieldName('parameters')?.text || '';
            const returnType = member.childForFieldName('return_type')?.text || '';

            methods.push({
              name: memberName.text,
              line: member.startPosition.row + 1,
              signature: params ? `${params}${returnType ? `: ${returnType}` : ''}` : undefined,
            });
          }
        }
      }

      points.push({
        kind: 'interface',
        name: name.text,
        line: actualNode.startPosition.row + 1,
        endLine: actualNode.endPosition.row + 1,
        isPublic: isExported || exportedNames.has(name.text),
        methods: methods.length > 0 ? methods : undefined,
        bases: bases.length > 0 ? bases : undefined,
      });
    }

    if (
      actualNode.type === 'abstract_class_declaration' ||
      (actualNode.type === 'class_declaration' && actualNode.text.startsWith('abstract '))
    ) {
      const name = actualNode.childForFieldName('name');
      if (!name) continue;

      const bases: string[] = [];
      const heritage = actualNode.descendantsOfType('class_heritage')[0];
      if (heritage) {
        const extendsClause = heritage.descendantsOfType('extends_clause')[0];
        if (extendsClause) {
          const baseType = extendsClause.namedChild(0);
          if (baseType) bases.push(baseType.text);
        }
        const implementsClause = heritage.descendantsOfType('implements_clause')[0];
        if (implementsClause) {
          for (const typeNode of implementsClause.namedChildren) {
            if (typeNode.type === 'type_identifier' || typeNode.type === 'generic_type') {
              bases.push(typeNode.text);
            }
          }
        }
      }

      const methods: ExtensionPoint['methods'] = [];
      const body = actualNode.childForFieldName('body');
      if (body) {
        for (const member of body.namedChildren) {
          if (member.type === 'method_definition' || member.type === 'abstract_method_definition') {
            const memberName = member.childForFieldName('name');
            if (!memberName) continue;

            const isAbstract =
              member.type === 'abstract_method_definition' || member.text.includes('abstract ');
            const params = member.childForFieldName('parameters')?.text || '()';
            const returnType = member.childForFieldName('return_type')?.text;

            methods.push({
              name: memberName.text,
              line: member.startPosition.row + 1,
              signature: `${params}${returnType ? `: ${returnType}` : ''}`,
              isAbstract,
              isDefault: !isAbstract,
            });
          }
        }
      }

      points.push({
        kind: 'abstract-class',
        name: name.text,
        line: actualNode.startPosition.row + 1,
        endLine: actualNode.endPosition.row + 1,
        isPublic: isExported || exportedNames.has(name.text),
        methods: methods.length > 0 ? methods : undefined,
        bases: bases.length > 0 ? bases : undefined,
      });
    }

    if (actualNode.type === 'type_alias_declaration') {
      const name = actualNode.childForFieldName('name');
      const typeNode = actualNode.childForFieldName('value');

      if (name && typeNode && typeNode.type === 'function_type') {
        const params = typeNode.childForFieldName('parameters')?.text || '()';
        const returnType = typeNode.childForFieldName('return_type')?.text || 'void';

        points.push({
          kind: 'func-type',
          name: name.text,
          line: actualNode.startPosition.row + 1,
          endLine: actualNode.endPosition.row + 1,
          isPublic: isExported || exportedNames.has(name.text),
          methods: [
            {
              name: 'call',
              line: actualNode.startPosition.row + 1,
              signature: `${params} => ${returnType}`,
            },
          ],
        });
      }
    }
  }

  return points;
}
