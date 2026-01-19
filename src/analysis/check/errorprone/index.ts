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
        type: 'errorprone' as any,
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
      type: 'errorprone' as any,
      success: true,
      issues: allIssues,
      summary: computeSummaryFromIssues(allIssues, files.length),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Error-prone check failed: ${msg}`);
    return {
      type: 'errorprone' as any,
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
  const supportedExts = new Set(LANGUAGE_SUPPORT.deadcode); // Reuse deadcode language support

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
 * Find all return statements within a node.
 */
function findReturnStatements(node: Node): Node[] {
  const returns: Node[] = [];

  visitNodes(node, (child) => {
    if (child.type === 'return_statement') {
      returns.push(child);
    }
  });

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
    java: ['switch_expression'],
  };

  const types = switchTypes[lang];
  if (!types) return issues;

  visitNodes(tree.rootNode, (node) => {
    if (!types.includes(node.type)) return;

    const body = node.childForFieldName('body');
    if (!body) return;

    const cases = collectSwitchCases(body, lang);
    for (let i = 0; i < cases.length; i++) {
      const caseNode = cases[i]!;
      const nextCase = cases[i + 1];

      // Skip default case at end
      if (!nextCase && caseNode.type.includes('default')) continue;

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

  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (
      child &&
      (child.type === 'switch_case' ||
        child.type === 'switch_default' ||
        child.type === 'case_statement' ||
        child.type === 'default_case')
    ) {
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

    // Skip label (case x:)
    if (child.type.includes('label') || child.type === ':') continue;

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
    if (child.type.includes('label') || child.type === ':') continue;
    if (isStatementNode(child)) {
      hasStatements = true;
      break;
    }
  }

  return !hasStatements;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a block node is empty (no statements, only comments allowed).
 */
function isEmptyBlock(node: Node): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    // Skip punctuation and comments
    if (child.type === '{' || child.type === '}') continue;
    if (child.type === 'comment' || child.type === 'line_comment' || child.type === 'block_comment') continue;
    if (child.type === ':') continue;

    // Any other node means non-empty
    return false;
  }
  return true;
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
