/**
 * Code Duplication Check Tool - Detect copy-paste patterns.
 * @module tools/duplicates
 */
import * as z from 'zod';
import * as path from 'node:path';
import { checkDuplicates, type DuplicateCheckResult, type DuplicateIssue } from '../analysis/duplicates/index.js';

export const DuplicatesInputSchema = {
  path: z.string().describe('Absolute path to file or directory to check'),
  minLines: z.number().optional().default(5).describe('Minimum lines for duplication (default: 5)'),
  minTokens: z.number().optional().default(50).describe('Minimum tokens for duplication (default: 50)'),
  threshold: z.number().optional().default(10).describe('Fail threshold percentage (default: 10)'),
  mode: z.enum(['strict', 'mild', 'weak']).optional().default('mild').describe('Detection mode (default: mild)'),
  formats: z.array(z.string()).optional().describe('Specific formats to check (e.g., ["python", "typescript"])'),
};

export type DuplicatesInput = {
  path: string;
  minLines?: number;
  minTokens?: number;
  threshold?: number;
  mode?: 'strict' | 'mild' | 'weak';
  formats?: string[];
};

export type DuplicatesOutput = {
  success: boolean;
  result?: string;
  data?: DuplicateCheckResult;
  error?: string;
};

export const duplicatesToolDescription = `Detect duplicated (copy-paste) code patterns in source files.

Uses jscpd engine supporting 150+ programming languages including:
Python, TypeScript, JavaScript, Java, C/C++, Go, Rust, Ruby, PHP, etc.

Detection modes:
- strict: All symbols as tokens, highest sensitivity
- mild: Skip newlines/empty symbols (default)
- weak: Also skip comments, lowest sensitivity

Severity based on duplication size:
- 50+ lines: Error
- 20-50 lines: Warning
- <20 lines: Info

Example usage:
- Check a directory: path="/home/user/project/src"
- Check with format filter: path="/project", formats=["python"]
- Strict mode: path="/project", mode="strict", minLines=3`;

/**
 * Format issues for display.
 */
function formatIssues(issues: DuplicateIssue[]): string {
  if (issues.length === 0) {
    return 'No code duplications found.';
  }

  const lines: string[] = [];

  // Group by file
  const byFile = new Map<string, DuplicateIssue[]>();
  for (const issue of issues) {
    const existing = byFile.get(issue.file) || [];
    existing.push(issue);
    byFile.set(issue.file, existing);
  }

  for (const [file, fileIssues] of byFile) {
    lines.push(`\n📄 ${file}`);

    for (const issue of fileIssues) {
      const icon = issue.severity === 'error' ? '❌' : issue.severity === 'warning' ? '⚠️' : 'ℹ️';
      lines.push(`  ${icon} Lines ${issue.lineRange}: ${issue.message}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format summary for display.
 */
function formatSummary(result: DuplicateCheckResult): string {
  const { summary } = result;
  const lines: string[] = [];

  lines.push('📊 Code Duplication Summary');
  lines.push(`   Files with duplications: ${summary.totalFiles}`);
  lines.push(`   Total clone pairs: ${summary.totalClones}`);
  lines.push(`   Total duplicated lines: ${summary.duplicatedLines}`);

  // Show formats breakdown if multiple
  const formats = Object.entries(summary.clonesByFormat);
  if (formats.length > 0) {
    lines.push('\n   By format:');
    for (const [format, count] of formats) {
      lines.push(`     ${format}: ${count} clones`);
    }
  }

  const totalIssues = result.issues.length;
  if (totalIssues > 0) {
    lines.push(`\n   Issues found: ${totalIssues}`);
    if (summary.issuesBySeverity.error > 0) {
      lines.push(`     ❌ Errors (50+ lines): ${summary.issuesBySeverity.error}`);
    }
    if (summary.issuesBySeverity.warning > 0) {
      lines.push(`     ⚠️ Warnings (20-50 lines): ${summary.issuesBySeverity.warning}`);
    }
    if (summary.issuesBySeverity.info > 0) {
      lines.push(`     ℹ️ Info (<20 lines): ${summary.issuesBySeverity.info}`);
    }
  } else {
    lines.push('\n   ✅ No duplications found!');
  }

  return lines.join('\n');
}

/**
 * Create the duplicates handler function.
 */
export function createDuplicatesHandler() {
  return async (input: DuplicatesInput): Promise<DuplicatesOutput> => {
    try {
      const targetPath = path.resolve(input.path);

      const result = await checkDuplicates(targetPath, {
        minLines: input.minLines ?? 5,
        minTokens: input.minTokens ?? 50,
        threshold: input.threshold ?? 10,
        mode: input.mode ?? 'mild',
        formats: input.formats,
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
