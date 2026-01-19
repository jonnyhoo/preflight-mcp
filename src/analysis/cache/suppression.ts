/**
 * Suppression Scanning Module
 *
 * Provides lightweight scanning for suppression comments.
 * Supports JS/TS (//, /* *\/) and Python (#) comment styles.
 *
 * Pattern: `// preflight-ignore RULE_ID` or `# preflight-ignore RULE_ID`
 *
 * @module analysis/cache/suppression
 */

// ============================================================================
// Types
// ============================================================================

/**
 * A single suppression directive.
 */
export interface SuppressionDirective {
  /** Line number (1-indexed) */
  line: number;
  /** Rule ID to suppress (or '*' for all) */
  ruleId: string;
  /** Scope: 'line' (next line) or 'block' (until end of block) */
  scope: 'line' | 'block';
  /** End line for block scope (inclusive) */
  endLine?: number;
}

/**
 * Suppression index for a file.
 */
export interface SuppressionIndex {
  /** File path */
  file: string;
  /** All suppression directives */
  directives: SuppressionDirective[];
}

/**
 * Language type for comment style detection.
 */
type CommentStyle = 'js' | 'python';

// ============================================================================
// Constants
// ============================================================================

/**
 * Pattern to match suppression comments.
 * Captures: (1) rule ID or nothing for wildcard
 */
const SUPPRESS_PATTERN = /preflight-ignore(?:\s+(\S+))?/i;

// ============================================================================
// Functions
// ============================================================================

/**
 * Detect comment style from file extension.
 */
function detectCommentStyle(filePath: string): CommentStyle | null {
  const ext = filePath.toLowerCase().split('.').pop();
  if (!ext) return null;

  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'java', 'go', 'rs'].includes(ext)) {
    return 'js';
  }
  if (ext === 'py') {
    return 'python';
  }
  return null;
}

/**
 * Scan a file for suppression directives.
 *
 * Supported formats:
 * - `// preflight-ignore RULE_ID` - suppress rule on next line
 * - `// preflight-ignore` - suppress all rules on next line
 * - `# preflight-ignore RULE_ID` - Python style
 * - `/* preflight-ignore RULE_ID *\/` - block comment (same line)
 *
 * @param filePath - File path (for comment style detection)
 * @param content - File content
 * @returns SuppressionIndex for the file
 */
export function scanSuppressions(filePath: string, content: string): SuppressionIndex {
  const style = detectCommentStyle(filePath);
  if (!style) {
    return { file: filePath, directives: [] };
  }

  const lines = content.split('\n');
  const directives: SuppressionDirective[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Check for single-line comments
    const singleLineDirective = parseSingleLineComment(line, lineNum, style);
    if (singleLineDirective) {
      directives.push(singleLineDirective);
      continue;
    }

    // Check for block comments (JS-style only)
    if (style === 'js') {
      const blockDirective = parseBlockComment(line, lineNum);
      if (blockDirective) {
        directives.push(blockDirective);
      }
    }
  }

  return { file: filePath, directives };
}

/**
 * Parse a single-line comment for suppression directive.
 */
function parseSingleLineComment(
  line: string,
  lineNum: number,
  style: CommentStyle
): SuppressionDirective | null {
  const trimmed = line.trim();

  let commentContent: string | null = null;

  if (style === 'js') {
    // JS-style: //
    if (trimmed.startsWith('//')) {
      commentContent = trimmed.slice(2).trim();
    }
  } else if (style === 'python') {
    // Python-style: #
    if (trimmed.startsWith('#')) {
      commentContent = trimmed.slice(1).trim();
    }
  }

  if (!commentContent) return null;

  const match = SUPPRESS_PATTERN.exec(commentContent);
  if (!match) return null;

  return {
    line: lineNum,
    ruleId: match[1] ?? '*',
    scope: 'line',
  };
}

/**
 * Parse a block comment for suppression directive.
 */
function parseBlockComment(line: string, lineNum: number): SuppressionDirective | null {
  // Match /* ... */ on same line
  const blockMatch = /\/\*\s*(preflight-ignore(?:\s+(\S+))?)\s*\*\//.exec(line);
  if (!blockMatch) return null;

  return {
    line: lineNum,
    ruleId: blockMatch[2] ?? '*',
    scope: 'line',
  };
}

/**
 * Check if a line is suppressed for a given rule.
 *
 * @param index - SuppressionIndex for the file
 * @param line - Line number to check (1-indexed)
 * @param ruleId - Rule ID to check (optional, checks for any suppression if not provided)
 * @returns true if the line should be suppressed
 */
export function isLineSuppressed(
  index: SuppressionIndex,
  line: number,
  ruleId?: string
): boolean {
  for (const directive of index.directives) {
    // Line-scope: directive on previous line affects current line
    if (directive.scope === 'line' && directive.line === line - 1) {
      if (directive.ruleId === '*' || directive.ruleId === ruleId || !ruleId) {
        return true;
      }
    }

    // Block-scope: directive affects range
    if (directive.scope === 'block' && directive.endLine) {
      if (line >= directive.line && line <= directive.endLine) {
        if (directive.ruleId === '*' || directive.ruleId === ruleId || !ruleId) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Get all suppressed rule IDs for a given line.
 */
export function getSuppressedRules(index: SuppressionIndex, line: number): string[] {
  const rules: string[] = [];

  for (const directive of index.directives) {
    if (directive.scope === 'line' && directive.line === line - 1) {
      rules.push(directive.ruleId);
    }

    if (directive.scope === 'block' && directive.endLine) {
      if (line >= directive.line && line <= directive.endLine) {
        rules.push(directive.ruleId);
      }
    }
  }

  return rules;
}
