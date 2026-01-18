/**
 * Documentation Check Tool - Check documentation-code consistency.
 * @module tools/doccheck
 */
import * as z from 'zod';
import * as path from 'node:path';
import { checkDocumentation, type DocCheckResult, type DocIssue } from '../analysis/doccheck/index.js';

export const DocCheckInputSchema = {
  path: z.string().describe('Absolute path to file or directory to check'),
  onlyExported: z.boolean().optional().default(true).describe('Only check exported/public functions (default: true)'),
  requireDocs: z.boolean().optional().default(false).describe('Require documentation for all exported functions (default: false)'),
  checkParamTypes: z.boolean().optional().default(false).describe('Check parameter types match (default: false)'),
  pythonStyle: z.enum(['google', 'numpy', 'sphinx']).optional().default('google').describe('Python docstring style (default: google)'),
};

export type DocCheckInput = {
  path: string;
  onlyExported?: boolean;
  requireDocs?: boolean;
  checkParamTypes?: boolean;
  pythonStyle?: 'google' | 'numpy' | 'sphinx';
};

export type DocCheckOutput = {
  success: boolean;
  result?: string;
  data?: DocCheckResult;
  error?: string;
};

export const doccheckToolDescription = `Check documentation-code consistency for TypeScript/JavaScript (JSDoc) and Python (docstrings).

Detects issues such as:
- Parameters in code but not documented
- Documented parameters that don't exist
- Missing @returns/@return documentation
- Documentation for non-existent return values

Supported languages: TypeScript, JavaScript, Python
Python docstring styles: Google (default), NumPy, Sphinx

Example usage:
- Check a directory: path="/home/user/project/src"
- Check a single file: path="/home/user/project/main.py"`;

/**
 * Format issues for display.
 */
function formatIssues(issues: DocIssue[]): string {
  if (issues.length === 0) {
    return 'No documentation issues found.';
  }

  const lines: string[] = [];

  // Group by file
  const byFile = new Map<string, DocIssue[]>();
  for (const issue of issues) {
    const existing = byFile.get(issue.file) || [];
    existing.push(issue);
    byFile.set(issue.file, existing);
  }

  for (const [file, fileIssues] of byFile) {
    lines.push(`\n📄 ${file}`);

    for (const issue of fileIssues) {
      const icon = issue.severity === 'error' ? '❌' : issue.severity === 'warning' ? '⚠️' : 'ℹ️';
      lines.push(`  ${icon} Line ${issue.line}: ${issue.message}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format summary for display.
 */
function formatSummary(result: DocCheckResult): string {
  const { summary } = result;
  const lines: string[] = [];

  lines.push('📊 Documentation Check Summary');
  lines.push(`   Files checked: ${summary.totalFiles}`);
  lines.push(`   Functions checked: ${summary.totalFunctions}`);
  lines.push(`   Functions documented: ${summary.documentedFunctions} (${summary.coveragePercent}%)`);

  const totalIssues = result.issues.length;
  if (totalIssues > 0) {
    lines.push(`\n   Issues found: ${totalIssues}`);
    if (summary.issuesBySeverity.error > 0) {
      lines.push(`     ❌ Errors: ${summary.issuesBySeverity.error}`);
    }
    if (summary.issuesBySeverity.warning > 0) {
      lines.push(`     ⚠️ Warnings: ${summary.issuesBySeverity.warning}`);
    }
    if (summary.issuesBySeverity.info > 0) {
      lines.push(`     ℹ️ Info: ${summary.issuesBySeverity.info}`);
    }
  } else {
    lines.push('\n   ✅ No issues found!');
  }

  return lines.join('\n');
}

/**
 * Create the doccheck handler function.
 */
export function createDocCheckHandler() {
  return async (input: DocCheckInput): Promise<DocCheckOutput> => {
    try {
      const targetPath = path.resolve(input.path);

      const result = await checkDocumentation(targetPath, {
        onlyExported: input.onlyExported ?? true,
        requireDocs: input.requireDocs ?? false,
        checkParamTypes: input.checkParamTypes ?? false,
        pythonStyle: input.pythonStyle ?? 'google',
      });

      const summaryText = formatSummary(result);
      const issuesText = formatIssues(result.issues);
      const resultText = `${summaryText}\n${issuesText}`;

      return {
        success: true,
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
