/**
 * Python Documentation Checker - Utility Functions
 *
 * @module analysis/doccheck/python/utils
 */

// ============================================================================
// String Similarity
// ============================================================================

/**
 * Calculate Levenshtein edit distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]!;
      } else {
        dp[i]![j] = Math.min(
          dp[i - 1]![j]! + 1,     // deletion
          dp[i]![j - 1]! + 1,     // insertion
          dp[i - 1]![j - 1]! + 1  // substitution
        );
      }
    }
  }

  return dp[m]![n]!;
}

/**
 * Check if two strings are similar enough to suggest a name mismatch.
 * Uses Levenshtein distance relative to string length.
 */
export function areSimilar(a: string, b: string): boolean {
  // Exact match means no mismatch
  if (a === b) return false;

  // Case-insensitive match is a likely mismatch
  if (a.toLowerCase() === b.toLowerCase()) return true;

  const distance = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
  const maxLen = Math.max(a.length, b.length);

  // Consider similar if edit distance is <= 2 and <= 30% of length
  return distance <= 2 && distance / maxLen <= 0.3;
}

// ============================================================================
// Type Matching
// ============================================================================

/**
 * Check if two Python types match (with flexibility for common equivalents).
 */
export function typesMatch(docType: string, codeType: string): boolean {
  // Normalize types
  const normalize = (t: string) =>
    t
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/^list\[(.+)\]$/, '$1[]')
      .replace(/^typing\./, '')  // Remove typing. prefix
      .replace(/^optional\[(.+)\]$/, '$1|none');

  const doc = normalize(docType);
  const code = normalize(codeType);

  // Exact match
  if (doc === code) return true;

  // Common Python type equivalents
  const equivalents: Record<string, string[]> = {
    str: ['str', 'string'],
    int: ['int', 'integer', 'number'],
    float: ['float', 'double', 'number'],
    bool: ['bool', 'boolean'],
    dict: ['dict', 'dict[str,any]', 'mapping', 'object'],
    list: ['list', 'list[any]', 'sequence', 'array'],
    any: ['any', 'object'],
    none: ['none', 'nonetype'],
  };

  for (const [, variants] of Object.entries(equivalents)) {
    if (variants.includes(doc) && variants.includes(code)) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// Exception Name Handling
// ============================================================================

/**
 * Normalize exception name for comparison (handles module.Exception vs Exception).
 */
export function normalizeExceptionName(name: string): string {
  // Get just the class name (last part after any dots)
  const parts = name.split('.');
  return parts[parts.length - 1]!.toLowerCase();
}

// ============================================================================
// Param Type Annotation Parsing
// ============================================================================

/**
 * Parse parameter type annotation from docstring.
 * Extracts type, optional flag, and default value from formats like:
 *   - "int"
 *   - "int, optional"
 *   - "int, optional, default=5"
 *   - "str, default='hello'"
 */
export function parseParamTypeAnnotation(typeStr?: string): {
  type?: string;
  optional?: boolean;
  defaultValue?: string;
} {
  if (!typeStr) {
    return {};
  }

  let type = typeStr.trim();
  let optional = false;
  let defaultValue: string | undefined;

  // Check for "optional" keyword
  if (/\boptional\b/i.test(type)) {
    optional = true;
    type = type.replace(/,?\s*optional\b/i, '').trim();
  }

  // Check for "default=X" or "default: X"
  const defaultMatch = type.match(/,?\s*default\s*[=:]\s*(.+)$/i);
  if (defaultMatch) {
    defaultValue = defaultMatch[1]!.trim();
    type = type.replace(/,?\s*default\s*[=:]\s*.+$/i, '').trim();
    optional = true; // Parameters with defaults are always optional
  }

  return {
    type: type || undefined,
    optional: optional || undefined,
    defaultValue,
  };
}
