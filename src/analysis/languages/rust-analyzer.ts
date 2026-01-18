/**
 * Rust Extension Point Analyzer.
 *
 * Detects Rust-specific extension points:
 * - Trait definitions (primary extension mechanism)
 * - Enum types (sum types / discriminated unions)
 * - Type aliases with trait bounds
 * - Generic parameters with trait constraints
 * - Macro definitions (extensibility indicators)
 *
 * @module analysis/languages/rust-analyzer
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
  GenericParamInfo,
  InferredPurpose,
} from '../types.js';

const logger = createModuleLogger('rust-analyzer');

// ============================================================================
// Type Definitions
// ============================================================================

interface RustTrait {
  name: string;
  line: number;
  methods: RustMethod[];
  supertraits: string[];
  isPublic: boolean;
  generics?: string;
}

interface RustMethod {
  name: string;
  line: number;
  signature: string;
  isDefault: boolean;
  isAsync: boolean;
}

interface RustEnum {
  name: string;
  line: number;
  variants: string[];
  isPublic: boolean;
  generics?: string;
}

interface RustTypeAlias {
  name: string;
  line: number;
  targetType: string;
  bounds?: string;
  isPublic: boolean;
}

interface RustMacro {
  name: string;
  line: number;
  kind: 'macro_rules' | 'proc_macro' | 'derive';
}

// ============================================================================
// Rust Analyzer Class
// ============================================================================

export class RustAnalyzer {
  /**
   * Analyze Rust source code for extension points.
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
    const optionalCallbacks: OptionalCallbackInfo[] = [];
    const unionTypes: UnionTypeInfo[] = [];
    const genericParams: GenericParamInfo[] = [];

    for (const point of tsPoints) {
      if (point.kind === 'trait') {
        extensionPoints.push({
          kind: 'interface',
          name: point.name,
          file: filePath,
          line: point.line,
          semantics: this.describeTraitFromTreeSitter(point),
          inferredPurpose: this.inferTraitPurpose(point.name, point.methods || []),
          extensibilityScore: this.scoreTraitFromTreeSitter(point),
        });

        // Each method in a trait is an extension point
        if (point.methods) {
          for (const method of point.methods) {
            optionalCallbacks.push({
              name: method.name,
              signature: method.signature || 'fn()',
              file: filePath,
              line: method.line,
              parent: point.name,
            });

            // Non-default methods are required implementations
            if (!method.isDefault) {
              extensionPoints.push({
                kind: 'optional-callback',
                name: `${point.name}::${method.name}`,
                file: filePath,
                line: method.line,
                semantics: `Required trait method`,
                inferredPurpose: 'callback-injection',
                extensibilityScore: 70,
              });
            }
          }
        }
      } else if (point.kind === 'enum' && point.variants && point.variants.length >= 2) {
        const unionInfo: UnionTypeInfo = {
          name: point.name,
          members: point.variants,
          file: filePath,
          line: point.line,
          inferredPurpose: this.inferEnumPurpose(point.name, point.variants),
          fullType: point.generics ? `${point.name}${point.generics}` : point.name,
        };

        unionTypes.push(unionInfo);

        extensionPoints.push({
          kind: 'union-type',
          name: point.name,
          file: filePath,
          line: point.line,
          semantics: `Enum with ${point.variants.length} variants: ${point.variants.slice(0, 4).join(', ')}${point.variants.length > 4 ? ', ...' : ''}`,
          values: point.variants,
          inferredPurpose: unionInfo.inferredPurpose,
          extensibilityScore: this.scoreEnumFromTreeSitter(point),
        });
      } else if (point.kind === 'macro') {
        extensionPoints.push({
          kind: 'design-comment',
          name: point.name,
          file: filePath,
          line: point.line,
          semantics: `macro_rules! macro for code generation`,
          inferredPurpose: 'plugin-type',
          extensibilityScore: 60,
        });
      }
    }

    // Also parse type aliases with regex (tree-sitter may miss some)
    const lines = content.split('\n');
    const typeAliases = this.parseTypeAliases(content, lines);
    for (const alias of typeAliases) {
      if (!alias.isPublic) continue;
      if (alias.bounds) {
        extensionPoints.push({
          kind: 'generic-param',
          name: alias.name,
          file: filePath,
          line: alias.line,
          semantics: `Type alias with bounds: ${alias.bounds}`,
          inferredPurpose: 'plugin-type',
          extensibilityScore: 55,
        });
      }
    }

    return {
      extensionPoints,
      typeSemantics: {
        unionTypes,
        optionalCallbacks,
        genericParams,
        designHints: [],
      },
    };
  }

  private describeTraitFromTreeSitter(point: TreeSitterExtensionPoint): string {
    const parts: string[] = [];
    const methodCount = point.methods?.length || 0;
    const defaultCount = point.methods?.filter(m => m.isDefault).length || 0;
    const requiredCount = methodCount - defaultCount;

    if (methodCount > 0) {
      parts.push(`${methodCount} methods (${requiredCount} required)`);
    }

    if (point.supertraits && point.supertraits.length > 0) {
      parts.push(`extends ${point.supertraits.join(' + ')}`);
    }

    if (parts.length === 0) {
      return 'Marker trait';
    }

    return `Trait with ${parts.join(', ')}`;
  }

  private scoreTraitFromTreeSitter(point: TreeSitterExtensionPoint): number {
    let score = 60;

    const methodCount = point.methods?.length || 0;
    if (methodCount >= 3) score += 15;
    else if (methodCount >= 1) score += 10;

    if (point.supertraits && point.supertraits.length > 0) score += 5;
    if (point.isPublic) score += 10;

    return Math.min(score, 100);
  }

  private scoreEnumFromTreeSitter(point: TreeSitterExtensionPoint): number {
    let score = 50;

    const variantCount = point.variants?.length || 0;
    if (variantCount >= 5) score += 20;
    else if (variantCount >= 3) score += 10;

    if (point.isPublic) score += 15;

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
    const traits = this.parseTraits(content, lines);
    const enums = this.parseEnums(content, lines);
    const typeAliases = this.parseTypeAliases(content, lines);
    const macros = this.parseMacros(content, lines);

    // Extract extension points
    const extensionPoints: ExtensionPointInfo[] = [];
    const optionalCallbacks: OptionalCallbackInfo[] = [];
    const unionTypes: UnionTypeInfo[] = [];
    const genericParams: GenericParamInfo[] = [];

    // Process traits
    for (const trait of traits) {
      if (!trait.isPublic) continue;

      extensionPoints.push({
        kind: 'interface',
        name: trait.name,
        file: filePath,
        line: trait.line,
        semantics: this.describeTrait(trait),
        inferredPurpose: this.inferTraitPurpose(trait.name, trait.methods),
        extensibilityScore: this.scoreTrait(trait),
      });

      // Each method in a trait is an extension point
      for (const method of trait.methods) {
        optionalCallbacks.push({
          name: method.name,
          signature: method.signature,
          file: filePath,
          line: method.line,
          parent: trait.name,
        });

        // Non-default methods are required implementations
        if (!method.isDefault) {
          extensionPoints.push({
            kind: 'optional-callback',
            name: `${trait.name}::${method.name}`,
            file: filePath,
            line: method.line,
            semantics: `Required trait method${method.isAsync ? ' (async)' : ''}`,
            inferredPurpose: 'callback-injection',
            extensibilityScore: 70,
          });
        }
      }
    }

    // Process enums (Rust's sum types)
    for (const enumDef of enums) {
      if (!enumDef.isPublic) continue;

      if (enumDef.variants.length >= 2) {
        const unionInfo: UnionTypeInfo = {
          name: enumDef.name,
          members: enumDef.variants,
          file: filePath,
          line: enumDef.line,
          inferredPurpose: this.inferEnumPurpose(enumDef.name, enumDef.variants),
          fullType: enumDef.generics ? `${enumDef.name}${enumDef.generics}` : enumDef.name,
        };

        unionTypes.push(unionInfo);

        extensionPoints.push({
          kind: 'union-type',
          name: enumDef.name,
          file: filePath,
          line: enumDef.line,
          semantics: `Enum with ${enumDef.variants.length} variants: ${enumDef.variants.slice(0, 4).join(', ')}${enumDef.variants.length > 4 ? ', ...' : ''}`,
          values: enumDef.variants,
          inferredPurpose: unionInfo.inferredPurpose,
          extensibilityScore: this.scoreEnum(enumDef),
        });
      }
    }

    // Process type aliases with trait bounds
    for (const alias of typeAliases) {
      if (!alias.isPublic) continue;

      if (alias.bounds) {
        extensionPoints.push({
          kind: 'generic-param',
          name: alias.name,
          file: filePath,
          line: alias.line,
          semantics: `Type alias with bounds: ${alias.bounds}`,
          inferredPurpose: 'plugin-type',
          extensibilityScore: 55,
        });
      }
    }

    // Process macros (extensibility indicators)
    for (const macro of macros) {
      extensionPoints.push({
        kind: 'design-comment', // Using design-comment as closest match
        name: macro.name,
        file: filePath,
        line: macro.line,
        semantics: `${macro.kind} macro for code generation`,
        inferredPurpose: 'plugin-type',
        extensibilityScore: macro.kind === 'proc_macro' ? 75 : 60,
      });
    }

    return {
      extensionPoints,
      typeSemantics: {
        unionTypes,
        optionalCallbacks,
        genericParams,
        designHints: [], // Handled by pattern-analyzer
      },
    };
  }

  // ============================================================================
  // Parsing Methods
  // ============================================================================

  private parseTraits(content: string, lines: string[]): RustTrait[] {
    const traits: RustTrait[] = [];

    // Match: pub trait TraitName<T>: SuperTrait { ... }
    const traitRegex = /^(pub\s+)?trait\s+(\w+)(?:<([^>]+)>)?(?:\s*:\s*([^\{]+))?\s*\{/gm;
    let match;

    while ((match = traitRegex.exec(content)) !== null) {
      const isPublic = !!match[1];
      const name = match[2]!;
      const generics = match[3];
      const supertraitsStr = match[4]?.trim();
      const startIndex = match.index;
      const lineNumber = content.substring(0, startIndex).split('\n').length;

      // Find the closing brace
      const bodyStart = content.indexOf('{', startIndex);
      const bodyEnd = this.findMatchingBrace(content, bodyStart);

      if (bodyEnd === -1) continue;

      const body = content.substring(bodyStart + 1, bodyEnd);
      const methods = this.parseTraitMethods(body, lineNumber);
      const supertraits = supertraitsStr
        ? supertraitsStr.split('+').map((s) => s.trim()).filter(Boolean)
        : [];

      traits.push({
        name,
        line: lineNumber,
        methods,
        supertraits,
        isPublic,
        generics,
      });
    }

    return traits;
  }

  private parseTraitMethods(body: string, baseLineNumber: number): RustMethod[] {
    const methods: RustMethod[] = [];
    const lines = body.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line || line.startsWith('//') || line.startsWith('/*')) continue;

      // Match method signature: fn method_name(...) -> ReturnType
      const methodMatch = line.match(/^(async\s+)?fn\s+(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)(?:\s*->\s*([^;{]+))?/);
      if (methodMatch) {
        const isAsync = !!methodMatch[1];
        const name = methodMatch[2]!;
        const generics = methodMatch[3] || '';
        const params = methodMatch[4]!;
        const returnType = methodMatch[5]?.trim() || '()';

        // Check if it's a default implementation (has a body)
        const isDefault = line.includes('{') || (i + 1 < lines.length && lines[i + 1]?.trim().startsWith('{')) || false;

        methods.push({
          name,
          line: baseLineNumber + i + 1,
          signature: `fn ${name}${generics}(${params}) -> ${returnType}`,
          isDefault,
          isAsync,
        });
      }
    }

    return methods;
  }

  private parseEnums(content: string, lines: string[]): RustEnum[] {
    const enums: RustEnum[] = [];

    // Match: pub enum EnumName<T> { ... }
    const enumRegex = /^(pub\s+)?enum\s+(\w+)(?:<([^>]+)>)?\s*\{/gm;
    let match;

    while ((match = enumRegex.exec(content)) !== null) {
      const isPublic = !!match[1];
      const name = match[2]!;
      const generics = match[3] ? `<${match[3]}>` : undefined;
      const startIndex = match.index;
      const lineNumber = content.substring(0, startIndex).split('\n').length;

      // Find the closing brace
      const bodyStart = content.indexOf('{', startIndex);
      const bodyEnd = this.findMatchingBrace(content, bodyStart);

      if (bodyEnd === -1) continue;

      const body = content.substring(bodyStart + 1, bodyEnd);
      const variants = this.parseEnumVariants(body);

      enums.push({
        name,
        line: lineNumber,
        variants,
        isPublic,
        generics,
      });
    }

    return enums;
  }

  private parseEnumVariants(body: string): string[] {
    const variants: string[] = [];
    const lines = body.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;

      // Match variant name (with optional tuple/struct data)
      const variantMatch = trimmed.match(/^(\w+)(?:\s*[({]|,|$)/);
      if (variantMatch) {
        variants.push(variantMatch[1]!);
      }
    }

    return variants;
  }

  private parseTypeAliases(content: string, lines: string[]): RustTypeAlias[] {
    const aliases: RustTypeAlias[] = [];

    // Match: pub type TypeName<T: Bound> = TargetType;
    const typeRegex = /^(pub\s+)?type\s+(\w+)(?:<([^>]+)>)?\s*=\s*([^;]+);/gm;
    let match;

    while ((match = typeRegex.exec(content)) !== null) {
      const isPublic = !!match[1];
      const name = match[2]!;
      const genericsWithBounds = match[3];
      const targetType = match[4]!.trim();
      const lineNumber = content.substring(0, match.index).split('\n').length;

      // Extract bounds from generics (e.g., T: Clone + Send)
      let bounds: string | undefined;
      if (genericsWithBounds && genericsWithBounds.includes(':')) {
        bounds = genericsWithBounds;
      }

      aliases.push({
        name,
        line: lineNumber,
        targetType,
        bounds,
        isPublic,
      });
    }

    return aliases;
  }

  private parseMacros(content: string, lines: string[]): RustMacro[] {
    const macros: RustMacro[] = [];

    // Match macro_rules!
    const macroRulesRegex = /^macro_rules!\s+(\w+)/gm;
    let match;

    while ((match = macroRulesRegex.exec(content)) !== null) {
      const lineNumber = content.substring(0, match.index).split('\n').length;
      macros.push({
        name: match[1]!,
        line: lineNumber,
        kind: 'macro_rules',
      });
    }

    // Match proc_macro attributes
    const procMacroRegex = /#\[proc_macro(?:_derive|_attribute)?\s*(?:\([^\)]*\))?\]/gm;
    while ((match = procMacroRegex.exec(content)) !== null) {
      const lineNumber = content.substring(0, match.index).split('\n').length;
      // Look for the next fn definition
      const fnMatch = content.substring(match.index).match(/\bfn\s+(\w+)/);
      if (fnMatch) {
        macros.push({
          name: fnMatch[1]!,
          line: lineNumber,
          kind: 'proc_macro',
        });
      }
    }

    // Match derive macros usage (common patterns)
    const deriveRegex = /#\[derive\(([^\)]+)\)\]/gm;
    while ((match = deriveRegex.exec(content)) !== null) {
      const lineNumber = content.substring(0, match.index).split('\n').length;
      const derives = match[1]!.split(',').map((d) => d.trim());
      
      // Only include custom derives (not standard library ones)
      const customDerives = derives.filter((d) => 
        !['Debug', 'Clone', 'Copy', 'Default', 'PartialEq', 'Eq', 'Hash', 'PartialOrd', 'Ord'].includes(d)
      );
      
      for (const derive of customDerives) {
        macros.push({
          name: derive,
          line: lineNumber,
          kind: 'derive',
        });
      }
    }

    return macros;
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

  private describeTrait(trait: RustTrait): string {
    const parts: string[] = [];

    if (trait.methods.length > 0) {
      const required = trait.methods.filter((m) => !m.isDefault).length;
      const defaulted = trait.methods.filter((m) => m.isDefault).length;
      if (required > 0) parts.push(`${required} required methods`);
      if (defaulted > 0) parts.push(`${defaulted} default methods`);
    }

    if (trait.supertraits.length > 0) {
      parts.push(`extends ${trait.supertraits.join(' + ')}`);
    }

    if (parts.length === 0) {
      return 'Marker trait';
    }

    return `Trait with ${parts.join(', ')}`;
  }

  // ============================================================================
  // Scoring Methods
  // ============================================================================

  private inferTraitPurpose(name: string, methods: Array<{ name: string }>): InferredPurpose {
    const nameLower = name.toLowerCase();

    if (nameLower.includes('handler') || nameLower.includes('processor')) {
      return 'plugin-type';
    }

    if (nameLower.includes('visitor') || nameLower.includes('iterator')) {
      return 'plugin-type';
    }

    if (nameLower.includes('serializer') || nameLower.includes('deserializer') || nameLower.includes('codec')) {
      return 'format-support';
    }

    if (nameLower.includes('callback') || nameLower.includes('hook') || nameLower.includes('listener')) {
      return 'callback-injection';
    }

    // Check method names
    const methodNames = methods.map((m) => m.name.toLowerCase());
    if (methodNames.some((n) => n.includes('handle') || n.includes('process') || n.includes('visit'))) {
      return 'plugin-type';
    }

    return 'plugin-type'; // Rust traits are primarily for extensibility
  }

  private inferEnumPurpose(name: string, variants: string[]): InferredPurpose {
    const nameLower = name.toLowerCase();
    const variantsLower = variants.map((v) => v.toLowerCase());

    if (
      nameLower.includes('error') ||
      nameLower.includes('result') ||
      variantsLower.some((v) => v.includes('error') || v.includes('ok'))
    ) {
      return 'enum-options';
    }

    if (
      nameLower.includes('format') ||
      nameLower.includes('type') ||
      nameLower.includes('kind')
    ) {
      return 'content-type';
    }

    if (
      nameLower.includes('mode') ||
      nameLower.includes('state') ||
      nameLower.includes('status')
    ) {
      return 'mode-selector';
    }

    if (nameLower.includes('event') || nameLower.includes('message') || nameLower.includes('command')) {
      return 'plugin-type';
    }

    return 'enum-options';
  }

  private scoreTrait(trait: RustTrait): number {
    let score = 60; // Base score for public traits

    // More methods = more extensible
    const requiredMethods = trait.methods.filter((m) => !m.isDefault).length;
    if (requiredMethods >= 3) score += 15;
    else if (requiredMethods >= 1) score += 10;

    // Default methods show flexibility
    const defaultMethods = trait.methods.filter((m) => m.isDefault).length;
    if (defaultMethods > 0) score += 5;

    // Marker traits (no methods) have lower extensibility
    if (trait.methods.length === 0) {
      score = 45;
    }

    // Supertraits indicate trait hierarchy (composition)
    if (trait.supertraits.length > 0) score += 10;

    // Common extension patterns
    const nameLower = trait.name.toLowerCase();
    if (nameLower.includes('handler') || nameLower.includes('processor')) {
      score += 15;
    }
    if (nameLower.includes('plugin') || nameLower.includes('provider') || nameLower.includes('service')) {
      score += 20;
    }

    return Math.min(score, 100);
  }

  private scoreEnum(enumDef: RustEnum): number {
    let score = 50;

    // More variants = more extensible (in terms of representing different cases)
    if (enumDef.variants.length >= 5) score += 20;
    else if (enumDef.variants.length >= 3) score += 10;

    // Generic enums are more flexible
    if (enumDef.generics) score += 10;

    // Common patterns
    const nameLower = enumDef.name.toLowerCase();
    if (nameLower.includes('event') || nameLower.includes('message') || nameLower.includes('command')) {
      score += 15;
    }

    return Math.min(score, 100);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createRustAnalyzer(): RustAnalyzer {
  return new RustAnalyzer();
}
