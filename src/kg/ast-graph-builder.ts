/**
 * AST Graph Builder - Extract type relationships using Tree-sitter.
 * Based on DKB approach from Reliable Graph-RAG paper.
 * 
 * @module kg/ast-graph-builder
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { minimatch } from 'minimatch';
import type { Tree } from 'web-tree-sitter';
import { languageForFile, loadLanguage, ensureInit, Parser } from '../ast/parser.js';

// SyntaxNode type from Tree's rootNode
type SyntaxNode = ReturnType<Tree['rootNode']['child']> & {
  type: string;
  text: string;
  children: SyntaxNode[];
  namedChildren: SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
  previousNamedSibling: SyntaxNode | null;
  previousSibling: SyntaxNode | null;
  parent: SyntaxNode | null;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
};
import type { TreeSitterLanguageId } from '../ast/types.js';
import type {
  AstGraph,
  AstGraphNode,
  AstGraphEdge,
  AstGraphBuildOptions,
  AstGraphBuildResult,
  AstNodeKind,
  AstEdgeRelation,
} from './types.js';
import { DEFAULT_AST_GRAPH_OPTIONS } from './types.js';
import {
  calculateImportance,
  truncateContent,
  DEFAULT_CODE_FILTER_OPTIONS,
} from './code-filter.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('kg');

// ============================================================================
// Type Declaration Extraction
// ============================================================================

interface TypeDeclaration {
  name: string;
  kind: AstNodeKind;
  startLine: number;
  endLine: number;
  description?: string;
  content?: string;
  isExported?: boolean;
  /** Parent class/interface name for methods */
  parentName?: string;
}

/**
 * Check if a node is exported (public API).
 */
function isNodeExported(node: SyntaxNode, lang: TreeSitterLanguageId): boolean {
  if (lang === 'typescript' || lang === 'tsx' || lang === 'javascript') {
    // Check for 'export' keyword in parent or siblings
    const parent = node.parent;
    if (parent?.type === 'export_statement') return true;
    // Check if preceded by 'export' keyword
    const prev = node.previousSibling;
    if (prev?.type === 'export' || prev?.text === 'export') return true;
    // Check for 'export' in node text (e.g., export class Foo)
    const firstChild = node.children[0];
    if (firstChild?.text === 'export') return true;
  }
  if (lang === 'go') {
    // Go: exported if name starts with uppercase
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      const firstChar = nameNode.text[0];
      return firstChar === firstChar?.toUpperCase();
    }
  }
  if (lang === 'python') {
    // Python: not starting with underscore
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      return !nameNode.text.startsWith('_');
    }
  }
  if (lang === 'rust') {
    // Rust: has 'pub' keyword
    const firstChild = node.children[0];
    if (firstChild?.type === 'visibility_modifier') return true;
  }
  if (lang === 'java') {
    // Java: has 'public' modifier
    for (const child of node.children) {
      if (child.type === 'modifiers') {
        if (child.text.includes('public')) return true;
      }
    }
  }
  return false;
}

/**
 * Extract content for a node from file content.
 */
function extractNodeContent(
  node: SyntaxNode,
  fileContent: string,
  maxLength: number
): string {
  const content = node.text;
  return truncateContent(content, maxLength);
}

/**
 * Extract type declarations from AST.
 */
function extractTypeDeclarations(
  tree: Tree,
  lang: TreeSitterLanguageId,
  _filePath: string,
  fileContent: string,
  maxContentLength: number
): TypeDeclaration[] {
  const declarations: TypeDeclaration[] = [];
  const root = tree.rootNode;

  // TypeScript/JavaScript class and interface declarations
  if (lang === 'typescript' || lang === 'tsx' || lang === 'javascript') {
    traverseNode(root, (node) => {
      // Class declarations
      if (node.type === 'class_declaration' || node.type === 'class') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          declarations.push({
            name: nameNode.text,
            kind: 'class',
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            description: extractLeadingComment(node),
            content: extractNodeContent(node, fileContent, maxContentLength),
            isExported: isNodeExported(node, lang),
          });
          // Extract methods from class
          extractClassMethods(node, nameNode.text, lang, fileContent, maxContentLength, declarations);
        }
      }

      // Interface declarations (TypeScript)
      if (node.type === 'interface_declaration') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          declarations.push({
            name: nameNode.text,
            kind: 'interface',
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            description: extractLeadingComment(node),
            content: extractNodeContent(node, fileContent, maxContentLength),
            isExported: isNodeExported(node, lang),
          });
        }
      }

      // Type alias declarations (TypeScript)
      if (node.type === 'type_alias_declaration') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          declarations.push({
            name: nameNode.text,
            kind: 'type',
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            description: extractLeadingComment(node),
            content: extractNodeContent(node, fileContent, maxContentLength),
            isExported: isNodeExported(node, lang),
          });
        }
      }

      // Enum declarations
      if (node.type === 'enum_declaration') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          declarations.push({
            name: nameNode.text,
            kind: 'enum',
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            description: extractLeadingComment(node),
            content: extractNodeContent(node, fileContent, maxContentLength),
            isExported: isNodeExported(node, lang),
          });
        }
      }

      // Top-level function declarations
      if (node.type === 'function_declaration' || node.type === 'lexical_declaration') {
        extractTopLevelFunctions(node, lang, fileContent, maxContentLength, declarations);
      }
    });
  }

  // Python class and function declarations
  if (lang === 'python') {
    traverseNode(root, (node) => {
      if (node.type === 'class_definition') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          declarations.push({
            name: nameNode.text,
            kind: 'class',
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            description: extractDocstring(node),
            content: extractNodeContent(node, fileContent, maxContentLength),
            isExported: isNodeExported(node, lang),
          });
          // Extract methods from class
          extractPythonMethods(node, nameNode.text, fileContent, maxContentLength, declarations);
        }
      }
      // Top-level functions
      if (node.type === 'function_definition' && node.parent?.type === 'module') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          declarations.push({
            name: nameNode.text,
            kind: 'function',
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            description: extractDocstring(node),
            content: extractNodeContent(node, fileContent, maxContentLength),
            isExported: isNodeExported(node, lang),
          });
        }
      }
    });
  }

  // Java class/interface declarations
  if (lang === 'java') {
    traverseNode(root, (node) => {
      if (node.type === 'class_declaration') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          declarations.push({
            name: nameNode.text,
            kind: 'class',
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            description: extractJavadoc(node),
            content: extractNodeContent(node, fileContent, maxContentLength),
            isExported: isNodeExported(node, lang),
          });
          // Extract methods from class
          extractJavaMethods(node, nameNode.text, fileContent, maxContentLength, declarations);
        }
      }
      if (node.type === 'interface_declaration') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          declarations.push({
            name: nameNode.text,
            kind: 'interface',
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            description: extractJavadoc(node),
            content: extractNodeContent(node, fileContent, maxContentLength),
            isExported: isNodeExported(node, lang),
          });
        }
      }
      if (node.type === 'enum_declaration') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          declarations.push({
            name: nameNode.text,
            kind: 'enum',
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            description: extractJavadoc(node),
            content: extractNodeContent(node, fileContent, maxContentLength),
            isExported: isNodeExported(node, lang),
          });
        }
      }
    });
  }

  // Go type and function declarations
  if (lang === 'go') {
    traverseNode(root, (node) => {
      if (node.type === 'type_declaration') {
        const specNode = node.namedChildren.find((c: SyntaxNode) => c.type === 'type_spec');
        if (specNode) {
          const nameNode = specNode.childForFieldName('name');
          const typeNode = specNode.childForFieldName('type');
          if (nameNode) {
            const kind: AstNodeKind = typeNode?.type === 'interface_type' ? 'interface' : 'type';
            declarations.push({
              name: nameNode.text,
              kind,
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              description: extractLeadingComment(node),
              content: extractNodeContent(node, fileContent, maxContentLength),
              isExported: isNodeExported(node, lang),
            });
          }
        }
      }
      // Go functions
      if (node.type === 'function_declaration') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          declarations.push({
            name: nameNode.text,
            kind: 'function',
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            description: extractLeadingComment(node),
            content: extractNodeContent(node, fileContent, maxContentLength),
            isExported: isNodeExported(node, lang),
          });
        }
      }
      // Go methods (function with receiver)
      if (node.type === 'method_declaration') {
        const nameNode = node.childForFieldName('name');
        const receiverNode = node.childForFieldName('receiver');
        if (nameNode && receiverNode) {
          const receiverType = extractGoReceiverType(receiverNode);
          declarations.push({
            name: nameNode.text,
            kind: 'method',
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            description: extractLeadingComment(node),
            content: extractNodeContent(node, fileContent, maxContentLength),
            isExported: isNodeExported(node, lang),
            parentName: receiverType,
          });
        }
      }
    });
  }

  // Rust struct/trait/enum declarations
  if (lang === 'rust') {
    traverseNode(root, (node) => {
      if (node.type === 'struct_item') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          declarations.push({
            name: nameNode.text,
            kind: 'class', // Rust struct ≈ class
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            description: extractRustDoc(node),
            content: extractNodeContent(node, fileContent, maxContentLength),
            isExported: isNodeExported(node, lang),
          });
        }
      }
      if (node.type === 'trait_item') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          declarations.push({
            name: nameNode.text,
            kind: 'interface', // Rust trait ≈ interface
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            description: extractRustDoc(node),
            content: extractNodeContent(node, fileContent, maxContentLength),
            isExported: isNodeExported(node, lang),
          });
        }
      }
      if (node.type === 'enum_item') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          declarations.push({
            name: nameNode.text,
            kind: 'enum',
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            description: extractRustDoc(node),
            content: extractNodeContent(node, fileContent, maxContentLength),
            isExported: isNodeExported(node, lang),
          });
        }
      }
      // Rust functions
      if (node.type === 'function_item') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          declarations.push({
            name: nameNode.text,
            kind: 'function',
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            description: extractRustDoc(node),
            content: extractNodeContent(node, fileContent, maxContentLength),
            isExported: isNodeExported(node, lang),
          });
        }
      }
    });
  }

  return declarations;
}

// ============================================================================
// Method Extraction Helpers
// ============================================================================

/**
 * Extract methods from TypeScript/JavaScript class.
 */
function extractClassMethods(
  classNode: SyntaxNode,
  className: string,
  lang: TreeSitterLanguageId,
  fileContent: string,
  maxContentLength: number,
  declarations: TypeDeclaration[]
): void {
  const body = classNode.childForFieldName('body');
  if (!body) return;

  for (const child of body.namedChildren) {
    if (child.type === 'method_definition' || child.type === 'public_field_definition') {
      const nameNode = child.childForFieldName('name');
      if (nameNode && child.type === 'method_definition') {
        declarations.push({
          name: nameNode.text,
          kind: 'method',
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          description: extractLeadingComment(child),
          content: extractNodeContent(child, fileContent, maxContentLength),
          isExported: isNodeExported(classNode, lang), // Methods inherit class export status
          parentName: className,
        });
      }
    }
  }
}

/**
 * Extract methods from Python class.
 */
function extractPythonMethods(
  classNode: SyntaxNode,
  className: string,
  fileContent: string,
  maxContentLength: number,
  declarations: TypeDeclaration[]
): void {
  const body = classNode.childForFieldName('body');
  if (!body) return;

  for (const child of body.namedChildren) {
    if (child.type === 'function_definition') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        declarations.push({
          name: nameNode.text,
          kind: 'method',
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          description: extractDocstring(child),
          content: extractNodeContent(child, fileContent, maxContentLength),
          isExported: !nameNode.text.startsWith('_'),
          parentName: className,
        });
      }
    }
  }
}

/**
 * Extract methods from Java class.
 */
function extractJavaMethods(
  classNode: SyntaxNode,
  className: string,
  fileContent: string,
  maxContentLength: number,
  declarations: TypeDeclaration[]
): void {
  const body = classNode.childForFieldName('body');
  if (!body) return;

  for (const child of body.namedChildren) {
    if (child.type === 'method_declaration') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        // Check for public modifier
        let isPublic = false;
        for (const mod of child.children) {
          if (mod.type === 'modifiers' && mod.text.includes('public')) {
            isPublic = true;
            break;
          }
        }
        declarations.push({
          name: nameNode.text,
          kind: 'method',
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          description: extractJavadoc(child),
          content: extractNodeContent(child, fileContent, maxContentLength),
          isExported: isPublic,
          parentName: className,
        });
      }
    }
  }
}

/**
 * Extract top-level functions from TypeScript/JavaScript.
 */
function extractTopLevelFunctions(
  node: SyntaxNode,
  lang: TreeSitterLanguageId,
  fileContent: string,
  maxContentLength: number,
  declarations: TypeDeclaration[]
): void {
  if (node.type === 'function_declaration') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      declarations.push({
        name: nameNode.text,
        kind: 'function',
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        description: extractLeadingComment(node),
        content: extractNodeContent(node, fileContent, maxContentLength),
        isExported: isNodeExported(node, lang),
      });
    }
  }
  // Arrow functions in const declarations
  if (node.type === 'lexical_declaration') {
    for (const child of node.namedChildren) {
      if (child.type === 'variable_declarator') {
        const nameNode = child.childForFieldName('name');
        const valueNode = child.childForFieldName('value');
        if (nameNode && valueNode?.type === 'arrow_function') {
          declarations.push({
            name: nameNode.text,
            kind: 'function',
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            description: extractLeadingComment(node),
            content: extractNodeContent(node, fileContent, maxContentLength),
            isExported: isNodeExported(node, lang),
          });
        }
      }
    }
  }
}

/**
 * Extract receiver type from Go method.
 */
function extractGoReceiverType(receiverNode: SyntaxNode): string | undefined {
  // Receiver is like (r *ReceiverType) or (r ReceiverType)
  for (const child of receiverNode.namedChildren) {
    if (child.type === 'parameter_declaration') {
      const typeNode = child.childForFieldName('type');
      if (typeNode) {
        // Handle pointer types
        if (typeNode.type === 'pointer_type') {
          const innerType = typeNode.namedChildren[0];
          return innerType?.text;
        }
        return typeNode.text;
      }
    }
  }
  return undefined;
}

// ============================================================================
// Relation Extraction
// ============================================================================

interface TypeRelation {
  src: string;
  tgt: string;
  relation: AstEdgeRelation;
}

/**
 * Extract type relationships (extends/implements/injects) from AST.
 */
function extractTypeRelations(
  tree: Tree,
  lang: TreeSitterLanguageId,
  knownTypes: Set<string>
): TypeRelation[] {
  const relations: TypeRelation[] = [];
  const root = tree.rootNode;

  if (lang === 'typescript' || lang === 'tsx' || lang === 'javascript') {
    traverseNode(root, (node) => {
      // Class extends
      if (node.type === 'class_declaration' || node.type === 'class') {
        const nameNode = node.childForFieldName('name');
        const className = nameNode?.text;
        if (!className) return;

        // Check heritage clause
        const heritageNode = node.children.find((c: { type: string }) => c.type === 'class_heritage');
        if (heritageNode) {
          // extends clause
          const extendsClause = heritageNode.children.find((c: { type: string }) => c.type === 'extends_clause');
          if (extendsClause) {
            const typeNode = extendsClause.namedChildren[0];
            if (typeNode) {
              const baseName = extractTypeName(typeNode);
              if (baseName && knownTypes.has(baseName)) {
                relations.push({ src: className, tgt: baseName, relation: 'extends' });
              }
            }
          }

          // implements clause
          const implementsClause = heritageNode.children.find((c: { type: string }) => c.type === 'implements_clause');
          if (implementsClause) {
            for (const child of implementsClause.namedChildren) {
              const interfaceName = extractTypeName(child);
              if (interfaceName && knownTypes.has(interfaceName)) {
                relations.push({ src: className, tgt: interfaceName, relation: 'implements' });
              }
            }
          }
        }

        // Constructor injection (field types)
        extractFieldInjections(node, className, knownTypes, relations);
      }

      // Interface extends
      if (node.type === 'interface_declaration') {
        const nameNode = node.childForFieldName('name');
        const interfaceName = nameNode?.text;
        if (!interfaceName) return;

        const extendsClause = node.children.find((c: { type: string }) => c.type === 'extends_type_clause');
        if (extendsClause) {
          for (const child of extendsClause.namedChildren) {
            const baseName = extractTypeName(child);
            if (baseName && knownTypes.has(baseName)) {
              relations.push({ src: interfaceName, tgt: baseName, relation: 'extends' });
            }
          }
        }
      }
    });
  }

  if (lang === 'python') {
    traverseNode(root, (node) => {
      if (node.type === 'class_definition') {
        const nameNode = node.childForFieldName('name');
        const className = nameNode?.text;
        if (!className) return;

        // Check base classes
        const argList = node.childForFieldName('superclasses');
        if (argList) {
          for (const arg of argList.namedChildren) {
            const baseName = arg.text;
            if (baseName && knownTypes.has(baseName)) {
              relations.push({ src: className, tgt: baseName, relation: 'extends' });
            }
          }
        }
      }
    });
  }

  if (lang === 'java') {
    traverseNode(root, (node) => {
      if (node.type === 'class_declaration') {
        const nameNode = node.childForFieldName('name');
        const className = nameNode?.text;
        if (!className) return;

        // extends
        const superclass = node.childForFieldName('superclass');
        if (superclass) {
          const baseName = extractTypeName(superclass);
          if (baseName && knownTypes.has(baseName)) {
            relations.push({ src: className, tgt: baseName, relation: 'extends' });
          }
        }

        // implements
        const interfaces = node.childForFieldName('interfaces');
        if (interfaces) {
          for (const child of interfaces.namedChildren) {
            const interfaceName = extractTypeName(child);
            if (interfaceName && knownTypes.has(interfaceName)) {
              relations.push({ src: className, tgt: interfaceName, relation: 'implements' });
            }
          }
        }
      }
    });
  }

  if (lang === 'rust') {
    traverseNode(root, (node) => {
      // impl Trait for Struct
      if (node.type === 'impl_item') {
        const traitNode = node.childForFieldName('trait');
        const typeNode = node.childForFieldName('type');
        if (traitNode && typeNode) {
          const traitName = extractTypeName(traitNode);
          const typeName = extractTypeName(typeNode);
          if (traitName && typeName && knownTypes.has(traitName)) {
            relations.push({ src: typeName, tgt: traitName, relation: 'implements' });
          }
        }
      }
    });
  }

  return relations;
}

/**
 * Extract field type injections (constructor parameters, class fields).
 */
function extractFieldInjections(
  classNode: SyntaxNode,
  className: string,
  knownTypes: Set<string>,
  relations: TypeRelation[]
): void {
  traverseNode(classNode, (node) => {
    // Constructor parameters
    if (node.type === 'method_definition' && node.childForFieldName('name')?.text === 'constructor') {
      const params = node.childForFieldName('parameters');
      if (params) {
        for (const param of params.namedChildren) {
          const typeAnnotation = param.children.find((c: { type: string }) => c.type === 'type_annotation');
          if (typeAnnotation) {
            const typeName = extractTypeName(typeAnnotation);
            if (typeName && knownTypes.has(typeName)) {
              relations.push({ src: className, tgt: typeName, relation: 'injects' });
            }
          }
        }
      }
    }

    // Public fields with type annotations
    if (node.type === 'public_field_definition') {
      const typeAnnotation = node.children.find((c: { type: string }) => c.type === 'type_annotation');
      if (typeAnnotation) {
        const typeName = extractTypeName(typeAnnotation);
        if (typeName && knownTypes.has(typeName)) {
          relations.push({ src: className, tgt: typeName, relation: 'injects' });
        }
      }
    }
  });
}

// ============================================================================
// Helper Functions
// ============================================================================

function traverseNode(node: SyntaxNode, callback: (node: SyntaxNode) => void): void {
  callback(node);
  for (const child of node.children) {
    traverseNode(child, callback);
  }
}

function extractTypeName(node: SyntaxNode): string | null {
  // Handle common type node patterns
  if (node.type === 'identifier' || node.type === 'type_identifier') {
    return node.text;
  }
  // For generic types, get the base type
  if (node.type === 'generic_type' || node.type === 'parameterized_type') {
    const nameNode = node.namedChildren[0];
    return nameNode ? extractTypeName(nameNode) : null;
  }
  // For type annotations, get the inner type
  if (node.type === 'type_annotation') {
    const typeNode = node.namedChildren[0];
    return typeNode ? extractTypeName(typeNode) : null;
  }
  // Fallback: first named child or text
  const firstNamed = node.namedChildren[0];
  if (firstNamed) {
    return extractTypeName(firstNamed);
  }
  return node.text.split('<')[0]?.trim() || null;
}

function extractLeadingComment(node: SyntaxNode): string | undefined {
  const prev = node.previousNamedSibling;
  if (prev && prev.type === 'comment') {
    return cleanComment(prev.text);
  }
  return undefined;
}

function extractDocstring(node: SyntaxNode): string | undefined {
  // Python docstring is first string in class/function body
  const body = node.childForFieldName('body');
  if (body) {
    const first = body.namedChildren[0];
    if (first?.type === 'expression_statement') {
      const str = first.namedChildren[0];
      if (str?.type === 'string') {
        return cleanComment(str.text);
      }
    }
  }
  return undefined;
}

function extractJavadoc(node: SyntaxNode): string | undefined {
  const prev = node.previousSibling;
  if (prev && prev.type === 'block_comment') {
    return cleanComment(prev.text);
  }
  return undefined;
}

function extractRustDoc(node: SyntaxNode): string | undefined {
  const prev = node.previousNamedSibling;
  if (prev && (prev.type === 'line_comment' || prev.type === 'block_comment')) {
    return cleanComment(prev.text);
  }
  return undefined;
}

function cleanComment(text: string): string {
  return text
    .replace(/^\/\*\*?|\*\/$/g, '')
    .replace(/^\/\/+\s?/gm, '')
    .replace(/^\s*\*\s?/gm, '')
    .replace(/^["']{3}|["']{3}$/g, '')
    .trim()
    .slice(0, 200); // Limit length
}

// ============================================================================
// File Collection
// ============================================================================

async function collectSourceFiles(
  rootPath: string,
  options: AstGraphBuildOptions
): Promise<string[]> {
  const files: string[] = [];
  const maxFiles = options.maxFiles ?? 1000;

  async function walk(dir: string): Promise<void> {
    if (files.length >= maxFiles) return;

    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) return;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, '/');

      // Check exclude patterns
      if (options.excludePatterns?.some(p => minimatch(relativePath, p))) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        // Check if supported language
        const lang = languageForFile(fullPath);
        if (lang) {
          files.push(fullPath);
        }
      }
    }
  }

  await walk(rootPath);
  return files;
}

// ============================================================================
// Main Builder
// ============================================================================

/**
 * Build AST-based knowledge graph for a code repository.
 */
export async function buildAstGraph(
  repoPath: string,
  options?: AstGraphBuildOptions
): Promise<AstGraphBuildResult> {
  const opts = { ...DEFAULT_AST_GRAPH_OPTIONS, ...options };
  const startTime = Date.now();
  const errors: string[] = [];

  const graph: AstGraph = {
    nodes: new Map(),
    edges: [],
  };

  // Initialize tree-sitter
  await ensureInit();

  // Collect source files
  const files = await collectSourceFiles(repoPath, opts);
  logger.info(`Found ${files.length} source files to analyze`);

  const maxContentLength = DEFAULT_CODE_FILTER_OPTIONS.maxContentLength;

  // Pass 1: Extract all type declarations
  for (const filePath of files) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const lang = languageForFile(filePath);
      if (!lang) continue;

      const language = await loadLanguage(lang);
      const parser = new Parser();
      parser.setLanguage(language);
      const tree = parser.parse(content);
      if (!tree) {
        parser.delete();
        continue;
      }

      try {
        const relativePath = path.relative(repoPath, filePath).replace(/\\/g, '/');
        const declarations = extractTypeDeclarations(tree, lang, relativePath, content, maxContentLength);

        for (const decl of declarations) {
          // Use unique key: for methods, include parent name
          const nodeKey = decl.parentName 
            ? `${decl.parentName}.${decl.name}`
            : decl.name;

          const node: AstGraphNode = {
            name: decl.name,
            kind: decl.kind,
            filePath: relativePath,
            startLine: decl.startLine,
            endLine: decl.endLine,
            description: decl.description,
            content: decl.content,
            isExported: decl.isExported,
          };

          // Calculate importance score
          node.importance = calculateImportance(node);

          graph.nodes.set(nodeKey, node);

          // Add 'contains' edge for methods/functions belonging to a class
          if (decl.parentName && graph.nodes.has(decl.parentName)) {
            graph.edges.push({
              src: decl.parentName,
              tgt: nodeKey,
              relation: 'contains',
              srcFile: relativePath,
            });
          }
        }
      } finally {
        tree.delete();
        parser.delete();
      }
    } catch (err) {
      const msg = `Failed to extract declarations from ${filePath}: ${err}`;
      logger.warn(msg);
      errors.push(msg);
    }
  }

  logger.info(`Extracted ${graph.nodes.size} declarations (types + functions/methods)`);

  // Pass 2: Extract relationships
  const knownTypes = new Set(graph.nodes.keys());

  for (const filePath of files) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const lang = languageForFile(filePath);
      if (!lang) continue;

      const language = await loadLanguage(lang);
      const parser = new Parser();
      parser.setLanguage(language);
      const tree = parser.parse(content);
      if (!tree) {
        parser.delete();
        continue;
      }

      try {
        const relativePath = path.relative(repoPath, filePath).replace(/\\/g, '/');
        const relations = extractTypeRelations(tree, lang, knownTypes);

        for (const rel of relations) {
          graph.edges.push({
            src: rel.src,
            tgt: rel.tgt,
            relation: rel.relation,
            srcFile: relativePath,
          });
        }
      } finally {
        tree.delete();
        parser.delete();
      }
    } catch (err) {
      const msg = `Failed to extract relations from ${filePath}: ${err}`;
      logger.warn(msg);
      errors.push(msg);
    }
  }

  logger.info(`Extracted ${graph.edges.length} type relationships`);

  return {
    graph,
    stats: {
      filesProcessed: files.length,
      nodesCount: graph.nodes.size,
      edgesCount: graph.edges.length,
      durationMs: Date.now() - startTime,
    },
    errors,
  };
}
