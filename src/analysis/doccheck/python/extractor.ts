/**
 * Python Documentation Checker - AST Extractor
 *
 * Extracts functions, classes, params, and docstrings from Python AST.
 *
 * @module analysis/doccheck/python/extractor
 */

import type { Node } from 'web-tree-sitter';
import type { FunctionInfo, ParamInfo, DocInfo, DocCheckOptions } from '../types.js';
import type { PyFunctionDocInfo, ClassAttributeInfo, ClassInfo, ClassDocInfo } from './types.js';
import { parseDocstring } from './docstring-parser.js';
import { extractNoqaCodes } from './noqa.js';

// ============================================================================
// Function Extraction
// ============================================================================

/**
 * Extract all functions and their documentation from AST.
 */
export function extractFunctions(
  root: Node,
  filePath: string,
  content: string,
  options: Required<DocCheckOptions>
): PyFunctionDocInfo[] {
  const result: PyFunctionDocInfo[] = [];
  const lines = content.split('\n');

  // Top-level functions
  for (const func of root.descendantsOfType('function_definition')) {
    // Check if this is a method (inside a class)
    const parent = func.parent;
    if (parent?.type === 'block' && parent.parent?.type === 'class_definition') {
      continue; // Will be handled as method
    }

    const funcInfo = extractFunctionInfo(func, filePath);
    const docInfo = extractDocstring(func, lines, options);
    const noqaCodes = extractNoqaCodes(func, lines);
    result.push({ func: funcInfo, doc: docInfo, node: func, noqaCodes });
  }

  // Class methods
  for (const cls of root.descendantsOfType('class_definition')) {
    const className = cls.childForFieldName('name')?.text || 'anonymous';
    const isPublicClass = !className.startsWith('_');

    const body = cls.childForFieldName('body');
    if (!body) continue;

    for (const method of body.descendantsOfType('function_definition')) {
      // Only direct children (not nested functions)
      if (method.parent !== body) continue;

      const funcInfo = extractMethodInfo(method, filePath, className, isPublicClass, options);
      const docInfo = extractDocstring(method, lines, options);
      const noqaCodes = extractNoqaCodes(method, lines);
      result.push({ func: funcInfo, doc: docInfo, node: method, noqaCodes });
    }
  }

  return result;
}

/**
 * Extract function info from AST node.
 */
export function extractFunctionInfo(func: Node, filePath: string): FunctionInfo {
  const name = func.childForFieldName('name')?.text || 'anonymous';
  const params = extractParams(func);
  const returnType = extractReturnAnnotation(func);

  return {
    name,
    file: filePath,
    line: func.startPosition.row + 1,
    params,
    returnType,
    isExported: !name.startsWith('_'),
    isAsync: func.children.some((c) => c.type === 'async'),
  };
}

/**
 * Extract method info from AST node.
 */
export function extractMethodInfo(
  method: Node,
  filePath: string,
  className: string,
  isClassPublic: boolean,
  options: Required<DocCheckOptions>
): FunctionInfo {
  const name = method.childForFieldName('name')?.text || 'anonymous';
  let params = extractParams(method);

  // Remove 'self' or 'cls' from params
  if (params.length > 0 && ['self', 'cls'].includes(params[0]!.name)) {
    params = params.slice(1);
  }

  const returnType = extractReturnAnnotation(method);
  const isPublicMethod = !name.startsWith('_') || name.startsWith('__') && name.endsWith('__');
  const isDunderMethod = name.startsWith('__') && name.endsWith('__');
  const isInitMethod = name === '__init__';

  // __init__ is checked if allowInitDocstring is true
  const shouldCheckInit = isInitMethod && options.allowInitDocstring;

  return {
    name,
    file: filePath,
    line: method.startPosition.row + 1,
    params,
    returnType,
    isExported: isClassPublic && (isPublicMethod && !isDunderMethod || shouldCheckInit),
    isAsync: method.children.some((c) => c.type === 'async'),
    className,
  };
}

/**
 * Extract parameters from function node.
 */
export function extractParams(func: Node): ParamInfo[] {
  const params: ParamInfo[] = [];
  const paramsNode = func.childForFieldName('parameters');

  if (!paramsNode) return params;

  for (const child of paramsNode.namedChildren) {
    if (child.type === 'identifier') {
      params.push({ name: child.text });
    } else if (child.type === 'typed_parameter') {
      const name = child.namedChild(0)?.text || '';
      const typeNode = child.childForFieldName('type');
      params.push({
        name,
        type: typeNode?.text,
      });
    } else if (child.type === 'default_parameter') {
      const name = child.childForFieldName('name')?.text || '';
      const value = child.childForFieldName('value')?.text;
      params.push({
        name,
        optional: true,
        defaultValue: value,
      });
    } else if (child.type === 'typed_default_parameter') {
      const name = child.childForFieldName('name')?.text || '';
      const typeNode = child.childForFieldName('type');
      const value = child.childForFieldName('value')?.text;
      params.push({
        name,
        type: typeNode?.text,
        optional: true,
        defaultValue: value,
      });
    } else if (child.type === 'list_splat_pattern' || child.type === 'dictionary_splat_pattern') {
      // *args or **kwargs - skip for doc checking
    }
  }

  return params;
}

/**
 * Extract return type annotation from function.
 */
export function extractReturnAnnotation(func: Node): string | undefined {
  const returnType = func.childForFieldName('return_type');
  return returnType?.text;
}

// ============================================================================
// Docstring Extraction
// ============================================================================

/**
 * Extract docstring from function node.
 */
export function extractDocstring(
  func: Node,
  lines: string[],
  options: Required<DocCheckOptions>
): DocInfo {
  const body = func.childForFieldName('body');
  if (!body) return { exists: false, params: [] };

  // First statement should be expression_statement with string
  const firstStmt = body.namedChild(0);
  if (!firstStmt || firstStmt.type !== 'expression_statement') {
    return { exists: false, params: [] };
  }

  const stringNode = firstStmt.namedChild(0);
  if (!stringNode || stringNode.type !== 'string') {
    return { exists: false, params: [] };
  }

  const rawDocstring = stringNode.text;
  // Remove quotes (""" or ''')
  const docstring = rawDocstring.slice(3, -3).trim();

  return parseDocstring(docstring, options.pythonStyle);
}

// ============================================================================
// Class Extraction
// ============================================================================

/**
 * Extract all classes and their documentation from AST.
 */
export function extractClasses(
  root: Node,
  filePath: string,
  content: string,
  options: Required<DocCheckOptions>
): ClassDocInfo[] {
  const result: ClassDocInfo[] = [];
  const lines = content.split('\n');

  for (const cls of root.descendantsOfType('class_definition')) {
    const classInfo = extractClassInfo(cls, filePath);
    const docInfo = extractClassDocstring(cls, lines, options);
    const noqaCodes = extractNoqaCodes(cls, lines);
    result.push({ cls: classInfo, doc: docInfo, noqaCodes });
  }

  return result;
}

/**
 * Extract class info from AST node.
 */
export function extractClassInfo(cls: Node, filePath: string): ClassInfo {
  const name = cls.childForFieldName('name')?.text || 'anonymous';
  const attributes = extractClassAttributes(cls);

  return {
    name,
    file: filePath,
    line: cls.startPosition.row + 1,
    attributes,
    isPublic: !name.startsWith('_'),
  };
}

/**
 * Extract class attributes from class body.
 * Includes: class variables, type annotations, @property methods.
 */
export function extractClassAttributes(cls: Node): ClassAttributeInfo[] {
  const attributes: ClassAttributeInfo[] = [];
  const body = cls.childForFieldName('body');
  if (!body) return attributes;

  for (const child of body.namedChildren) {
    // Type annotation: `x: int` or `x: int = value`
    if (child.type === 'expression_statement') {
      const expr = child.namedChild(0);
      if (expr?.type === 'assignment') {
        // x = value or x: type = value
        const left = expr.childForFieldName('left');
        const typeNode = expr.childForFieldName('type');
        if (left?.type === 'identifier') {
          const name = left.text;
          // Skip private attributes
          if (!name.startsWith('_')) {
            attributes.push({
              name,
              type: typeNode?.text,
            });
          }
        }
      } else if (expr?.type === 'type') {
        // Standalone type annotation: `x: int`
        // In tree-sitter-python, this might be an `annotated_assignment`
      }
    }

    // Annotated assignment (standalone or with value)
    if (child.type === 'expression_statement') {
      const expr = child.namedChild(0);
      // Check for pattern: identifier : type [= value]
      if (expr?.type === 'type') {
        // This is a bare annotation like `x: int`
        const identNode = expr.namedChild(0);
        const typeNode = expr.namedChild(1);
        if (identNode?.type === 'identifier' && !identNode.text.startsWith('_')) {
          attributes.push({
            name: identNode.text,
            type: typeNode?.text,
          });
        }
      }
    }

    // @property decorated methods
    if (child.type === 'decorated_definition') {
      const decorators = child.descendantsOfType('decorator');
      const isProperty = decorators.some(d => {
        const name = d.namedChild(0);
        return name?.text === 'property';
      });

      if (isProperty) {
        const funcDef = child.childForFieldName('definition');
        if (funcDef?.type === 'function_definition') {
          const name = funcDef.childForFieldName('name')?.text;
          const returnType = funcDef.childForFieldName('return_type')?.text;
          if (name && !name.startsWith('_')) {
            attributes.push({
              name,
              type: returnType,
              isProperty: true,
            });
          }
        }
      }
    }
  }

  return attributes;
}

/**
 * Extract docstring from class node (not method docstrings).
 */
export function extractClassDocstring(
  cls: Node,
  lines: string[],
  options: Required<DocCheckOptions>
): DocInfo {
  const body = cls.childForFieldName('body');
  if (!body) return { exists: false, params: [] };

  // First statement should be expression_statement with string
  const firstStmt = body.namedChild(0);
  if (!firstStmt || firstStmt.type !== 'expression_statement') {
    return { exists: false, params: [] };
  }

  const stringNode = firstStmt.namedChild(0);
  if (!stringNode || stringNode.type !== 'string') {
    return { exists: false, params: [] };
  }

  const rawDocstring = stringNode.text;
  // Remove quotes (""" or ''')
  const docstring = rawDocstring.slice(3, -3).trim();

  return parseDocstring(docstring, options.pythonStyle);
}
