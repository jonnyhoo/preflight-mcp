/**
 * Python Test Analyzer
 *
 * Extracts usage examples from Python test files using regex patterns.
 * Supports both pytest and unittest patterns.
 *
 * @module bundle/analyzers/test-examples/python-analyzer
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

/** Patterns that indicate trivial/mock-only tests */
const TRIVIAL_PATTERNS = [
  'assertTrue(True)',
  'assertFalse(False)',
  'assertEqual(1, 1)',
  'assertIsNone(None)',
  'assertIsNotNone(None)',
  'Mock()',
  'MagicMock()',
  'pass',
  '...',
];

/** Minimum code length for non-trivial examples */
const MIN_CODE_LENGTH = 20;

// ============================================================================
// Regex Patterns
// ============================================================================

/** Test function pattern: `def test_xxx(` */
const TEST_FUNCTION_PATTERN = /^(\s*)def\s+(test_\w+)\s*\(([^)]*)\)\s*(?:->.*?)?:/gm;

/** Test class pattern: `class TestXxx(TestCase)` or `class TestXxx:` */
const TEST_CLASS_PATTERN = /^(\s*)class\s+(Test\w+)(?:\s*\(([^)]*)\))?\s*:/gm;

/** setUp method pattern */
const SETUP_METHOD_PATTERN = /^\s*def\s+setUp\s*\(self\)\s*(?:->.*?)?:\s*\n([\s\S]*?)(?=\n\s*def\s|\n\s*class\s|\Z)/gm;

/** Object instantiation pattern: `var = ClassName(...)` */
const INSTANTIATION_PATTERN = /^(\s*)(\w+)\s*=\s*(\w+)\s*\(([^)]*)\)/gm;

/** Method call pattern: `obj.method(...)` or `result = obj.method(...)` */
const METHOD_CALL_PATTERN = /^(\s*)(?:(\w+)\s*=\s*)?(\w+)\.(\w+)\s*\(([^)]*)\)/gm;

/** Assertion patterns */
const ASSERTION_PATTERNS = [
  /self\.assert\w+\s*\([^)]+\)/g,
  /assert\s+.+/g,
  /expect\([^)]+\)\./g,
  /pytest\.\w+\s*\(/g,
];

/** Config dict pattern: `config = { ... }` */
const CONFIG_DICT_PATTERN = /^(\s*)(\w+)\s*=\s*\{([^}]+)\}/gm;

/** Import pattern for dependencies */
const IMPORT_PATTERN = /^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;

/** Decorator patterns */
const DECORATOR_PATTERNS = [
  /@pytest\.\w+/g,
  /@mock\.\w+/g,
  /@patch\s*\(/g,
  /@asyncio\.\w+/g,
];

// ============================================================================
// Python Test Analyzer Class
// ============================================================================

/**
 * Python test analyzer implementation.
 * Uses regex patterns to extract meaningful examples from pytest and unittest files.
 */
export class PythonTestAnalyzer implements LanguageTestAnalyzer {
  readonly language = TestLanguage.Python;

  /**
   * Extract examples from Python test file.
   */
  extract(filePath: string, content: string): TestExample[] {
    const examples: TestExample[] = [];

    // Extract imports for dependency tracking
    const imports = this.extractImports(content);

    // Find test classes
    const classMatches = this.findTestClasses(content);
    for (const classMatch of classMatches) {
      const classExamples = this.extractFromTestClass(
        classMatch.name,
        classMatch.body,
        classMatch.setupCode,
        filePath,
        classMatch.lineStart,
        imports
      );
      examples.push(...classExamples);
    }

    // Find standalone test functions (pytest style)
    const funcMatches = this.findTestFunctions(content);
    for (const funcMatch of funcMatches) {
      // Skip if inside a class
      if (classMatches.some((c) => funcMatch.lineStart >= c.lineStart && funcMatch.lineStart <= c.lineEnd)) {
        continue;
      }

      const funcExamples = this.extractFromTestFunction(
        funcMatch.name,
        funcMatch.body,
        funcMatch.fixtures,
        filePath,
        funcMatch.lineStart,
        imports
      );
      examples.push(...funcExamples);
    }

    return examples;
  }

  /**
   * Extract imported modules.
   */
  private extractImports(content: string): string[] {
    const imports: string[] = [];
    let match: RegExpExecArray | null;

    IMPORT_PATTERN.lastIndex = 0;
    while ((match = IMPORT_PATTERN.exec(content)) !== null) {
      const module = match[1] ?? match[2];
      if (module) {
        imports.push(module.split('.')[0]!);
      }
    }

    return [...new Set(imports)];
  }

  /**
   * Find all test classes in content.
   */
  private findTestClasses(content: string): Array<{
    name: string;
    body: string;
    setupCode: string | undefined;
    lineStart: number;
    lineEnd: number;
  }> {
    const classes: Array<{
      name: string;
      body: string;
      setupCode: string | undefined;
      lineStart: number;
      lineEnd: number;
    }> = [];

    TEST_CLASS_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = TEST_CLASS_PATTERN.exec(content)) !== null) {
      const indent = match[1]?.length ?? 0;
      const className = match[2]!;
      const lineStart = this.getLineNumber(content, match.index);

      // Find class body (until next class/function at same or lesser indent)
      const afterMatch = content.slice(match.index + match[0].length);
      const bodyEndPattern = new RegExp(`^(?!\\s{${indent + 1},})\\S`, 'm');
      const bodyEndMatch = bodyEndPattern.exec(afterMatch);
      const body = bodyEndMatch ? afterMatch.slice(0, bodyEndMatch.index) : afterMatch;

      // Extract setUp method
      let setupCode: string | undefined;
      SETUP_METHOD_PATTERN.lastIndex = 0;
      const setupMatch = SETUP_METHOD_PATTERN.exec(body);
      if (setupMatch) {
        setupCode = setupMatch[1]?.trim();
      }

      const lineEnd = lineStart + body.split('\n').length;

      classes.push({
        name: className,
        body,
        setupCode,
        lineStart,
        lineEnd,
      });
    }

    return classes;
  }

  /**
   * Find all test functions in content.
   */
  private findTestFunctions(content: string): Array<{
    name: string;
    body: string;
    fixtures: string[];
    lineStart: number;
  }> {
    const functions: Array<{
      name: string;
      body: string;
      fixtures: string[];
      lineStart: number;
    }> = [];

    TEST_FUNCTION_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = TEST_FUNCTION_PATTERN.exec(content)) !== null) {
      const indent = match[1]?.length ?? 0;
      const funcName = match[2]!;
      const params = match[3] ?? '';
      const lineStart = this.getLineNumber(content, match.index);

      // Parse fixtures (parameters except 'self')
      const fixtures = params
        .split(',')
        .map((p) => p.trim().split(':')[0]?.trim() ?? '')
        .filter((p) => p && p !== 'self');

      // Find function body
      const afterMatch = content.slice(match.index + match[0].length);
      const bodyEndPattern = new RegExp(`^(?!\\s{${indent + 1},})\\S`, 'm');
      const bodyEndMatch = bodyEndPattern.exec(afterMatch);
      const body = bodyEndMatch ? afterMatch.slice(0, bodyEndMatch.index) : afterMatch;

      functions.push({
        name: funcName,
        body,
        fixtures,
        lineStart,
      });
    }

    return functions;
  }

  /**
   * Extract examples from a test class.
   */
  private extractFromTestClass(
    className: string,
    classBody: string,
    setupCode: string | undefined,
    filePath: string,
    classLineStart: number,
    imports: string[]
  ): TestExample[] {
    const examples: TestExample[] = [];

    // Find test methods within the class
    TEST_FUNCTION_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = TEST_FUNCTION_PATTERN.exec(classBody)) !== null) {
      const methodName = match[2]!;
      const lineStart = classLineStart + this.getLineNumber(classBody.slice(0, match.index), 0);

      // Get method body
      const afterMatch = classBody.slice(match.index + match[0].length);
      const bodyEnd = afterMatch.search(/^\s*def\s+/m);
      const methodBody = bodyEnd >= 0 ? afterMatch.slice(0, bodyEnd) : afterMatch;

      // Detect tags
      const tags = this.detectTags(methodBody, imports);

      // Extract different pattern types
      examples.push(
        ...this.findInstantiations(methodBody, methodName, filePath, lineStart, tags, imports, setupCode, className)
      );
      examples.push(
        ...this.findMethodCallsWithAssertions(methodBody, methodName, filePath, lineStart, tags, imports, setupCode, className)
      );
      examples.push(
        ...this.findConfigDicts(methodBody, methodName, filePath, lineStart, tags, imports, setupCode, className)
      );
    }

    return examples;
  }

  /**
   * Extract examples from a standalone test function.
   */
  private extractFromTestFunction(
    funcName: string,
    funcBody: string,
    fixtures: string[],
    filePath: string,
    lineStart: number,
    imports: string[]
  ): TestExample[] {
    const examples: TestExample[] = [];

    // Create setup code from fixtures
    const setupCode = fixtures.length > 0 ? `# Fixtures: ${fixtures.join(', ')}` : undefined;

    // Detect tags
    const tags = this.detectTags(funcBody, imports);

    // Extract different pattern types
    examples.push(
      ...this.findInstantiations(funcBody, funcName, filePath, lineStart, tags, imports, setupCode)
    );
    examples.push(
      ...this.findMethodCallsWithAssertions(funcBody, funcName, filePath, lineStart, tags, imports, setupCode)
    );
    examples.push(
      ...this.findConfigDicts(funcBody, funcName, filePath, lineStart, tags, imports, setupCode)
    );

    // Check for workflow pattern (integration test)
    if (this.isIntegrationTest(funcName, funcBody)) {
      const workflow = this.extractWorkflow(funcBody, funcName, filePath, lineStart, tags, imports, setupCode);
      if (workflow) {
        examples.push(workflow);
      }
    }

    return examples;
  }

  /**
   * Detect test tags from content and imports.
   */
  private detectTags(content: string, imports: string[]): string[] {
    const tags: string[] = [];
    const contentLower = content.toLowerCase();

    // Check imports
    if (imports.includes('unittest')) tags.push('unittest');
    if (imports.includes('pytest')) tags.push('pytest');

    // Check decorators and content
    for (const pattern of DECORATOR_PATTERNS) {
      if (pattern.test(content)) {
        if (pattern.source.includes('pytest')) tags.push('pytest');
        if (pattern.source.includes('mock')) tags.push('mock');
        if (pattern.source.includes('patch')) tags.push('mock');
        if (pattern.source.includes('asyncio')) tags.push('async');
      }
    }

    // Check for async
    if (contentLower.includes('async def') || contentLower.includes('await ')) {
      tags.push('async');
    }

    // Check for mock usage
    if (contentLower.includes('mock') || contentLower.includes('patch')) {
      tags.push('mock');
    }

    return [...new Set(tags)];
  }

  /**
   * Find object instantiation patterns.
   */
  private findInstantiations(
    body: string,
    testName: string,
    filePath: string,
    baseLineStart: number,
    tags: string[],
    imports: string[],
    setupCode?: string,
    className?: string
  ): TestExample[] {
    const examples: TestExample[] = [];

    INSTANTIATION_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = INSTANTIATION_PATTERN.exec(body)) !== null) {
      const code = match[0].trim();

      // Skip trivial or mock-only
      if (this.isTrivial(code)) continue;

      const varName = match[2]!;
      const typeName = match[3]!;
      const lineStart = baseLineStart + this.getLineNumber(body.slice(0, match.index), 0);

      // Find assertion after this line
      const assertion = this.findAssertionAfter(body, match.index);

      const example: TestExample = {
        exampleId: this.generateId(code),
        testName,
        category: ExampleCategory.Instantiation,
        code,
        language: TestLanguage.Python,
        description: `Instantiate ${typeName}`,
        expectedBehavior: assertion,
        filePath,
        lineStart,
        lineEnd: lineStart + code.split('\n').length - 1,
        complexityScore: this.calculateComplexity(code),
        confidence: 0.8,
        tags,
        dependencies: imports,
        setupCode,
        className,
        methodName: varName,
      };

      examples.push(example);
    }

    return examples;
  }

  /**
   * Find method calls followed by assertions.
   */
  private findMethodCallsWithAssertions(
    body: string,
    testName: string,
    filePath: string,
    baseLineStart: number,
    tags: string[],
    imports: string[],
    setupCode?: string,
    className?: string
  ): TestExample[] {
    const examples: TestExample[] = [];
    const lines = body.split('\n');

    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i]!.trim();
      const nextLine = lines[i + 1]?.trim() ?? '';

      // Check if current line is a method call
      METHOD_CALL_PATTERN.lastIndex = 0;
      const callMatch = METHOD_CALL_PATTERN.exec(line);
      if (!callMatch) continue;

      // Check if next line is an assertion
      const isAssertion = ASSERTION_PATTERNS.some((p) => {
        p.lastIndex = 0;
        return p.test(nextLine);
      });

      if (!isAssertion) continue;

      const code = `${line}\n${nextLine}`;

      // Skip trivial
      if (this.isTrivial(code)) continue;

      const methodName = callMatch[4]!;
      const lineStart = baseLineStart + i;

      const example: TestExample = {
        exampleId: this.generateId(code),
        testName,
        category: ExampleCategory.MethodCall,
        code,
        language: TestLanguage.Python,
        description: `Call ${methodName} with assertion`,
        expectedBehavior: nextLine,
        filePath,
        lineStart,
        lineEnd: lineStart + 1,
        complexityScore: this.calculateComplexity(code),
        confidence: 0.85,
        tags,
        dependencies: imports,
        setupCode,
        className,
        methodName,
      };

      examples.push(example);
    }

    return examples;
  }

  /**
   * Find configuration dictionary patterns.
   */
  private findConfigDicts(
    body: string,
    testName: string,
    filePath: string,
    baseLineStart: number,
    tags: string[],
    imports: string[],
    setupCode?: string,
    className?: string
  ): TestExample[] {
    const examples: TestExample[] = [];

    CONFIG_DICT_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = CONFIG_DICT_PATTERN.exec(body)) !== null) {
      const code = match[0].trim();
      const varName = match[2]!;
      const dictContent = match[3] ?? '';

      // Must have at least 2 key-value pairs
      const keyCount = (dictContent.match(/['"]?\w+['"]?\s*:/g) ?? []).length;
      if (keyCount < 2) continue;

      // Check if it looks like configuration
      if (!this.looksLikeConfig(varName, dictContent)) continue;

      const lineStart = baseLineStart + this.getLineNumber(body.slice(0, match.index), 0);

      const example: TestExample = {
        exampleId: this.generateId(code),
        testName,
        category: ExampleCategory.Config,
        code,
        language: TestLanguage.Python,
        description: `Configuration: ${varName}`,
        expectedBehavior: this.findAssertionAfter(body, match.index),
        filePath,
        lineStart,
        lineEnd: lineStart + code.split('\n').length - 1,
        complexityScore: this.calculateComplexity(code),
        confidence: 0.75,
        tags,
        dependencies: imports,
        setupCode,
        className,
      };

      examples.push(example);
    }

    return examples;
  }

  /**
   * Check if function is an integration test.
   */
  private isIntegrationTest(funcName: string, body: string): boolean {
    const name = funcName.toLowerCase();
    const integrationKeywords = ['workflow', 'integration', 'end_to_end', 'e2e', 'full'];

    // Check name
    if (integrationKeywords.some((k) => name.includes(k))) return true;

    // Check if has 3+ meaningful steps (non-trivial statements)
    const meaningfulLines = body
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#') && !this.isTrivial(l));

    return meaningfulLines.length >= 5;
  }

  /**
   * Extract workflow pattern from integration test.
   */
  private extractWorkflow(
    body: string,
    testName: string,
    filePath: string,
    lineStart: number,
    tags: string[],
    imports: string[],
    setupCode?: string
  ): TestExample | null {
    // Skip if too long
    const lineCount = body.split('\n').length;
    if (lineCount > 30) return null;

    const code = body.trim();

    // Find final assertion
    const finalAssertion = this.extractFinalAssertion(body);

    return {
      exampleId: this.generateId(code),
      testName,
      category: ExampleCategory.Workflow,
      code,
      language: TestLanguage.Python,
      description: `Workflow: ${testName.replace(/_/g, ' ')}`,
      expectedBehavior: finalAssertion,
      filePath,
      lineStart,
      lineEnd: lineStart + lineCount - 1,
      complexityScore: Math.min(1.0, lineCount / 10),
      confidence: 0.9,
      tags: [...tags, 'workflow', 'integration'],
      dependencies: imports,
      setupCode,
    };
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
   * Check if code is trivial/mock-only.
   */
  private isTrivial(code: string): boolean {
    if (code.length < MIN_CODE_LENGTH) return true;
    return TRIVIAL_PATTERNS.some((p) => code.includes(p));
  }

  /**
   * Check if dict looks like configuration.
   */
  private looksLikeConfig(varName: string, content: string): boolean {
    const configNames = ['config', 'settings', 'options', 'params', 'args', 'kwargs', 'data'];
    const varNameLower = varName.toLowerCase();

    // Check variable name
    if (configNames.some((n) => varNameLower.includes(n))) return true;

    // Check if keys are strings
    const stringKeyPattern = /['"](\w+)['"]\s*:/g;
    const matches = content.match(stringKeyPattern) ?? [];
    return matches.length >= 2;
  }

  /**
   * Find assertion after a given position.
   */
  private findAssertionAfter(content: string, position: number): string {
    const after = content.slice(position);
    const lines = after.split('\n').slice(1); // Skip current line

    for (const line of lines) {
      const trimmed = line.trim();
      for (const pattern of ASSERTION_PATTERNS) {
        pattern.lastIndex = 0;
        const match = pattern.exec(trimmed);
        if (match) return match[0];
      }
    }

    return '';
  }

  /**
   * Extract final assertion from test body.
   */
  private extractFinalAssertion(body: string): string {
    const lines = body.split('\n').reverse();

    for (const line of lines) {
      const trimmed = line.trim();
      for (const pattern of ASSERTION_PATTERNS) {
        pattern.lastIndex = 0;
        const match = pattern.exec(trimmed);
        if (match) return match[0];
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
 * Creates a new PythonTestAnalyzer instance.
 */
export function createPythonTestAnalyzer(): PythonTestAnalyzer {
  return new PythonTestAnalyzer();
}
