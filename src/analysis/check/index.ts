/**
 * Unified Code Check Module
 *
 * Provides unified interface for all code quality checks:
 * - duplicates: Copy-paste code detection (jscpd)
 * - doccheck: Documentation-code consistency
 * - deadcode: Unused code detection
 * - circular: Circular dependency detection
 * - complexity: Code complexity hotspots
 *
 * @module analysis/check
 */

import * as path from 'node:path';

import { createModuleLogger } from '../../logging/logger.js';
import { checkDocumentation } from '../doccheck/index.js';
import { checkDuplicates } from '../duplicates/index.js';
import { AnalysisContext } from '../cache/index.js';
import { checkDeadCode } from './deadcode/index.js';
import { checkCircular } from './circular/index.js';
import { checkComplexity } from './complexity/index.js';
import { checkErrorProne } from './errorprone/index.js';
import { checkSecurity } from './security/index.js';
import type {
  CheckType,
  CheckOptions,
  CheckSeverity,
  SingleCheckResult,
  UnifiedCheckResult,
  BaseCheckIssue,
} from './types.js';
import { ALL_CHECK_TYPES, DEFAULT_CHECK_OPTIONS } from './types.js';

// ============================================================================
// Re-exports
// ============================================================================

export * from './types.js';
export { checkDeadCode } from './deadcode/index.js';
export { checkCircular } from './circular/index.js';
export { checkComplexity } from './complexity/index.js';
export { checkErrorProne } from './errorprone/index.js';
export { checkSecurity } from './security/index.js';

const logger = createModuleLogger('check');

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Run multiple code quality checks on a directory.
 */
export async function runChecks(
  targetPath: string,
  options?: Partial<CheckOptions>
): Promise<UnifiedCheckResult> {
  const opts = mergeOptions(options);
  const resolvedPath = path.resolve(targetPath);
  const checksToRun = opts.checks;

  logger.info(`Running checks on: ${resolvedPath}`);
  logger.info(`Checks: ${checksToRun.join(', ')}`);

  // Create analysis context for shared caching
  const context = new AnalysisContext({
    rootPath: resolvedPath,
    excludePatterns: opts.excludePatterns,
  });

  const result: UnifiedCheckResult = {
    success: true,
    checks: {},
    skipped: {},
    totalIssues: 0,
    summary: {
      totalFiles: 0,
      issuesByCheck: {},
      issuesBySeverity: { error: 0, warning: 0, info: 0 },
    },
  };

  // Track unique files across all checks
  const allFiles = new Set<string>();

  try {
    // Run each check
    for (const checkType of checksToRun) {
      try {
        const checkResult = await runSingleCheck(checkType, resolvedPath, opts, context);
        result.checks[checkType] = checkResult;

        if (!checkResult.success) {
          result.success = false;
        }

        // Aggregate stats
        result.summary.issuesByCheck[checkType] = checkResult.issues.length;
        result.totalIssues += checkResult.issues.length;

        for (const issue of checkResult.issues) {
          result.summary.issuesBySeverity[issue.severity]++;
          allFiles.add(issue.file);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Check ${checkType} failed: ${msg}`);
        result.checks[checkType] = {
          type: checkType,
          success: false,
          issues: [],
          summary: { totalFiles: 0, totalIssues: 0, issuesBySeverity: { error: 0, warning: 0, info: 0 } },
          error: msg,
        };
        result.success = false;
      }
    }

    result.summary.totalFiles = allFiles.size;

    // Log cache statistics
    const stats = context.stats();
    logger.info(`Cache stats: AST hits=${stats.astCache.hits}, misses=${stats.astCache.misses}`);

    return result;
  } finally {
    // Always dispose the context to release resources
    context.dispose();
  }
}

// ============================================================================
// Single Check Execution
// ============================================================================

/**
 * Run a single check.
 */
async function runSingleCheck(
  checkType: CheckType,
  targetPath: string,
  options: Required<CheckOptions>,
  context: AnalysisContext
): Promise<SingleCheckResult> {
  switch (checkType) {
    case 'duplicates':
      return runDuplicatesCheck(targetPath, options);

    case 'doccheck':
      return runDocCheck(targetPath, options, context);

    case 'deadcode':
      return checkDeadCode(targetPath, options.deadcode, options.excludePatterns, context);

    case 'circular':
      return checkCircular(targetPath, options.circular, options.excludePatterns);

    case 'complexity':
      return checkComplexity(targetPath, options.complexity, options.excludePatterns, context);

    case 'errorprone':
      return checkErrorProne(targetPath, options.excludePatterns, context);

    case 'security':
      return checkSecurity(targetPath, options.excludePatterns, context, options.security);

    default:
      throw new Error(`Unknown check type: ${checkType}`);
  }
}

/**
 * Run duplicates check with adapter.
 */
async function runDuplicatesCheck(
  targetPath: string,
  options: Required<CheckOptions>
): Promise<SingleCheckResult> {
  const duplicatesResult = await checkDuplicates(targetPath, {
    minLines: options.duplicates.minLines,
    minTokens: options.duplicates.minTokens,
    threshold: options.duplicates.threshold,
    mode: options.duplicates.mode,
    formats: options.duplicates.formats,
    excludePatterns: options.excludePatterns,
  });

  // Convert to unified format
  const issues: BaseCheckIssue[] = duplicatesResult.issues.map((issue) => ({
    severity: issue.severity,
    file: issue.file,
    line: issue.lineRange,
    message: issue.message,
  }));

  return {
    type: 'duplicates',
    success: true,
    issues,
    summary: {
      totalFiles: duplicatesResult.summary.totalFiles,
      totalIssues: issues.length,
      issuesBySeverity: duplicatesResult.summary.issuesBySeverity,
    },
  };
}

/**
 * Run doccheck with adapter.
 */
async function runDocCheck(
  targetPath: string,
  options: Required<CheckOptions>,
  context: AnalysisContext
): Promise<SingleCheckResult> {
  const docResult = await checkDocumentation(
    targetPath,
    {
      onlyExported: options.doccheck.onlyExported,
      requireDocs: options.doccheck.requireDocs,
      checkParamTypes: options.doccheck.checkParamTypes,
      pythonStyle: options.doccheck.pythonStyle,
      excludePatterns: options.excludePatterns,
    },
    context
  );

  // Convert to unified format
  const issues: BaseCheckIssue[] = docResult.issues.map((issue) => ({
    severity: issue.severity,
    file: issue.file,
    line: String(issue.line),
    message: issue.message,
  }));

  return {
    type: 'doccheck',
    success: true,
    issues,
    summary: {
      totalFiles: docResult.summary.totalFiles,
      totalIssues: issues.length,
      issuesBySeverity: docResult.summary.issuesBySeverity,
    },
  };
}

// ============================================================================
// Options Merging
// ============================================================================

/**
 * Merge user options with defaults.
 */
function mergeOptions(options?: Partial<CheckOptions>): Required<CheckOptions> {
  return {
    checks: options?.checks ?? DEFAULT_CHECK_OPTIONS.checks,
    excludePatterns: options?.excludePatterns ?? DEFAULT_CHECK_OPTIONS.excludePatterns,
    deadcode: { ...DEFAULT_CHECK_OPTIONS.deadcode, ...options?.deadcode },
    circular: { ...DEFAULT_CHECK_OPTIONS.circular, ...options?.circular },
    complexity: { ...DEFAULT_CHECK_OPTIONS.complexity, ...options?.complexity },
    doccheck: { ...DEFAULT_CHECK_OPTIONS.doccheck, ...options?.doccheck },
    duplicates: { ...DEFAULT_CHECK_OPTIONS.duplicates, ...options?.duplicates },
    security: { ...DEFAULT_CHECK_OPTIONS.security, ...options?.security },
    // Phase 0: new rule configuration options
    rules: { ...DEFAULT_CHECK_OPTIONS.rules, ...options?.rules },
    categories: { ...DEFAULT_CHECK_OPTIONS.categories, ...options?.categories },
    suppressions: { ...DEFAULT_CHECK_OPTIONS.suppressions, ...options?.suppressions },
    semantics: { ...DEFAULT_CHECK_OPTIONS.semantics, ...options?.semantics },
  };
}
