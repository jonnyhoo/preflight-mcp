/**
 * Error-prone Rules - Type Definitions
 *
 * Types for error-prone code pattern detection.
 *
 * @module analysis/check/errorprone/types
 */

import type { CheckSeverity, RuleCategory, RuleConfidence } from '../types.js';

// ============================================================================
// Rule Metadata
// ============================================================================

/**
 * Error-prone rule identifier.
 */
export type ErrorProneRuleId =
  | 'empty-catch-block'
  | 'empty-if-statement'
  | 'return-from-finally'
  | 'missing-break-in-switch';

/**
 * Error-prone rule metadata.
 */
export interface ErrorProneRuleMetadata {
  ruleId: ErrorProneRuleId;
  category: RuleCategory;
  languages: string[];
  confidence: RuleConfidence;
  defaultEnabled: boolean;
  requiresSemantics: boolean;
  severity: CheckSeverity;
  description: string;
}

/**
 * All error-prone rules with metadata.
 */
export const ERRORPRONE_RULES: ErrorProneRuleMetadata[] = [
  {
    ruleId: 'empty-catch-block',
    category: 'errorprone',
    languages: ['javascript', 'typescript', 'tsx', 'java'],
    confidence: 'high',
    defaultEnabled: true,
    requiresSemantics: false,
    severity: 'warning',
    description: 'Catch block is empty or contains only comments',
  },
  {
    ruleId: 'empty-if-statement',
    category: 'errorprone',
    languages: ['javascript', 'typescript', 'tsx', 'java', 'python', 'go', 'rust'],
    confidence: 'high',
    defaultEnabled: true,
    requiresSemantics: false,
    severity: 'warning',
    description: 'If statement has empty body',
  },
  {
    ruleId: 'return-from-finally',
    category: 'errorprone',
    languages: ['javascript', 'typescript', 'tsx', 'java'],
    confidence: 'high',
    defaultEnabled: true,
    requiresSemantics: false,
    severity: 'error',
    description: 'Return statement in finally block',
  },
  {
    ruleId: 'missing-break-in-switch',
    category: 'errorprone',
    languages: ['javascript', 'typescript', 'tsx', 'java'],
    confidence: 'medium',
    defaultEnabled: true,
    requiresSemantics: false,
    severity: 'warning',
    description: 'Switch case may fall through without break/return/throw',
  },
];

/**
 * Get rule metadata by ID.
 */
export function getRuleMetadata(ruleId: ErrorProneRuleId): ErrorProneRuleMetadata | undefined {
  return ERRORPRONE_RULES.find((r) => r.ruleId === ruleId);
}

/**
 * Check if a rule applies to a language.
 */
export function ruleAppliesToLanguage(ruleId: ErrorProneRuleId, lang: string): boolean {
  const rule = getRuleMetadata(ruleId);
  return rule ? rule.languages.includes(lang) : false;
}

// ============================================================================
// Issue Types
// ============================================================================

/**
 * Error-prone issue type.
 */
export type ErrorProneIssueType =
  | 'empty-catch-block'
  | 'empty-if-statement'
  | 'return-from-finally'
  | 'missing-break-in-switch';

/**
 * Error-prone issue.
 */
export interface ErrorProneIssue {
  ruleId: ErrorProneRuleId;
  type: ErrorProneIssueType;
  severity: CheckSeverity;
  file: string;
  line: string;
  message: string;
}
