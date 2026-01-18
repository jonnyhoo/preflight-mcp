/**
 * Python Extension Point Analyzer using tree-sitter.
 *
 * Detects Python-specific extension points:
 * - Abstract Base Classes (ABC)
 * - Protocol classes (typing.Protocol)
 * - Abstract methods (@abstractmethod)
 * - Type hints with Union/Optional
 * - Callback patterns
 *
 * @module analysis/languages/python-analyzer
 */

import { createModuleLogger } from '../../logging/logger.js';
import {
  extractExtensionPointsWasm,
  type ExtensionPoint as TreeSitterExtensionPoint,
} from '../../ast/index.js';
import type {
  ExtensionPointInfo,
  TypeSemantics,
  UnionTypeInfo,
  OptionalCallbackInfo,
  DesignHintInfo,
  InferredPurpose,
} from '../types.js';

const logger = createModuleLogger('python-analyzer');

// ============================================================================
// Type Definitions
// ============================================================================

interface PythonClass {
  name: string;
  line: number;
  bases: string[];
  decorators: string[];
  methods: PythonMethod[];
  isAbstract: boolean;
  isProtocol: boolean;
}

interface PythonMethod {
  name: string;
  line: number;
  decorators: string[];
  params: string[];
  returnType?: string;
  isAbstract: boolean;
  isCallback: boolean;
}

interface PythonTypeAlias {
  name: string;
  line: number;
  typeExpr: string;
  isUnion: boolean;
  members?: string[];
}

// ============================================================================
// Regex Patterns for Python Analysis
// ============================================================================

const PATTERNS = {
  // Class definition: class Foo(Bar, Baz):
  classDefinition: /^(\s*)class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/gm,

  // Decorator: @abstractmethod, @property, etc.
  decorator: /^(\s*)@(\w+(?:\.\w+)*)/gm,

  // Method definition: def foo(self, ...):
  methodDefinition: /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?\s*:/gm,

  // Type alias: FooType = Union[A, B] or FooType: TypeAlias = ...
  typeAlias: /^(\w+)(?:\s*:\s*TypeAlias)?\s*=\s*(.+)$/gm,

  // Union type in annotation: Union[A, B] or A | B
  unionType: /Union\[([^\]]+)\]|(\w+(?:\s*\|\s*\w+)+)/,

  // Optional type: Optional[X] or X | None
  optionalType: /Optional\[(\w+)\]|(\w+)\s*\|\s*None/,

  // Callable type: Callable[[...], ...]
  callableType: /Callable\[\[([^\]]*)\],\s*([^\]]+)\]/,

  // Protocol import check
  protocolImport: /from\s+typing(?:_extensions)?\s+import\s+.*\bProtocol\b/,

  // ABC import check
  abcImport: /from\s+abc\s+import\s+.*\bABC\b|import\s+abc/,
};

// ============================================================================
// Python Analyzer Class
// ============================================================================

export class PythonAnalyzer {
  /**
   * Analyze Python source code for extension points.
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
      return this.convertTreeSitterResult(treeSitterResult.extensionPoints, content, filePath);
    }
    
    // Fallback to regex-based parsing
    return this.analyzeContentWithRegex(content, filePath);
  }

  /**
   * Convert tree-sitter extension points to our format.
   */
  private convertTreeSitterResult(
    tsPoints: TreeSitterExtensionPoint[],
    content: string,
    filePath: string
  ): {
    extensionPoints: ExtensionPointInfo[];
    typeSemantics: TypeSemantics;
  } {
    const extensionPoints: ExtensionPointInfo[] = [];
    const unionTypes: UnionTypeInfo[] = [];
    const optionalCallbacks: OptionalCallbackInfo[] = [];

    for (const point of tsPoints) {
      if (point.kind === 'abstract-class' || point.kind === 'protocol') {
        extensionPoints.push({
          kind: 'interface',
          name: point.name,
          file: filePath,
          line: point.line,
          semantics: point.kind === 'protocol'
            ? `Protocol class defining structural typing contract`
            : `Abstract base class with ${point.methods?.filter(m => m.isAbstract).length || 0} abstract methods`,
          inferredPurpose: 'plugin-type',
          extensibilityScore: point.kind === 'protocol' ? 85 : 75,
        });

        // Add abstract methods as extension points
        if (point.methods) {
          for (const method of point.methods) {
            if (method.isAbstract) {
              extensionPoints.push({
                kind: 'optional-callback',
                name: `${point.name}.${method.name}`,
                file: filePath,
                line: method.line,
                semantics: `Abstract method to be implemented by subclasses`,
                inferredPurpose: 'callback-injection',
                extensibilityScore: 70,
              });

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
      }
    }

    // Also parse type aliases with regex (tree-sitter doesn't easily detect these)
    const typeAliases = this.parseTypeAliases(content);
    for (const alias of typeAliases) {
      if (alias.isUnion && alias.members && alias.members.length >= 2) {
        const unionInfo: UnionTypeInfo = {
          name: alias.name,
          members: alias.members,
          file: filePath,
          line: alias.line,
          inferredPurpose: this.inferUnionPurpose(alias.name, alias.members),
          fullType: alias.typeExpr,
        };

        unionTypes.push(unionInfo);

        extensionPoints.push({
          kind: 'union-type',
          name: alias.name,
          file: filePath,
          line: alias.line,
          semantics: `Union type with ${alias.members.length} variants: ${alias.members.slice(0, 4).join(' | ')}${alias.members.length > 4 ? ' | ...' : ''}`,
          values: alias.members,
          inferredPurpose: unionInfo.inferredPurpose,
          extensibilityScore: this.scoreUnionType(unionInfo.inferredPurpose ?? 'enum-options', alias.members.length),
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
    const classes = this.parseClasses(content, lines);
    const typeAliases = this.parseTypeAliases(content);
    const hasProtocolImport = PATTERNS.protocolImport.test(content);
    const hasAbcImport = PATTERNS.abcImport.test(content);

    // Extract extension points
    const extensionPoints: ExtensionPointInfo[] = [];
    const unionTypes: UnionTypeInfo[] = [];
    const optionalCallbacks: OptionalCallbackInfo[] = [];

    // Process classes
    for (const cls of classes) {
      // Check if it's an ABC or Protocol
      const isExtensionPoint =
        cls.isAbstract ||
        cls.isProtocol ||
        cls.bases.some((b) => ['ABC', 'Protocol', 'abc.ABC'].includes(b));

      if (isExtensionPoint) {
        extensionPoints.push({
          kind: 'interface', // Python ABCs/Protocols are analogous to interfaces
          name: cls.name,
          file: filePath,
          line: cls.line,
          semantics: cls.isProtocol
            ? `Protocol class defining structural typing contract`
            : `Abstract base class with ${cls.methods.filter((m) => m.isAbstract).length} abstract methods`,
          inferredPurpose: 'plugin-type',
          extensibilityScore: cls.isProtocol ? 85 : 75,
        });
      }

      // Process abstract methods
      for (const method of cls.methods) {
        if (method.isAbstract) {
          extensionPoints.push({
            kind: 'optional-callback',
            name: `${cls.name}.${method.name}`,
            file: filePath,
            line: method.line,
            semantics: `Abstract method to be implemented by subclasses`,
            inferredPurpose: 'callback-injection',
            extensibilityScore: 70,
          });
        }

        // Check for callback-style methods
        if (method.isCallback && method.returnType) {
          optionalCallbacks.push({
            name: method.name,
            signature: `(${method.params.join(', ')}) -> ${method.returnType}`,
            file: filePath,
            line: method.line,
            parent: cls.name,
            paramTypes: method.params,
            returnType: method.returnType,
          });
        }
      }
    }

    // Process type aliases
    for (const alias of typeAliases) {
      if (alias.isUnion && alias.members && alias.members.length >= 2) {
        const unionInfo: UnionTypeInfo = {
          name: alias.name,
          members: alias.members,
          file: filePath,
          line: alias.line,
          inferredPurpose: this.inferUnionPurpose(alias.name, alias.members),
          fullType: alias.typeExpr,
        };

        unionTypes.push(unionInfo);

        extensionPoints.push({
          kind: 'union-type',
          name: alias.name,
          file: filePath,
          line: alias.line,
          semantics: `Union type with ${alias.members.length} variants: ${alias.members.slice(0, 4).join(' | ')}${alias.members.length > 4 ? ' | ...' : ''}`,
          values: alias.members,
          inferredPurpose: unionInfo.inferredPurpose,
          extensibilityScore: this.scoreUnionType(unionInfo.inferredPurpose ?? 'enum-options', alias.members.length),
        });
      }
    }

    return {
      extensionPoints,
      typeSemantics: {
        unionTypes,
        optionalCallbacks,
        genericParams: [], // Could be extended to parse Generic[T] patterns
        designHints: [], // Handled by pattern-analyzer
      },
    };
  }

  // ============================================================================
  // Parsing Methods
  // ============================================================================

  private parseClasses(content: string, lines: string[]): PythonClass[] {
    const classes: PythonClass[] = [];
    const decoratorStack: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Collect decorators
      const decoratorMatch = line.match(/^\s*@(\w+(?:\.\w+)*)/);
      if (decoratorMatch) {
        decoratorStack.push(decoratorMatch[1]!);
        continue;
      }

      // Check for class definition
      const classMatch = line.match(/^(\s*)class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/);
      if (classMatch) {
        const indent = classMatch[1]!.length;
        const name = classMatch[2]!;
        const basesStr = classMatch[3] || '';
        const bases = basesStr
          .split(',')
          .map((b) => b.trim())
          .filter(Boolean);

        const decorators = [...decoratorStack];
        decoratorStack.length = 0;

        const isAbstract =
          bases.some((b) => ['ABC', 'abc.ABC'].includes(b)) ||
          decorators.includes('abstractmethod');
        const isProtocol = bases.some((b) => ['Protocol', 'typing.Protocol'].includes(b));

        // Parse methods within this class
        const methods = this.parseClassMethods(lines, i + 1, indent);

        classes.push({
          name,
          line: i + 1,
          bases,
          decorators,
          methods,
          isAbstract: isAbstract || methods.some((m) => m.isAbstract),
          isProtocol,
        });

        continue;
      }

      // Reset decorator stack if we hit a non-decorator, non-class line
      if (line.trim() && !line.trim().startsWith('#')) {
        decoratorStack.length = 0;
      }
    }

    return classes;
  }

  private parseClassMethods(lines: string[], startLine: number, classIndent: number): PythonMethod[] {
    const methods: PythonMethod[] = [];
    const decoratorStack: string[] = [];

    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i]!;

      // Check if we've exited the class (less indentation)
      if (line.trim() && !line.trim().startsWith('#')) {
        const currentIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
        if (currentIndent <= classIndent && line.trim()) {
          break;
        }
      }

      // Collect decorators
      const decoratorMatch = line.match(/^\s*@(\w+(?:\.\w+)*)/);
      if (decoratorMatch) {
        decoratorStack.push(decoratorMatch[1]!);
        continue;
      }

      // Check for method definition
      const methodMatch = line.match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?\s*:/);
      if (methodMatch) {
        const name = methodMatch[1]!;
        const paramsStr = methodMatch[2] || '';
        const returnType = methodMatch[3]?.trim();

        const params = paramsStr
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p && p !== 'self' && p !== 'cls');

        const decorators = [...decoratorStack];
        decoratorStack.length = 0;

        const isAbstract = decorators.includes('abstractmethod') || decorators.includes('abc.abstractmethod');
        const isCallback =
          returnType?.includes('Callable') ||
          params.some((p) => p.includes('Callable')) ||
          decorators.includes('property');

        methods.push({
          name,
          line: i + 1,
          decorators,
          params,
          returnType,
          isAbstract,
          isCallback,
        });

        continue;
      }

      // Reset decorator stack
      if (line.trim() && !line.trim().startsWith('#')) {
        decoratorStack.length = 0;
      }
    }

    return methods;
  }

  private parseTypeAliases(content: string): PythonTypeAlias[] {
    const aliases: PythonTypeAlias[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Match: FooType = Union[...] or FooType: TypeAlias = ...
      const match = line.match(/^(\w+)(?:\s*:\s*TypeAlias)?\s*=\s*(.+)$/);
      if (match) {
        const name = match[1]!;
        const typeExpr = match[2]!.trim();

        // Skip if it looks like a regular assignment (not a type)
        if (!this.looksLikeTypeExpression(typeExpr)) {
          continue;
        }

        const unionMembers = this.extractUnionMembers(typeExpr);

        aliases.push({
          name,
          line: i + 1,
          typeExpr,
          isUnion: unionMembers.length >= 2,
          members: unionMembers.length >= 2 ? unionMembers : undefined,
        });
      }
    }

    return aliases;
  }

  private looksLikeTypeExpression(expr: string): boolean {
    // Type expressions typically contain:
    // - Union, Optional, List, Dict, Callable, etc.
    // - Literal[...] for literal types
    // - A | B pipe syntax (including "a" | "b" string literal unions)
    // - Capitalized type names
    return (
      /Union\[|Optional\[|List\[|Dict\[|Callable\[|Literal\[|Set\[|Tuple\[/.test(expr) ||
      /\w+\s*\|\s*\w+/.test(expr) ||
      /["']\w+["']\s*\|/.test(expr) ||  // String literal unions: "a" | "b"
      /^[A-Z]\w*$/.test(expr)
    );
  }

  private extractUnionMembers(typeExpr: string): string[] {
    // Handle Union[A, B, C]
    const unionMatch = typeExpr.match(/Union\[([^\]]+)\]/);
    if (unionMatch) {
      return unionMatch[1]!
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);
    }

    // Handle A | B | C (Python 3.10+ syntax, including string literals)
    if (typeExpr.includes('|')) {
      return typeExpr
        .split('|')
        .map((m) => m.trim().replace(/^['"]|['"]$/g, ''))  // Strip surrounding quotes
        .filter(Boolean);
    }

    // Handle Literal["a", "b", "c"]
    const literalMatch = typeExpr.match(/Literal\[([^\]]+)\]/);
    if (literalMatch) {
      return literalMatch[1]!
        .split(',')
        .map((m) => m.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    }

    return [];
  }

  // ============================================================================
  // Scoring Methods
  // ============================================================================

  private inferUnionPurpose(name: string, members: string[]): InferredPurpose {
    const nameLower = name.toLowerCase();
    const membersLower = members.map((m) => m.toLowerCase());

    if (
      nameLower.includes('format') ||
      nameLower.includes('source') ||
      membersLower.some((m) => ['json', 'xml', 'yaml', 'text', 'html', 'markdown', 'csv'].includes(m))
    ) {
      return 'format-support';
    }

    if (
      nameLower.includes('mode') ||
      nameLower.includes('scope') ||
      nameLower.includes('level') ||
      membersLower.some((m) => ['all', 'none', 'auto', 'manual', 'default'].includes(m))
    ) {
      return 'mode-selector';
    }

    if (
      nameLower.includes('type') ||
      nameLower.includes('kind') ||
      membersLower.some((m) => ['image', 'table', 'text', 'code', 'audio', 'video'].includes(m))
    ) {
      return 'content-type';
    }

    if (
      nameLower.includes('processor') ||
      nameLower.includes('handler') ||
      nameLower.includes('parser') ||
      nameLower.includes('plugin')
    ) {
      return 'plugin-type';
    }

    return 'enum-options';
  }

  private scoreUnionType(purpose: InferredPurpose, memberCount: number): number {
    let base = 50;

    // Purpose bonus
    switch (purpose) {
      case 'format-support':
        base += 25;
        break;
      case 'plugin-type':
        base += 20;
        break;
      case 'content-type':
        base += 15;
        break;
      case 'mode-selector':
        base += 10;
        break;
    }

    // Member count bonus (more members = more extensible)
    if (memberCount >= 5) base += 10;
    else if (memberCount >= 3) base += 5;

    return Math.min(base, 100);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createPythonAnalyzer(): PythonAnalyzer {
  return new PythonAnalyzer();
}
