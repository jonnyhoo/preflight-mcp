/**
 * Python Adapter for Call Graph Analysis
 *
 * Uses tree-sitter to parse Python code and extract:
 * - Function definitions
 * - Method definitions
 * - Class definitions
 * - Function calls
 *
 * Note: Python's dynamic nature limits static analysis accuracy.
 * This adapter provides best-effort call graph construction.
 *
 * @module analysis/call-graph/adapters/python-adapter
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
        '@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm'
      );
      return Language.load(wasmPath);
    })();
  }
  return languagePromise;
}

// ============================================================================
// Helper Types
// ============================================================================

interface PythonFunction {
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  params: string[];
  returnType?: string;
  docstring?: string;
  isAsync: boolean;
  decorators: string[];
  className?: string;
}

interface PythonCall {
  name: string;
  line: number;
  column: number;
  arguments: string[];
}

// ============================================================================
// AST Helpers
// ============================================================================

function getNodeText(node: Node | null): string {
  return node?.text ?? '';
}

function getDocstring(node: Node): string | undefined {
  // In Python, docstring is the first expression_statement with a string
  const body = node.childForFieldName('body');
  if (!body) return undefined;

  const firstChild = body.namedChild(0);
  if (firstChild?.type === 'expression_statement') {
    const expr = firstChild.namedChild(0);
    if (expr?.type === 'string') {
      // Remove quotes and clean up
      let text = expr.text;
      if (text.startsWith('"""') || text.startsWith("'''")) {
        text = text.slice(3, -3);
      } else if (text.startsWith('"') || text.startsWith("'")) {
        text = text.slice(1, -1);
      }
      return text.trim();
    }
  }
  return undefined;
}

function getDecorators(node: Node): string[] {
  const decorators: string[] = [];
  let sibling = node.previousNamedSibling;
  
  while (sibling && sibling.type === 'decorator') {
    const name = sibling.childForFieldName('value') ?? sibling.namedChild(0);
    if (name) {
      decorators.unshift(getNodeText(name));
    }
    sibling = sibling.previousNamedSibling;
  }
  
  return decorators;
}

function getParameters(node: Node): string[] {
  const params: string[] = [];
  const paramsNode = node.childForFieldName('parameters');
  
  if (paramsNode) {
    for (const child of paramsNode.namedChildren) {
      if (child.type === 'identifier') {
        const name = child.text;
        if (name !== 'self' && name !== 'cls') {
          params.push(name);
        }
      } else if (child.type === 'typed_parameter' || child.type === 'default_parameter') {
        const nameNode = child.childForFieldName('name') ?? child.namedChild(0);
        const name = getNodeText(nameNode);
        if (name && name !== 'self' && name !== 'cls') {
          params.push(name);
        }
      }
    }
  }
  
  return params;
}

function getReturnType(node: Node): string | undefined {
  const returnType = node.childForFieldName('return_type');
  return returnType ? getNodeText(returnType) : undefined;
}

// ============================================================================
// Python Adapter
// ============================================================================

export class PythonAdapter implements CallGraphAdapter {
  readonly language: CallGraphLanguage = 'python';

  private rootPath: string = '';
  private fileCache: Map<string, string> = new Map();
  private functionCache: Map<string, PythonFunction[]> = new Map();
  private callCache: Map<string, PythonCall[]> = new Map();

  /**
   * Initialize the adapter.
   */
  async initialize(rootPath: string): Promise<void> {
    this.rootPath = rootPath;
    // Pre-initialize parser
    await getParser();
  }

  /**
   * Shutdown the adapter.
   */
  async shutdown(): Promise<void> {
    this.fileCache.clear();
    this.functionCache.clear();
    this.callCache.clear();
  }

  /**
   * Check if file is Python.
   */
  supportsFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ext === '.py';
  }

  /**
   * Find all references to a symbol.
   * Note: Limited in Python due to dynamic nature.
   */
  async findReferences(
    filePath: string,
    line: number,
    column: number
  ): Promise<SymbolReference[]> {
    const results: SymbolReference[] = [];
    
    // Get the function at this location
    const functions = await this.parseFunctions(filePath);
    const targetFunc = functions.find(
      (f) => f.line === line || (f.line <= line && f.endLine >= line)
    );
    
    if (!targetFunc) return results;

    // Search for calls to this function in all cached files
    for (const [cachedPath, calls] of this.callCache) {
      for (const call of calls) {
        if (call.name === targetFunc.name || call.name.endsWith(`.${targetFunc.name}`)) {
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
      documentation: func.docstring,
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
      detail: func.className || path.basename(filePath),
    };
  }

  /**
   * Get incoming calls (who calls this symbol).
   */
  async getIncomingCalls(item: CallHierarchyItem): Promise<IncomingCall[]> {
    const results: IncomingCall[] = [];

    // Search all parsed files for calls to this function
    for (const [filePath, calls] of this.callCache) {
      const functions = await this.parseFunctions(filePath);

      for (const call of calls) {
        if (call.name === item.name || call.name.endsWith(`.${item.name}`)) {
          // Find the containing function
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
                detail: container.className,
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

    // Filter calls within this function's range
    const callsInRange = calls.filter(
      (c) =>
        c.line >= item.location.line &&
        c.line <= (item.location.endLine ?? item.location.line + 100)
    );

    for (const call of callsInRange) {
      // Try to find the definition
      const targetFunc = await this.findFunctionByName(call.name);

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
            detail: targetFunc.func.className,
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
    // Also parse calls for later use
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
      documentation: func.docstring,
      isExported: !func.name.startsWith('_'), // Python convention
      isAsync: func.isAsync,
      language: 'python',
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

  private async parseFunctions(filePath: string): Promise<PythonFunction[]> {
    const cached = this.functionCache.get(filePath);
    if (cached) return cached;

    const content = await this.getContent(filePath);
    const parser = await getParser();
    const tree = parser.parse(content);

    const functions: PythonFunction[] = [];
    
    // Visit the tree
    const visit = (node: Node, className?: string) => {
      if (node.type === 'function_definition') {
        const nameNode = node.childForFieldName('name');
        const name = getNodeText(nameNode);
        const decorators = getDecorators(node);
        const isAsync = node.previousNamedSibling?.type === 'async';

        functions.push({
          name,
          qualifiedName: className ? `${className}.${name}` : name,
          kind: className ? 'method' : 'function',
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          endLine: node.endPosition.row + 1,
          endColumn: node.endPosition.column + 1,
          params: getParameters(node),
          returnType: getReturnType(node),
          docstring: getDocstring(node),
          isAsync: isAsync || decorators.includes('asyncio.coroutine'),
          decorators,
          className,
        });
      } else if (node.type === 'class_definition') {
        const nameNode = node.childForFieldName('name');
        const name = getNodeText(nameNode);

        // Add class as a symbol
        functions.push({
          name,
          qualifiedName: name,
          kind: 'class',
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          endLine: node.endPosition.row + 1,
          endColumn: node.endPosition.column + 1,
          params: [],
          docstring: getDocstring(node),
          isAsync: false,
          decorators: getDecorators(node),
        });

        // Visit methods with class context
        const body = node.childForFieldName('body');
        if (body) {
          for (const child of body.namedChildren) {
            visit(child, name);
          }
        }
        return; // Don't recurse further
      }

      // Recurse
      for (const child of node.namedChildren) {
        visit(child, className);
      }
    };

    if (tree) {
      visit(tree.rootNode);
    }
    this.functionCache.set(filePath, functions);
    return functions;
  }

  private async parseCalls(filePath: string): Promise<PythonCall[]> {
    const cached = this.callCache.get(filePath);
    if (cached) return cached;

    const content = await this.getContent(filePath);
    const parser = await getParser();
    const tree = parser.parse(content);

    const calls: PythonCall[] = [];

    const visit = (node: Node) => {
      if (node.type === 'call') {
        const funcNode = node.childForFieldName('function');
        if (funcNode) {
          let name = '';
          
          if (funcNode.type === 'identifier') {
            name = funcNode.text;
          } else if (funcNode.type === 'attribute') {
            // method call: obj.method()
            name = funcNode.text;
          }

          if (name && !this.isBuiltin(name)) {
            const argsNode = node.childForFieldName('arguments');
            const args: string[] = [];
            
            if (argsNode) {
              for (const child of argsNode.namedChildren) {
                if (child.type !== 'comment') {
                  args.push(child.text.slice(0, 50)); // Truncate long args
                }
              }
            }

            calls.push({
              name,
              line: node.startPosition.row + 1,
              column: node.startPosition.column + 1,
              arguments: args,
            });
          }
        }
      }

      // Recurse
      for (const child of node.namedChildren) {
        visit(child);
      }
    };

    if (tree) {
      visit(tree.rootNode);
    }
    this.callCache.set(filePath, calls);
    return calls;
  }

  private async findFunctionByName(
    name: string
  ): Promise<{ func: PythonFunction; filePath: string } | null> {
    // Extract the actual function name (handle method calls like obj.method)
    const parts = name.split('.');
    const funcName = parts[parts.length - 1]!;

    for (const [filePath, functions] of this.functionCache) {
      for (const func of functions) {
        if (func.name === funcName || func.qualifiedName === name) {
          return { func, filePath };
        }
      }
    }
    return null;
  }

  private buildSignature(func: PythonFunction): string {
    const params = func.params.join(', ');
    const returnType = func.returnType ? ` -> ${func.returnType}` : '';
    const asyncPrefix = func.isAsync ? 'async ' : '';
    return `${asyncPrefix}def ${func.name}(${params})${returnType}`;
  }

  private isBuiltin(name: string): boolean {
    const builtins = new Set([
      'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set',
      'tuple', 'bool', 'type', 'isinstance', 'issubclass', 'hasattr', 'getattr',
      'setattr', 'delattr', 'open', 'input', 'sum', 'min', 'max', 'abs', 'round',
      'sorted', 'reversed', 'enumerate', 'zip', 'map', 'filter', 'any', 'all',
      'next', 'iter', 'id', 'hash', 'repr', 'format', 'super', 'object',
      'staticmethod', 'classmethod', 'property',
    ]);
    
    // Get just the function name for builtins check
    const baseName = name.split('.').pop() || name;
    return builtins.has(baseName);
  }
}

// Export factory function
export function createPythonAdapter(): CallGraphAdapter {
  return new PythonAdapter();
}
