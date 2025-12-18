import fs from 'node:fs/promises';
import path from 'node:path';
import { type BundleFacts } from './facts.js';
import { type LLMAnalysisResult } from './llm-analysis.js';

export type ValidationResult = {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  confidence: 'high' | 'medium' | 'low';
};

export type ValidationError = {
  type: 'file-not-found' | 'dependency-mismatch' | 'hallucination' | 'invalid-evidence';
  message: string;
  location?: string;
};

export type ValidationWarning = {
  type: 'weak-evidence' | 'speculation' | 'incomplete' | 'hallucination';
  message: string;
  location?: string;
};

/**
 * Check if a file path exists in the bundle
 */
async function validateFilePath(
  bundleRoot: string,
  filePath: string
): Promise<boolean> {
  try {
    const fullPath = path.join(bundleRoot, filePath);
    await fs.access(fullPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate evidence pointers in analysis
 */
async function validateEvidencePointers(
  bundleRoot: string,
  analysis: LLMAnalysisResult,
  errors: ValidationError[]
): Promise<void> {
  // Validate architecture evidence
  if (analysis.architecture?.keyComponents) {
    for (const comp of analysis.architecture.keyComponents) {
      if (comp.evidence) {
        // Extract file path from evidence (format: "file:line" or "Top-level directory: name")
        const match = comp.evidence.match(/^([^:]+)(?::\d+)?$/);
        if (match && match[1] && !match[1].includes('Top-level directory')) {
          const filePath = match[1].trim();
          const exists = await validateFilePath(bundleRoot, filePath);
          if (!exists) {
            errors.push({
              type: 'file-not-found',
              message: `Evidence file not found: ${filePath}`,
              location: `architecture.keyComponents["${comp.name}"]`,
            });
          }
        }
      }
    }
  }
}

/**
 * Validate dependencies match facts
 */
function validateDependencies(
  facts: BundleFacts,
  analysis: LLMAnalysisResult,
  errors: ValidationError[]
): void {
  if (!analysis.architecture?.technicalStack?.frameworks) {
    return;
  }

  const claimedFrameworks = analysis.architecture.technicalStack.frameworks;
  const actualFrameworks = facts.frameworks;
  const actualDeps = [
    ...facts.dependencies.runtime.map((d) => d.name.toLowerCase()),
    ...facts.dependencies.dev.map((d) => d.name.toLowerCase()),
  ];

  for (const framework of claimedFrameworks) {
    const frameworkLower = framework.toLowerCase();
    
    // Check if framework is in facts.frameworks or dependencies
    const inFactsFrameworks = actualFrameworks.some(
      (f) => f.toLowerCase() === frameworkLower
    );
    const inDeps = actualDeps.some((dep) => dep.includes(frameworkLower));

    if (!inFactsFrameworks && !inDeps) {
      errors.push({
        type: 'dependency-mismatch',
        message: `Framework "${framework}" not found in dependencies or detected frameworks`,
        location: 'architecture.technicalStack.frameworks',
      });
    }
  }
}

/**
 * Detect hallucinations (invented information)
 */
function detectHallucinations(
  facts: BundleFacts,
  analysis: LLMAnalysisResult,
  errors: ValidationError[],
  warnings: ValidationWarning[]
): void {
  // Check for suspiciously specific claims without evidence
  if (analysis.architecture?.keyComponents) {
    for (const comp of analysis.architecture.keyComponents) {
      if (!comp.evidence || comp.evidence.includes('unknown')) {
        warnings.push({
          type: 'weak-evidence',
          message: `Component "${comp.name}" has weak or missing evidence`,
          location: 'architecture.keyComponents',
        });
      }
    }
  }

  // Check for package manager mismatch
  if (analysis.usage?.installation) {
    const installSteps = analysis.usage.installation.steps || [];
    const claimedManager = installSteps.some((s: string) => s.includes('npm'))
      ? 'npm'
      : installSteps.some((s: string) => s.includes('pip'))
        ? 'pip'
        : installSteps.some((s: string) => s.includes('go'))
          ? 'go'
          : 'unknown';

    if (
      claimedManager !== 'unknown' &&
      facts.dependencies.manager !== 'unknown' &&
      claimedManager !== facts.dependencies.manager
    ) {
      errors.push({
        type: 'hallucination',
        message: `Installation uses ${claimedManager} but package manager is ${facts.dependencies.manager}`,
        location: 'usage.installation',
      });
    }
  }

  // Check for entry point mismatch
  if (analysis.usage?.quickStart?.mainEntryPoint) {
    const claimedEntry = analysis.usage.quickStart.mainEntryPoint;
    const actualEntries = facts.entryPoints.map((ep) => ep.file);

    if (claimedEntry !== 'unknown' && !actualEntries.some((ep) => ep.includes(claimedEntry))) {
      const similar = actualEntries.some((ep) =>
        ep.toLowerCase().includes(claimedEntry.toLowerCase()) ||
        claimedEntry.toLowerCase().includes(ep.toLowerCase())
      );

      if (!similar) {
        warnings.push({
          type: 'hallucination',
          message: `Claimed entry point "${claimedEntry}" does not match any actual entry points`,
          location: 'usage.quickStart.mainEntryPoint',
        });
      }
    }
  }

  // Check for invented environment variables
  if (analysis.configuration?.environmentVariables) {
    for (const envVar of analysis.configuration.environmentVariables) {
      if (!envVar.evidence || envVar.evidence === 'unknown') {
        warnings.push({
          type: 'speculation',
          message: `Environment variable "${envVar.name}" suggested without clear evidence`,
          location: 'configuration.environmentVariables',
        });
      }
    }
  }
}

/**
 * Calculate confidence score
 */
function calculateConfidence(
  errors: ValidationError[],
  warnings: ValidationWarning[]
): 'high' | 'medium' | 'low' {
  if (errors.length > 0) {
    return 'low';
  }

  if (warnings.length === 0) {
    return 'high';
  }

  if (warnings.length <= 2) {
    return 'medium';
  }

  return 'low';
}

/**
 * Validate analysis result against facts
 */
export async function validateAnalysis(
  bundleRoot: string,
  facts: BundleFacts,
  analysis: LLMAnalysisResult
): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Skip validation for fallback provider (already safe)
  if (analysis.provider === 'fallback') {
    return {
      valid: true,
      errors: [],
      warnings: [],
      confidence: 'high',
    };
  }

  // Validate evidence pointers
  await validateEvidencePointers(bundleRoot, analysis, errors);

  // Validate dependencies
  validateDependencies(facts, analysis, errors);

  // Detect hallucinations
  detectHallucinations(facts, analysis, errors, warnings);

  // Calculate confidence
  const confidence = calculateConfidence(errors, warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    confidence,
  };
}

/**
 * Format validation result as readable text
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];

  lines.push(`\n=== Validation Result ===`);
  lines.push(`Valid: ${result.valid ? '✅ Yes' : '❌ No'}`);
  lines.push(`Confidence: ${result.confidence.toUpperCase()}`);
  lines.push('');

  if (result.errors.length > 0) {
    lines.push(`Errors (${result.errors.length}):`);
    for (const error of result.errors) {
      lines.push(`  ❌ [${error.type}] ${error.message}`);
      if (error.location) {
        lines.push(`     Location: ${error.location}`);
      }
    }
    lines.push('');
  }

  if (result.warnings.length > 0) {
    lines.push(`Warnings (${result.warnings.length}):`);
    for (const warning of result.warnings) {
      lines.push(`  ⚠️  [${warning.type}] ${warning.message}`);
      if (warning.location) {
        lines.push(`     Location: ${warning.location}`);
      }
    }
    lines.push('');
  }

  if (result.valid && result.errors.length === 0 && result.warnings.length === 0) {
    lines.push('✅ All checks passed!');
  }

  return lines.join('\n');
}

/**
 * Apply validation corrections to analysis
 */
export function applyValidationCorrections(
  analysis: LLMAnalysisResult,
  validation: ValidationResult
): LLMAnalysisResult {
  const corrected = { ...analysis };

  // Add validation metadata
  corrected.validation = {
    confidence: validation.confidence,
    errors: validation.errors.length,
    warnings: validation.warnings.length,
  };

  // If validation failed, mark as low confidence
  if (!validation.valid) {
    if (corrected.configuration) {
      corrected.configuration.confidence = 'low';
    }
  }

  return corrected;
}
