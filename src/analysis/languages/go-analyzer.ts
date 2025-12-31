/**
 * Go Extension Point Analyzer.
 *
 * Detects Go-specific extension points:
 * - Interface definitions (primary extension mechanism)
 * - Function types (callback patterns)
 * - Struct types with embedded interfaces
 * - Type aliases and constraints
 *
 * @module analysis/languages/go-analyzer
 */

import { createModuleLogger } from '../../logging/logger.js';
import {
  extractExtensionPointsWasm,
  type ExtensionPoint as TreeSitterExtensionPoint,
} from '../../ast/treeSitter.js';
import type {
  ExtensionPointInfo,
  TypeSemantics,
  UnionTypeInfo,
  OptionalCallbackInfo,
  InferredPurpose,
} from '../types.js';

const logger = createModuleLogger('go-analyzer');

// ============================================================================
// Type Definitions
// ============================================================================

interface GoInterface {
  name: string;
  line: number;
  methods: GoMethod[];
  embedded: string[];
  isExported: boolean;
}

interface GoMethod {
  name: string;
  line: number;
  params: string;
  returns: string;
}

interface GoFuncType {
  name: string;
  line: number;
  signature: string;
  isExported: boolean;
}

interface GoTypeAlias {
  name: string;
  line: number;
  targetType: string;
  isConstraint: boolean;
  members?: string[];
}

// ============================================================================
// Go Analyzer Class
// ============================================================================

export class GoAnalyzer {
  /**
   * Analyze Go source code for extension points.
   * Uses tree-sitter for accurate AST parsing with regex fallback.
   */
  async analyzeContent(
    content: string,
    filePath: string
  ): Promise<{
    extensionPoints: ExtensionPointInfo[];
    typeSemantics: TypeSemantics;
  }> {
    // Try tree-sitter first for accurate AST parsing
    const treeSitterResult = await extractExtensionPointsWasm(filePath, content);
    
    if (treeSitterResult && treeSitterResult.extensionPoints.length > 0) {
      return this.convertTreeSitterResult(treeSitterResult.extensionPoints, filePath);
    }
    
    // Fallback to regex-based parsing
    return this.analyzeContentWithRegex(content, filePath);
  }

  /**
   * Convert tree-sitter extension points to our format.
   */
  private convertTreeSitterResult(
    tsPoints: TreeSitterExtensionPoint[],
    filePath: string
  ): {
    extensionPoints: ExtensionPointInfo[];
    typeSemantics: TypeSemantics;
  } {
    const extensionPoints: ExtensionPointInfo[] = [];
    const optionalCallbacks: OptionalCallbackInfo[] = [];
    const unionTypes: UnionTypeInfo[] = [];

    for (const point of tsPoints) {
      if (point.kind === 'interface') {
        extensionPoints.push({
          kind: 'interface',
          name: point.name,
          file: filePath,
          line: point.line,
          semantics: this.describeInterfaceFromTreeSitter(point),
          inferredPurpose: this.inferInterfacePurpose(point.name, point.methods || []),
          extensibilityScore: this.scoreInterfaceFromTreeSitter(point),
        });

        // Each method in an interface is an extension point
        if (point.methods) {
          for (const method of point.methods) {
            if (this.isExportedName(method.name)) {
              optionalCallbacks.push({
                name: method.name,
                signature: method.signature || '()',
                file: filePath,
                line: method.line,
                parent: point.name,
              });
            }
          }
        }
      } else if (point.kind === 'func-type') {
        extensionPoints.push({
          kind: 'optional-callback',
          name: point.name,
          file: filePath,
          line: point.line,
          semantics: `Function type: ${point.methods?.[0]?.signature || '()'}`,
          inferredPurpose: this.inferFuncTypePurpose(point.name),
          extensibilityScore: 65,
        });

        optionalCallbacks.push({
          name: point.name,
          signature: point.methods?.[0]?.signature || '()',
          file: filePath,
          line: point.line,
        });
      } else if (point.kind === 'type-constraint' && point.variants && point.variants.length >= 2) {
        const unionInfo: UnionTypeInfo = {
          name: point.name,
          members: point.variants,
          file: filePath,
          line: point.line,
          inferredPurpose: this.inferConstraintPurpose(point.name, point.variants),
          fullType: point.variants.join(' | '),
        };

        unionTypes.push(unionInfo);

        extensionPoints.push({
          kind: 'union-type',
          name: point.name,
          file: filePath,
          line: point.line,
          semantics: `Type constraint: ${point.variants.slice(0, 4).join(' | ')}${point.variants.length > 4 ? ' | ...' : ''}`,
          values: point.variants,
          inferredPurpose: unionInfo.inferredPurpose,
          extensibilityScore: this.scoreConstraint(point.variants.length),
        });
      }
    }

    return {
      extensionPoints,
      typeSemantics: {
        unionTypes,
        optionalCallbacks,
        genericParams: [],
        designHints: [],
      },
    };
  }

  private describeInterfaceFromTreeSitter(point: TreeSitterExtensionPoint): string {
    const parts: string[] = [];

    if (point.methods && point.methods.length > 0) {
      parts.push(`${point.methods.length} methods`);
    }

    if (point.embedded && point.embedded.length > 0) {
      parts.push(`embeds ${point.embedded.join(', ')}`);
    }

    if (parts.length === 0) {
      return 'Empty interface (accepts any type)';
    }

    return `Interface with ${parts.join(', ')}`;
  }

  private scoreInterfaceFromTreeSitter(point: TreeSitterExtensionPoint): number {
    let score = 60;

    const methodCount = point.methods?.length || 0;
    if (methodCount >= 3) score += 15;
    else if (methodCount >= 1) score += 10;

    if (point.embedded && point.embedded.length > 0) score += 5;

    if (point.isPublic) score += 10;

    return Math.min(score, 100);
  }

  /**
   * Fallback regex-based analysis.
   */
  private analyzeContentWithRegex(
    content: string,
    filePath: string
  ): {
    extensionPoints: ExtensionPointInfo[];
    typeSemantics: TypeSemantics;
  } {
    const lines = content.split('\n');

    // Parse structure
    const interfaces = this.parseInterfaces(content, lines);
    const funcTypes = this.parseFuncTypes(content, lines);
    const typeAliases = this.parseTypeAliases(content, lines);

    // Extract extension points
    const extensionPoints: ExtensionPointInfo[] = [];
    const optionalCallbacks: OptionalCallbackInfo[] = [];
    const unionTypes: UnionTypeInfo[] = [];

    // Process interfaces
    for (const iface of interfaces) {
      if (!iface.isExported) continue;

      extensionPoints.push({
        kind: 'interface',
        name: iface.name,
        file: filePath,
        line: iface.line,
        semantics: this.describeInterface(iface),
        inferredPurpose: this.inferInterfacePurpose(iface.name, iface.methods),
        extensibilityScore: this.scoreInterface(iface),
      });

      // Each method in an interface is an extension point
      for (const method of iface.methods) {
        if (this.isExportedName(method.name)) {
          optionalCallbacks.push({
            name: method.name,
            signature: `(${method.params}) ${method.returns}`,
            file: filePath,
            line: method.line,
            parent: iface.name,
            returnType: method.returns,
          });
        }
      }
    }

    // Process function types (callback patterns)
    for (const funcType of funcTypes) {
      if (!funcType.isExported) continue;

      extensionPoints.push({
        kind: 'optional-callback',
        name: funcType.name,
        file: filePath,
        line: funcType.line,
        semantics: `Function type: ${funcType.signature}`,
        inferredPurpose: this.inferFuncTypePurpose(funcType.name),
        extensibilityScore: 65,
      });

      optionalCallbacks.push({
        name: funcType.name,
        signature: funcType.signature,
        file: filePath,
        line: funcType.line,
      });
    }

    // Process type aliases (especially type constraints)
    for (const alias of typeAliases) {
      if (alias.isConstraint && alias.members && alias.members.length >= 2) {
        const unionInfo: UnionTypeInfo = {
          name: alias.name,
          members: alias.members,
          file: filePath,
          line: alias.line,
          inferredPurpose: this.inferConstraintPurpose(alias.name, alias.members),
          fullType: alias.targetType,
        };

        unionTypes.push(unionInfo);

        extensionPoints.push({
          kind: 'union-type',
          name: alias.name,
          file: filePath,
          line: alias.line,
          semantics: `Type constraint: ${alias.members.slice(0, 4).join(' | ')}${alias.members.length > 4 ? ' | ...' : ''}`,
          values: alias.members,
          inferredPurpose: unionInfo.inferredPurpose,
          extensibilityScore: this.scoreConstraint(alias.members.length),
        });
      }
    }

    return {
      extensionPoints,
      typeSemantics: {
        unionTypes,
        optionalCallbacks,
        genericParams: [],
        designHints: [], // Handled by pattern-analyzer
      },
    };
  }

  // ============================================================================
  // Parsing Methods
  // ============================================================================

  private parseInterfaces(content: string, lines: string[]): GoInterface[] {
    const interfaces: GoInterface[] = [];

    // Match: type InterfaceName interface { ... }
    const interfaceRegex = /^type\s+(\w+)\s+interface\s*\{/gm;
    let match;

    while ((match = interfaceRegex.exec(content)) !== null) {
      const name = match[1]!;
      const startIndex = match.index;
      const lineNumber = content.substring(0, startIndex).split('\n').length;

      // Find the closing brace
      const bodyStart = content.indexOf('{', startIndex);
      const bodyEnd = this.findMatchingBrace(content, bodyStart);

      if (bodyEnd === -1) continue;

      const body = content.substring(bodyStart + 1, bodyEnd);
      const methods = this.parseInterfaceMethods(body, lineNumber);
      const embedded = this.parseEmbeddedInterfaces(body);

      interfaces.push({
        name,
        line: lineNumber,
        methods,
        embedded,
        isExported: this.isExportedName(name),
      });
    }

    return interfaces;
  }

  private parseInterfaceMethods(body: string, baseLineNumber: number): GoMethod[] {
    const methods: GoMethod[] = [];
    const lines = body.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line || line.startsWith('//')) continue;

      // Match method signature: MethodName(params) returns
      const methodMatch = line.match(/^(\w+)\s*\(([^)]*)\)\s*(.*)$/);
      if (methodMatch) {
        const name = methodMatch[1]!;
        const params = methodMatch[2]!;
        const returns = methodMatch[3]?.trim() || '';

        // Skip if it looks like an embedded interface (no parentheses originally)
        if (name && !line.includes('(') === false) {
          methods.push({
            name,
            line: baseLineNumber + i + 1,
            params,
            returns,
          });
        }
      }
    }

    return methods;
  }

  private parseEmbeddedInterfaces(body: string): string[] {
    const embedded: string[] = [];
    const lines = body.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;

      // Embedded interface: just a type name without parentheses
      if (/^\w+$/.test(trimmed) && this.isExportedName(trimmed)) {
        embedded.push(trimmed);
      }
    }

    return embedded;
  }

  private parseFuncTypes(content: string, lines: string[]): GoFuncType[] {
    const funcTypes: GoFuncType[] = [];

    // Match: type HandlerFunc func(...)
    const funcTypeRegex = /^type\s+(\w+)\s+func\s*(\([^)]*\)(?:\s*\([^)]*\)|\s*\w+)?)/gm;
    let match;

    while ((match = funcTypeRegex.exec(content)) !== null) {
      const name = match[1]!;
      const signature = match[2]!;
      const lineNumber = content.substring(0, match.index).split('\n').length;

      funcTypes.push({
        name,
        line: lineNumber,
        signature: `func${signature}`,
        isExported: this.isExportedName(name),
      });
    }

    return funcTypes;
  }

  private parseTypeAliases(content: string, lines: string[]): GoTypeAlias[] {
    const aliases: GoTypeAlias[] = [];

    // Match type constraints: type Constraint interface { Type1 | Type2 | Type3 }
    const constraintRegex = /^type\s+(\w+)\s+interface\s*\{\s*([^{}]+)\s*\}/gm;
    let match;

    while ((match = constraintRegex.exec(content)) !== null) {
      const name = match[1]!;
      const body = match[2]!.trim();
      const lineNumber = content.substring(0, match.index).split('\n').length;

      // Check if it's a type constraint (contains | for union)
      if (body.includes('|')) {
        const members = body
          .split('|')
          .map((m) => m.trim())
          .filter(Boolean);

        if (members.length >= 2) {
          aliases.push({
            name,
            line: lineNumber,
            targetType: body,
            isConstraint: true,
            members,
          });
        }
      }
    }

    // Also match simple type aliases: type MyType = OtherType
    const aliasRegex = /^type\s+(\w+)\s*=\s*(.+)$/gm;
    while ((match = aliasRegex.exec(content)) !== null) {
      const name = match[1]!;
      const targetType = match[2]!.trim();
      const lineNumber = content.substring(0, match.index).split('\n').length;

      aliases.push({
        name,
        line: lineNumber,
        targetType,
        isConstraint: false,
      });
    }

    return aliases;
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private findMatchingBrace(content: string, start: number): number {
    let depth = 0;
    for (let i = start; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  private isExportedName(name: string): boolean {
    return /^[A-Z]/.test(name);
  }

  private describeInterface(iface: GoInterface): string {
    const parts: string[] = [];

    if (iface.methods.length > 0) {
      parts.push(`${iface.methods.length} methods`);
    }

    if (iface.embedded.length > 0) {
      parts.push(`embeds ${iface.embedded.join(', ')}`);
    }

    if (parts.length === 0) {
      return 'Empty interface (accepts any type)';
    }

    return `Interface with ${parts.join(', ')}`;
  }

  // ============================================================================
  // Scoring Methods
  // ============================================================================

  private inferInterfacePurpose(name: string, methods: Array<{ name: string }>): InferredPurpose {
    const nameLower = name.toLowerCase();

    if (nameLower.includes('handler') || nameLower.includes('processor')) {
      return 'plugin-type';
    }

    if (nameLower.includes('reader') || nameLower.includes('writer') || nameLower.includes('formatter')) {
      return 'format-support';
    }

    if (nameLower.includes('callback') || nameLower.includes('hook') || nameLower.includes('listener')) {
      return 'callback-injection';
    }

    // Check method names
    const methodNames = methods.map((m) => m.name.toLowerCase());
    if (methodNames.some((n) => n.includes('handle') || n.includes('process'))) {
      return 'plugin-type';
    }

    return 'plugin-type'; // Go interfaces are primarily for extensibility
  }

  private inferFuncTypePurpose(name: string): InferredPurpose {
    const nameLower = name.toLowerCase();

    if (nameLower.includes('handler') || nameLower.includes('func')) {
      return 'callback-injection';
    }

    if (nameLower.includes('middleware')) {
      return 'plugin-type';
    }

    return 'callback-injection';
  }

  private inferConstraintPurpose(name: string, members: string[]): InferredPurpose {
    const nameLower = name.toLowerCase();
    const membersLower = members.map((m) => m.toLowerCase());

    if (nameLower.includes('number') || membersLower.some((m) => ['int', 'float', 'int64', 'float64'].includes(m))) {
      return 'content-type';
    }

    if (nameLower.includes('ordered') || nameLower.includes('comparable')) {
      return 'mode-selector';
    }

    return 'enum-options';
  }

  private scoreInterface(iface: GoInterface): number {
    let score = 60; // Base score for exported interfaces

    // More methods = more extensible
    if (iface.methods.length >= 3) score += 15;
    else if (iface.methods.length >= 1) score += 10;

    // Empty interface (any) is very extensible
    if (iface.methods.length === 0 && iface.embedded.length === 0) {
      score = 50; // Lower score - too generic
    }

    // Embedding other interfaces suggests composition pattern
    if (iface.embedded.length > 0) score += 10;

    // Common extension patterns
    const nameLower = iface.name.toLowerCase();
    if (nameLower.includes('handler') || nameLower.includes('processor')) {
      score += 15;
    }
    if (nameLower.includes('plugin') || nameLower.includes('provider')) {
      score += 20;
    }

    return Math.min(score, 100);
  }

  private scoreConstraint(memberCount: number): number {
    let score = 50;

    if (memberCount >= 5) score += 20;
    else if (memberCount >= 3) score += 10;

    return Math.min(score, 100);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createGoAnalyzer(): GoAnalyzer {
  return new GoAnalyzer();
}
