/**
 * Report validation for EDDA.
 * Validates claims and evidence chains to ensure auditability.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { type Claim, type EvidenceRef } from '../types/evidence.js';

export type ValidationSeverity = 'error' | 'warning' | 'info';

export type ValidationIssue = {
  severity: ValidationSeverity;
  code: string;
  message: string;
  claimId?: string;
  evidenceIndex?: number;
  file?: string;
};

export type ClaimValidationResult = {
  claimId: string;
  valid: boolean;
  issues: ValidationIssue[];
  evidenceChecks: Array<{
    evidenceIndex: number;
    fileExists: boolean;
    snippetVerified: boolean | null; // null if no snippet to verify
    lineRangeValid: boolean;
  }>;
};

export type ValidateReportInput = {
  bundleId: string;
  claims: Claim[];
  options?: {
    verifySnippets?: boolean;
    verifyFileExists?: boolean;
    strictMode?: boolean;
  };
};

export type ValidateReportResult = {
  bundleId: string;
  totalClaims: number;
  validClaims: number;
  invalidClaims: number;
  issues: ValidationIssue[];
  claimResults: ClaimValidationResult[];
  summary: string;
  passed: boolean;
};

/**
 * Compute SHA256 hash of a string.
 */
function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Check if a file exists.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read lines from a file.
 */
async function readFileLines(
  filePath: string,
  startLine: number,
  endLine: number
): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n');
    const selected = lines.slice(startLine - 1, endLine);
    return selected.join('\n');
  } catch {
    return null;
  }
}

/**
 * Validate a single claim.
 */
async function validateClaim(
  claim: Claim,
  bundleRoot: string,
  options: {
    verifySnippets?: boolean;
    verifyFileExists?: boolean;
  }
): Promise<ClaimValidationResult> {
  const issues: ValidationIssue[] = [];
  const evidenceChecks: ClaimValidationResult['evidenceChecks'] = [];

  // Basic claim validation
  if (!claim.id) {
    issues.push({
      severity: 'error',
      code: 'MISSING_CLAIM_ID',
      message: 'Claim is missing required id field',
    });
  }

  if (!claim.text || claim.text.trim().length === 0) {
    issues.push({
      severity: 'error',
      code: 'EMPTY_CLAIM_TEXT',
      message: 'Claim text is empty',
      claimId: claim.id,
    });
  }

  if (claim.confidence < 0 || claim.confidence > 1) {
    issues.push({
      severity: 'error',
      code: 'INVALID_CONFIDENCE',
      message: `Confidence ${claim.confidence} is out of range [0, 1]`,
      claimId: claim.id,
    });
  }

  // Status-specific validation
  if (claim.status === 'unknown' && !claim.whyInferred) {
    issues.push({
      severity: 'warning',
      code: 'MISSING_WHY_UNKNOWN',
      message: 'Claim with status "unknown" should have whyInferred explanation',
      claimId: claim.id,
    });
  }

  if (claim.status === 'inferred' && !claim.whyInferred) {
    issues.push({
      severity: 'warning',
      code: 'MISSING_WHY_INFERRED',
      message: 'Claim with status "inferred" should have whyInferred explanation',
      claimId: claim.id,
    });
  }

  // Evidence validation
  if (claim.status === 'supported' && claim.evidence.length === 0) {
    issues.push({
      severity: 'error',
      code: 'SUPPORTED_NO_EVIDENCE',
      message: 'Claim marked as "supported" has no evidence',
      claimId: claim.id,
    });
  }

  // Validate each evidence reference
  for (let i = 0; i < claim.evidence.length; i++) {
    const ev = claim.evidence[i]!;
    const check: ClaimValidationResult['evidenceChecks'][0] = {
      evidenceIndex: i,
      fileExists: false,
      snippetVerified: null,
      lineRangeValid: true,
    };

    // Check file reference
    if (!ev.file) {
      issues.push({
        severity: 'error',
        code: 'MISSING_EVIDENCE_FILE',
        message: `Evidence ${i} is missing file reference`,
        claimId: claim.id,
        evidenceIndex: i,
      });
    } else if (options.verifyFileExists) {
      const fullPath = path.join(bundleRoot, ev.file);
      check.fileExists = await fileExists(fullPath);
      if (!check.fileExists) {
        issues.push({
          severity: 'error',
          code: 'FILE_NOT_FOUND',
          message: `Evidence file not found: ${ev.file}`,
          claimId: claim.id,
          evidenceIndex: i,
          file: ev.file,
        });
      }
    }

    // Check line range validity
    if (ev.range) {
      if (ev.range.startLine > ev.range.endLine) {
        check.lineRangeValid = false;
        issues.push({
          severity: 'error',
          code: 'INVALID_LINE_RANGE',
          message: `Invalid line range: start (${ev.range.startLine}) > end (${ev.range.endLine})`,
          claimId: claim.id,
          evidenceIndex: i,
          file: ev.file,
        });
      }
      if (ev.range.startLine < 1 || ev.range.endLine < 1) {
        check.lineRangeValid = false;
        issues.push({
          severity: 'error',
          code: 'INVALID_LINE_NUMBER',
          message: 'Line numbers must be >= 1',
          claimId: claim.id,
          evidenceIndex: i,
          file: ev.file,
        });
      }
    }

    // Verify snippet hash if provided
    if (options.verifySnippets && ev.snippet && ev.snippetSha256) {
      const computedHash = sha256(ev.snippet);
      check.snippetVerified = computedHash === ev.snippetSha256;
      if (!check.snippetVerified) {
        issues.push({
          severity: 'error',
          code: 'SNIPPET_HASH_MISMATCH',
          message: 'Snippet hash does not match content',
          claimId: claim.id,
          evidenceIndex: i,
          file: ev.file,
        });
      }
    }

    evidenceChecks.push(check);
  }

  const hasErrors = issues.some(i => i.severity === 'error');

  return {
    claimId: claim.id,
    valid: !hasErrors,
    issues,
    evidenceChecks,
  };
}

/**
 * Validate a report containing claims with evidence.
 */
export async function validateReport(
  bundleRoot: string,
  input: ValidateReportInput
): Promise<ValidateReportResult> {
  const options = {
    verifySnippets: input.options?.verifySnippets ?? true,
    verifyFileExists: input.options?.verifyFileExists ?? true,
  };

  const claimResults: ClaimValidationResult[] = [];
  const allIssues: ValidationIssue[] = [];

  // Validate each claim
  for (const claim of input.claims) {
    const result = await validateClaim(claim, bundleRoot, options);
    claimResults.push(result);
    allIssues.push(...result.issues);
  }

  const validClaims = claimResults.filter(r => r.valid).length;
  const invalidClaims = claimResults.filter(r => !r.valid).length;

  const errorCount = allIssues.filter(i => i.severity === 'error').length;
  const warningCount = allIssues.filter(i => i.severity === 'warning').length;

  // Build summary
  const summaryParts: string[] = [];
  summaryParts.push(`## Validation Report`);
  summaryParts.push(`- Total claims: ${input.claims.length}`);
  summaryParts.push(`- Valid: ${validClaims}`);
  summaryParts.push(`- Invalid: ${invalidClaims}`);
  summaryParts.push(`- Errors: ${errorCount}`);
  summaryParts.push(`- Warnings: ${warningCount}`);
  summaryParts.push('');

  if (errorCount > 0) {
    summaryParts.push(`### Errors`);
    for (const issue of allIssues.filter(i => i.severity === 'error').slice(0, 10)) {
      summaryParts.push(`- [${issue.code}] ${issue.message}`);
    }
    if (errorCount > 10) {
      summaryParts.push(`... and ${errorCount - 10} more errors`);
    }
  }

  const passed = errorCount === 0 && (input.options?.strictMode ? warningCount === 0 : true);

  return {
    bundleId: input.bundleId,
    totalClaims: input.claims.length,
    validClaims,
    invalidClaims,
    issues: allIssues,
    claimResults,
    summary: summaryParts.join('\n'),
    passed,
  };
}
