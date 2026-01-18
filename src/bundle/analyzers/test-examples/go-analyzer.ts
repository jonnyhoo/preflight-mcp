/**
 * Go Test Analyzer
 *
 * Extracts usage examples from Go test files using regex patterns.
 * Supports standard testing package and table-driven tests.
 *
 * @module bundle/analyzers/test-examples/go-analyzer
 */

import * as crypto from 'node:crypto';

import {
  type TestExample,
  type LanguageTestAnalyzer,
  ExampleCategory,
  TestLanguage,
} from './types.js';

// ============================================================================
// Constants
// ============================================================================

/** Minimum code length for non-trivial examples */
const MIN_CODE_LENGTH = 20;

// ============================================================================
// Regex Patterns
// ============================================================================

/** Test function pattern: `func TestXxx(t *testing.T)` */
const TEST_FUNCTION_PATTERN = /func\s+(Test\w+)\s*\(\s*(\w+)\s+\*testing\.T\s*\)\s*\{/g;

/** Benchmark function pattern: `func BenchmarkXxx(b *testing.B)` */
const BENCHMARK_PATTERN = /func\s+(Benchmark\w+)\s*\(\s*(\w+)\s+\*testing\.B\s*\)\s*\{/g;

/** Struct instantiation pattern: `name := StructName{...}` or `name := &StructName{...}` */
const INSTANTIATION_PATTERN = /(\w+)\s*:=\s*(&)?(\w+)\s*\{([^}]*)\}/g;

/** Function call with result: `result := funcName(...)` or `result, err := funcName(...)` */
const FUNC_CALL_PATTERN = /(\w+)(?:\s*,\s*\w+)?\s*:=\s*(?:(\w+)\.)?(\w+)\s*\(([^)]*)\)/g;

/** Method call pattern: `obj.Method(...)` */
const METHOD_CALL_PATTERN = /(\w+)\.(\w+)\s*\(([^)]*)\)/g;

/** Assertion patterns */
const ASSERTION_PATTERNS = [
  /t\.Error(?:f)?\s*\([^)]+\)/g,
  /t\.Fatal(?:f)?\s*\([^)]+\)/g,
  /t\.Fail(?:Now)?\s*\(\)/g,
  /if\s+.*\s*!=\s*.*\s*\{\s*t\./g,
  /assert\.\w+\s*\(/g,
  /require\.\w+\s*\(/g,
];

/** Table-driven test pattern */
const TABLE_TEST_PATTERN = /(\w+)\s*:=\s*\[\]struct\s*\{([^}]+)\}\s*\{([\s\S]*?)\}/g;

/** Import pattern */
const IMPORT_PATTERN = /import\s+(?:\(\s*([\s\S]*?)\s*\)|"([^"]+)")/g;

// ============================================================================
// Go Test Analyzer Class
// ============================================================================

/**
 * Go test analyzer implementation.
 * Uses regex patterns to extract meaningful examples from Go test files.
 */
export class GoTestAnalyzer implements LanguageTestAnalyzer {
  readonly language = TestLanguage.Go;

  /**
   * Extract examples from Go test file.
   */
  extract(filePath: string, content: string): TestExample[] {
    const examples: TestExample[] = [];

    // Extract imports for dependency tracking
    const imports = this.extractImports(content);

    // Find test functions
    const testFunctions = this.findTestFunctions(content);

    for (const testFunc of testFunctions) {
      // Detect tags
      const tags = this.detectTags(testFunc.body, imports);

      // Extract different pattern types
      examples.push(
        ...this.findInstantiations(testFunc.body, testFunc.name, filePath, testFunc.lineStart, tags, imports)
      );
      examples.push(
        ...this.findFuncCallsWithAssertions(testFunc.body, testFunc.name, filePath, testFunc.lineStart, tags, imports)
      );
      examples.push(
        ...this.findTableTests(testFunc.body, testFunc.name, filePath, testFunc.lineStart, tags, imports)
      );
    }

    return examples;
  }

  /**
   * Extract imported packages.
   */
  private extractImports(content: string): string[] {
    const imports: string[] = [];
    let match: RegExpExecArray | null;

    IMPORT_PATTERN.lastIndex = 0;
    while ((match = IMPORT_PATTERN.exec(content)) !== null) {
      const block = match[1] ?? match[2];
      if (block) {
        // Parse import block
        const lines = block.split('\n');
        for (const line of lines) {
          const pkgMatch = /"([^"]+)"/.exec(line);
          if (pkgMatch) {
            const pkg = pkgMatch[1]!;
            // Get package name (last part of path)
            const pkgName = pkg.split('/').pop() ?? pkg;
            imports.push(pkgName);
          }
        }
      }
    }

    return [...new Set(imports)];
  }

  /**
   * Find all test functions in content.
   */
  private findTestFunctions(content: string): Array<{
    name: string;
    body: string;
    lineStart: number;
  }> {
    const functions: Array<{
      name: string;
      body: string;
      lineStart: number;
    }> = [];

    TEST_FUNCTION_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = TEST_FUNCTION_PATTERN.exec(content)) !== null) {
      const funcName = match[1]!;
      const lineStart = this.getLineNumber(content, match.index);

      // Find function body (balanced braces)
      const startIndex = match.index + match[0].length;
      const body = this.extractBlockBody(content, startIndex);

      functions.push({
        name: funcName,
        body,
        lineStart,
      });
    }

    return functions;
  }

  /**
   * Extract block body with balanced braces.
   */
  private extractBlockBody(content: string, startIndex: number): string {
    let braceCount = 1;
    let i = startIndex;

    while (i < content.length && braceCount > 0) {
      const char = content[i];
      if (char === '{') braceCount++;
      else if (char === '}') braceCount--;
      i++;
    }

    return content.slice(startIndex, i - 1);
  }

  /**
   * Detect test tags from content and imports.
   */
  private detectTags(content: string, imports: string[]): string[] {
    const tags: string[] = ['go'];

    // Check for testify
    if (imports.includes('assert') || imports.includes('require')) {
      tags.push('testify');
    }

    // Check for parallel tests
    if (content.includes('t.Parallel()')) {
      tags.push('parallel');
    }

    // Check for subtests
    if (content.includes('t.Run(')) {
      tags.push('subtests');
    }

    return tags;
  }

  /**
   * Find struct instantiation patterns.
   */
  private findInstantiations(
    body: string,
    testName: string,
    filePath: string,
    baseLineStart: number,
    tags: string[],
    imports: string[]
  ): TestExample[] {
    const examples: TestExample[] = [];

    INSTANTIATION_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = INSTANTIATION_PATTERN.exec(body)) !== null) {
      const code = match[0].trim();

      // Skip short code
      if (code.length < MIN_CODE_LENGTH) continue;

      const varName = match[1]!;
      const structName = match[3]!;
      const lineStart = baseLineStart + this.getLineNumber(body.slice(0, match.index), 0);

      // Find assertion after this line
      const assertion = this.findAssertionAfter(body, match.index);

      const example: TestExample = {
        exampleId: this.generateId(code),
        testName,
        category: ExampleCategory.Instantiation,
        code,
        language: TestLanguage.Go,
        description: `Instantiate ${structName}`,
        expectedBehavior: assertion,
        filePath,
        lineStart,
        lineEnd: lineStart + code.split('\n').length - 1,
        complexityScore: this.calculateComplexity(code),
        confidence: 0.8,
        tags,
        dependencies: imports,
        methodName: varName,
      };

      examples.push(example);
    }

    return examples;
  }

  /**
   * Find function calls followed by assertions.
   */
  private findFuncCallsWithAssertions(
    body: string,
    testName: string,
    filePath: string,
    baseLineStart: number,
    tags: string[],
    imports: string[]
  ): TestExample[] {
    const examples: TestExample[] = [];
    const lines = body.split('\n');

    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i]!.trim();
      const nextLine = lines[i + 1]?.trim() ?? '';

      // Check if current line is a function call
      FUNC_CALL_PATTERN.lastIndex = 0;
      const callMatch = FUNC_CALL_PATTERN.exec(line);
      if (!callMatch) continue;

      // Check if next line is an assertion or error check
      const isAssertion = ASSERTION_PATTERNS.some((p) => {
        p.lastIndex = 0;
        return p.test(nextLine);
      }) || nextLine.includes('if err != nil');

      if (!isAssertion) continue;

      const code = `${line}\n${nextLine}`;

      // Skip short code
      if (code.length < MIN_CODE_LENGTH) continue;

      const funcName = callMatch[3]!;
      const lineStart = baseLineStart + i;

      const example: TestExample = {
        exampleId: this.generateId(code),
        testName,
        category: ExampleCategory.MethodCall,
        code,
        language: TestLanguage.Go,
        description: `Call ${funcName} with assertion`,
        expectedBehavior: nextLine,
        filePath,
        lineStart,
        lineEnd: lineStart + 1,
        complexityScore: this.calculateComplexity(code),
        confidence: 0.85,
        tags,
        dependencies: imports,
        methodName: funcName,
      };

      examples.push(example);
    }

    return examples;
  }

  /**
   * Find table-driven test patterns.
   */
  private findTableTests(
    body: string,
    testName: string,
    filePath: string,
    baseLineStart: number,
    tags: string[],
    imports: string[]
  ): TestExample[] {
    const examples: TestExample[] = [];

    TABLE_TEST_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = TABLE_TEST_PATTERN.exec(body)) !== null) {
      const code = match[0].trim();
      const varName = match[1]!;

      // Skip if too long
      if (code.split('\n').length > 30) continue;

      const lineStart = baseLineStart + this.getLineNumber(body.slice(0, match.index), 0);

      const example: TestExample = {
        exampleId: this.generateId(code),
        testName,
        category: ExampleCategory.Config,
        code,
        language: TestLanguage.Go,
        description: `Table-driven test: ${varName}`,
        expectedBehavior: '',
        filePath,
        lineStart,
        lineEnd: lineStart + code.split('\n').length - 1,
        complexityScore: Math.min(1.0, code.split('\n').length / 10),
        confidence: 0.9,
        tags: [...tags, 'table-driven'],
        dependencies: imports,
      };

      examples.push(example);
    }

    return examples;
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Get line number from character position.
   */
  private getLineNumber(content: string, position: number): number {
    return (content.slice(0, position).match(/\n/g) ?? []).length + 1;
  }

  /**
   * Find assertion after a given position.
   */
  private findAssertionAfter(content: string, position: number): string {
    const after = content.slice(position);
    const lines = after.split('\n').slice(1);

    for (const line of lines) {
      const trimmed = line.trim();
      for (const pattern of ASSERTION_PATTERNS) {
        pattern.lastIndex = 0;
        const match = pattern.exec(trimmed);
        if (match) return match[0];
      }
      // Also check for error handling
      if (trimmed.includes('if err != nil')) {
        return trimmed;
      }
    }

    return '';
  }

  /**
   * Calculate complexity score.
   */
  private calculateComplexity(code: string): number {
    const lines = code.split('\n').length;
    const params = (code.match(/,/g) ?? []).length + 1;
    return Math.min(1.0, Math.round((lines * 0.1 + params * 0.05) * 100) / 100);
  }

  /**
   * Generate unique ID for example.
   */
  private generateId(code: string): string {
    return crypto.createHash('md5').update(code).digest('hex').slice(0, 8);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new GoTestAnalyzer instance.
 */
export function createGoTestAnalyzer(): GoTestAnalyzer {
  return new GoTestAnalyzer();
}
