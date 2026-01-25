/**
 * Error-prone Rules Module
 *
 * Detects common error-prone code patterns:
 * - EmptyCatchBlock: Empty or comment-only catch blocks
 * - EmptyIfStatement: Empty if statement bodies
 * - ReturnFromFinallyBlock: Return statements in finally blocks
 * - MissingBreakInSwitch: Switch cases without break/return/throw
 *
 * @module analysis/check/errorprone
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Node, Tree } from 'web-tree-sitter';
import { minimatch } from 'minimatch';

import { createModuleLogger } from '../../../logging/logger.js';
import type { AnalysisContext } from '../../cache/index.js';
import { languageForFile } from '../../../ast/index.js';
import type { TreeSitterLanguageId } from '../../../ast/types.js';
import type { BaseCheckIssue, SingleCheckResult } from '../types.js';
import { computeSummaryFromIssues, LANGUAGE_SUPPORT } from '../types.js';
import type { ErrorProneIssue, ErrorProneRuleId } from './types.js';
import { ruleAppliesToLanguage, getRuleMetadata } from './types.js';

export * from './types.js';

const logger = createModuleLogger('errorprone');

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Run error-prone checks on a directory.
 */
export async function checkErrorProne(
  targetPath: string,
  excludePatterns?: string[],
  context?: AnalysisContext
): Promise<SingleCheckResult<BaseCheckIssue>> {
  const resolvedPath = path.resolve(targetPath);

  logger.info(`Checking error-prone patterns in: ${resolvedPath}`);

  try {
    const files = await collectFiles(resolvedPath, excludePatterns ?? []);

    if (files.length === 0) {
      return {
        type: 'errorprone',
        success: true,
        issues: [],
        summary: computeSummaryFromIssues([], 0),
      };
    }

    const allIssues: BaseCheckIssue[] = [];

    for (const filePath of files) {
      try {
        const issues = await analyzeFile(filePath, context);
        allIssues.push(...issues);
      } catch {
        // Skip files that fail to parse
      }
    }

    return {
      type: 'errorprone',
      success: true,
      issues: allIssues,
      summary: computeSummaryFromIssues(allIssues, files.length),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Error-prone check failed: ${msg}`);
    return {
      type: 'errorprone',
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
  const supportedExts = new Set(LANGUAGE_SUPPORT.errorprone);

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
// File Analysis
// ============================================================================

async function analyzeFile(filePath: string, context?: AnalysisContext): Promise<BaseCheckIssue[]> {
  const lang = languageForFile(filePath);
  if (!lang) return [];

  if (!context) {
    // Without context, skip (we need AST for analysis)
    return [];
  }

  const result = await context.ast.withTree(context.fileIndex, filePath, (tree, tsLang) => {
    return analyzeTree(tree, tsLang, filePath);
  });

  return result ?? [];
}

function analyzeTree(tree: Tree, lang: TreeSitterLanguageId, filePath: string): BaseCheckIssue[] {
  const issues: BaseCheckIssue[] = [];

  // Run each applicable rule
  if (ruleAppliesToLanguage('empty-catch-block', lang)) {
    issues.push(...checkEmptyCatchBlock(tree, lang, filePath));
  }

  if (ruleAppliesToLanguage('empty-if-statement', lang)) {
    issues.push(...checkEmptyIfStatement(tree, lang, filePath));
  }

  if (ruleAppliesToLanguage('return-from-finally', lang)) {
    issues.push(...checkReturnFromFinally(tree, lang, filePath));
  }

  if (ruleAppliesToLanguage('missing-break-in-switch', lang)) {
    issues.push(...checkMissingBreakInSwitch(tree, lang, filePath));
  }

  return issues;
}

// ============================================================================
// Rule Implementations
// ============================================================================

/**
 * Check for empty catch blocks.
 * Detects: catch { } or catch { // comment }
 */
function checkEmptyCatchBlock(tree: Tree, lang: TreeSitterLanguageId, filePath: string): BaseCheckIssue[] {
  const issues: BaseCheckIssue[] = [];
  const rule = getRuleMetadata('empty-catch-block')!;

  // Node types for catch blocks by language
  const catchTypes: Record<string, string[]> = {
    javascript: ['catch_clause'],
    typescript: ['catch_clause'],
    tsx: ['catch_clause'],
    java: ['catch_clause'],
  };

  const types = catchTypes[lang];
  if (!types) return issues;

  visitNodes(tree.rootNode, (node) => {
    if (!types.includes(node.type)) return;

    const body = findCatchBody(node, lang);
    if (body && isEmptyBlock(body)) {
      issues.push({
        ruleId: 'empty-catch-block',
        severity: rule.severity,
        file: filePath,
        line: String(node.startPosition.row + 1),
        message: 'Catch block is empty. Consider logging or re-throwing the error.',
      });
    }
  });

  return issues;
}

/**
 * Find catch body node based on language.
 */
function findCatchBody(catchNode: Node, lang: TreeSitterLanguageId): Node | null {
  // JavaScript/TypeScript/Java: catch_clause has statement_block as body
  for (let i = 0; i < catchNode.childCount; i++) {
    const child = catchNode.child(i);
    if (child && (child.type === 'statement_block' || child.type === 'block')) {
      return child;
    }
  }
  return null;
}

/**
 * Check for empty if statements.
 */
function checkEmptyIfStatement(tree: Tree, lang: TreeSitterLanguageId, filePath: string): BaseCheckIssue[] {
  const issues: BaseCheckIssue[] = [];
  const rule = getRuleMetadata('empty-if-statement')!;

  // Node types for if statements by language
  const ifTypes: Record<string, string[]> = {
    javascript: ['if_statement'],
    typescript: ['if_statement'],
    tsx: ['if_statement'],
    java: ['if_statement'],
    python: ['if_statement'],
    go: ['if_statement'],
    rust: ['if_expression'],
  };

  const types = ifTypes[lang];
  if (!types) return issues;

  visitNodes(tree.rootNode, (node) => {
    if (!types.includes(node.type)) return;

    const body = findIfBody(node, lang);
    if (body && isEmptyBlock(body)) {
      issues.push({
        ruleId: 'empty-if-statement',
        severity: rule.severity,
        file: filePath,
        line: String(node.startPosition.row + 1),
        message: 'If statement has empty body.',
      });
    }
  });

  return issues;
}

/**
 * Find if body node based on language.
 */
function findIfBody(ifNode: Node, lang: TreeSitterLanguageId): Node | null {
  // For different languages, body may have different names
  const bodyFieldNames = ['consequence', 'body'];

  for (const fieldName of bodyFieldNames) {
    const body = ifNode.childForFieldName(fieldName);
    if (body) return body;
  }

  // Fallback: look for block-like children
  for (let i = 0; i < ifNode.childCount; i++) {
    const child = ifNode.child(i);
    if (
      child &&
      (child.type === 'statement_block' ||
        child.type === 'block' ||
        child.type === 'compound_statement')
    ) {
      return child;
    }
  }

  return null;
}

/**
 * Check for return statements in finally blocks.
 */
function checkReturnFromFinally(tree: Tree, lang: TreeSitterLanguageId, filePath: string): BaseCheckIssue[] {
  const issues: BaseCheckIssue[] = [];
  const rule = getRuleMetadata('return-from-finally')!;

  // Node types for finally blocks
  const finallyTypes: Record<string, string[]> = {
    javascript: ['finally_clause'],
    typescript: ['finally_clause'],
    tsx: ['finally_clause'],
    java: ['finally_clause'],
  };

  const types = finallyTypes[lang];
  if (!types) return issues;

  visitNodes(tree.rootNode, (node) => {
    if (!types.includes(node.type)) return;

    // Find return statements within this finally block
    const returns = findReturnStatements(node);
    for (const ret of returns) {
      issues.push({
        ruleId: 'return-from-finally',
        severity: rule.severity,
        file: filePath,
        line: String(ret.startPosition.row + 1),
        message: 'Return statement in finally block may suppress exceptions.',
      });
    }
  });

  return issues;
}

/**
 * Find all return statements within a node, excluding nested functions/classes.
 */
function findReturnStatements(node: Node): Node[] {
  const returns: Node[] = [];

  // Node types that define new scope (should not traverse into)
  const scopeBoundaries = new Set([
    'function_declaration',
    'function_expression',
    'arrow_function',
    'method_definition',
    'class_declaration',
    'class_expression',
    'method_declaration',
    'constructor_declaration',
    'lambda_expression',
  ]);

  function visit(n: Node): void {
    if (n.type === 'return_statement') {
      returns.push(n);
      return;
    }

    for (let i = 0; i < n.childCount; i++) {
      const child = n.child(i);
      if (child && !scopeBoundaries.has(child.type)) {
        visit(child);
      }
    }
  }

  visit(node);
  return returns;
}

/**
 * Check for missing break in switch cases.
 */
function checkMissingBreakInSwitch(tree: Tree, lang: TreeSitterLanguageId, filePath: string): BaseCheckIssue[] {
  const issues: BaseCheckIssue[] = [];
  const rule = getRuleMetadata('missing-break-in-switch')!;

  // Node types for switch statements
  const switchTypes: Record<string, string[]> = {
    javascript: ['switch_statement'],
    typescript: ['switch_statement'],
    tsx: ['switch_statement'],
    java: ['switch_statement', 'switch_expression'],
  };

  const types = switchTypes[lang];
  if (!types) return issues;

  visitNodes(tree.rootNode, (node) => {
    if (!types.includes(node.type)) return;

    // Get switch body (JS/TS: 'body' field, Java: 'switch_block' child)
    let body = node.childForFieldName('body');
    if (!body) {
      // Java: look for switch_block child
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'switch_block') {
          body = child;
          break;
        }
      }
    }
    if (!body) return;

    const cases = collectSwitchCases(body, lang);
    for (let i = 0; i < cases.length; i++) {
      const caseNode = cases[i]!;
      const nextCase = cases[i + 1];

      // Skip default case at end (or last case)
      if (!nextCase) {
        // Check if it's a default case (or for Java, contains default switch_label)
        if (caseNode.type.includes('default') || isDefaultCase(caseNode)) continue;
      }

      // Check if case has terminating statement
      if (!hasTerminatingStatement(caseNode, lang)) {
        // Check if it's intentional fall-through (empty case)
        if (isIntentionalFallThrough(caseNode)) continue;

        issues.push({
          ruleId: 'missing-break-in-switch',
          severity: rule.severity,
          file: filePath,
          line: String(caseNode.startPosition.row + 1),
          message: 'Switch case may fall through. Add break, return, or throw.',
        });
      }
    }
  });

  return issues;
}

/**
 * Collect all case/default nodes from switch body.
 */
function collectSwitchCases(body: Node, lang: TreeSitterLanguageId): Node[] {
  const cases: Node[] = [];

  // JS/TS: switch_case, switch_default
  // Java: switch_block_statement_group (contains switch_label)
  const caseTypes = new Set([
    'switch_case',
    'switch_default',
    'case_statement',
    'default_case',
    'switch_block_statement_group',
  ]);

  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (child && caseTypes.has(child.type)) {
      cases.push(child);
    }
  }

  return cases;
}

/**
 * Check if a case has a terminating statement.
 */
function hasTerminatingStatement(caseNode: Node, lang: TreeSitterLanguageId): boolean {
  const terminators = ['break_statement', 'return_statement', 'throw_statement', 'continue_statement'];

  // Check last meaningful statement
  let lastStatement: Node | null = null;

  for (let i = 0; i < caseNode.childCount; i++) {
    const child = caseNode.child(i);
    if (!child) continue;

    // Skip label (case x:) and switch_label (Java)
    if (child.type.includes('label') || child.type === ':' || child.type === 'switch_label') continue;

    if (isStatementNode(child)) {
      lastStatement = child;
    }
  }

  if (!lastStatement) return false;

  // Check if the last statement is a terminator
  if (terminators.includes(lastStatement.type)) return true;

  // Check for nested terminators (e.g., in if/else)
  return containsTerminator(lastStatement, terminators);
}

/**
 * Check if node is a statement.
 */
function isStatementNode(node: Node): boolean {
  return (
    node.type.includes('statement') ||
    node.type.includes('declaration') ||
    node.type === 'expression_statement'
  );
}

/**
 * Check if node contains a terminator.
 */
function containsTerminator(node: Node, terminators: string[]): boolean {
  if (terminators.includes(node.type)) return true;

  // For if/else, both branches must terminate
  if (node.type === 'if_statement') {
    const consequence = node.childForFieldName('consequence');
    const alternative = node.childForFieldName('alternative');

    // If no else, doesn't guarantee termination
    if (!alternative) return false;

    const conseqTerminates = consequence ? containsTerminator(consequence, terminators) : false;
    const altTerminates = containsTerminator(alternative, terminators);

    return conseqTerminates && altTerminates;
  }

  // Check children
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && containsTerminator(child, terminators)) return true;
  }

  return false;
}

/**
 * Check if case is intentional fall-through (empty or has fall-through comment).
 */
function isIntentionalFallThrough(caseNode: Node): boolean {
  // Check if case body is empty (just the label)
  let hasStatements = false;

  for (let i = 0; i < caseNode.childCount; i++) {
    const child = caseNode.child(i);
    if (!child) continue;
    // Skip label and switch_label (Java)
    if (child.type.includes('label') || child.type === ':' || child.type === 'switch_label') continue;
    if (isStatementNode(child)) {
      hasStatements = true;
      break;
    }
  }

  return !hasStatements;
}

/**
 * Check if a case node is a default case (for Java switch_block_statement_group).
 */
function isDefaultCase(caseNode: Node): boolean {
  for (let i = 0; i < caseNode.childCount; i++) {
    const child = caseNode.child(i);
    if (!child) continue;
    // Java: switch_label containing 'default'
    if (child.type === 'switch_label') {
      for (let j = 0; j < child.childCount; j++) {
        const labelChild = child.child(j);
        if (labelChild?.type === 'default') return true;
      }
    }
  }
  return false;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a block node is empty (no statements, only comments/empty statements allowed).
 * Returns false if:
 * - Comments indicate intentional ignore (e.g., "// ignore", "// expected")
 * - Block contains only a single return statement (returning default value pattern)
 */
function isEmptyBlock(node: Node): boolean {
  let hasIntentionalIgnoreComment = false;
  let statementCount = 0;
  let hasOnlyReturnStatement = false;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    // Skip punctuation
    if (child.type === '{' || child.type === '}') continue;
    if (child.type === ':') continue;

    // Check comments for intentional ignore patterns
    if (child.type === 'comment' || child.type === 'line_comment' || child.type === 'block_comment') {
      if (isIntentionalIgnoreComment(child.text)) {
        hasIntentionalIgnoreComment = true;
      }
      continue;
    }

    // Empty statements are also considered "empty" (JS/TS/Java `;`, Python `pass`)
    if (child.type === 'empty_statement' || child.type === 'pass_statement') continue;

    // Count real statements
    statementCount++;

    // Single return statement is a common "return default value" pattern
    if (child.type === 'return_statement') {
      hasOnlyReturnStatement = statementCount === 1;
    }
  }

  // If there's a comment indicating intentional ignore, don't report as empty
  if (hasIntentionalIgnoreComment) return false;

  // If block has only a single return statement, it's intentional (returning default value)
  if (statementCount === 1 && hasOnlyReturnStatement) return false;

  // Empty (no statements) is problematic
  return statementCount === 0;
}

/**
 * Check if a comment indicates intentional error ignoring.
 * Matches patterns like: // ignore, // expected, // ok, // intentional, // noop, etc.
 */
function isIntentionalIgnoreComment(commentText: string): boolean {
  const normalized = commentText.toLowerCase();
  
  // Common patterns for intentional ignoring
  const ignorePatterns = [
    // Explicit ignore keywords
    /\bignore\b/,
    /\bignored\b/,
    /\bexpected\b/,
    /\bintentional\b/,
    /\bok\b/,
    /\bnoop\b/,
    /\bno-op\b/,
    /\bskip\b/,
    /\bsilent\b/,
    /\bsilently\b/,
    /\bswallow\b/,
    /\bsuppress\b/,
    /\bfall\s*through\b/,
    /\bfallthrough\b/,
    /\bnot\s+critical\b/,
    /\bnon-critical\b/,
    /\bbest[\s-]effort\b/,
    /\boptional\b/,
    // Failure explanations
    /\bcan't\s+fail\b/,
    /\bcannot\s+fail\b/,
    /\bwon't\s+fail\b/,
    /\bnever\s+fails?\b/,
    /\bfile\s+(doesn't|does\s+not)\s+exist\b/,
    /\balready\s+(exists?|deleted|removed)\b/,
    // Common explanatory patterns
    /\bmissing\b/,
    /\bunreadable\b/,
    /\binaccessible\b/,
    /\bcan't\s+be\s+(read|parsed|analyzed)\b/,
    /\bcannot\s+be\s+(read|parsed|analyzed)\b/,
    /\bfail(ed)?\s+to\s+(read|parse|open|analyze)\b/,
    /\bfallback\b/,
    /\bdefault\b.*\bvalue\b/,
    /\bproceed\s+without\b/,
    /\bclean(ed)?\s+(up|on)\b/,
    /\bshutdown\b/,
    /\bcorrupt\b/,
    /\bnot\s+found\b/,
    /\bdoesn't\s+exist\b/,
    /\bdoes\s+not\s+exist\b/,
  ];

  return ignorePatterns.some(pattern => pattern.test(normalized));
}

/**
 * Visit all nodes in tree.
 */
function visitNodes(node: Node, callback: (node: Node) => void): void {
  callback(node);
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      visitNodes(child, callback);
    }
  }
}
