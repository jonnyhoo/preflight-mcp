/**
 * Fine-grained Dead Code Detection
 *
 * Detects unused local variables, parameters, and private fields.
 * Supports: JS/TS/TSX, Python, Go, Java, Rust.
 *
 * @module analysis/check/deadcode/fine-grained
 */

import type { Node, Tree } from 'web-tree-sitter';
import type { TreeSitterLanguageId } from '../../../ast/types.js';
import type { FineGrainedIssue } from './types.js';

// ============================================================================
// Types
// ============================================================================

/** Symbol kind for tracking */
type SymbolKind = 'parameter' | 'local' | 'private-field';

/** Declared symbol */
interface Symbol {
  name: string;
  kind: SymbolKind;
  line: number;
  className?: string;
}

/** Collected scope data */
interface ScopeData {
  symbols: Symbol[];
  usedNames: Set<string>;
  /** Classes with dynamic property access (suppress private field warnings) */
  dynamicClasses: Set<string>;
}

// ============================================================================
// Main Entry
// ============================================================================

/**
 * Analyze a file for fine-grained dead code.
 */
export function analyzeFineGrained(
  tree: Tree,
  lang: TreeSitterLanguageId,
  filePath: string
): FineGrainedIssue[] {
  const root = tree.rootNode;

  switch (lang) {
    case 'javascript':
    case 'typescript':
    case 'tsx':
      return analyzeJsTs(root, filePath);
    case 'python':
      return analyzePython(root, filePath);
    case 'go':
      return analyzeGo(root, filePath);
    case 'java':
      return analyzeJava(root, filePath);
    case 'rust':
      return analyzeRust(root, filePath);
    default:
      return [];
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Check if name should be ignored (underscore prefix convention) */
function isIgnoredName(name: string): boolean {
  return name === '_' || name.startsWith('_');
}

/** Check if identifier is used */
function isUsed(name: string, used: Set<string>): boolean {
  return used.has(name);
}

/** Convert to issue */
function toIssue(sym: Symbol, file: string): FineGrainedIssue {
  const typeMap: Record<SymbolKind, FineGrainedIssue['type']> = {
    'parameter': 'unused-parameter',
    'local': 'unused-local-variable',
    'private-field': 'unused-private-field',
  };
  return {
    type: typeMap[sym.kind],
    file,
    line: sym.line,
    symbolName: sym.name,
    className: sym.className,
  };
}

/** Get all descendant nodes of given types */
function descendantsOfTypes(node: Node, types: string[]): Node[] {
  const results: Node[] = [];
  const stack = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (types.includes(n.type)) {
      results.push(n);
    }
    for (let i = n.childCount - 1; i >= 0; i--) {
      stack.push(n.child(i)!);
    }
  }
  return results;
}

/** Get direct children of given type */
function childrenOfType(node: Node, type: string): Node[] {
  const results: Node[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === type) results.push(c);
  }
  return results;
}

// ============================================================================
// JavaScript / TypeScript / TSX
// ============================================================================

function analyzeJsTs(root: Node, filePath: string): FineGrainedIssue[] {
  const issues: FineGrainedIssue[] = [];

  // Collect classes and detect dynamic access
  const classNodes = descendantsOfTypes(root, ['class_declaration', 'class']);
  const classData = new Map<Node, { name: string; hasDynamic: boolean }>();

  for (const cls of classNodes) {
    const nameNode = cls.childForFieldName('name');
    const className = nameNode?.text ?? '<anonymous>';

    // Check for dynamic access: this[expr]
    const body = cls.childForFieldName('body');
    let hasDynamic = false;
    if (body) {
      const subscripts = descendantsOfTypes(body, ['subscript_expression']);
      for (const sub of subscripts) {
        const obj = sub.childForFieldName('object');
        if (obj?.type === 'this') {
          hasDynamic = true;
          break;
        }
      }
    }
    classData.set(cls, { name: className, hasDynamic });
  }

  // Analyze each class for private fields
  for (const [cls, { name: className, hasDynamic }] of classData) {
    if (hasDynamic) continue; // Skip classes with dynamic access

    const body = cls.childForFieldName('body');
    if (!body) continue;

    const privateFields = new Map<string, number>();

    // Collect private fields
    for (const child of body.namedChildren) {
      // Handle both field_definition (JS) and public_field_definition (TS)
      if (child.type === 'field_definition' || child.type === 'public_field_definition') {
        let hasPrivate = false;
        let propName: Node | null = null;
        
        for (let i = 0; i < child.childCount; i++) {
          const c = child.child(i);
          // TS private modifier
          if (c?.type === 'accessibility_modifier' && c.text === 'private') {
            hasPrivate = true;
          }
          // TS private field name
          if (c?.type === 'property_identifier') {
            propName = c;
          }
          // ES private field name (#name)
          if (c?.type === 'private_property_identifier') {
            hasPrivate = true;
            propName = c;
          }
        }
        
        if (hasPrivate && propName) {
          privateFields.set(propName.text, propName.startPosition.row + 1);
        }
      }
    }

    // Collect uses within class body (only in methods, not field definitions)
    const usedFields = new Set<string>();
    
    // Get all methods in the class
    const methods = body.namedChildren.filter(c => c.type === 'method_definition');
    for (const method of methods) {
      // Check member expressions: this.x or this.#x
      const memberExprs = descendantsOfTypes(method, ['member_expression']);
      for (const mem of memberExprs) {
        const obj = mem.childForFieldName('object');
        const prop = mem.childForFieldName('property');
        if (obj?.type === 'this' && prop) {
          usedFields.add(prop.text);
        }
      }
      // Check ES private field access: this.#x
      const privateAccess = descendantsOfTypes(method, ['private_property_identifier']);
      for (const pa of privateAccess) {
        usedFields.add(pa.text);
      }
    }

    // Report unused private fields
    for (const [fieldName, line] of privateFields) {
      const cleanName = fieldName.replace(/^#/, '');
      if (!usedFields.has(fieldName) && !usedFields.has(cleanName)) {
        issues.push({
          type: 'unused-private-field',
          file: filePath,
          line,
          symbolName: fieldName,
          className,
        });
      }
    }
  }

  // Analyze functions for params and locals
  const funcTypes = [
    'function_declaration',
    'function_expression',
    'arrow_function',
    'method_definition',
    'function',
  ];
  const functions = descendantsOfTypes(root, funcTypes);

  for (const fn of functions) {
    const scope: ScopeData = { symbols: [], usedNames: new Set(), dynamicClasses: new Set() };

    // Collect parameters
    const params = fn.childForFieldName('parameters') ?? fn.childForFieldName('parameter');
    if (params) {
      collectJsTsParams(params, scope);
    }

    // Collect body
    const body = fn.childForFieldName('body');
    if (body) {
      collectJsTsLocals(body, scope);
      collectJsTsUses(body, scope);
    }

    // Report unused
    for (const sym of scope.symbols) {
      if (isIgnoredName(sym.name)) continue;
      if (!isUsed(sym.name, scope.usedNames)) {
        issues.push(toIssue(sym, filePath));
      }
    }
  }

  return issues;
}

function collectJsTsParams(params: Node, scope: ScopeData): void {
  // Handle formal_parameters or parameter nodes
  for (const child of params.namedChildren) {
    if (child.type === 'identifier') {
      scope.symbols.push({
        name: child.text,
        kind: 'parameter',
        line: child.startPosition.row + 1,
      });
    } else if (child.type === 'required_parameter' || child.type === 'optional_parameter') {
      const pattern = child.childForFieldName('pattern');
      if (pattern?.type === 'identifier') {
        scope.symbols.push({
          name: pattern.text,
          kind: 'parameter',
          line: pattern.startPosition.row + 1,
        });
      }
    } else if (child.type === 'assignment_pattern') {
      const left = child.childForFieldName('left');
      if (left?.type === 'identifier') {
        scope.symbols.push({
          name: left.text,
          kind: 'parameter',
          line: left.startPosition.row + 1,
        });
      }
    } else if (child.type === 'rest_pattern') {
      const nameNode = child.namedChild(0);
      if (nameNode?.type === 'identifier') {
        scope.symbols.push({
          name: nameNode.text,
          kind: 'parameter',
          line: nameNode.startPosition.row + 1,
        });
      }
    }
  }
}

function collectJsTsLocals(body: Node, scope: ScopeData): void {
  const varDecls = descendantsOfTypes(body, ['lexical_declaration', 'variable_declaration']);
  for (const decl of varDecls) {
    const declarators = descendantsOfTypes(decl, ['variable_declarator']);
    for (const d of declarators) {
      const nameNode = d.childForFieldName('name');
      if (nameNode?.type === 'identifier') {
        scope.symbols.push({
          name: nameNode.text,
          kind: 'local',
          line: nameNode.startPosition.row + 1,
        });
      }
    }
  }
}

function collectJsTsUses(body: Node, scope: ScopeData): void {
  const idents = descendantsOfTypes(body, ['identifier']);
  for (const id of idents) {
    // Skip if this is a declaration site (compare by node id)
    const parent = id.parent;
    if (parent?.type === 'variable_declarator') {
      const nameNode = parent.childForFieldName('name');
      if (nameNode && nameNode.id === id.id) {
        continue;
      }
    }
    scope.usedNames.add(id.text);
  }
}

// ============================================================================
// Python
// ============================================================================

function analyzePython(root: Node, filePath: string): FineGrainedIssue[] {
  const issues: FineGrainedIssue[] = [];

  // Collect classes and detect dynamic access
  const classNodes = descendantsOfTypes(root, ['class_definition']);
  const classData = new Map<Node, { name: string; hasDynamic: boolean }>();

  for (const cls of classNodes) {
    const nameNode = cls.childForFieldName('name');
    const className = nameNode?.text ?? '<anonymous>';

    // Check for dynamic access: getattr, setattr, __dict__
    const body = cls.childForFieldName('body');
    let hasDynamic = false;
    if (body) {
      const calls = descendantsOfTypes(body, ['call']);
      for (const call of calls) {
        const func = call.childForFieldName('function');
        if (func?.type === 'identifier' && ['getattr', 'setattr'].includes(func.text)) {
          hasDynamic = true;
          break;
        }
      }
      // Check for __dict__ access
      const attrs = descendantsOfTypes(body, ['attribute']);
      for (const attr of attrs) {
        const attrName = attr.childForFieldName('attribute');
        if (attrName?.text === '__dict__') {
          hasDynamic = true;
          break;
        }
      }
    }
    classData.set(cls, { name: className, hasDynamic });
  }

  // Analyze classes for private fields (attributes starting with _)
  for (const [cls, { name: className, hasDynamic }] of classData) {
    if (hasDynamic) continue;

    const body = cls.childForFieldName('body');
    if (!body) continue;

    // Find private fields from self._x assignments in __init__ or class body
    const privateFields = new Map<string, number>();
    const assignments = descendantsOfTypes(body, ['assignment', 'augmented_assignment']);

    for (const assign of assignments) {
      const left = assign.childForFieldName('left');
      if (left?.type === 'attribute') {
        const obj = left.childForFieldName('object');
        const attr = left.childForFieldName('attribute');
        if (obj?.text === 'self' && attr && attr.text.startsWith('_') && !attr.text.startsWith('__')) {
          if (!privateFields.has(attr.text)) {
            privateFields.set(attr.text, attr.startPosition.row + 1);
          }
        }
      }
    }

    // Collect all uses
    const usedAttrs = new Set<string>();
    const allAttrs = descendantsOfTypes(body, ['attribute']);
    for (const attr of allAttrs) {
      const obj = attr.childForFieldName('object');
      const attrName = attr.childForFieldName('attribute');
      if (obj?.text === 'self' && attrName) {
        usedAttrs.add(attrName.text);
      }
    }

    // Report unused (only if used only once - the definition)
    for (const [fieldName, line] of privateFields) {
      // Count occurrences
      let count = 0;
      for (const attr of allAttrs) {
        const obj = attr.childForFieldName('object');
        const attrName = attr.childForFieldName('attribute');
        if (obj?.text === 'self' && attrName?.text === fieldName) {
          count++;
        }
      }
      if (count <= 1) {
        issues.push({
          type: 'unused-private-field',
          file: filePath,
          line,
          symbolName: fieldName,
          className,
        });
      }
    }
  }

  // Analyze functions for params and locals
  const funcNodes = descendantsOfTypes(root, ['function_definition']);
  for (const fn of funcNodes) {
    const scope: ScopeData = { symbols: [], usedNames: new Set(), dynamicClasses: new Set() };

    // Collect parameters
    const params = fn.childForFieldName('parameters');
    if (params) {
      for (const child of params.namedChildren) {
        if (child.type === 'identifier') {
          // Skip 'self' and 'cls'
          if (child.text !== 'self' && child.text !== 'cls') {
            scope.symbols.push({
              name: child.text,
              kind: 'parameter',
              line: child.startPosition.row + 1,
            });
          }
        } else if (child.type === 'default_parameter' || child.type === 'typed_parameter' || child.type === 'typed_default_parameter') {
          const nameNode = child.childForFieldName('name');
          if (nameNode?.type === 'identifier' && nameNode.text !== 'self' && nameNode.text !== 'cls') {
            scope.symbols.push({
              name: nameNode.text,
              kind: 'parameter',
              line: nameNode.startPosition.row + 1,
            });
          }
        } else if (child.type === 'list_splat_pattern' || child.type === 'dictionary_splat_pattern') {
          const nameNode = child.namedChild(0);
          if (nameNode?.type === 'identifier') {
            scope.symbols.push({
              name: nameNode.text,
              kind: 'parameter',
              line: nameNode.startPosition.row + 1,
            });
          }
        }
      }
    }

    // Collect locals from assignments
    const body = fn.childForFieldName('body');
    if (body) {
      collectPythonLocals(body, scope);
      collectPythonUses(body, scope);
    }

    // Report unused
    for (const sym of scope.symbols) {
      if (isIgnoredName(sym.name)) continue;
      if (!isUsed(sym.name, scope.usedNames)) {
        issues.push(toIssue(sym, filePath));
      }
    }
  }

  return issues;
}

function collectPythonLocals(body: Node, scope: ScopeData): void {
  const assigns = descendantsOfTypes(body, ['assignment', 'augmented_assignment', 'for_statement']);
  for (const assign of assigns) {
    if (assign.type === 'for_statement') {
      const left = assign.childForFieldName('left');
      if (left?.type === 'identifier') {
        scope.symbols.push({
          name: left.text,
          kind: 'local',
          line: left.startPosition.row + 1,
        });
      }
    } else {
      const left = assign.childForFieldName('left');
      if (left?.type === 'identifier') {
        // Skip if already defined as param
        if (!scope.symbols.some(s => s.name === left.text)) {
          scope.symbols.push({
            name: left.text,
            kind: 'local',
            line: left.startPosition.row + 1,
          });
        }
      }
    }
  }
}

function collectPythonUses(body: Node, scope: ScopeData): void {
  const idents = descendantsOfTypes(body, ['identifier']);
  for (const id of idents) {
    // Skip if this is a declaration site (assignment left-hand side)
    const parent = id.parent;
    if (parent?.type === 'assignment' || parent?.type === 'augmented_assignment') {
      const left = parent.childForFieldName('left');
      if (left && left.id === id.id) {
        continue;
      }
    }
    // Skip for loop variable
    if (parent?.type === 'for_statement') {
      const left = parent.childForFieldName('left');
      if (left && left.id === id.id) {
        continue;
      }
    }
    scope.usedNames.add(id.text);
  }
}

// ============================================================================
// Go
// ============================================================================

function analyzeGo(root: Node, filePath: string): FineGrainedIssue[] {
  const issues: FineGrainedIssue[] = [];

  // Analyze structs for private fields (lowercase)
  const typeDecls = descendantsOfTypes(root, ['type_declaration']);
  for (const typeDecl of typeDecls) {
    const spec = typeDecl.namedChild(0);
    if (spec?.type !== 'type_spec') continue;

    const typeName = spec.childForFieldName('name')?.text;
    const typeBody = spec.childForFieldName('type');

    if (typeBody?.type === 'struct_type' && typeName) {
      const fieldList = typeBody.childForFieldName('fields') ?? typeBody.namedChild(0);
      if (!fieldList) continue;

      const privateFields = new Map<string, number>();
      const fieldDecls = descendantsOfTypes(fieldList, ['field_declaration']);

      for (const fd of fieldDecls) {
        const nameNode = fd.childForFieldName('name');
        if (nameNode && /^[a-z]/.test(nameNode.text)) {
          privateFields.set(nameNode.text, nameNode.startPosition.row + 1);
        }
      }

      // Collect uses in methods of this struct
      const usedFields = new Set<string>();
      const funcDecls = descendantsOfTypes(root, ['function_declaration', 'method_declaration']);

      for (const fn of funcDecls) {
        // Check if method receiver matches this struct
        const receiver = fn.childForFieldName('receiver');
        if (receiver) {
          const params = receiver.namedChildren.filter(c => c.type === 'parameter_declaration');
          for (const p of params) {
            const pType = p.childForFieldName('type');
            const typeText = pType?.text ?? '';
            if (typeText.includes(typeName)) {
              // Collect field uses in this method
              const selectors = descendantsOfTypes(fn, ['selector_expression']);
              for (const sel of selectors) {
                const field = sel.childForFieldName('field');
                if (field) {
                  usedFields.add(field.text);
                }
              }
            }
          }
        }
      }

      // Report unused private fields
      for (const [fieldName, line] of privateFields) {
        if (!usedFields.has(fieldName)) {
          issues.push({
            type: 'unused-private-field',
            file: filePath,
            line,
            symbolName: fieldName,
            className: typeName,
          });
        }
      }
    }
  }

  // Analyze functions for params and locals
  const funcDecls = descendantsOfTypes(root, ['function_declaration', 'method_declaration', 'func_literal']);
  for (const fn of funcDecls) {
    const scope: ScopeData = { symbols: [], usedNames: new Set(), dynamicClasses: new Set() };

    // Collect parameters
    const params = fn.childForFieldName('parameters');
    if (params) {
      const paramDecls = descendantsOfTypes(params, ['parameter_declaration']);
      for (const pd of paramDecls) {
        const nameNode = pd.childForFieldName('name');
        if (nameNode) {
          scope.symbols.push({
            name: nameNode.text,
            kind: 'parameter',
            line: nameNode.startPosition.row + 1,
          });
        }
      }
    }

    // Collect receiver (for methods)
    const receiver = fn.childForFieldName('receiver');
    if (receiver) {
      const paramDecls = descendantsOfTypes(receiver, ['parameter_declaration']);
      for (const pd of paramDecls) {
        const nameNode = pd.childForFieldName('name');
        if (nameNode) {
          scope.symbols.push({
            name: nameNode.text,
            kind: 'parameter',
            line: nameNode.startPosition.row + 1,
          });
        }
      }
    }

    // Collect locals
    const body = fn.childForFieldName('body');
    if (body) {
      collectGoLocals(body, scope);
      collectGoUses(body, scope);
    }

    // Report unused
    for (const sym of scope.symbols) {
      if (isIgnoredName(sym.name)) continue;
      if (!isUsed(sym.name, scope.usedNames)) {
        issues.push(toIssue(sym, filePath));
      }
    }
  }

  return issues;
}

function collectGoLocals(body: Node, scope: ScopeData): void {
  // Short variable declarations: x := ...
  const shortDecls = descendantsOfTypes(body, ['short_var_declaration']);
  for (const decl of shortDecls) {
    const left = decl.childForFieldName('left');
    if (left?.type === 'expression_list') {
      for (const child of left.namedChildren) {
        if (child.type === 'identifier') {
          scope.symbols.push({
            name: child.text,
            kind: 'local',
            line: child.startPosition.row + 1,
          });
        }
      }
    } else if (left?.type === 'identifier') {
      scope.symbols.push({
        name: left.text,
        kind: 'local',
        line: left.startPosition.row + 1,
      });
    }
  }

  // Var declarations
  const varDecls = descendantsOfTypes(body, ['var_declaration']);
  for (const decl of varDecls) {
    const specs = descendantsOfTypes(decl, ['var_spec']);
    for (const spec of specs) {
      const nameNode = spec.childForFieldName('name');
      if (nameNode?.type === 'identifier') {
        scope.symbols.push({
          name: nameNode.text,
          kind: 'local',
          line: nameNode.startPosition.row + 1,
        });
      }
    }
  }

  // Range clauses in for loops
  const rangeNodes = descendantsOfTypes(body, ['range_clause']);
  for (const range of rangeNodes) {
    const left = range.childForFieldName('left');
    if (left?.type === 'expression_list') {
      for (const child of left.namedChildren) {
        if (child.type === 'identifier' && child.text !== '_') {
          scope.symbols.push({
            name: child.text,
            kind: 'local',
            line: child.startPosition.row + 1,
          });
        }
      }
    }
  }
}

function collectGoUses(body: Node, scope: ScopeData): void {
  const idents = descendantsOfTypes(body, ['identifier']);
  for (const id of idents) {
    // Skip short_var_declaration left-hand side
    const parent = id.parent;
    if (parent?.type === 'expression_list') {
      const grandparent = parent.parent;
      if (grandparent?.type === 'short_var_declaration') {
        const left = grandparent.childForFieldName('left');
        if (left && left.id === parent.id) {
          continue;
        }
      }
    }
    // Skip var_spec name
    if (parent?.type === 'var_spec') {
      const nameNode = parent.childForFieldName('name');
      if (nameNode && nameNode.id === id.id) {
        continue;
      }
    }
    // Skip range_clause left-hand side
    if (parent?.type === 'expression_list') {
      const grandparent = parent.parent;
      if (grandparent?.type === 'range_clause') {
        const left = grandparent.childForFieldName('left');
        if (left && left.id === parent.id) {
          continue;
        }
      }
    }
    scope.usedNames.add(id.text);
  }
}

// ============================================================================
// Java
// ============================================================================

function analyzeJava(root: Node, filePath: string): FineGrainedIssue[] {
  const issues: FineGrainedIssue[] = [];

  // Analyze classes for private fields
  const classDecls = descendantsOfTypes(root, ['class_declaration']);
  for (const cls of classDecls) {
    const nameNode = cls.childForFieldName('name');
    const className = nameNode?.text ?? '<anonymous>';
    const body = cls.childForFieldName('body');
    if (!body) continue;

    const privateFields = new Map<string, number>();

    // Collect private fields
    const fieldDecls = descendantsOfTypes(body, ['field_declaration']);
    for (const fd of fieldDecls) {
      const modifiers = fd.childForFieldName('modifiers') ?? fd.namedChild(0);
      const hasPrivate = modifiers?.children.some(c => c.text === 'private');
      if (hasPrivate) {
        const declarator = fd.childForFieldName('declarator');
        if (declarator?.type === 'variable_declarator') {
          const varName = declarator.childForFieldName('name');
          if (varName) {
            privateFields.set(varName.text, varName.startPosition.row + 1);
          }
        }
        // Handle multiple declarators
        const declarators = descendantsOfTypes(fd, ['variable_declarator']);
        for (const d of declarators) {
          const varName = d.childForFieldName('name');
          if (varName) {
            privateFields.set(varName.text, varName.startPosition.row + 1);
          }
        }
      }
    }

    // Collect uses (only in methods, not in field declarations)
    const usedFields = new Set<string>();
    const methods = body.namedChildren.filter(c => 
      c.type === 'method_declaration' || c.type === 'constructor_declaration'
    );
    for (const method of methods) {
      // Field access: this.x or fieldName
      const idents = descendantsOfTypes(method, ['identifier']);
      for (const id of idents) {
        usedFields.add(id.text);
      }
      const fieldAccess = descendantsOfTypes(method, ['field_access']);
      for (const fa of fieldAccess) {
        const field = fa.childForFieldName('field');
        if (field) {
          usedFields.add(field.text);
        }
      }
    }

    // Report unused private fields
    for (const [fieldName, line] of privateFields) {
      if (!usedFields.has(fieldName)) {
        issues.push({
          type: 'unused-private-field',
          file: filePath,
          line,
          symbolName: fieldName,
          className,
        });
      }
    }
  }

  // Analyze methods for params and locals
  const methodDecls = descendantsOfTypes(root, ['method_declaration', 'constructor_declaration']);
  for (const method of methodDecls) {
    const scope: ScopeData = { symbols: [], usedNames: new Set(), dynamicClasses: new Set() };

    // Collect parameters
    const params = method.childForFieldName('parameters');
    if (params) {
      const formalParams = descendantsOfTypes(params, ['formal_parameter', 'spread_parameter']);
      for (const fp of formalParams) {
        const nameNode = fp.childForFieldName('name');
        if (nameNode) {
          scope.symbols.push({
            name: nameNode.text,
            kind: 'parameter',
            line: nameNode.startPosition.row + 1,
          });
        }
      }
    }

    // Collect locals
    const body = method.childForFieldName('body');
    if (body) {
      collectJavaLocals(body, scope);
      collectJavaUses(body, scope);
    }

    // Report unused
    for (const sym of scope.symbols) {
      if (isIgnoredName(sym.name)) continue;
      if (!isUsed(sym.name, scope.usedNames)) {
        issues.push(toIssue(sym, filePath));
      }
    }
  }

  return issues;
}

function collectJavaLocals(body: Node, scope: ScopeData): void {
  const localDecls = descendantsOfTypes(body, ['local_variable_declaration']);
  for (const decl of localDecls) {
    const declarators = descendantsOfTypes(decl, ['variable_declarator']);
    for (const d of declarators) {
      const nameNode = d.childForFieldName('name');
      if (nameNode) {
        scope.symbols.push({
          name: nameNode.text,
          kind: 'local',
          line: nameNode.startPosition.row + 1,
        });
      }
    }
  }

  // Enhanced for loop variables
  const enhancedFor = descendantsOfTypes(body, ['enhanced_for_statement']);
  for (const ef of enhancedFor) {
    const nameNode = ef.childForFieldName('name');
    if (nameNode) {
      scope.symbols.push({
        name: nameNode.text,
        kind: 'local',
        line: nameNode.startPosition.row + 1,
      });
    }
  }
}

function collectJavaUses(body: Node, scope: ScopeData): void {
  const idents = descendantsOfTypes(body, ['identifier']);
  for (const id of idents) {
    // Skip variable_declarator name
    const parent = id.parent;
    if (parent?.type === 'variable_declarator') {
      const nameNode = parent.childForFieldName('name');
      if (nameNode && nameNode.id === id.id) {
        continue;
      }
    }
    // Skip enhanced_for_statement variable
    if (parent?.type === 'enhanced_for_statement') {
      const nameNode = parent.childForFieldName('name');
      if (nameNode && nameNode.id === id.id) {
        continue;
      }
    }
    scope.usedNames.add(id.text);
  }
}

// ============================================================================
// Rust
// ============================================================================

function analyzeRust(root: Node, filePath: string): FineGrainedIssue[] {
  const issues: FineGrainedIssue[] = [];

  // Analyze structs for private fields (non-pub)
  const structItems = descendantsOfTypes(root, ['struct_item']);
  for (const structItem of structItems) {
    const nameNode = structItem.childForFieldName('name');
    const structName = nameNode?.text ?? '<anonymous>';
    const body = structItem.childForFieldName('body');
    if (!body) continue;

    const privateFields = new Map<string, number>();

    // Collect non-pub fields
    const fieldDecls = descendantsOfTypes(body, ['field_declaration']);
    for (const fd of fieldDecls) {
      // Check for pub visibility
      const hasPub = fd.children.some(c => c.type === 'visibility_modifier');
      if (!hasPub) {
        const fieldName = fd.childForFieldName('name');
        if (fieldName) {
          privateFields.set(fieldName.text, fieldName.startPosition.row + 1);
        }
      }
    }

    // Collect uses in impl blocks
    const usedFields = new Set<string>();
    const implBlocks = descendantsOfTypes(root, ['impl_item']);

    for (const impl of implBlocks) {
      const implType = impl.childForFieldName('type');
      if (implType?.text === structName || implType?.text?.includes(structName)) {
        const fieldExprs = descendantsOfTypes(impl, ['field_expression']);
        for (const fe of fieldExprs) {
          const field = fe.childForFieldName('field');
          if (field) {
            usedFields.add(field.text);
          }
        }
        // Also collect from struct expressions (initialization)
        const structExprs = descendantsOfTypes(impl, ['struct_expression']);
        for (const se of structExprs) {
          const fieldInits = descendantsOfTypes(se, ['field_initializer', 'shorthand_field_initializer']);
          for (const fi of fieldInits) {
            const fieldName = fi.childForFieldName('name') ?? fi.namedChild(0);
            if (fieldName) {
              usedFields.add(fieldName.text);
            }
          }
        }
      }
    }

    // Report unused private fields
    for (const [fieldName, line] of privateFields) {
      if (!usedFields.has(fieldName)) {
        issues.push({
          type: 'unused-private-field',
          file: filePath,
          line,
          symbolName: fieldName,
          className: structName,
        });
      }
    }
  }

  // Analyze functions for params and locals
  const funcItems = descendantsOfTypes(root, ['function_item', 'closure_expression']);
  for (const fn of funcItems) {
    const scope: ScopeData = { symbols: [], usedNames: new Set(), dynamicClasses: new Set() };

    // Collect parameters
    const params = fn.childForFieldName('parameters');
    if (params) {
      const paramNodes = descendantsOfTypes(params, ['parameter', 'self_parameter']);
      for (const p of paramNodes) {
        if (p.type === 'self_parameter') continue;
        const pattern = p.childForFieldName('pattern');
        if (pattern?.type === 'identifier') {
          scope.symbols.push({
            name: pattern.text,
            kind: 'parameter',
            line: pattern.startPosition.row + 1,
          });
        }
      }
    }

    // Collect locals
    const body = fn.childForFieldName('body');
    if (body) {
      collectRustLocals(body, scope);
      collectRustUses(body, scope);
    }

    // Report unused
    for (const sym of scope.symbols) {
      if (isIgnoredName(sym.name)) continue;
      if (!isUsed(sym.name, scope.usedNames)) {
        issues.push(toIssue(sym, filePath));
      }
    }
  }

  return issues;
}

function collectRustLocals(body: Node, scope: ScopeData): void {
  const letDecls = descendantsOfTypes(body, ['let_declaration']);
  for (const decl of letDecls) {
    const pattern = decl.childForFieldName('pattern');
    if (pattern?.type === 'identifier') {
      scope.symbols.push({
        name: pattern.text,
        kind: 'local',
        line: pattern.startPosition.row + 1,
      });
    } else if (pattern?.type === 'tuple_pattern') {
      for (const child of pattern.namedChildren) {
        if (child.type === 'identifier') {
          scope.symbols.push({
            name: child.text,
            kind: 'local',
            line: child.startPosition.row + 1,
          });
        }
      }
    }
  }

  // For loop variables
  const forExprs = descendantsOfTypes(body, ['for_expression']);
  for (const fe of forExprs) {
    const pattern = fe.childForFieldName('pattern');
    if (pattern?.type === 'identifier') {
      scope.symbols.push({
        name: pattern.text,
        kind: 'local',
        line: pattern.startPosition.row + 1,
      });
    }
  }
}

function collectRustUses(body: Node, scope: ScopeData): void {
  const idents = descendantsOfTypes(body, ['identifier']);
  for (const id of idents) {
    // Skip let_declaration pattern
    const parent = id.parent;
    if (parent?.type === 'let_declaration') {
      const pattern = parent.childForFieldName('pattern');
      if (pattern && pattern.id === id.id) {
        continue;
      }
    }
    // Skip tuple_pattern identifiers in let_declaration
    if (parent?.type === 'tuple_pattern') {
      const grandparent = parent.parent;
      if (grandparent?.type === 'let_declaration') {
        continue;
      }
    }
    // Skip for_expression pattern
    if (parent?.type === 'for_expression') {
      const pattern = parent.childForFieldName('pattern');
      if (pattern && pattern.id === id.id) {
        continue;
      }
    }
    scope.usedNames.add(id.text);
  }
}
