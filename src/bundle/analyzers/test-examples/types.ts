/**
 * Test Example Extraction - Type Definitions
 *
 * Type definitions for extracting usage examples from test files.
 * Supports multiple languages including Python, TypeScript, JavaScript, Go, etc.
 *
 * @module bundle/analyzers/test-examples/types
 */

import type { AnalyzerOptions } from '../types.js';

// ============================================================================
// Enums
// ============================================================================

/**
 * Categories of test examples.
 */
export enum ExampleCategory {
  /** Object instantiation with parameters: `obj = ClassName(...)` */
  Instantiation = 'instantiation',
  /** Method calls with assertions */
  MethodCall = 'method_call',
  /** Configuration dictionaries/objects */
  Config = 'config',
  /** Setup code from fixtures/setUp() */
  Setup = 'setup',
  /** Multi-step integration test workflows */
  Workflow = 'workflow',
}

/**
 * Supported programming languages for test extraction.
 */
export enum TestLanguage {
  Python = 'Python',
  TypeScript = 'TypeScript',
  JavaScript = 'JavaScript',
  Go = 'Go',
  Rust = 'Rust',
  Java = 'Java',
  CSharp = 'C#',
  PHP = 'PHP',
  Ruby = 'Ruby',
  Unknown = 'Unknown',
}

// ============================================================================
// Test Example Types
// ============================================================================

/**
 * Single extracted usage example from test code.
 */
export type TestExample = {
  /** Unique identifier (hash of code) */
  exampleId: string;
  /** Test function/method name */
  testName: string;
  /** Example category */
  category: ExampleCategory;
  /** Actual example code */
  code: string;
  /** Programming language */
  language: TestLanguage;
  /** What this demonstrates */
  description: string;
  /** Expected outcome from assertions */
  expectedBehavior: string;
  /** File path (relative to repo) */
  filePath: string;
  /** Start line number */
  lineStart: number;
  /** End line number */
  lineEnd: number;
  /** Complexity score (0-1, higher = more complex/valuable) */
  complexityScore: number;
  /** Detection confidence (0-1, higher = more confident) */
  confidence: number;
  /** Required setup code (optional) */
  setupCode?: string;
  /** Tags like ['pytest', 'mock', 'async'] */
  tags: string[];
  /** Imported modules/dependencies */
  dependencies: string[];
  /** Class name involved (if applicable) */
  className?: string;
  /** Method name being tested (if applicable) */
  methodName?: string;
};

/**
 * Summary by category.
 */
export type CategoryCount = {
  [K in ExampleCategory]?: number;
};

/**
 * Summary by language.
 */
export type LanguageCount = {
  [K in TestLanguage]?: number;
};

/**
 * Test example extraction report for a single file.
 */
export type FileExampleReport = {
  /** File path (relative to repo) */
  filePath: string;
  /** Detected programming language */
  language: TestLanguage;
  /** Examples extracted from this file */
  examples: TestExample[];
  /** Total test functions found */
  totalTests: number;
  /** Total examples extracted */
  totalExamples: number;
};

/**
 * Complete test example extraction report.
 */
export type TestExampleReport = {
  /** Reports per file */
  files: FileExampleReport[];
  /** All examples across files */
  allExamples: TestExample[];
  /** Summary by category */
  examplesByCategory: CategoryCount;
  /** Summary by language */
  examplesByLanguage: LanguageCount;
  /** Total files analyzed */
  totalFiles: number;
  /** Total examples extracted */
  totalExamples: number;
  /** Average complexity score */
  avgComplexity: number;
  /** Count of high-value examples (confidence > 0.7) */
  highValueCount: number;
};

// ============================================================================
// Analyzer Options
// ============================================================================

/**
 * Test Example Analyzer specific options.
 */
export type TestExampleAnalyzerOptions = AnalyzerOptions & {
  /** Minimum confidence threshold (0.0-1.0) */
  minConfidence: number;
  /** Maximum examples to extract per file */
  maxPerFile: number;
  /** Languages to analyze (empty = all supported) */
  languages: TestLanguage[];
  /** Categories to extract (empty = all) */
  categories: ExampleCategory[];
  /** Minimum code length to include */
  minCodeLength: number;
  /** Whether to include setup code in examples */
  includeSetupCode: boolean;
};

/**
 * Default options for Test Example Analyzer.
 */
export const DEFAULT_TEST_EXAMPLE_OPTIONS: Required<TestExampleAnalyzerOptions> = {
  enabled: true,
  timeout: 60000,
  maxFiles: 0,
  includePatterns: [],
  excludePatterns: ['**/node_modules/**', '**/vendor/**', '**/.git/**'],
  minConfidence: 0.5,
  maxPerFile: 10,
  languages: [],
  categories: [],
  minCodeLength: 20,
  includeSetupCode: true,
};

// ============================================================================
// Analyzer Output
// ============================================================================

/**
 * Test Example Analyzer output data.
 */
export type TestExampleOutput = TestExampleReport;

// ============================================================================
// Language Analyzer Interface
// ============================================================================

/**
 * Interface for language-specific test analyzers.
 */
export type LanguageTestAnalyzer = {
  /** Supported language */
  readonly language: TestLanguage;
  /** Additional supported languages (aliases) */
  readonly aliases?: TestLanguage[];

  /**
   * Extract examples from test file content.
   *
   * @param filePath - File path (relative to repo)
   * @param content - File content
   * @returns Array of extracted examples
   */
  extract(filePath: string, content: string): TestExample[];
};

/**
 * Factory function type for language test analyzers.
 */
export type LanguageTestAnalyzerFactory = () => LanguageTestAnalyzer;

// ============================================================================
// Test File Detection
// ============================================================================

/**
 * Test file patterns by language.
 */
export const TEST_FILE_PATTERNS: Record<TestLanguage, string[]> = {
  [TestLanguage.Python]: ['test_*.py', '*_test.py', 'tests.py'],
  [TestLanguage.TypeScript]: ['*.test.ts', '*.spec.ts', '*.test.tsx', '*.spec.tsx'],
  [TestLanguage.JavaScript]: ['*.test.js', '*.spec.js', '*.test.jsx', '*.spec.jsx'],
  [TestLanguage.Go]: ['*_test.go'],
  [TestLanguage.Rust]: ['*_test.rs'],
  [TestLanguage.Java]: ['*Test.java', '*Tests.java'],
  [TestLanguage.CSharp]: ['*Test.cs', '*Tests.cs'],
  [TestLanguage.PHP]: ['*Test.php'],
  [TestLanguage.Ruby]: ['*_spec.rb', '*_test.rb'],
  [TestLanguage.Unknown]: [],
};

/**
 * File extension to language mapping.
 */
export const EXTENSION_TO_LANGUAGE: Record<string, TestLanguage> = {
  py: TestLanguage.Python,
  pyw: TestLanguage.Python,
  ts: TestLanguage.TypeScript,
  tsx: TestLanguage.TypeScript,
  js: TestLanguage.JavaScript,
  jsx: TestLanguage.JavaScript,
  mjs: TestLanguage.JavaScript,
  cjs: TestLanguage.JavaScript,
  go: TestLanguage.Go,
  rs: TestLanguage.Rust,
  java: TestLanguage.Java,
  cs: TestLanguage.CSharp,
  php: TestLanguage.PHP,
  rb: TestLanguage.Ruby,
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Gets language from file extension.
 */
export function getLanguageFromExtension(ext: string): TestLanguage {
  return EXTENSION_TO_LANGUAGE[ext.toLowerCase()] ?? TestLanguage.Unknown;
}

/**
 * Checks if a file path looks like a test file.
 */
export function isTestFile(filePath: string, language: TestLanguage): boolean {
  const patterns = TEST_FILE_PATTERNS[language];
  if (!patterns || patterns.length === 0) return false;

  const fileName = filePath.split('/').pop() ?? '';

  return patterns.some((pattern) => {
    // Convert glob pattern to regex
    const regex = new RegExp(
      '^' +
        pattern
          .replace(/\./g, '\\.')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.') +
        '$'
    );
    return regex.test(fileName);
  });
}
