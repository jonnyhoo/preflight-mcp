/**
 * Unified Code Check Tool - Check code quality across multiple dimensions.
 * @module tools/check
 */
import * as z from 'zod';
import * as path from 'node:path';
import {
  runChecks,
  type UnifiedCheckResult,
  type CheckType,
  type SingleCheckResult,
  ALL_CHECK_TYPES,
} from '../analysis/check/index.js';

// ============================================================================
// Schema & Types
// ============================================================================

export const CheckInputSchema = {
  path: z.string().describe('Absolute path to file or directory to check'),
  checks: z
    .array(z.enum(['duplicates', 'doccheck', 'deadcode', 'circular', 'complexity', 'errorprone', 'security']))
    .optional()
    .default(['duplicates', 'doccheck', 'deadcode', 'circular', 'complexity', 'errorprone', 'security'])
    .describe('Checks to run (default: all). Options: duplicates, doccheck, deadcode, circular, complexity, errorprone, security'),
};

export type CheckInput = {
  path: string;
  checks?: CheckType[];
};

export type CheckOutput = {
  success: boolean;
  result?: string;
  data?: UnifiedCheckResult;
  error?: string;
};

// ============================================================================
// Tool Description
// ============================================================================

export const checkToolDescription = `Run code quality checks on a project directory.

Available checks:
- **duplicates**: Detect copy-paste code patterns (150+ languages via jscpd)
- **doccheck**: Check documentation-code consistency (TypeScript, JavaScript, Python, Java)
- **deadcode**: Detect unused/orphaned files and exports
- **circular**: Detect circular import dependencies
- **complexity**: Detect high complexity functions (long functions, deep nesting, many params)
- **errorprone**: Detect error-prone patterns (null checks, type coercion, async issues)
- **security**: Detect security vulnerabilities (hardcoded secrets, injection risks, unsafe patterns)

Severity levels:
- ❌ Error: Critical issues that should be fixed
- ⚠️ Warning: Issues that may cause problems
- ℹ️ Info: Suggestions for improvement

Example usage:
- Check all: path="/home/user/project"
- Check specific: path="/home/user/project", checks=["deadcode", "circular"]
- Security scan: path="/home/user/project", checks=["security", "errorprone"]`;

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format unified result for display.
 */
function formatResult(result: UnifiedCheckResult): string {
  const lines: string[] = [];

  // Overall summary
  lines.push('📊 Code Quality Check Summary');
  lines.push(`   Total issues: ${result.totalIssues}`);

  if (result.summary.issuesBySeverity.error > 0) {
    lines.push(`   ❌ Errors: ${result.summary.issuesBySeverity.error}`);
  }
  if (result.summary.issuesBySeverity.warning > 0) {
    lines.push(`   ⚠️ Warnings: ${result.summary.issuesBySeverity.warning}`);
  }
  if (result.summary.issuesBySeverity.info > 0) {
    lines.push(`   ℹ️ Info: ${result.summary.issuesBySeverity.info}`);
  }

  if (result.totalIssues === 0) {
    lines.push('\n   ✅ No issues found!');
    return lines.join('\n');
  }

  // Per-check results
  for (const [checkType, checkResult] of Object.entries(result.checks)) {
    if (!checkResult) continue;

    const issueCount = checkResult.issues.length;
    if (issueCount === 0) continue;

    const icon = getCheckIcon(checkType as CheckType);
    lines.push(`\n${icon} ${formatCheckName(checkType as CheckType)} (${issueCount} issues)`);

    // Group issues by file
    const byFile = new Map<string, typeof checkResult.issues>();
    for (const issue of checkResult.issues) {
      const existing = byFile.get(issue.file) || [];
      existing.push(issue);
      byFile.set(issue.file, existing);
    }

    // Show up to 10 issues per check
    let shown = 0;
    const maxPerCheck = 10;

    for (const [file, fileIssues] of byFile) {
      if (shown >= maxPerCheck) {
        lines.push(`   ... and ${issueCount - shown} more issues`);
        break;
      }

      lines.push(`\n   📄 ${path.basename(file)}`);

      for (const issue of fileIssues.slice(0, maxPerCheck - shown)) {
        const severityIcon = issue.severity === 'error' ? '❌' : issue.severity === 'warning' ? '⚠️' : 'ℹ️';
        lines.push(`      ${severityIcon} Line ${issue.line}: ${issue.message}`);
        shown++;
      }
    }
  }

  return lines.join('\n');
}

/**
 * Get icon for check type.
 */
function getCheckIcon(checkType: CheckType): string {
  switch (checkType) {
    case 'duplicates':
      return '📋';
    case 'doccheck':
      return '📝';
    case 'deadcode':
      return '🧹';
    case 'circular':
      return '🔄';
    case 'complexity':
      return '🔥';
    case 'errorprone':
      return '⚠️';
    case 'security':
      return '🔒';
    default:
      return '🔍';
  }
}

/**
 * Format check name for display.
 */
function formatCheckName(checkType: CheckType): string {
  switch (checkType) {
    case 'duplicates':
      return 'Code Duplication';
    case 'doccheck':
      return 'Documentation';
    case 'deadcode':
      return 'Dead Code';
    case 'circular':
      return 'Circular Dependencies';
    case 'complexity':
      return 'Complexity Hotspots';
    case 'errorprone':
      return 'Error-Prone Patterns';
    case 'security':
      return 'Security Issues';
    default:
      return checkType;
  }
}

// ============================================================================
// Handler
// ============================================================================

/**
 * Create the check handler function.
 */
export function createCheckHandler() {
  return async (input: CheckInput): Promise<CheckOutput> => {
    try {
      const targetPath = path.resolve(input.path);
      const checks = input.checks ?? ALL_CHECK_TYPES;

      const result = await runChecks(targetPath, { checks });

      const resultText = formatResult(result);

      return {
        success: result.success,
        result: resultText,
        data: result,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: msg,
      };
    }
  };
}
