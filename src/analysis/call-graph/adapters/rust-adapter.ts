/**
 * Rust Adapter for Call Graph Analysis
 *
 * Uses tree-sitter to parse Rust code and extract:
 * - Function definitions (fn)
 * - Method implementations (impl blocks)
 * - Trait definitions
 * - Function/method calls
 *
 * @module analysis/call-graph/adapters/rust-adapter
 */

import * as path from 'path';
import * as fs from 'fs';
import { createRequire } from 'node:module';
import { Language, Parser, type Node } from 'web-tree-sitter';
import {
  CallGraphAdapter,
  CallGraphLanguage,
  CallGraphNode,
  CallHierarchyItem,
  IncomingCall,
  OutgoingCall,
  SourceLocation,
  SymbolDefinition,
  SymbolKind,
  SymbolReference,
  createNodeId,
} from '../types.js';

const require = createRequire(import.meta.url);

// ============================================================================
// Tree-sitter Setup
// ============================================================================

let parserPromise: Promise<Parser> | null = null;
let languagePromise: Promise<Language> | null = null;

async function getParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init();
      const parser = new Parser();
      const language = await getLanguage();
      parser.setLanguage(language);
      return parser;
    })();
  }
  return parserPromise;
}

async function getLanguage(): Promise<Language> {
  if (!languagePromise) {
    languagePromise = (async () => {
      await Parser.init();
      const wasmPath = require.resolve(
        '@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm'
      );
      return Language.load(wasmPath);
    })();
  }
  return languagePromise;
}

// ============================================================================
// Helper Types
// ============================================================================

interface RustFunction {
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  params: string[];
  returnType?: string;
  doc?: string;
  implType?: string; // For methods: the impl type
  isPublic: boolean;
  isAsync: boolean;
  visibility: 'pub' | 'pub(crate)' | 'pub(super)' | 'private';
}

interface RustCall {
  name: string;
  line: number;
  column: number;
  receiver?: string;
}

// ============================================================================
// AST Helpers
// ============================================================================

function getNodeText(node: Node | null): string {
  return node?.text ?? '';
}

function getDoc(node: Node): string | undefined {
  // Rust doc comments are siblings before the declaration
  let sibling = node.previousNamedSibling;
  const comments: string[] = [];

  while (sibling && (sibling.type === 'line_comment' || sibling.type === 'block_comment')) {
    const text = sibling.text;
    // Check if it's a doc comment (/// or /** */)
    if (text.startsWith('///') || text.startsWith('/**')) {
      const cleaned = text
        .replace(/^\/\/\/\s?/, '')
        .replace(/^\/\*\*\s?|\s?\*\/$/g, '')
        .replace(/^\s*\*\s?/gm, '');
      comments.unshift(cleaned.trim());
    }
    sibling = sibling.previousNamedSibling;
  }

  return comments.length > 0 ? comments.join('\n') : undefined;
}

function getVisibility(node: Node): RustFunction['visibility'] {
  const visMarker = node.childForFieldName('visibility_modifier') || 
                    node.namedChildren.find(c => c.type === 'visibility_modifier');
  
  if (!visMarker) return 'private';
  
  const text = visMarker.text;
  if (text === 'pub') return 'pub';
  if (text.includes('crate')) return 'pub(crate)';
  if (text.includes('super')) return 'pub(super)';
  return 'pub';
}

function getParameters(node: Node): string[] {
  const params: string[] = [];
  const paramList = node.childForFieldName('parameters');

  if (paramList) {
    for (const child of paramList.namedChildren) {
      if (child.type === 'parameter') {
        const pattern = child.childForFieldName('pattern');
        if (pattern) {
          const name = pattern.text;
          if (name !== 'self' && name !== '&self' && name !== '&mut self') {
            params.push(name);
          }
        }
      } else if (child.type === 'self_parameter') {
        // Skip self
      }
    }
  }

  return params;
}

function getReturnType(node: Node): string | undefined {
  const returnType = node.childForFieldName('return_type');
  return returnType ? returnType.text.replace(/^->\s*/, '') : undefined;
}

function isAsync(node: Node): boolean {
  // Check for async keyword in function modifiers
  for (const child of node.children) {
    if (child.type === 'async') return true;
  }
  return false;
}

// ============================================================================
// Rust Adapter
// ============================================================================

export class RustAdapter implements CallGraphAdapter {
  readonly language: CallGraphLanguage = 'rust';

  private rootPath: string = '';
  private fileCache: Map<string, string> = new Map();
  private functionCache: Map<string, RustFunction[]> = new Map();
  private callCache: Map<string, RustCall[]> = new Map();
  private crateNameCache: Map<string, string> = new Map();

  /**
   * Initialize the adapter.
   */
  async initialize(rootPath: string): Promise<void> {
    this.rootPath = rootPath;
    await getParser();
    
    // Try to detect crate name from Cargo.toml
    try {
      const cargoPath = path.join(rootPath, 'Cargo.toml');
      if (fs.existsSync(cargoPath)) {
        const content = fs.readFileSync(cargoPath, 'utf-8');
        const match = content.match(/name\s*=\s*"([^"]+)"/);
        if (match) {
          this.crateNameCache.set(rootPath, match[1]!);
        }
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Shutdown the adapter.
   */
  async shutdown(): Promise<void> {
    this.fileCache.clear();
    this.functionCache.clear();
    this.callCache.clear();
    this.crateNameCache.clear();
  }

  /**
   * Check if file is Rust.
   */
  supportsFile(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === '.rs';
  }

  /**
   * Find all references to a symbol.
   */
  async findReferences(
    filePath: string,
    line: number,
    column: number
  ): Promise<SymbolReference[]> {
    const results: SymbolReference[] = [];

    const functions = await this.parseFunctions(filePath);
    const targetFunc = functions.find(
      (f) => f.line === line || (f.line <= line && f.endLine >= line)
    );

    if (!targetFunc) return results;

    for (const [cachedPath, calls] of this.callCache) {
      for (const call of calls) {
        if (this.matchesCall(call, targetFunc)) {
          results.push({
            filePath: cachedPath,
            location: {
              filePath: cachedPath,
              line: call.line,
              column: call.column,
            },
            isDefinition: false,
          });
        }
      }
    }

    return results;
  }

  /**
   * Get definition of a symbol.
   */
  async getDefinition(
    filePath: string,
    line: number,
    column: number
  ): Promise<SymbolDefinition | null> {
    const functions = await this.parseFunctions(filePath);
    const func = functions.find(
      (f) => f.line === line || (f.line <= line && f.endLine >= line)
    );

    if (!func) return null;

    return {
      name: func.name,
      qualifiedName: func.qualifiedName,
      kind: func.kind,
      location: {
        filePath,
        line: func.line,
        column: func.column,
      },
      signature: this.buildSignature(func),
      documentation: func.doc,
    };
  }

  /**
   * Prepare call hierarchy item at position.
   */
  async prepareCallHierarchy(
    filePath: string,
    line: number,
    column: number
  ): Promise<CallHierarchyItem | null> {
    const functions = await this.parseFunctions(filePath);
    const func = functions.find(
      (f) => f.line === line || (f.line <= line && f.endLine >= line)
    );

    if (!func) return null;

    return {
      name: func.name,
      kind: func.kind,
      location: {
        filePath,
        line: func.line,
        column: func.column,
        endLine: func.endLine,
        endColumn: func.endColumn,
      },
      selectionLocation: {
        filePath,
        line: func.line,
        column: func.column,
      },
      detail: func.implType || path.basename(filePath),
    };
  }

  /**
   * Get incoming calls (who calls this symbol).
   */
  async getIncomingCalls(item: CallHierarchyItem): Promise<IncomingCall[]> {
    const results: IncomingCall[] = [];

    const targetFunctions = await this.parseFunctions(item.location.filePath);
    const targetFunc = targetFunctions.find(
      (f) => f.line === item.location.line
    );

    if (!targetFunc) return results;

    for (const [filePath, calls] of this.callCache) {
      const functions = await this.parseFunctions(filePath);

      for (const call of calls) {
        if (this.matchesCall(call, targetFunc)) {
          const container = functions.find(
            (f) => f.line <= call.line && f.endLine >= call.line
          );

          if (container) {
            results.push({
              from: {
                name: container.name,
                kind: container.kind,
                location: {
                  filePath,
                  line: container.line,
                  column: container.column,
                  endLine: container.endLine,
                  endColumn: container.endColumn,
                },
                selectionLocation: {
                  filePath,
                  line: container.line,
                  column: container.column,
                },
                detail: container.implType,
              },
              fromRanges: [
                {
                  filePath,
                  line: call.line,
                  column: call.column,
                },
              ],
            });
          }
        }
      }
    }

    return results;
  }

  /**
   * Get outgoing calls (what this symbol calls).
   */
  async getOutgoingCalls(item: CallHierarchyItem): Promise<OutgoingCall[]> {
    const results: OutgoingCall[] = [];
    const calls = this.callCache.get(item.location.filePath) || [];

    const callsInRange = calls.filter(
      (c) =>
        c.line >= item.location.line &&
        c.line <= (item.location.endLine ?? item.location.line + 100)
    );

    for (const call of callsInRange) {
      const targetFunc = await this.findFunctionByName(call.name, call.receiver);

      if (targetFunc) {
        results.push({
          to: {
            name: targetFunc.func.name,
            kind: targetFunc.func.kind,
            location: {
              filePath: targetFunc.filePath,
              line: targetFunc.func.line,
              column: targetFunc.func.column,
              endLine: targetFunc.func.endLine,
              endColumn: targetFunc.func.endColumn,
            },
            selectionLocation: {
              filePath: targetFunc.filePath,
              line: targetFunc.func.line,
              column: targetFunc.func.column,
            },
            detail: targetFunc.func.implType,
          },
          fromRanges: [
            {
              filePath: item.location.filePath,
              line: call.line,
              column: call.column,
            },
          ],
        });
      }
    }

    return results;
  }

  /**
   * Get all callable symbols in a file.
   */
  async getFileSymbols(filePath: string): Promise<CallGraphNode[]> {
    const functions = await this.parseFunctions(filePath);
    await this.parseCalls(filePath);

    return functions.map((func) => ({
      id: createNodeId(filePath, func.line, func.column, func.name),
      name: func.name,
      qualifiedName: func.qualifiedName,
      kind: func.kind,
      location: {
        filePath,
        line: func.line,
        column: func.column,
        endLine: func.endLine,
        endColumn: func.endColumn,
      },
      signature: this.buildSignature(func),
      documentation: func.doc,
      isExported: func.isPublic,
      isAsync: func.isAsync,
      language: 'rust',
    }));
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private async getContent(filePath: string): Promise<string> {
    let content = this.fileCache.get(filePath);
    if (!content) {
      content = fs.readFileSync(filePath, 'utf-8');
      this.fileCache.set(filePath, content);
    }
    return content;
  }

  private async parseFunctions(filePath: string): Promise<RustFunction[]> {
    const cached = this.functionCache.get(filePath);
    if (cached) return cached;

    const content = await this.getContent(filePath);
    const parser = await getParser();
    const tree = parser.parse(content);

    const functions: RustFunction[] = [];

    if (!tree) {
      this.functionCache.set(filePath, functions);
      return functions;
    }

    const visit = (node: Node, implType?: string) => {
      // Function definition
      if (node.type === 'function_item') {
        const nameNode = node.childForFieldName('name');
        const name = getNodeText(nameNode);
        const visibility = getVisibility(node);

        functions.push({
          name,
          qualifiedName: implType ? `${implType}::${name}` : name,
          kind: implType ? 'method' : 'function',
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          endLine: node.endPosition.row + 1,
          endColumn: node.endPosition.column + 1,
          params: getParameters(node),
          returnType: getReturnType(node),
          doc: getDoc(node),
          implType,
          isPublic: visibility === 'pub',
          isAsync: isAsync(node),
          visibility,
        });
      }

      // Impl block
      if (node.type === 'impl_item') {
        const typeNode = node.childForFieldName('type');
        const typeName = getNodeText(typeNode);
        
        // Check if it's a trait impl
        const traitNode = node.childForFieldName('trait');
        const fullType = traitNode 
          ? `<${typeName} as ${getNodeText(traitNode)}>`
          : typeName;

        // Visit methods inside impl
        const body = node.childForFieldName('body');
        if (body) {
          for (const child of body.namedChildren) {
            visit(child, fullType);
          }
        }
        return; // Don't recurse further
      }

      // Trait definition
      if (node.type === 'trait_item') {
        const nameNode = node.childForFieldName('name');
        const name = getNodeText(nameNode);
        const visibility = getVisibility(node);

        functions.push({
          name,
          qualifiedName: name,
          kind: 'interface',
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          endLine: node.endPosition.row + 1,
          endColumn: node.endPosition.column + 1,
          params: [],
          doc: getDoc(node),
          isPublic: visibility === 'pub',
          isAsync: false,
          visibility,
        });

        // Visit trait methods
        const body = node.childForFieldName('body');
        if (body) {
          for (const child of body.namedChildren) {
            if (child.type === 'function_signature_item' || child.type === 'function_item') {
              const methodName = getNodeText(child.childForFieldName('name'));
              functions.push({
                name: methodName,
                qualifiedName: `${name}::${methodName}`,
                kind: 'method',
                line: child.startPosition.row + 1,
                column: child.startPosition.column + 1,
                endLine: child.endPosition.row + 1,
                endColumn: child.endPosition.column + 1,
                params: getParameters(child),
                returnType: getReturnType(child),
                doc: getDoc(child),
                implType: name,
                isPublic: visibility === 'pub',
                isAsync: isAsync(child),
                visibility,
              });
            }
          }
        }
        return;
      }

      // Struct definition
      if (node.type === 'struct_item') {
        const nameNode = node.childForFieldName('name');
        const name = getNodeText(nameNode);
        const visibility = getVisibility(node);

        functions.push({
          name,
          qualifiedName: name,
          kind: 'class',
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          endLine: node.endPosition.row + 1,
          endColumn: node.endPosition.column + 1,
          params: [],
          doc: getDoc(node),
          isPublic: visibility === 'pub',
          isAsync: false,
          visibility,
        });
      }

      // Enum definition
      if (node.type === 'enum_item') {
        const nameNode = node.childForFieldName('name');
        const name = getNodeText(nameNode);
        const visibility = getVisibility(node);

        functions.push({
          name,
          qualifiedName: name,
          kind: 'enum',
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          endLine: node.endPosition.row + 1,
          endColumn: node.endPosition.column + 1,
          params: [],
          doc: getDoc(node),
          isPublic: visibility === 'pub',
          isAsync: false,
          visibility,
        });
      }

      for (const child of node.namedChildren) {
        visit(child, implType);
      }
    };

    visit(tree.rootNode);
    this.functionCache.set(filePath, functions);
    return functions;
  }

  private async parseCalls(filePath: string): Promise<RustCall[]> {
    const cached = this.callCache.get(filePath);
    if (cached) return cached;

    const content = await this.getContent(filePath);
    const parser = await getParser();
    const tree = parser.parse(content);

    const calls: RustCall[] = [];

    if (!tree) {
      this.callCache.set(filePath, calls);
      return calls;
    }

    const visit = (node: Node) => {
      if (node.type === 'call_expression') {
        const funcNode = node.childForFieldName('function');
        if (funcNode) {
          let name = '';
          let receiver: string | undefined;

          if (funcNode.type === 'identifier') {
            name = funcNode.text;
          } else if (funcNode.type === 'scoped_identifier') {
            // Qualified call: module::func()
            const pathNode = funcNode.childForFieldName('path');
            const nameNode = funcNode.childForFieldName('name');
            name = getNodeText(nameNode);
            receiver = getNodeText(pathNode);
          } else if (funcNode.type === 'field_expression') {
            // Method call: obj.method()
            const field = funcNode.childForFieldName('field');
            const value = funcNode.childForFieldName('value');
            name = getNodeText(field);
            receiver = getNodeText(value);
          }

          if (name && !this.isBuiltin(name)) {
            calls.push({
              name,
              line: node.startPosition.row + 1,
              column: node.startPosition.column + 1,
              receiver,
            });
          }
        }
      }

      // Also handle macro invocations
      if (node.type === 'macro_invocation') {
        const macroNode = node.childForFieldName('macro');
        if (macroNode) {
          const name = macroNode.text.replace(/!$/, '');
          if (!this.isStdMacro(name)) {
            calls.push({
              name,
              line: node.startPosition.row + 1,
              column: node.startPosition.column + 1,
            });
          }
        }
      }

      for (const child of node.namedChildren) {
        visit(child);
      }
    };

    visit(tree.rootNode);
    this.callCache.set(filePath, calls);
    return calls;
  }

  private matchesCall(call: RustCall, func: RustFunction): boolean {
    return call.name === func.name;
  }

  private async findFunctionByName(
    name: string,
    receiver?: string
  ): Promise<{ func: RustFunction; filePath: string } | null> {
    for (const [filePath, functions] of this.functionCache) {
      for (const func of functions) {
        if (func.name === name) {
          if (receiver && func.implType) {
            if (receiver === func.implType || receiver.endsWith(func.implType)) {
              return { func, filePath };
            }
          } else if (!func.implType || !receiver) {
            return { func, filePath };
          }
        }
      }
    }

    // Fallback: match by name only
    for (const [filePath, functions] of this.functionCache) {
      for (const func of functions) {
        if (func.name === name) {
          return { func, filePath };
        }
      }
    }

    return null;
  }

  private buildSignature(func: RustFunction): string {
    const params = func.params.join(', ');
    const returnType = func.returnType ? ` -> ${func.returnType}` : '';
    const asyncPrefix = func.isAsync ? 'async ' : '';
    const pubPrefix = func.isPublic ? 'pub ' : '';
    
    if (func.implType) {
      return `${pubPrefix}${asyncPrefix}fn ${func.name}(&self, ${params})${returnType}`;
    }
    return `${pubPrefix}${asyncPrefix}fn ${func.name}(${params})${returnType}`;
  }

  private isBuiltin(name: string): boolean {
    const builtins = new Set([
      'drop', 'clone', 'default', 'from', 'into', 'try_from', 'try_into',
      'as_ref', 'as_mut', 'borrow', 'borrow_mut',
    ]);
    return builtins.has(name);
  }

  private isStdMacro(name: string): boolean {
    const stdMacros = new Set([
      'println', 'print', 'eprintln', 'eprint', 'format', 'write', 'writeln',
      'panic', 'assert', 'assert_eq', 'assert_ne', 'debug_assert', 'debug_assert_eq',
      'vec', 'format_args', 'todo', 'unimplemented', 'unreachable',
      'cfg', 'env', 'option_env', 'concat', 'line', 'column', 'file', 'module_path',
      'stringify', 'include', 'include_str', 'include_bytes',
    ]);
    return stdMacros.has(name);
  }
}

// Export factory function
export function createRustAdapter(): CallGraphAdapter {
  return new RustAdapter();
}
