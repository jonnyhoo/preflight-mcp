/**
 * Go Adapter for Call Graph Analysis
 *
 * Uses tree-sitter to parse Go code and extract:
 * - Function declarations
 * - Method declarations (with receivers)
 * - Function/method calls
 * - Interface definitions
 *
 * @module analysis/call-graph/adapters/go-adapter
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
        '@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm'
      );
      return Language.load(wasmPath);
    })();
  }
  return languagePromise;
}

// ============================================================================
// Helper Types
// ============================================================================

interface GoFunction {
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
  receiver?: string; // For methods: the receiver type
  isExported: boolean;
  packageName?: string;
}

interface GoCall {
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

function isExported(name: string): boolean {
  // In Go, exported names start with uppercase letter
  return /^[A-Z]/.test(name);
}

function getDoc(node: Node): string | undefined {
  // Go comments are siblings before the declaration
  let sibling = node.previousNamedSibling;
  const comments: string[] = [];

  while (sibling && sibling.type === 'comment') {
    const text = sibling.text;
    // Strip // or /* */
    const cleaned = text.replace(/^\/\/\s?/, '').replace(/^\/\*\s?|\s?\*\/$/g, '');
    comments.unshift(cleaned);
    sibling = sibling.previousNamedSibling;
  }

  return comments.length > 0 ? comments.join('\n') : undefined;
}

function getParameters(node: Node): string[] {
  const params: string[] = [];
  const paramList = node.childForFieldName('parameters');

  if (paramList) {
    for (const child of paramList.namedChildren) {
      if (child.type === 'parameter_declaration') {
        const nameNode = child.childForFieldName('name');
        if (nameNode) {
          params.push(nameNode.text);
        }
      }
    }
  }

  return params;
}

function getReturnType(node: Node): string | undefined {
  const result = node.childForFieldName('result');
  if (!result) return undefined;

  if (result.type === 'parameter_list') {
    // Multiple return values
    const types = result.namedChildren
      .map((c) => getNodeText(c.childForFieldName('type') ?? c))
      .filter(Boolean);
    return `(${types.join(', ')})`;
  }

  return result.text;
}

function getReceiver(node: Node): string | undefined {
  const receiver = node.childForFieldName('receiver');
  if (!receiver) return undefined;

  const paramDecl = receiver.namedChild(0);
  if (!paramDecl) return undefined;

  const typeNode = paramDecl.childForFieldName('type');
  if (!typeNode) return undefined;

  // Handle pointer receivers (*Type)
  let typeName = typeNode.text;
  if (typeNode.type === 'pointer_type') {
    const elem = typeNode.namedChild(0);
    typeName = elem ? `*${elem.text}` : typeName;
  }

  return typeName;
}

// ============================================================================
// Go Adapter
// ============================================================================

export class GoAdapter implements CallGraphAdapter {
  readonly language: CallGraphLanguage = 'go';

  private rootPath: string = '';
  private fileCache: Map<string, string> = new Map();
  private functionCache: Map<string, GoFunction[]> = new Map();
  private callCache: Map<string, GoCall[]> = new Map();
  private packageCache: Map<string, string> = new Map(); // file -> package name

  /**
   * Initialize the adapter.
   */
  async initialize(rootPath: string): Promise<void> {
    this.rootPath = rootPath;
    await getParser();
  }

  /**
   * Shutdown the adapter.
   */
  async shutdown(): Promise<void> {
    this.fileCache.clear();
    this.functionCache.clear();
    this.callCache.clear();
    this.packageCache.clear();
  }

  /**
   * Check if file is Go.
   */
  supportsFile(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === '.go';
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
      detail: func.receiver || func.packageName || path.basename(filePath),
    };
  }

  /**
   * Get incoming calls (who calls this symbol).
   */
  async getIncomingCalls(item: CallHierarchyItem): Promise<IncomingCall[]> {
    const results: IncomingCall[] = [];

    // Find the target function
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
                detail: container.receiver || container.packageName,
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
            detail: targetFunc.func.receiver || targetFunc.func.packageName,
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
      isExported: func.isExported,
      isAsync: false, // Go doesn't have async keyword
      language: 'go',
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

  private async parseFunctions(filePath: string): Promise<GoFunction[]> {
    const cached = this.functionCache.get(filePath);
    if (cached) return cached;

    const content = await this.getContent(filePath);
    const parser = await getParser();
    const tree = parser.parse(content);

    const functions: GoFunction[] = [];
    let packageName: string | undefined;

    if (!tree) {
      this.functionCache.set(filePath, functions);
      return functions;
    }

    const visit = (node: Node) => {
      // Extract package name
      if (node.type === 'package_clause') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          packageName = nameNode.text;
          this.packageCache.set(filePath, packageName);
        }
      }

      // Function declaration
      if (node.type === 'function_declaration') {
        const nameNode = node.childForFieldName('name');
        const name = getNodeText(nameNode);

        functions.push({
          name,
          qualifiedName: packageName ? `${packageName}.${name}` : name,
          kind: 'function',
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          endLine: node.endPosition.row + 1,
          endColumn: node.endPosition.column + 1,
          params: getParameters(node),
          returnType: getReturnType(node),
          doc: getDoc(node),
          isExported: isExported(name),
          packageName,
        });
      }

      // Method declaration
      if (node.type === 'method_declaration') {
        const nameNode = node.childForFieldName('name');
        const name = getNodeText(nameNode);
        const receiver = getReceiver(node);
        const receiverType = receiver?.replace('*', '') || '';

        functions.push({
          name,
          qualifiedName: receiverType ? `${receiverType}.${name}` : name,
          kind: 'method',
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          endLine: node.endPosition.row + 1,
          endColumn: node.endPosition.column + 1,
          params: getParameters(node),
          returnType: getReturnType(node),
          doc: getDoc(node),
          receiver,
          isExported: isExported(name),
          packageName,
        });
      }

      // Type declaration (struct/interface)
      if (node.type === 'type_declaration') {
        const spec = node.namedChild(0);
        if (spec?.type === 'type_spec') {
          const nameNode = spec.childForFieldName('name');
          const typeNode = spec.childForFieldName('type');
          const name = getNodeText(nameNode);

          if (typeNode?.type === 'interface_type') {
            functions.push({
              name,
              qualifiedName: packageName ? `${packageName}.${name}` : name,
              kind: 'interface',
              line: node.startPosition.row + 1,
              column: node.startPosition.column + 1,
              endLine: node.endPosition.row + 1,
              endColumn: node.endPosition.column + 1,
              params: [],
              doc: getDoc(node),
              isExported: isExported(name),
              packageName,
            });
          } else if (typeNode?.type === 'struct_type') {
            functions.push({
              name,
              qualifiedName: packageName ? `${packageName}.${name}` : name,
              kind: 'class', // struct is similar to class
              line: node.startPosition.row + 1,
              column: node.startPosition.column + 1,
              endLine: node.endPosition.row + 1,
              endColumn: node.endPosition.column + 1,
              params: [],
              doc: getDoc(node),
              isExported: isExported(name),
              packageName,
            });
          }
        }
      }

      for (const child of node.namedChildren) {
        visit(child);
      }
    };

    visit(tree.rootNode);
    this.functionCache.set(filePath, functions);
    return functions;
  }

  private async parseCalls(filePath: string): Promise<GoCall[]> {
    const cached = this.callCache.get(filePath);
    if (cached) return cached;

    const content = await this.getContent(filePath);
    const parser = await getParser();
    const tree = parser.parse(content);

    const calls: GoCall[] = [];

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
          } else if (funcNode.type === 'selector_expression') {
            // Method call: obj.Method() or pkg.Func()
            const operand = funcNode.childForFieldName('operand');
            const field = funcNode.childForFieldName('field');
            name = getNodeText(field);
            receiver = getNodeText(operand);
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

      for (const child of node.namedChildren) {
        visit(child);
      }
    };

    visit(tree.rootNode);
    this.callCache.set(filePath, calls);
    return calls;
  }

  private matchesCall(call: GoCall, func: GoFunction): boolean {
    if (call.name !== func.name) return false;

    // If the function has a receiver, the call should have a matching receiver type
    if (func.receiver) {
      // For method calls, we can't always determine the exact type statically
      // So we match by name only for methods
      return true;
    }

    return true;
  }

  private async findFunctionByName(
    name: string,
    receiver?: string
  ): Promise<{ func: GoFunction; filePath: string } | null> {
    for (const [filePath, functions] of this.functionCache) {
      for (const func of functions) {
        if (func.name === name) {
          // If receiver is specified, try to match
          if (receiver && func.receiver) {
            const receiverType = func.receiver.replace('*', '');
            if (receiver === receiverType || receiver.endsWith(`.${receiverType}`)) {
              return { func, filePath };
            }
          } else if (!func.receiver) {
            // Function (not method) match
            return { func, filePath };
          }
        }
      }
    }

    // Fallback: just match by name
    for (const [filePath, functions] of this.functionCache) {
      for (const func of functions) {
        if (func.name === name) {
          return { func, filePath };
        }
      }
    }

    return null;
  }

  private buildSignature(func: GoFunction): string {
    const params = func.params.join(', ');
    const returnType = func.returnType ? ` ${func.returnType}` : '';
    const receiver = func.receiver ? `(${func.receiver}) ` : '';
    return `func ${receiver}${func.name}(${params})${returnType}`;
  }

  private isBuiltin(name: string): boolean {
    const builtins = new Set([
      'make', 'new', 'len', 'cap', 'append', 'copy', 'delete',
      'close', 'panic', 'recover', 'print', 'println',
      'complex', 'real', 'imag',
    ]);
    return builtins.has(name);
  }
}

// Export factory function
export function createGoAdapter(): CallGraphAdapter {
  return new GoAdapter();
}
