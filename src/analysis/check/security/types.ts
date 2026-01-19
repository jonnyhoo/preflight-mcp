/**
 * Security Rules - Type Definitions
 *
 * Types for security-related code pattern detection.
 *
 * @module analysis/check/security/types
 */

import type { CheckSeverity, RuleCategory, RuleConfidence } from '../types.js';

// ============================================================================
// Rule Metadata
// ============================================================================

/**
 * Security rule identifier.
 */
export type SecurityRuleId = 'hardcoded-credentials' | 'insecure-random';

/**
 * Security rule metadata.
 */
export interface SecurityRuleMetadata {
  ruleId: SecurityRuleId;
  category: RuleCategory;
  languages: string[];
  confidence: RuleConfidence;
  defaultEnabled: boolean;
  requiresSemantics: boolean;
  severity: CheckSeverity;
  description: string;
}

/**
 * All security rules with metadata.
 */
export const SECURITY_RULES: SecurityRuleMetadata[] = [
  {
    ruleId: 'hardcoded-credentials',
    category: 'security',
    languages: ['javascript', 'typescript', 'tsx', 'python', 'java', 'go', 'rust'],
    confidence: 'medium',
    defaultEnabled: true,
    requiresSemantics: false,
    severity: 'warning',
    description: 'Potential hardcoded credential detected',
  },
  {
    ruleId: 'insecure-random',
    category: 'security',
    languages: ['javascript', 'typescript', 'tsx', 'java'],
    confidence: 'high',
    defaultEnabled: true,
    requiresSemantics: false,
    severity: 'warning',
    description: 'Insecure random number generator usage',
  },
];

/**
 * Get rule metadata by ID.
 */
export function getRuleMetadata(ruleId: SecurityRuleId): SecurityRuleMetadata | undefined {
  return SECURITY_RULES.find((r) => r.ruleId === ruleId);
}

/**
 * Check if a rule applies to a language.
 */
export function ruleAppliesToLanguage(ruleId: SecurityRuleId, lang: string): boolean {
  const rule = getRuleMetadata(ruleId);
  return rule ? rule.languages.includes(lang) : false;
}

// ============================================================================
// Credential Detection Patterns
// ============================================================================

/**
 * Variable/field name patterns that suggest credentials.
 */
export const CREDENTIAL_NAME_PATTERN =
  /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|auth[_-]?key|bearer|credential)/i;

/**
 * Placeholder patterns to exclude (false positives).
 */
export const PLACEHOLDER_PATTERNS = [
  /^changeme$/i,
  /^example/i,
  /^dummy/i,
  /^test(?:ing)?$/i,
  /^your[_-]/i,
  /^xxx+$/i,
  /^placeholder/i,
  /^\$\{/,
  /^\{\{/,
  /^<[^>]+>$/,
  /^TODO/i,
  /^FIXME/i,
  /^env\./i,
  /^process\.env/i,
  /^os\.environ/i,
  /^System\.getenv/i,
];

/**
 * Minimum string length for credential detection.
 */
export const MIN_CREDENTIAL_LENGTH = 8;

/**
 * Check if a string value looks like a real credential (not a placeholder).
 * @param value - The string value to check
 * @param customIgnorePatterns - Additional regex patterns to ignore
 */
export function looksLikeCredential(value: string, customIgnorePatterns?: RegExp[]): boolean {
  // Too short to be a real credential
  if (value.length < MIN_CREDENTIAL_LENGTH) return false;

  // Check against placeholder patterns
  if (PLACEHOLDER_PATTERNS.some((p) => p.test(value))) return false;

  // Check against custom ignore patterns
  if (customIgnorePatterns?.some((p) => p.test(value))) return false;

  // Simple character diversity check (at least 2 of: lowercase, uppercase, digits, symbols)
  let diversity = 0;
  if (/[a-z]/.test(value)) diversity++;
  if (/[A-Z]/.test(value)) diversity++;
  if (/[0-9]/.test(value)) diversity++;
  if (/[^a-zA-Z0-9]/.test(value)) diversity++;

  return diversity >= 2;
}

/**
 * Check if a variable name suggests a credential.
 * @param name - The variable/field name to check
 * @param customIgnorePatterns - Additional regex patterns to ignore
 */
export function isCredentialName(name: string, customIgnorePatterns?: RegExp[]): boolean {
  // Check against custom ignore patterns first
  if (customIgnorePatterns?.some((p) => p.test(name))) return false;

  return CREDENTIAL_NAME_PATTERN.test(name);
}

// ============================================================================
// Issue Types
// ============================================================================

/**
 * Security issue type.
 */
export type SecurityIssueType = 'hardcoded-credentials' | 'insecure-random';

/**
 * Security issue.
 */
export interface SecurityIssue {
  ruleId: SecurityRuleId;
  type: SecurityIssueType;
  severity: CheckSeverity;
  file: string;
  line: string;
  message: string;
}
