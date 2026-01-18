/**
 * TypeScript/JavaScript Test Analyzer
 *
 * Extracts usage examples from TypeScript and JavaScript test files using regex patterns.
 * Supports Jest, Mocha, Vitest, and similar testing frameworks.
 *
 * @module bundle/analyzers/test-examples/typescript-analyzer
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

/** Patterns that indicate trivial tests */
const TRIVIAL_PATTERNS = [
  'expect(true).toBe(true)',
  'expect(false).toBe(false)',
  'expect(1).toBe(1)',
  'expect(null).toBeNull()',
  'expect(undefined).toBeUndefined()',
  'jest.fn()',
  'vi.fn()',
  'sinon.stub()',
];

/** Minimum code length for non-trivial examples */
const MIN_CODE_LENGTH = 20;

// ============================================================================
// Regex Patterns
// ============================================================================

/** Test function patterns: it('...'), test('...'), describe('...') */
const TEST_BLOCK_PATTERN = /(?:^|\n)\s*(it|test|describe)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(?:async\s*)?\(?[^)]*\)?\s*(?:=>)?\s*\{/gm;

/** Object instantiation pattern: `const obj = new ClassName(...)` */
const INSTANTIATION_PATTERN = /(?:const|let|var)\s+(\w+)(?:\s*:\s*\w+)?\s*=\s*new\s+(\w+)\s*\(([^)]*)\)/g;

/** Factory call pattern: `const obj = createXxx(...)` or `ClassName.create(...)` */
const FACTORY_PATTERN = /(?:const|let|var)\s+(\w+)(?:\s*:\s*\w+)?\s*=\s*(?:(\w+)\.)?(\w+)\s*\(([^)]*)\)/g;

/** Method call with result: `const result = obj.method(...)` */
const METHOD_CALL_PATTERN = /(?:const|let|var)\s+(\w+)(?:\s*:\s*\w+)?\s*=\s*(?:await\s+)?(\w+)\.(\w+)\s*\(([^)]*)\)/g;

/** Assertion patterns */
const ASSERTION_PATTERNS = [
  /expect\([^)]+\)\.to\w+\([^)]*\)/g,
  /assert\.\w+\([^)]+\)/g,
  /should\.\w+/g,
  /\.to\.\w+/g,
];

/** Config object pattern: `const config = { ... }` */
const CONFIG_OBJECT_PATTERN = /(?:const|let|var)\s+(\w+)(?:\s*:\s*\w+)?\s*=\s*\{([^}]+)\}/g;

/** Import pattern for dependencies */
const IMPORT_PATTERN = /import\s+(?:\{[^}]+\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g;

/** beforeEach/beforeAll pattern for setup code */
const SETUP_PATTERN = /(?:beforeEach|beforeAll)\s*\(\s*(?:async\s*)?\(?[^)]*\)?\s*(?:=>)?\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;

// ============================================================================
// TypeScript Test Analyzer Class
// ============================================================================

/**
 * TypeScript/JavaScript test analyzer implementation.
 * Uses regex patterns to extract meaningful examples from Jest/Mocha/Vitest files.
 */
export class TypeScriptTestAnalyzer implements LanguageTestAnalyzer {
  readonly language = TestLanguage.TypeScript;
  readonly aliases = [TestLanguage.JavaScript];

  /**
   * Extract examples from TypeScript/JavaScript test file.
   */
  extract(filePath: string, content: string): TestExample[] {
    const examples: TestExample[] = [];
    const language = this.detectLanguage(filePath);

    // Extract imports for dependency tracking
    const imports = this.extractImports(content);

    // Extract setup code (beforeEach/beforeAll)
    const setupCode = this.extractSetupCode(content);

    // Find test blocks
    const testBlocks = this.findTestBlocks(content);

    for (const block of testBlocks) {
      // Detect tags
      const tags = this.detectTags(block.body, imports);

      // Extract different pattern types
      examples.push(
        ...this.findInstantiations(block.body, block.name, filePath, block.lineStart, tags, imports, setupCode, language)
      );
      examples.push(
        ...this.findMethodCallsWithAssertions(block.body, block.name, filePath, block.lineStart, tags, imports, setupCode, language)
      );
      examples.push(
        ...this.findConfigObjects(block.body, block.name, filePath, block.lineStart, tags, imports, setupCode, language)
      );

      // Check for workflow pattern
      if (this.isIntegrationTest(block.name, block.body)) {
        const workflow = this.extractWorkflow(block.body, block.name, filePath, block.lineStart, tags, imports, setupCode, language);
        if (workflow) {
          examples.push(workflow);
        }
      }
    }

    return examples;
  }

  /**
   * Detect if file is TypeScript or JavaScript.
   */
  private detectLanguage(filePath: string): TestLanguage {
    if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
      return TestLanguage.TypeScript;
    }
    return TestLanguage.JavaScript;
  }

  /**
   * Extract imported modules.
   */
  private extractImports(content: string): string[] {
    const imports: string[] = [];
    let match: RegExpExecArray | null;

    IMPORT_PATTERN.lastIndex = 0;
    while ((match = IMPORT_PATTERN.exec(content)) !== null) {
      const module = match[1]!;
      // Get package name (first part before '/')
      const packageName = module.startsWith('@') 
        ? module.split('/').slice(0, 2).join('/')
        : module.split('/')[0]!;
      imports.push(packageName);
    }

    return [...new Set(imports)];
  }

  /**
   * Extract setup code from beforeEach/beforeAll.
   */
  private extractSetupCode(content: string): string | undefined {
    SETUP_PATTERN.lastIndex = 0;
    const match = SETUP_PATTERN.exec(content);
    if (match) {
      return match[1]?.trim();
    }
    return undefined;
  }

  /**
   * Find all test blocks in content.
   */
  private findTestBlocks(content: string): Array<{
    type: 'it' | 'test' | 'describe';
    name: string;
    body: string;
    lineStart: number;
  }> {
    const blocks: Array<{
      type: 'it' | 'test' | 'describe';
      name: string;
      body: string;
      lineStart: number;
    }> = [];

    TEST_BLOCK_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = TEST_BLOCK_PATTERN.exec(content)) !== null) {
      const blockType = match[1] as 'it' | 'test' | 'describe';
      const name = match[2]!;
      const lineStart = this.getLineNumber(content, match.index);

      // Find block body (balanced braces)
      const startIndex = match.index + match[0].length;
      const body = this.extractBlockBody(content, startIndex);

      // Only include actual tests (it/test), not describe blocks themselves
      if (blockType !== 'describe') {
        blocks.push({
          type: blockType,
          name,
          body,
          lineStart,
        });
      }
    }

    return blocks;
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
    const tags: string[] = [];
    const contentLower = content.toLowerCase();

    // Check imports for test framework
    if (imports.some((i) => i.includes('jest'))) tags.push('jest');
    if (imports.some((i) => i.includes('vitest'))) tags.push('vitest');
    if (imports.some((i) => i.includes('mocha'))) tags.push('mocha');

    // Check for async
    if (contentLower.includes('async') || contentLower.includes('await')) {
      tags.push('async');
    }

    // Check for mock usage
    if (contentLower.includes('mock') || contentLower.includes('jest.fn') || contentLower.includes('vi.fn')) {
      tags.push('mock');
    }

    // Check for snapshot testing
    if (contentLower.includes('tomatchsnapshot') || contentLower.includes('tomatchinlinesnapshot')) {
      tags.push('snapshot');
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
    setupCode: string | undefined,
    language: TestLanguage
  ): TestExample[] {
    const examples: TestExample[] = [];

    INSTANTIATION_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = INSTANTIATION_PATTERN.exec(body)) !== null) {
      const code = match[0].trim();

      // Skip trivial
      if (this.isTrivial(code)) continue;

      const varName = match[1]!;
      const className = match[2]!;
      const lineStart = baseLineStart + this.getLineNumber(body.slice(0, match.index), 0);

      // Find assertion after this line
      const assertion = this.findAssertionAfter(body, match.index);

      const example: TestExample = {
        exampleId: this.generateId(code),
        testName,
        category: ExampleCategory.Instantiation,
        code,
        language,
        description: `Instantiate ${className}`,
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

    // Also find factory patterns
    FACTORY_PATTERN.lastIndex = 0;
    while ((match = FACTORY_PATTERN.exec(body)) !== null) {
      const code = match[0].trim();
      const funcName = match[3]!;

      // Skip if not a factory-like name
      if (!funcName.startsWith('create') && !funcName.startsWith('build') && !funcName.startsWith('make')) {
        continue;
      }

      // Skip trivial
      if (this.isTrivial(code)) continue;

      const varName = match[1]!;
      const lineStart = baseLineStart + this.getLineNumber(body.slice(0, match.index), 0);
      const assertion = this.findAssertionAfter(body, match.index);

      const example: TestExample = {
        exampleId: this.generateId(code),
        testName,
        category: ExampleCategory.Instantiation,
        code,
        language,
        description: `Create via ${funcName}`,
        expectedBehavior: assertion,
        filePath,
        lineStart,
        lineEnd: lineStart + code.split('\n').length - 1,
        complexityScore: this.calculateComplexity(code),
        confidence: 0.75,
        tags,
        dependencies: imports,
        setupCode,
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
    setupCode: string | undefined,
    language: TestLanguage
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

      const methodName = callMatch[3]!;
      const lineStart = baseLineStart + i;

      const example: TestExample = {
        exampleId: this.generateId(code),
        testName,
        category: ExampleCategory.MethodCall,
        code,
        language,
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
        methodName,
      };

      examples.push(example);
    }

    return examples;
  }

  /**
   * Find configuration object patterns.
   */
  private findConfigObjects(
    body: string,
    testName: string,
    filePath: string,
    baseLineStart: number,
    tags: string[],
    imports: string[],
    setupCode: string | undefined,
    language: TestLanguage
  ): TestExample[] {
    const examples: TestExample[] = [];

    CONFIG_OBJECT_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = CONFIG_OBJECT_PATTERN.exec(body)) !== null) {
      const code = match[0].trim();
      const varName = match[1]!;
      const objContent = match[2] ?? '';

      // Must have at least 2 properties
      const propCount = (objContent.match(/\w+\s*:/g) ?? []).length;
      if (propCount < 2) continue;

      // Check if it looks like configuration
      if (!this.looksLikeConfig(varName, objContent)) continue;

      const lineStart = baseLineStart + this.getLineNumber(body.slice(0, match.index), 0);

      const example: TestExample = {
        exampleId: this.generateId(code),
        testName,
        category: ExampleCategory.Config,
        code,
        language,
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
      };

      examples.push(example);
    }

    return examples;
  }

  /**
   * Check if test is an integration test.
   */
  private isIntegrationTest(testName: string, body: string): boolean {
    const nameLower = testName.toLowerCase();
    const integrationKeywords = ['workflow', 'integration', 'end to end', 'e2e', 'full'];

    // Check name
    if (integrationKeywords.some((k) => nameLower.includes(k))) return true;

    // Check if has 5+ meaningful steps
    const meaningfulLines = body
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('//') && !this.isTrivial(l));

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
    setupCode: string | undefined,
    language: TestLanguage
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
      language,
      description: `Workflow: ${testName}`,
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
   * Check if code is trivial.
   */
  private isTrivial(code: string): boolean {
    if (code.length < MIN_CODE_LENGTH) return true;
    return TRIVIAL_PATTERNS.some((p) => code.includes(p));
  }

  /**
   * Check if object looks like configuration.
   */
  private looksLikeConfig(varName: string, content: string): boolean {
    const configNames = ['config', 'settings', 'options', 'params', 'props', 'data', 'opts'];
    const varNameLower = varName.toLowerCase();

    // Check variable name
    if (configNames.some((n) => varNameLower.includes(n))) return true;

    // Check if has typical config properties
    const configProps = ['host', 'port', 'url', 'timeout', 'enabled', 'debug', 'name', 'type'];
    const contentLower = content.toLowerCase();
    return configProps.some((p) => contentLower.includes(p));
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
 * Creates a new TypeScriptTestAnalyzer instance.
 */
export function createTypeScriptTestAnalyzer(): TypeScriptTestAnalyzer {
  return new TypeScriptTestAnalyzer();
}
