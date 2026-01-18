/**
 * TypeScript/JavaScript Documentation Checker
 *
 * Uses ts-morph to extract function signatures and JSDoc,
 * then compares them to detect inconsistencies.
 *
 * @module analysis/doccheck/ts-checker
 */

import { Project, SourceFile, FunctionDeclaration, MethodDeclaration, Node, SyntaxKind, JSDoc } from 'ts-morph';
import { createModuleLogger } from '../../logging/logger.js';
import type {
  DocIssue,
  DocCheckOptions,
  FileCheckResult,
  FunctionInfo,
  DocInfo,
  ParamInfo,
  DocParamInfo,
  FunctionDocInfo,
} from './types.js';
import { ISSUE_SEVERITY, DEFAULT_DOCCHECK_OPTIONS } from './types.js';

const logger = createModuleLogger('doccheck:ts');

// ============================================================================
// TypeScript Checker Class
// ============================================================================

/**
 * TypeScript/JavaScript documentation checker.
 */
export class TypeScriptDocChecker {
  private project: Project;
  private options: Required<DocCheckOptions>;

  constructor(options?: Partial<DocCheckOptions>, tsConfigPath?: string) {
    this.options = { ...DEFAULT_DOCCHECK_OPTIONS, ...options };
    this.project = new Project({
      tsConfigFilePath: tsConfigPath,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        allowJs: true,
        declaration: false,
        noEmit: true,
      },
    });
  }

  /**
   * Check a single file for documentation issues.
   */
  checkFile(filePath: string): FileCheckResult {
    const issues: DocIssue[] = [];
    let functionsChecked = 0;
    let functionsDocumented = 0;

    try {
      let sourceFile = this.project.getSourceFile(filePath);
      if (!sourceFile) {
        sourceFile = this.project.addSourceFileAtPath(filePath);
      }

      const functions = this.extractFunctions(sourceFile, filePath);

      for (const funcDoc of functions) {
        // Skip non-exported if option is set
        if (this.options.onlyExported && !funcDoc.func.isExported) {
          continue;
        }

        functionsChecked++;
        if (funcDoc.doc.exists) {
          functionsDocumented++;
        }

        const funcIssues = this.checkFunction(funcDoc);
        issues.push(...funcIssues);
      }
    } catch (err) {
      logger.warn(`Failed to check file ${filePath}`, { error: String(err) });
    }

    const isTypeScript = filePath.endsWith('.ts') || filePath.endsWith('.tsx');

    return {
      file: filePath,
      language: isTypeScript ? 'typescript' : 'javascript',
      issues,
      functionsChecked,
      functionsDocumented,
    };
  }

  /**
   * Check multiple files.
   */
  checkFiles(filePaths: string[]): FileCheckResult[] {
    return filePaths.map((fp) => this.checkFile(fp));
  }

  /**
   * Clear the project cache.
   */
  clearCache(): void {
    for (const sf of this.project.getSourceFiles()) {
      this.project.removeSourceFile(sf);
    }
  }

  // ============================================================================
  // Function Extraction
  // ============================================================================

  /**
   * Extract all functions and their documentation from a source file.
   */
  private extractFunctions(sourceFile: SourceFile, filePath: string): FunctionDocInfo[] {
    const result: FunctionDocInfo[] = [];

    // Top-level functions
    for (const func of sourceFile.getFunctions()) {
      const funcInfo = this.extractFunctionInfo(func, filePath);
      const docInfo = this.extractJSDoc(func);
      result.push({ func: funcInfo, doc: docInfo });
    }

    // Class methods
    for (const cls of sourceFile.getClasses()) {
      const className = cls.getName() || 'anonymous';
      const isClassExported = cls.isExported();

      for (const method of cls.getMethods()) {
        const funcInfo = this.extractMethodInfo(method, filePath, className, isClassExported);
        const docInfo = this.extractJSDoc(method);
        result.push({ func: funcInfo, doc: docInfo });
      }
    }

    return result;
  }

  /**
   * Extract function info from a FunctionDeclaration.
   */
  private extractFunctionInfo(func: FunctionDeclaration, filePath: string): FunctionInfo {
    const params: ParamInfo[] = [];

    for (const param of func.getParameters()) {
      const paramInfo: ParamInfo = {
        name: param.getName(),
        type: param.getType().getText(param),
        optional: param.isOptional(),
      };

      const initializer = param.getInitializer();
      if (initializer) {
        paramInfo.defaultValue = initializer.getText();
        paramInfo.optional = true;
      }

      params.push(paramInfo);
    }

    return {
      name: func.getName() || 'anonymous',
      file: filePath,
      line: func.getStartLineNumber(),
      params,
      returnType: func.getReturnType().getText(func),
      isExported: func.isExported(),
      isAsync: func.isAsync(),
    };
  }

  /**
   * Extract function info from a MethodDeclaration.
   */
  private extractMethodInfo(
    method: MethodDeclaration,
    filePath: string,
    className: string,
    isClassExported: boolean
  ): FunctionInfo {
    const params: ParamInfo[] = [];

    for (const param of method.getParameters()) {
      const paramInfo: ParamInfo = {
        name: param.getName(),
        type: param.getType().getText(param),
        optional: param.isOptional(),
      };

      const initializer = param.getInitializer();
      if (initializer) {
        paramInfo.defaultValue = initializer.getText();
        paramInfo.optional = true;
      }

      params.push(paramInfo);
    }

    // Method is "exported" if it's public and class is exported
    const isPublic = method.getScope() === undefined || method.getScope() === 'public';
    const isPrivateName = method.getName().startsWith('_');

    return {
      name: method.getName(),
      file: filePath,
      line: method.getStartLineNumber(),
      params,
      returnType: method.getReturnType().getText(method),
      isExported: isClassExported && isPublic && !isPrivateName,
      isAsync: method.isAsync(),
      className,
    };
  }

  // ============================================================================
  // JSDoc Extraction
  // ============================================================================

  /**
   * Extract JSDoc information from a function/method.
   */
  private extractJSDoc(node: FunctionDeclaration | MethodDeclaration): DocInfo {
    const jsDocs = node.getJsDocs();

    if (jsDocs.length === 0) {
      return { exists: false, params: [] };
    }

    const jsDoc = jsDocs[0]!;
    const params: DocParamInfo[] = [];
    let returns: { type?: string; description?: string } | undefined;

    // Extract @param tags
    for (const tag of jsDoc.getTags()) {
      const tagName = tag.getTagName();

      if (tagName === 'param') {
        const paramTag = tag;
        const text = paramTag.getText();

        // Parse @param {type} name - description
        // or @param name - description
        const match = text.match(/@param\s+(?:\{([^}]+)\}\s+)?(\w+)(?:\s*-?\s*(.*))?/);
        if (match) {
          params.push({
            name: match[2]!,
            type: match[1],
            description: match[3]?.trim(),
          });
        }
      } else if (tagName === 'returns' || tagName === 'return') {
        const text = tag.getText();
        // Parse @returns {type} description
        const match = text.match(/@returns?\s+(?:\{([^}]+)\}\s*)?(.*)$/);
        if (match) {
          returns = {
            type: match[1],
            description: match[2]?.trim(),
          };
        }
      }
    }

    return {
      exists: true,
      params,
      returns,
      description: jsDoc.getDescription().trim(),
      raw: jsDoc.getText(),
    };
  }

  // ============================================================================
  // Issue Detection
  // ============================================================================

  /**
   * Check a function for documentation issues.
   */
  private checkFunction(funcDoc: FunctionDocInfo): DocIssue[] {
    const issues: DocIssue[] = [];
    const { func, doc } = funcDoc;
    const fullName = func.className ? `${func.className}.${func.name}` : func.name;

    // Check if documentation is missing
    if (!doc.exists) {
      if (this.options.requireDocs) {
        issues.push({
          type: 'missing_doc',
          severity: ISSUE_SEVERITY.missing_doc,
          file: func.file,
          line: func.line,
          name: fullName,
          message: `Function '${fullName}' has no JSDoc documentation`,
        });
      }
      return issues;
    }

    // Build sets for comparison
    const codeParamNames = new Set(func.params.map((p) => p.name));
    const docParamNames = new Set(doc.params.map((p) => p.name));

    // Check for missing @param (param in code but not in doc)
    for (const param of func.params) {
      if (!docParamNames.has(param.name)) {
        issues.push({
          type: 'param_missing',
          severity: ISSUE_SEVERITY.param_missing,
          file: func.file,
          line: func.line,
          name: fullName,
          message: `Parameter '${param.name}' is not documented in JSDoc`,
          expected: param.name,
        });
      }
    }

    // Check for extra @param (param in doc but not in code)
    for (const docParam of doc.params) {
      if (!codeParamNames.has(docParam.name)) {
        issues.push({
          type: 'param_extra',
          severity: ISSUE_SEVERITY.param_extra,
          file: func.file,
          line: func.line,
          name: fullName,
          message: `JSDoc documents parameter '${docParam.name}' which does not exist in function signature`,
          actual: docParam.name,
        });
      }
    }

    // Check for param_name_mismatch (DOC103) - similar names suggest typos
    const missingInDoc = func.params.filter(p => !docParamNames.has(p.name));
    const extraInDoc = doc.params.filter(p => !codeParamNames.has(p.name));

    for (const missing of missingInDoc) {
      for (const extra of extraInDoc) {
        if (this.areSimilar(missing.name, extra.name)) {
          issues.push({
            type: 'param_name_mismatch',
            severity: ISSUE_SEVERITY.param_name_mismatch,
            file: func.file,
            line: func.line,
            name: fullName,
            message: `Possible typo: parameter '${missing.name}' in code, '${extra.name}' in JSDoc`,
            expected: missing.name,
            actual: extra.name,
          });
        }
      }
    }

    // Check param order (DOC104) - only when all params match
    if (func.params.length === doc.params.length &&
        func.params.every(p => docParamNames.has(p.name)) &&
        doc.params.every(p => codeParamNames.has(p.name))) {
      for (let i = 0; i < func.params.length; i++) {
        if (func.params[i]!.name !== doc.params[i]!.name) {
          const codeOrder = func.params.map(p => p.name).join(', ');
          const docOrder = doc.params.map(p => p.name).join(', ');
          issues.push({
            type: 'param_order_mismatch',
            severity: ISSUE_SEVERITY.param_order_mismatch,
            file: func.file,
            line: func.line,
            name: fullName,
            message: `Parameter order mismatch: code has (${codeOrder}), JSDoc has (${docOrder})`,
            expected: codeOrder,
            actual: docOrder,
          });
          break; // Only report once
        }
      }
    }

    // Check param types if enabled
    if (this.options.checkParamTypes) {
      for (const param of func.params) {
        const docParam = doc.params.find((p) => p.name === param.name);
        if (docParam?.type && param.type) {
          if (!this.typesMatch(docParam.type, param.type)) {
            issues.push({
              type: 'param_type_mismatch',
              severity: ISSUE_SEVERITY.param_type_mismatch,
              file: func.file,
              line: func.line,
              name: fullName,
              message: `Parameter '${param.name}' type mismatch: JSDoc says '${docParam.type}', code has '${param.type}'`,
              expected: param.type,
              actual: docParam.type,
            });
          }
        }
      }
    }

    // Check return type
    const hasReturnType = func.returnType && func.returnType !== 'void' && func.returnType !== 'undefined';
    const hasReturnDoc = doc.returns !== undefined;

    if (hasReturnType && !hasReturnDoc) {
      issues.push({
        type: 'return_missing',
        severity: ISSUE_SEVERITY.return_missing,
        file: func.file,
        line: func.line,
        name: fullName,
        message: `Function returns '${func.returnType}' but JSDoc has no @returns`,
        expected: func.returnType,
      });
    }

    if (!hasReturnType && hasReturnDoc && doc.returns?.type && doc.returns.type !== 'void') {
      issues.push({
        type: 'return_extra',
        severity: ISSUE_SEVERITY.return_extra,
        file: func.file,
        line: func.line,
        name: fullName,
        message: `JSDoc has @returns '${doc.returns.type}' but function returns void`,
        actual: doc.returns.type,
      });
    }

    // Check return type match if enabled
    if (this.options.checkReturnTypes && hasReturnType && hasReturnDoc && doc.returns?.type) {
      if (!this.typesMatch(doc.returns.type, func.returnType!)) {
        issues.push({
          type: 'return_type_mismatch',
          severity: ISSUE_SEVERITY.return_type_mismatch,
          file: func.file,
          line: func.line,
          name: fullName,
          message: `Return type mismatch: JSDoc says '${doc.returns.type}', code has '${func.returnType}'`,
          expected: func.returnType,
          actual: doc.returns.type,
        });
      }
    }

    return issues;
  }

  /**
   * Calculate Levenshtein edit distance between two strings.
   */
  private levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i]![0] = i;
    for (let j = 0; j <= n; j++) dp[0]![j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i]![j] = dp[i - 1]![j - 1]!;
        } else {
          dp[i]![j] = Math.min(
            dp[i - 1]![j]! + 1,
            dp[i]![j - 1]! + 1,
            dp[i - 1]![j - 1]! + 1
          );
        }
      }
    }

    return dp[m]![n]!;
  }

  /**
   * Check if two strings are similar enough to suggest a name mismatch.
   */
  private areSimilar(a: string, b: string): boolean {
    if (a === b) return false;
    if (a.toLowerCase() === b.toLowerCase()) return true;

    const distance = this.levenshteinDistance(a.toLowerCase(), b.toLowerCase());
    const maxLen = Math.max(a.length, b.length);

    return distance <= 2 && distance / maxLen <= 0.3;
  }

  /**
   * Check if two types match (with some flexibility).
   */
  private typesMatch(docType: string, codeType: string): boolean {
    // Normalize types
    const normalize = (t: string) =>
      t
        .toLowerCase()
        .replace(/\s+/g, '')
        .replace(/^array<(.+)>$/, '$1[]');

    const doc = normalize(docType);
    const code = normalize(codeType);

    // Exact match
    if (doc === code) return true;

    // Common equivalents
    const equivalents: Record<string, string[]> = {
      string: ['string'],
      number: ['number', 'int', 'integer', 'float', 'double'],
      boolean: ['boolean', 'bool'],
      object: ['object', 'record<string,unknown>', 'record<string,any>'],
      any: ['any', 'unknown'],
      void: ['void', 'undefined'],
    };

    for (const [canonical, variants] of Object.entries(equivalents)) {
      if (variants.includes(doc) && variants.includes(code)) {
        return true;
      }
    }

    return false;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new TypeScript documentation checker.
 */
export function createTypeScriptDocChecker(
  options?: Partial<DocCheckOptions>,
  tsConfigPath?: string
): TypeScriptDocChecker {
  return new TypeScriptDocChecker(options, tsConfigPath);
}
