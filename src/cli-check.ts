#!/usr/bin/env node
/**
 * Simple CLI for running preflight checks.
 * Used by npm scripts for automated quality checks.
 */

import { runChecks, type CheckType } from './analysis/check/index.js';

async function main() {
  const args = process.argv.slice(2);
  
  // Parse arguments
  let targetPath = '.';
  let checks: CheckType[] = ['security', 'circular'];
  let failOn: 'error' | 'warning' | 'none' = 'error';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--checks' && args[i + 1]) {
      checks = args[i + 1]!.split(',') as CheckType[];
      i++;
    } else if (arg === '--fail-on' && args[i + 1]) {
      failOn = args[i + 1] as 'error' | 'warning' | 'none';
      i++;
    } else if (!arg?.startsWith('--')) {
      targetPath = arg!;
    }
  }

  console.error(`[preflight-check] Running checks: ${checks.join(', ')}`);
  console.error(`[preflight-check] Target: ${targetPath}`);

  try {
    const result = await runChecks(targetPath, { checks });

    // Summary
    const { summary } = result;
    console.error(`\n[preflight-check] Results:`);
    console.error(`  Total issues: ${result.totalIssues}`);
    console.error(`  Errors: ${summary.issuesBySeverity.error}`);
    console.error(`  Warnings: ${summary.issuesBySeverity.warning}`);

    // Determine exit code
    if (failOn === 'error' && summary.issuesBySeverity.error > 0) {
      console.error(`\n[preflight-check] FAILED: ${summary.issuesBySeverity.error} error(s) found`);
      process.exit(1);
    }
    if (failOn === 'warning' && (summary.issuesBySeverity.error > 0 || summary.issuesBySeverity.warning > 0)) {
      console.error(`\n[preflight-check] FAILED: issues found`);
      process.exit(1);
    }

    console.error(`\n[preflight-check] PASSED`);
    process.exit(0);
  } catch (err) {
    console.error(`[preflight-check] Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
