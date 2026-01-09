/**
 * Type Semantic Analyzer using ts-morph.
 *
 * Provides deep TypeScript type analysis including:
 * - Union type extraction with literal values
 * - Optional callback detection in interfaces
 * - Generic type parameter analysis
 *
 * @module analysis/type-semantic-analyzer
 */

import { Project, SourceFile, Type, Node, SyntaxKind } from 'ts-morph';
import type {
  UnionTypeInfo,
  OptionalCallbackInfo,
  GenericParamInfo,
  TypeSemantics,
  InferredPurpose,
} from './types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('type-semantic-analyzer');

// ============================================================================
// Type Semantic Analyzer
// ============================================================================

/**
 * Analyzer for TypeScript type semantics using ts-morph.
 */
export class TypeSemanticAnalyzer {
  private project: Project;
  private initialized = false;

  constructor(tsConfigPath?: string) {
    this.project = new Project({
      tsConfigFilePath: tsConfigPath || undefined,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        allowJs: true,
        declaration: false,
        noEmit: true,
      },
    });
  }

  /**
   * Analyze a single file for type semantics.
   */
  analyzeFile(filePath: string, bundleRelativePath?: string): TypeSemantics {
    const startTime = Date.now();
    const relativePath = bundleRelativePath || filePath;

    try {
      // Add file to project
      let sourceFile = this.project.getSourceFile(filePath);
      if (!sourceFile) {
        sourceFile = this.project.addSourceFileAtPath(filePath);
      }

      const result: TypeSemantics = {
        unionTypes: this.extractUnionTypes(sourceFile, relativePath),
        optionalCallbacks: this.extractOptionalCallbacks(sourceFile, relativePath),
        genericParams: this.extractGenericParams(sourceFile, relativePath),
        designHints: [], // Handled by pattern-analyzer
      };

      logger.debug(`Analyzed ${relativePath} in ${Date.now() - startTime}ms`, {
        unionTypes: result.unionTypes.length,
        callbacks: result.optionalCallbacks.length,
        generics: result.genericParams.length,
      });

      return result;
    } catch (error) {
      logger.error(`Failed to analyze ${relativePath}`, error instanceof Error ? error : undefined);
      return {
        unionTypes: [],
        optionalCallbacks: [],
        genericParams: [],
        designHints: [],
      };
    }
  }

  /**
   * Analyze multiple files.
   */
  analyzeFiles(files: Array<{ absPath: string; relativePath: string }>): TypeSemantics {
    const aggregated: TypeSemantics = {
      unionTypes: [],
      optionalCallbacks: [],
      genericParams: [],
      designHints: [],
    };

    for (const file of files) {
      try {
        const result = this.analyzeFile(file.absPath, file.relativePath);
        aggregated.unionTypes.push(...result.unionTypes);
        aggregated.optionalCallbacks.push(...result.optionalCallbacks);
        aggregated.genericParams.push(...result.genericParams);
      } catch (error) {
        logger.warn(`Skipping file ${file.relativePath}`, { error: String(error) });
      }
    }

    return aggregated;
  }

  // ============================================================================
  // Union Type Extraction
  // ============================================================================

  /**
   * Extract union type definitions from a source file.
   */
  private extractUnionTypes(sourceFile: SourceFile, filePath: string): UnionTypeInfo[] {
    const results: UnionTypeInfo[] = [];

    // Get all type aliases
    for (const alias of sourceFile.getTypeAliases()) {
      const type = alias.getType();

      if (type.isUnion()) {
        const members = this.extractUnionMembers(type);

        // Only include if we have meaningful members (at least 2)
        if (members.length >= 2) {
          const name = alias.getName();
          results.push({
            name,
            members,
            file: filePath,
            line: alias.getStartLineNumber(),
            inferredPurpose: this.inferUnionPurpose(name, members),
            fullType: alias.getType().getText(),
          });
        }
      }
    }

    return results;
  }

  /**
   * Extract union type members, handling literals and type references.
   */
  private extractUnionMembers(type: Type): string[] {
    const members: string[] = [];

    for (const unionType of type.getUnionTypes()) {
      // Handle string literals
      if (unionType.isStringLiteral()) {
        const literal = unionType.getLiteralValue();
        if (literal !== undefined) {
          members.push(String(literal));
        }
      }
      // Handle number literals
      else if (unionType.isNumberLiteral()) {
        const literal = unionType.getLiteralValue();
        if (literal !== undefined) {
          members.push(String(literal));
        }
      }
      // Handle boolean literals
      else if (unionType.isBooleanLiteral()) {
        members.push(unionType.getText());
      }
      // Handle type references and other types
      else {
        const text = unionType.getText();
        // Filter out complex types, keep simple type names
        if (text && !text.includes('{') && !text.includes('(') && text.length < 50) {
          members.push(text);
        }
      }
    }

    return members;
  }

  /**
   * Infer the semantic purpose of a union type based on name and members.
   */
  private inferUnionPurpose(name: string, members: string[]): InferredPurpose {
    const nameLower = name.toLowerCase();
    const membersLower = members.map((m) => m.toLowerCase());

    // Format support detection
    if (
      nameLower.includes('format') ||
      nameLower.includes('source') ||
      membersLower.some((m) => ['json', 'xml', 'yaml', 'text', 'html', 'markdown'].includes(m))
    ) {
      return 'format-support';
    }

    // Mode/scope selector
    if (
      nameLower.includes('mode') ||
      nameLower.includes('scope') ||
      nameLower.includes('level') ||
      membersLower.some((m) => ['all', 'none', 'auto', 'manual'].includes(m))
    ) {
      return 'mode-selector';
    }

    // Content type discrimination
    if (
      nameLower.includes('type') ||
      nameLower.includes('kind') ||
      membersLower.some((m) => ['image', 'table', 'text', 'code', 'equation'].includes(m))
    ) {
      return 'content-type';
    }

    // Plugin/processor type
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

  // ============================================================================
  // Optional Callback Extraction
  // ============================================================================

  /**
   * Extract optional callback properties from interfaces and types.
   */
  private extractOptionalCallbacks(
    sourceFile: SourceFile,
    filePath: string
  ): OptionalCallbackInfo[] {
    const results: OptionalCallbackInfo[] = [];

    // Analyze interfaces
    for (const iface of sourceFile.getInterfaces()) {
      const interfaceName = iface.getName();

      for (const prop of iface.getProperties()) {
        if (!prop.hasQuestionToken()) continue;

        const type = prop.getType();
        const callSignatures = type.getCallSignatures();

        if (callSignatures.length > 0) {
          const sig = callSignatures[0]!;
          const params = sig
            .getParameters()
            .map((p) => {
              const paramType = p.getTypeAtLocation(prop);
              return `${p.getName()}: ${paramType.getText()}`;
            })
            .join(', ');

          const returnType = sig.getReturnType().getText();

          results.push({
            name: prop.getName(),
            signature: `(${params}) => ${returnType}`,
            file: filePath,
            line: prop.getStartLineNumber(),
            parent: interfaceName,
            paramTypes: sig.getParameters().map((p) => p.getTypeAtLocation(prop).getText()),
            returnType,
          });
        }
      }
    }

    // Analyze type aliases with object types
    for (const alias of sourceFile.getTypeAliases()) {
      const type = alias.getType();
      const aliasName = alias.getName();

      // Check if it's an object type
      for (const prop of type.getProperties()) {
        const propType = prop.getTypeAtLocation(alias);
        const declarations = prop.getDeclarations();
        const declaration = declarations[0];

        // Check if property is optional
        const isOptional =
          declaration && Node.isPropertySignature(declaration) && declaration.hasQuestionToken();

        if (isOptional) {
          const callSignatures = propType.getCallSignatures();
          if (callSignatures.length > 0) {
            const sig = callSignatures[0]!;
            const params = sig
              .getParameters()
              .map((p) => {
                const paramType = p.getTypeAtLocation(alias);
                return `${p.getName()}: ${paramType.getText()}`;
              })
              .join(', ');

            const returnType = sig.getReturnType().getText();

            results.push({
              name: prop.getName(),
              signature: `(${params}) => ${returnType}`,
              file: filePath,
              line: declaration?.getStartLineNumber() ?? alias.getStartLineNumber(),
              parent: aliasName,
              paramTypes: sig.getParameters().map((p) => p.getTypeAtLocation(alias).getText()),
              returnType,
            });
          }
        }
      }
    }

    return results;
  }

  // ============================================================================
  // Generic Parameter Extraction
  // ============================================================================

  /**
   * Extract generic type parameters with constraints.
   */
  private extractGenericParams(sourceFile: SourceFile, filePath: string): GenericParamInfo[] {
    const results: GenericParamInfo[] = [];

    // From interfaces
    for (const iface of sourceFile.getInterfaces()) {
      const typeParams = iface.getTypeParameters();
      for (const param of typeParams) {
        const constraint = param.getConstraint();
        const defaultType = param.getDefault();

        results.push({
          name: param.getName(),
          constraint: constraint?.getText(),
          defaultType: defaultType?.getText(),
          file: filePath,
          line: param.getStartLineNumber(),
          parent: iface.getName(),
        });
      }
    }

    // From type aliases
    for (const alias of sourceFile.getTypeAliases()) {
      const typeParams = alias.getTypeParameters();
      for (const param of typeParams) {
        const constraint = param.getConstraint();
        const defaultType = param.getDefault();

        results.push({
          name: param.getName(),
          constraint: constraint?.getText(),
          defaultType: defaultType?.getText(),
          file: filePath,
          line: param.getStartLineNumber(),
          parent: alias.getName(),
        });
      }
    }

    // From classes
    for (const cls of sourceFile.getClasses()) {
      const typeParams = cls.getTypeParameters();
      for (const param of typeParams) {
        const constraint = param.getConstraint();
        const defaultType = param.getDefault();

        results.push({
          name: param.getName(),
          constraint: constraint?.getText(),
          defaultType: defaultType?.getText(),
          file: filePath,
          line: param.getStartLineNumber(),
          parent: cls.getName() || 'anonymous',
        });
      }
    }

    // From functions
    for (const func of sourceFile.getFunctions()) {
      const typeParams = func.getTypeParameters();
      for (const param of typeParams) {
        const constraint = param.getConstraint();
        const defaultType = param.getDefault();

        results.push({
          name: param.getName(),
          constraint: constraint?.getText(),
          defaultType: defaultType?.getText(),
          file: filePath,
          line: param.getStartLineNumber(),
          parent: func.getName() || 'anonymous',
        });
      }
    }

    return results;
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Clear the project cache.
   */
  clearCache(): void {
    // Remove all source files
    for (const sf of this.project.getSourceFiles()) {
      this.project.removeSourceFile(sf);
    }
  }

  /**
   * Get project for advanced usage.
   */
  getProject(): Project {
    return this.project;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new type semantic analyzer.
 */
export function createTypeSemanticAnalyzer(tsConfigPath?: string): TypeSemanticAnalyzer {
  return new TypeSemanticAnalyzer(tsConfigPath);
}
