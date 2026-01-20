/**
 * Security Rules Module
 *
 * Detects security-related code patterns:
 * - HardcodedCredentials: Potential hardcoded secrets in variable assignments
 * - InsecureRandom: Usage of Math.random() (JS/TS) or java.util.Random (Java)
 *
 * @module analysis/check/security
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Node, Tree } from 'web-tree-sitter';
import { minimatch } from 'minimatch';

import { createModuleLogger } from '../../../logging/logger.js';
import type { AnalysisContext } from '../../cache/index.js';
import { languageForFile } from '../../../ast/index.js';
import type { TreeSitterLanguageId } from '../../../ast/types.js';
import type { BaseCheckIssue, SingleCheckResult, SecurityOptions } from '../types.js';
import { computeSummaryFromIssues, LANGUAGE_SUPPORT } from '../types.js';
import {
  ruleAppliesToLanguage,
  getRuleMetadata,
  isCredentialName,
  looksLikeCredential,
} from './types.js';
import type { SecurityRuleId } from './types.js';

export * from './types.js';

const logger = createModuleLogger('security');

// ============================================================================
// Test/Fixture Exclusion Patterns
// ============================================================================

const TEST_PATTERNS = [
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/fixtures/**',
  '**/fixture/**',
  '**/__fixtures__/**',
  '**/testdata/**',
  '**/test-data/**',
  '**/__mocks__/**',
  '**/mocks/**',
];

function isTestFile(filePath: string, rootPath: string): boolean {
  const rel = path.relative(rootPath, filePath).replace(/\\/g, '/');
  return TEST_PATTERNS.some((p) => minimatch(rel, p, { dot: true }));
}

// ============================================================================
// Main Entry Point
// ============================================================================

/** Compiled regex patterns for performance */
interface CompiledPatterns {
  ignoreNames: RegExp[];
  ignoreValues: RegExp[];
}

function compilePatterns(options?: SecurityOptions): CompiledPatterns {
  return {
    ignoreNames: (options?.ignoreNamePatterns ?? []).map((p) => new RegExp(p)),
    ignoreValues: (options?.ignoreValuePatterns ?? []).map((p) => new RegExp(p)),
  };
}

/**
 * Run security checks on a directory.
 */
export async function checkSecurity(
  targetPath: string,
  excludePatterns?: string[],
  context?: AnalysisContext,
  options?: SecurityOptions
): Promise<SingleCheckResult<BaseCheckIssue>> {
  const resolvedPath = path.resolve(targetPath);
  const patterns = compilePatterns(options);

  logger.info(`Checking security patterns in: ${resolvedPath}`);

  try {
    const files = await collectFiles(resolvedPath, excludePatterns ?? []);

    if (files.length === 0) {
      return {
        type: 'security',
        success: true,
        issues: [],
        summary: computeSummaryFromIssues([], 0),
      };
    }

    const allIssues: BaseCheckIssue[] = [];

    for (const filePath of files) {
      // Skip test/fixture files by default
      if (isTestFile(filePath, resolvedPath)) continue;

      try {
        const issues = await analyzeFile(filePath, context, patterns);
        allIssues.push(...issues);
      } catch {
        // Skip files that fail to parse
      }
    }

    return {
      type: 'security',
      success: true,
      issues: allIssues,
      summary: computeSummaryFromIssues(allIssues, files.length),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Security check failed: ${msg}`);
    return {
      type: 'security',
      success: false,
      issues: [],
      summary: computeSummaryFromIssues([], 0),
      error: msg,
    };
  }
}

// ============================================================================
// File Collection
// ============================================================================

async function collectFiles(rootPath: string, excludePatterns: string[]): Promise<string[]> {
  const files: string[] = [];
  const supportedExts = new Set(LANGUAGE_SUPPORT.security);

  await walkDir(rootPath, async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!supportedExts.has(ext)) return;

    const relativePath = path.relative(rootPath, filePath).replace(/\\/g, '/');
    if (excludePatterns.some((p) => minimatch(relativePath, p))) return;

    files.push(filePath);
  });

  return files;
}

async function walkDir(dir: string, callback: (filePath: string) => Promise<void>): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (
        [
          'node_modules',
          '.git',
          '__pycache__',
          '.venv',
          'venv',
          'dist',
          'build',
          'coverage',
          '.next',
          'out',
          'vendor',
          'target',
        ].includes(entry.name)
      ) {
        continue;
      }
      await walkDir(fullPath, callback);
    } else if (entry.isFile()) {
      await callback(fullPath);
    }
  }
}

// ============================================================================
// Suppression Comments
// ============================================================================

/**
 * Patterns for suppression comments.
 * Supports: @security-ignore, @preflight-ignore: security, @preflight-ignore
 */
const SUPPRESSION_PATTERNS = [
  /@security-ignore/i,
  /@preflight-ignore:\s*security/i,
  /@preflight-ignore(?!:)/i,  // @preflight-ignore without specific check
];

/**
 * Check if a line is suppressed by a comment.
 * Looks for suppression comments on the same line or the line above.
 */
function isLineSuppressed(sourceLines: string[], lineNumber: number): boolean {
  // lineNumber is 1-based
  const lineIndex = lineNumber - 1;
  
  // Check current line (inline comment)
  if (lineIndex >= 0 && lineIndex < sourceLines.length) {
    const currentLine = sourceLines[lineIndex] ?? '';
    if (SUPPRESSION_PATTERNS.some(p => p.test(currentLine))) {
      return true;
    }
  }
  
  // Check line above
  if (lineIndex > 0 && lineIndex - 1 < sourceLines.length) {
    const lineAbove = sourceLines[lineIndex - 1] ?? '';
    if (SUPPRESSION_PATTERNS.some(p => p.test(lineAbove))) {
      return true;
    }
  }
  
  return false;
}

// ============================================================================
// File Analysis
// ============================================================================

async function analyzeFile(
  filePath: string,
  context: AnalysisContext | undefined,
  patterns: CompiledPatterns
): Promise<BaseCheckIssue[]> {
  const lang = languageForFile(filePath);
  if (!lang) return [];

  if (!context) {
    return [];
  }

  // Read source for suppression check
  let sourceLines: string[] = [];
  try {
    const content = await fs.readFile(filePath, 'utf8');
    sourceLines = content.split(/\r?\n/);
  } catch {
    // If can't read, proceed without suppression support
  }

  const result = await context.ast.withTree(context.fileIndex, filePath, (tree, tsLang) => {
    return analyzeTree(tree, tsLang, filePath, patterns, sourceLines);
  });

  return result ?? [];
}

function analyzeTree(
  tree: Tree,
  lang: TreeSitterLanguageId,
  filePath: string,
  patterns: CompiledPatterns,
  sourceLines: string[]
): BaseCheckIssue[] {
  const issues: BaseCheckIssue[] = [];

  if (ruleAppliesToLanguage('hardcoded-credentials', lang)) {
    issues.push(...checkHardcodedCredentials(tree, lang, filePath, patterns, sourceLines));
  }

  if (ruleAppliesToLanguage('insecure-random', lang)) {
    issues.push(...checkInsecureRandom(tree, lang, filePath, sourceLines));
  }

  return issues;
}

// ============================================================================
// HardcodedCredentials Rule
// ============================================================================

/**
 * Check for hardcoded credentials.
 * Detects: variable/field assignments with credential-like names and string literals.
 */
function checkHardcodedCredentials(
  tree: Tree,
  lang: TreeSitterLanguageId,
  filePath: string,
  patterns: CompiledPatterns,
  sourceLines: string[]
): BaseCheckIssue[] {
  const issues: BaseCheckIssue[] = [];
  const rule = getRuleMetadata('hardcoded-credentials')!;

  visitNodes(tree.rootNode, (node) => {
    const result = extractCredentialAssignment(node, lang);
    if (!result) return;

    const { name, value, line } = result;

    // Check for suppression comment
    if (isLineSuppressed(sourceLines, line)) return;

    if (
      isCredentialName(name, patterns.ignoreNames) &&
      looksLikeCredential(value, patterns.ignoreValues)
    ) {
      issues.push({
        ruleId: 'hardcoded-credentials',
        severity: rule.severity,
        file: filePath,
        line: String(line),
        message: `Potential hardcoded credential in '${name}'. Consider using environment variables or secrets management.`,
      });
    }
  });

  return issues;
}

/**
 * Extract credential assignment info from a node.
 */
function extractCredentialAssignment(
  node: Node,
  lang: TreeSitterLanguageId
): { name: string; value: string; line: number } | null {
  switch (lang) {
    case 'javascript':
    case 'typescript':
    case 'tsx':
      return extractJsCredentialAssignment(node);
    case 'python':
      return extractPythonCredentialAssignment(node);
    case 'java':
      return extractJavaCredentialAssignment(node);
    case 'go':
      return extractGoCredentialAssignment(node);
    case 'rust':
      return extractRustCredentialAssignment(node);
    default:
      return null;
  }
}

/**
 * JS/TS: variable_declarator or assignment_expression
 */
function extractJsCredentialAssignment(
  node: Node
): { name: string; value: string; line: number } | null {
  // const password = "secret"
  if (node.type === 'variable_declarator') {
    const nameNode = node.childForFieldName('name');
    const valueNode = node.childForFieldName('value');

    if (nameNode && valueNode && isStringLiteral(valueNode)) {
      return {
        name: nameNode.text,
        value: extractStringValue(valueNode),
        line: node.startPosition.row + 1,
      };
    }
  }

  // password = "secret"
  if (node.type === 'assignment_expression') {
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');

    if (left && right && isStringLiteral(right)) {
      const name = extractAssignmentTarget(left);
      if (name) {
        return {
          name,
          value: extractStringValue(right),
          line: node.startPosition.row + 1,
        };
      }
    }
  }

  // { password: "secret" }
  if (node.type === 'pair') {
    const key = node.childForFieldName('key');
    const value = node.childForFieldName('value');

    if (key && value && isStringLiteral(value)) {
      const name = key.type === 'string' ? extractStringValue(key) : key.text;
      return {
        name,
        value: extractStringValue(value),
        line: node.startPosition.row + 1,
      };
    }
  }

  return null;
}

/**
 * Python: assignment
 */
function extractPythonCredentialAssignment(
  node: Node
): { name: string; value: string; line: number } | null {
  // password = "secret"
  if (node.type === 'assignment') {
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');

    if (left && right && isStringLiteral(right)) {
      const name = left.type === 'identifier' ? left.text : null;
      if (name) {
        return {
          name,
          value: extractStringValue(right),
          line: node.startPosition.row + 1,
        };
      }
    }
  }

  // password: str = "secret" (annotated assignment)
  if (node.type === 'typed_assignment') {
    const name = node.childForFieldName('left');
    const value = node.childForFieldName('right');

    if (name && value && isStringLiteral(value) && name.type === 'identifier') {
      return {
        name: name.text,
        value: extractStringValue(value),
        line: node.startPosition.row + 1,
      };
    }
  }

  // { "password": "secret" } or {"password": "secret"}
  if (node.type === 'pair') {
    const key = node.childForFieldName('key');
    const value = node.childForFieldName('value');

    if (key && value && isStringLiteral(value) && isStringLiteral(key)) {
      return {
        name: extractStringValue(key),
        value: extractStringValue(value),
        line: node.startPosition.row + 1,
      };
    }
  }

  return null;
}

/**
 * Java: variable_declarator or field_declaration
 */
function extractJavaCredentialAssignment(
  node: Node
): { name: string; value: string; line: number } | null {
  // String password = "secret";
  if (node.type === 'variable_declarator') {
    const nameNode = node.childForFieldName('name');
    const valueNode = node.childForFieldName('value');

    if (nameNode && valueNode && isStringLiteral(valueNode)) {
      return {
        name: nameNode.text,
        value: extractStringValue(valueNode),
        line: node.startPosition.row + 1,
      };
    }
  }

  // assignment_expression
  if (node.type === 'assignment_expression') {
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');

    if (left && right && isStringLiteral(right)) {
      const name = extractAssignmentTarget(left);
      if (name) {
        return {
          name,
          value: extractStringValue(right),
          line: node.startPosition.row + 1,
        };
      }
    }
  }

  return null;
}

/**
 * Go: short_var_declaration or assignment_statement
 */
function extractGoCredentialAssignment(
  node: Node
): { name: string; value: string; line: number } | null {
  // password := "secret"
  if (node.type === 'short_var_declaration') {
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');

    if (left && right) {
      const name = left.type === 'expression_list' ? left.firstChild?.text : left.text;
      const valueNode = right.type === 'expression_list' ? right.firstChild : right;

      if (name && valueNode && isStringLiteral(valueNode)) {
        return {
          name,
          value: extractStringValue(valueNode),
          line: node.startPosition.row + 1,
        };
      }
    }
  }

  // var password = "secret"
  if (node.type === 'var_spec') {
    const nameNode = node.childForFieldName('name');
    const valueNode = node.childForFieldName('value');

    if (nameNode && valueNode && isStringLiteral(valueNode)) {
      return {
        name: nameNode.text,
        value: extractStringValue(valueNode),
        line: node.startPosition.row + 1,
      };
    }
  }

  return null;
}

/**
 * Rust: let_declaration
 */
function extractRustCredentialAssignment(
  node: Node
): { name: string; value: string; line: number } | null {
  // let password = "secret";
  if (node.type === 'let_declaration') {
    const pattern = node.childForFieldName('pattern');
    const value = node.childForFieldName('value');

    if (pattern && value && isStringLiteral(value)) {
      const name = pattern.type === 'identifier' ? pattern.text : null;
      if (name) {
        return {
          name,
          value: extractStringValue(value),
          line: node.startPosition.row + 1,
        };
      }
    }
  }

  return null;
}

// ============================================================================
// InsecureRandom Rule
// ============================================================================

/**
 * Check for insecure random number generation.
 * JS/TS: Math.random()
 * Java: new Random() or Random.nextInt/nextLong/etc.
 */
function checkInsecureRandom(
  tree: Tree,
  lang: TreeSitterLanguageId,
  filePath: string,
  sourceLines: string[]
): BaseCheckIssue[] {
  const issues: BaseCheckIssue[] = [];
  const rule = getRuleMetadata('insecure-random')!;

  visitNodes(tree.rootNode, (node) => {
    const isInsecure = detectInsecureRandom(node, lang);
    if (isInsecure) {
      const line = node.startPosition.row + 1;

      // Check for suppression comment
      if (isLineSuppressed(sourceLines, line)) return;

      const message =
        lang === 'java'
          ? 'java.util.Random is not cryptographically secure. Use java.security.SecureRandom for security-sensitive contexts.'
          : 'Math.random() is not cryptographically secure. Use crypto.getRandomValues() or crypto.randomUUID() for security-sensitive contexts.';

      issues.push({
        ruleId: 'insecure-random',
        severity: rule.severity,
        file: filePath,
        line: String(line),
        message,
      });
    }
  });

  return issues;
}

/**
 * Detect insecure random usage.
 */
function detectInsecureRandom(node: Node, lang: TreeSitterLanguageId): boolean {
  switch (lang) {
    case 'javascript':
    case 'typescript':
    case 'tsx':
      return detectJsInsecureRandom(node);
    case 'java':
      return detectJavaInsecureRandom(node);
    default:
      return false;
  }
}

/**
 * JS/TS: Math.random()
 */
function detectJsInsecureRandom(node: Node): boolean {
  if (node.type !== 'call_expression') return false;

  const fn = node.childForFieldName('function');
  if (!fn || fn.type !== 'member_expression') return false;

  const obj = fn.childForFieldName('object');
  const prop = fn.childForFieldName('property');

  return obj?.text === 'Math' && prop?.text === 'random';
}

/**
 * Java: new Random() or Random.nextXxx()
 */
function detectJavaInsecureRandom(node: Node): boolean {
  // new Random()
  if (node.type === 'object_creation_expression') {
    const typeNode = node.childForFieldName('type');
    if (typeNode?.text === 'Random' || typeNode?.text === 'java.util.Random') {
      return true;
    }
  }

  // Random.nextInt(), random.nextLong(), etc.
  if (node.type === 'method_invocation') {
    const obj = node.childForFieldName('object');
    const name = node.childForFieldName('name');

    if (!obj || !name) return false;

    const methodName = name.text;
    const randomMethods = ['nextInt', 'nextLong', 'nextFloat', 'nextDouble', 'nextBoolean', 'nextBytes', 'nextGaussian'];

    if (randomMethods.includes(methodName)) {
      // Check if the object is Random type (best effort)
      const objText = obj.text.toLowerCase();
      if (objText.includes('random') && !objText.includes('secure')) {
        return true;
      }
    }
  }

  return false;
}

// ============================================================================
// Utility Functions
// ============================================================================

function isStringLiteral(node: Node): boolean {
  return (
    node.type === 'string' ||
    node.type === 'string_literal' ||
    node.type === 'template_string' ||
    node.type === 'raw_string_literal' ||
    node.type === 'interpreted_string_literal'
  );
}

function extractStringValue(node: Node): string {
  const text = node.text;
  // Remove surrounding quotes (", ', `, """, etc.)
  if (text.startsWith('"""') && text.endsWith('"""')) {
    return text.slice(3, -3);
  }
  if (text.startsWith("'''") && text.endsWith("'''")) {
    return text.slice(3, -3);
  }
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('`') && text.endsWith('`'))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function extractAssignmentTarget(node: Node): string | null {
  if (node.type === 'identifier') {
    return node.text;
  }
  if (node.type === 'member_expression' || node.type === 'field_access') {
    const prop = node.childForFieldName('property') ?? node.lastChild;
    return prop?.text ?? null;
  }
  return null;
}

function visitNodes(node: Node, callback: (node: Node) => void): void {
  callback(node);
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      visitNodes(child, callback);
    }
  }
}
