/**
 * TypeScript Adapter for Call Graph Analysis
 *
 * Uses TypeScript Language Service API to provide:
 * - Find references
 * - Go to definition
 * - Call hierarchy (incoming/outgoing calls)
 *
 * @module analysis/call-graph/adapters/typescript-adapter
 */

import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';
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

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert TypeScript ScriptElementKind to our SymbolKind.
 */
function tsKindToSymbolKind(kind: ts.ScriptElementKind): SymbolKind {
  switch (kind) {
    case ts.ScriptElementKind.functionElement:
    case ts.ScriptElementKind.localFunctionElement:
      return 'function';
    case ts.ScriptElementKind.memberFunctionElement:
      return 'method';
    case ts.ScriptElementKind.constructorImplementationElement:
      return 'constructor';
    case ts.ScriptElementKind.memberGetAccessorElement:
      return 'getter';
    case ts.ScriptElementKind.memberSetAccessorElement:
      return 'setter';
    case ts.ScriptElementKind.classElement:
    case ts.ScriptElementKind.localClassElement:
      return 'class';
    case ts.ScriptElementKind.interfaceElement:
      return 'interface';
    case ts.ScriptElementKind.moduleElement:
      return 'module';
    default:
      return 'function';
  }
}

/**
 * Convert TS SyntaxKind to SymbolKind.
 */
function syntaxKindToSymbolKind(kind: ts.SyntaxKind): SymbolKind {
  switch (kind) {
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ArrowFunction:
      return 'function';
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.MethodSignature:
      return 'method';
    case ts.SyntaxKind.Constructor:
      return 'constructor';
    case ts.SyntaxKind.GetAccessor:
      return 'getter';
    case ts.SyntaxKind.SetAccessor:
      return 'setter';
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.ClassExpression:
      return 'class';
    case ts.SyntaxKind.InterfaceDeclaration:
      return 'interface';
    case ts.SyntaxKind.ModuleDeclaration:
      return 'module';
    default:
      return 'function';
  }
}

/**
 * Get the name of a node.
 */
function getNodeName(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
      ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
    return node.name?.getText() || '<anonymous>';
  }
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.getText();
    }
    if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.getText();
    }
    return '<anonymous>';
  }
  if (ts.isConstructorDeclaration(node)) {
    return 'constructor';
  }
  if (ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    return node.name?.getText() || '<accessor>';
  }
  return '<unknown>';
}

/**
 * Get qualified name including container.
 */
function getQualifiedName(node: ts.Node, sourceFile: ts.SourceFile): string {
  const parts: string[] = [];
  let current: ts.Node | undefined = node;

  while (current) {
    const name = getNodeName(current);
    if (name && name !== '<anonymous>' && name !== '<unknown>') {
      parts.unshift(name);
    }
    current = current.parent;
    if (ts.isSourceFile(current)) break;
  }

  return parts.join('.') || getNodeName(node);
}

/**
 * Check if a node is exported.
 */
function isNodeExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (!modifiers) return false;
  return modifiers.some(
    (m) =>
      m.kind === ts.SyntaxKind.ExportKeyword ||
      m.kind === ts.SyntaxKind.DefaultKeyword
  );
}

/**
 * Check if a function is async.
 */
function isAsyncFunction(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (!modifiers) return false;
  return modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

/**
 * Get function signature.
 */
function getFunctionSignature(
  node: ts.Node,
  checker: ts.TypeChecker
): string | undefined {
  try {
    const symbol = checker.getSymbolAtLocation(
      ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
        ? node.name!
        : node
    );
    if (symbol) {
      return checker.signatureToString(
        checker.getSignatureFromDeclaration(
          node as ts.SignatureDeclaration
        )!
      );
    }
  } catch {
    // Ignore errors
  }
  return undefined;
}

/**
 * Get documentation from JSDoc.
 */
function getDocumentation(
  node: ts.Node,
  checker: ts.TypeChecker
): string | undefined {
  try {
    let symbol: ts.Symbol | undefined;

    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      symbol = node.name ? checker.getSymbolAtLocation(node.name) : undefined;
    } else if (ts.isVariableDeclaration(node.parent)) {
      symbol = checker.getSymbolAtLocation(node.parent.name);
    }

    if (symbol) {
      const docs = symbol.getDocumentationComment(checker);
      if (docs.length > 0) {
        return docs.map((d) => d.text).join('\n');
      }
    }
  } catch {
    // Ignore errors
  }
  return undefined;
}

// ============================================================================
// TypeScript Adapter
// ============================================================================

export class TypeScriptAdapter implements CallGraphAdapter {
  readonly language: CallGraphLanguage = 'typescript';

  private rootPath: string = '';
  private program: ts.Program | null = null;
  private languageService: ts.LanguageService | null = null;
  private fileVersions: Map<string, number> = new Map();
  private fileContents: Map<string, string> = new Map();

  /**
   * Initialize the TypeScript Language Service.
   */
  async initialize(rootPath: string): Promise<void> {
    this.rootPath = rootPath;

    // Find tsconfig.json
    const configPath = ts.findConfigFile(
      rootPath,
      ts.sys.fileExists,
      'tsconfig.json'
    );

    let compilerOptions: ts.CompilerOptions;
    let rootFileNames: string[];

    if (configPath) {
      const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
      const parsedConfig = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        path.dirname(configPath)
      );
      compilerOptions = parsedConfig.options;
      rootFileNames = parsedConfig.fileNames;
    } else {
      // Default options if no tsconfig
      compilerOptions = {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        esModuleInterop: true,
        allowJs: true,
        checkJs: false,
        strict: false,
      };
      rootFileNames = this.findSourceFiles(rootPath);
    }

    // Initialize file versions
    for (const fileName of rootFileNames) {
      this.fileVersions.set(fileName, 0);
    }

    // Create language service host
    const serviceHost: ts.LanguageServiceHost = {
      getScriptFileNames: () => Array.from(this.fileVersions.keys()),
      getScriptVersion: (fileName) =>
        (this.fileVersions.get(fileName) || 0).toString(),
      getScriptSnapshot: (fileName) => {
        let content = this.fileContents.get(fileName);
        if (!content) {
          try {
            content = fs.readFileSync(fileName, 'utf-8');
            this.fileContents.set(fileName, content);
          } catch {
            return undefined;
          }
        }
        return ts.ScriptSnapshot.fromString(content);
      },
      getCurrentDirectory: () => rootPath,
      getCompilationSettings: () => compilerOptions,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    };

    this.languageService = ts.createLanguageService(
      serviceHost,
      ts.createDocumentRegistry()
    );

    // Create program for type checking
    this.program = ts.createProgram({
      rootNames: rootFileNames,
      options: compilerOptions,
    });
  }

  /**
   * Shutdown the adapter.
   */
  async shutdown(): Promise<void> {
    this.languageService?.dispose();
    this.languageService = null;
    this.program = null;
    this.fileVersions.clear();
    this.fileContents.clear();
  }

  /**
   * Check if file is TypeScript/JavaScript.
   */
  supportsFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs'].includes(ext);
  }

  /**
   * Find all references to a symbol.
   */
  async findReferences(
    filePath: string,
    line: number,
    column: number
  ): Promise<SymbolReference[]> {
    if (!this.languageService) {
      throw new Error('TypeScript adapter not initialized');
    }

    const sourceFile = this.program?.getSourceFile(filePath);
    if (!sourceFile) {
      // Try to add the file
      this.ensureFile(filePath);
    }

    const position = this.getPosition(filePath, line, column);
    if (position === undefined) return [];

    const references = this.languageService.findReferences(filePath, position);
    if (!references) return [];

    const results: SymbolReference[] = [];

    for (const refEntry of references) {
      for (const ref of refEntry.references) {
        const refSourceFile = this.program?.getSourceFile(ref.fileName);
        if (!refSourceFile) continue;

        const { line: refLine, character: refColumn } =
          refSourceFile.getLineAndCharacterOfPosition(ref.textSpan.start);

        // Find containing function
        const containerName = this.findContainingFunction(
          refSourceFile,
          ref.textSpan.start
        );

        results.push({
          filePath: ref.fileName,
          location: {
            filePath: ref.fileName,
            line: refLine + 1,
            column: refColumn + 1,
          },
          isDefinition: ref.isDefinition || false,
          isWrite: ref.isWriteAccess,
          containerName,
        });
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
    if (!this.languageService || !this.program) {
      throw new Error('TypeScript adapter not initialized');
    }

    const position = this.getPosition(filePath, line, column);
    if (position === undefined) return null;

    const definitions = this.languageService.getDefinitionAtPosition(
      filePath,
      position
    );
    if (!definitions || definitions.length === 0) return null;

    const def = definitions[0]!;
    const defSourceFile = this.program.getSourceFile(def.fileName);
    if (!defSourceFile) return null;

    const { line: defLine, character: defColumn } =
      defSourceFile.getLineAndCharacterOfPosition(def.textSpan.start);

    // Get quick info for more details
    const quickInfo = this.languageService.getQuickInfoAtPosition(
      def.fileName,
      def.textSpan.start
    );

    return {
      name: def.name,
      qualifiedName: def.containerName
        ? `${def.containerName}.${def.name}`
        : def.name,
      kind: tsKindToSymbolKind(def.kind),
      location: {
        filePath: def.fileName,
        line: defLine + 1,
        column: defColumn + 1,
      },
      signature: quickInfo?.displayParts
        ?.map((p) => p.text)
        .join('')
        .split('\n')[0],
      documentation: quickInfo?.documentation?.map((d) => d.text).join('\n'),
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
    if (!this.languageService || !this.program) {
      throw new Error('TypeScript adapter not initialized');
    }

    const position = this.getPosition(filePath, line, column);
    if (position === undefined) return null;

    const items = this.languageService.prepareCallHierarchy(filePath, position);
    const itemsArray = Array.isArray(items) ? items : items ? [items] : [];
    if (itemsArray.length === 0) return null;

    const item = itemsArray[0]!;
    const sourceFile = this.program.getSourceFile(item.file);
    if (!sourceFile) return null;

    const { line: itemLine, character: itemColumn } =
      sourceFile.getLineAndCharacterOfPosition(item.span.start);
    const { line: selLine, character: selColumn } =
      sourceFile.getLineAndCharacterOfPosition(item.selectionSpan.start);
    const { line: endLine, character: endColumn } =
      sourceFile.getLineAndCharacterOfPosition(
        item.span.start + item.span.length
      );

    return {
      name: item.name,
      kind: tsKindToSymbolKind(item.kind),
      location: {
        filePath: item.file,
        line: itemLine + 1,
        column: itemColumn + 1,
        endLine: endLine + 1,
        endColumn: endColumn + 1,
      },
      selectionLocation: {
        filePath: item.file,
        line: selLine + 1,
        column: selColumn + 1,
      },
      detail: item.containerName || path.basename(item.file),
    };
  }

  /**
   * Get incoming calls (who calls this symbol).
   */
  async getIncomingCalls(item: CallHierarchyItem): Promise<IncomingCall[]> {
    if (!this.languageService || !this.program) {
      throw new Error('TypeScript adapter not initialized');
    }

    // Convert back to TS call hierarchy item
    const sourceFile = this.program.getSourceFile(item.location.filePath);
    if (!sourceFile) return [];

    const position = sourceFile.getPositionOfLineAndCharacter(
      item.selectionLocation.line - 1,
      item.selectionLocation.column - 1
    );

    const tsItems = this.languageService.prepareCallHierarchy(
      item.location.filePath,
      position
    );
    const tsItemsArray = Array.isArray(tsItems) ? tsItems : tsItems ? [tsItems] : [];
    if (tsItemsArray.length === 0) return [];

    const incomingCalls = this.languageService.provideCallHierarchyIncomingCalls(
      item.location.filePath,
      position
    );

    const results: IncomingCall[] = [];

    for (const call of incomingCalls) {
      const callSourceFile = this.program.getSourceFile(call.from.file);
      if (!callSourceFile) continue;

      const { line: fromLine, character: fromColumn } =
        callSourceFile.getLineAndCharacterOfPosition(call.from.span.start);
      const { line: selLine, character: selColumn } =
        callSourceFile.getLineAndCharacterOfPosition(
          call.from.selectionSpan.start
        );

      const fromRanges: SourceLocation[] = call.fromSpans.map((span) => {
        const { line: l, character: c } =
          callSourceFile.getLineAndCharacterOfPosition(span.start);
        return {
          filePath: call.from.file,
          line: l + 1,
          column: c + 1,
        };
      });

      results.push({
        from: {
          name: call.from.name,
          kind: tsKindToSymbolKind(call.from.kind),
          location: {
            filePath: call.from.file,
            line: fromLine + 1,
            column: fromColumn + 1,
          },
          selectionLocation: {
            filePath: call.from.file,
            line: selLine + 1,
            column: selColumn + 1,
          },
          detail: call.from.containerName,
        },
        fromRanges,
      });
    }

    return results;
  }

  /**
   * Get outgoing calls (what this symbol calls).
   */
  async getOutgoingCalls(item: CallHierarchyItem): Promise<OutgoingCall[]> {
    if (!this.languageService || !this.program) {
      throw new Error('TypeScript adapter not initialized');
    }

    const sourceFile = this.program.getSourceFile(item.location.filePath);
    if (!sourceFile) return [];

    const position = sourceFile.getPositionOfLineAndCharacter(
      item.selectionLocation.line - 1,
      item.selectionLocation.column - 1
    );

    const outgoingCalls = this.languageService.provideCallHierarchyOutgoingCalls(
      item.location.filePath,
      position
    );

    const results: OutgoingCall[] = [];

    for (const call of outgoingCalls) {
      const callSourceFile = this.program.getSourceFile(call.to.file);
      if (!callSourceFile) continue;

      const { line: toLine, character: toColumn } =
        callSourceFile.getLineAndCharacterOfPosition(call.to.span.start);
      const { line: selLine, character: selColumn } =
        callSourceFile.getLineAndCharacterOfPosition(
          call.to.selectionSpan.start
        );

      // fromSpans are in the caller's file (item.location.filePath)
      const fromRanges: SourceLocation[] = call.fromSpans.map((span) => {
        const { line: l, character: c } =
          sourceFile.getLineAndCharacterOfPosition(span.start);
        return {
          filePath: item.location.filePath,
          line: l + 1,
          column: c + 1,
        };
      });

      results.push({
        to: {
          name: call.to.name,
          kind: tsKindToSymbolKind(call.to.kind),
          location: {
            filePath: call.to.file,
            line: toLine + 1,
            column: toColumn + 1,
          },
          selectionLocation: {
            filePath: call.to.file,
            line: selLine + 1,
            column: selColumn + 1,
          },
          detail: call.to.containerName,
        },
        fromRanges,
      });
    }

    return results;
  }

  /**
   * Get all callable symbols in a file.
   */
  async getFileSymbols(filePath: string): Promise<CallGraphNode[]> {
    if (!this.program) {
      throw new Error('TypeScript adapter not initialized');
    }

    this.ensureFile(filePath);
    const sourceFile = this.program.getSourceFile(filePath);
    if (!sourceFile) return [];

    const checker = this.program.getTypeChecker();
    const symbols: CallGraphNode[] = [];

    const visit = (node: ts.Node) => {
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessor(node) ||
        ts.isSetAccessor(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node)
      ) {
        const name = getNodeName(node);
        const qualifiedName = getQualifiedName(node, sourceFile);
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart()
        );
        const { line: endLine, character: endCol } =
          sourceFile.getLineAndCharacterOfPosition(node.getEnd());

        symbols.push({
          id: createNodeId(filePath, line + 1, character + 1, name),
          name,
          qualifiedName,
          kind: syntaxKindToSymbolKind(node.kind),
          location: {
            filePath,
            line: line + 1,
            column: character + 1,
            endLine: endLine + 1,
            endColumn: endCol + 1,
          },
          signature: getFunctionSignature(node, checker),
          documentation: getDocumentation(node, checker),
          isExported: isNodeExported(node),
          isAsync: isAsyncFunction(node),
          language: 'typescript',
        });
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return symbols;
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Find source files in a directory.
   */
  private findSourceFiles(dir: string): string[] {
    const files: string[] = [];
    const extensions = ['.ts', '.tsx', '.js', '.jsx'];

    const walk = (currentDir: string) => {
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
              walk(fullPath);
            }
          } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
            files.push(fullPath);
          }
        }
      } catch {
        // Ignore permission errors
      }
    };

    walk(dir);
    return files;
  }

  /**
   * Ensure a file is tracked by the language service.
   */
  private ensureFile(filePath: string): void {
    if (!this.fileVersions.has(filePath)) {
      this.fileVersions.set(filePath, 0);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        this.fileContents.set(filePath, content);
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Convert 1-indexed line/column to position.
   */
  private getPosition(
    filePath: string,
    line: number,
    column: number
  ): number | undefined {
    this.ensureFile(filePath);
    const content = this.fileContents.get(filePath);
    if (!content) return undefined;

    const lines = content.split('\n');
    let pos = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) {
      pos += (lines[i]?.length ?? 0) + 1; // +1 for newline
    }
    pos += column - 1;
    return pos;
  }

  /**
   * Find the containing function for a position.
   */
  private findContainingFunction(
    sourceFile: ts.SourceFile,
    position: number
  ): string | undefined {
    let result: string | undefined;

    const visit = (node: ts.Node) => {
      if (position >= node.getStart() && position <= node.getEnd()) {
        if (
          ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node)
        ) {
          result = getNodeName(node);
        }
        ts.forEachChild(node, visit);
      }
    };

    visit(sourceFile);
    return result;
  }
}

// Export singleton factory
export function createTypeScriptAdapter(): CallGraphAdapter {
  return new TypeScriptAdapter();
}
