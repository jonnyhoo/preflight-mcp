/**
 * Tree-sitter AST - Java Extractors
 *
 * @module ast/languages/java
 */

import type { Node } from 'web-tree-sitter';
import type { ImportRef, SymbolOutline, ExtensionPoint } from '../types.js';
import { rangeFromNode } from '../utils.js';

// ============================================================================
// Import Extraction
// ============================================================================

export function extractImportsJava(root: Node): ImportRef[] {
  const out: ImportRef[] = [];

  for (const decl of root.descendantsOfType('import_declaration')) {
    const scopedId = decl.descendantsOfType('scoped_identifier')[0];
    if (scopedId) {
      out.push({
        language: 'java',
        kind: 'import',
        module: scopedId.text,
        range: rangeFromNode(scopedId),
      });
    }
  }

  return out;
}

// ============================================================================
// Export Extraction
// ============================================================================

export function extractExportsJava(root: Node): string[] {
  const out = new Set<string>();

  const isPublic = (node: Node): boolean => {
    const modifiers = node.childForFieldName('modifiers');
    if (!modifiers) return false;
    return modifiers.text.includes('public');
  };

  for (const cls of root.descendantsOfType('class_declaration')) {
    if (!isPublic(cls)) continue;
    const name = cls.childForFieldName('name');
    if (name) out.add(name.text);
  }

  for (const iface of root.descendantsOfType('interface_declaration')) {
    if (!isPublic(iface)) continue;
    const name = iface.childForFieldName('name');
    if (name) out.add(name.text);
  }

  for (const en of root.descendantsOfType('enum_declaration')) {
    if (!isPublic(en)) continue;
    const name = en.childForFieldName('name');
    if (name) out.add(name.text);
  }

  return Array.from(out);
}

// ============================================================================
// Outline Extraction
// ============================================================================

function extractMethodSignatureJava(node: Node): string | undefined {
  const params = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('type');

  if (!params) return undefined;

  let sig = params.text;
  if (returnType) {
    sig = `${returnType.text} ${sig}`;
  }

  return sig;
}

function extractClassMembersJava(classNode: Node): SymbolOutline[] {
  const members: SymbolOutline[] = [];
  const body = classNode.childForFieldName('body');
  if (!body) return members;

  const isPublic = (node: Node): boolean => {
    const modifiers = node.childForFieldName('modifiers');
    if (!modifiers) return false;
    return modifiers.text.includes('public');
  };

  for (const child of body.namedChildren) {
    if (child.type === 'method_declaration') {
      const name = child.childForFieldName('name');
      if (!name) continue;

      members.push({
        kind: 'method',
        name: name.text,
        signature: extractMethodSignatureJava(child),
        range: {
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        },
        exported: isPublic(child),
      });
    }

    if (child.type === 'field_declaration') {
      const declarator = child.descendantsOfType('variable_declarator')[0];
      if (!declarator) continue;

      const name = declarator.childForFieldName('name');
      if (!name) continue;

      members.push({
        kind: 'variable',
        name: name.text,
        range: {
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        },
        exported: isPublic(child),
      });
    }
  }

  return members;
}

const isPublic = (node: Node): boolean => {
  const modifiers = node.childForFieldName('modifiers');
  if (!modifiers) return false;
  return modifiers.text.includes('public');
};

export function extractOutlineJava(root: Node): SymbolOutline[] {
  const outline: SymbolOutline[] = [];

  for (const child of root.namedChildren) {
    if (child.type === 'class_declaration') {
      const name = child.childForFieldName('name');
      if (!name) continue;

      const children = extractClassMembersJava(child);
      outline.push({
        kind: 'class',
        name: name.text,
        range: {
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        },
        exported: isPublic(child),
        children: children.length > 0 ? children : undefined,
      });
    }

    if (child.type === 'interface_declaration') {
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

    if (child.type === 'enum_declaration') {
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
  }

  return outline;
}

// ============================================================================
// Extension Point Extraction
// ============================================================================

export function extractExtensionPointsJava(root: Node): ExtensionPoint[] {
  const points: ExtensionPoint[] = [];

  for (const child of root.namedChildren) {
    if (child.type === 'interface_declaration') {
      const name = child.childForFieldName('name');
      if (!name) continue;

      const body = child.childForFieldName('body');
      const methods: ExtensionPoint['methods'] = [];
      const bases: string[] = [];

      const extendsClause = child.childForFieldName('interfaces');
      if (extendsClause) {
        for (const typeNode of extendsClause.namedChildren) {
          if (typeNode.type === 'type_identifier' || typeNode.type === 'generic_type') {
            bases.push(typeNode.text);
          }
        }
      }

      if (body) {
        for (const member of body.namedChildren) {
          if (member.type === 'method_declaration') {
            const methodName = member.childForFieldName('name');
            if (!methodName) continue;

            const params = member.childForFieldName('parameters');
            const returnType = member.childForFieldName('type');
            const hasBody = member.childForFieldName('body');

            methods.push({
              name: methodName.text,
              line: member.startPosition.row + 1,
              signature: params
                ? `${returnType?.text || 'void'} ${params.text}`
                : undefined,
              isAbstract: !hasBody,
              isDefault: !!hasBody,
            });
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

    if (child.type === 'class_declaration') {
      const modifiers = child.childForFieldName('modifiers');
      const isAbstract = modifiers?.text.includes('abstract');
      if (!isAbstract) continue;

      const name = child.childForFieldName('name');
      if (!name) continue;

      const body = child.childForFieldName('body');
      const methods: ExtensionPoint['methods'] = [];
      const bases: string[] = [];

      const superclass = child.childForFieldName('superclass');
      if (superclass) {
        const typeName = superclass.namedChild(0);
        if (typeName) bases.push(typeName.text);
      }

      const interfaces = child.childForFieldName('interfaces');
      if (interfaces) {
        for (const typeNode of interfaces.namedChildren) {
          if (typeNode.type === 'type_identifier' || typeNode.type === 'generic_type') {
            bases.push(typeNode.text);
          }
        }
      }

      if (body) {
        for (const member of body.namedChildren) {
          if (member.type === 'method_declaration') {
            const methodName = member.childForFieldName('name');
            if (!methodName) continue;

            const memberModifiers = member.childForFieldName('modifiers');
            const isAbstractMethod = memberModifiers?.text.includes('abstract');

            const params = member.childForFieldName('parameters');
            const returnType = member.childForFieldName('type');
            const hasBody = member.childForFieldName('body');

            methods.push({
              name: methodName.text,
              line: member.startPosition.row + 1,
              signature: params
                ? `${returnType?.text || 'void'} ${params.text}`
                : undefined,
              isAbstract: isAbstractMethod,
              isDefault: !isAbstractMethod && !!hasBody,
            });
          }
        }
      }

      points.push({
        kind: 'abstract-class',
        name: name.text,
        line: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
        isPublic: isPublic(child),
        methods: methods.length > 0 ? methods : undefined,
        bases: bases.length > 0 ? bases : undefined,
      });
    }
  }

  return points;
}
