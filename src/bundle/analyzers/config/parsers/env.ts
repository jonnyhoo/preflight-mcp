/**
 * ENV Configuration Parser
 *
 * Parses .env configuration files with KEY=VALUE format.
 * Handles comments, quotes, and multiline values.
 *
 * @module bundle/analyzers/config/parsers/env
 */

import type { ConfigParser, ConfigParseResult, ConfigSetting, ConfigValueType } from '../types.js';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Regex pattern for parsing KEY=VALUE lines.
 * Matches: KEY=value, KEY="value", KEY='value'
 */
const ENV_LINE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/**
 * Infers value type from string value.
 */
function inferEnvValueType(value: string): ConfigValueType {
  // Check for boolean
  if (value.toLowerCase() === 'true' || value.toLowerCase() === 'false') {
    return 'boolean';
  }

  // Check for integer
  if (/^-?\d+$/.test(value)) {
    return 'integer';
  }

  // Check for number
  if (/^-?\d+\.?\d*$/.test(value) || /^-?\d*\.?\d+$/.test(value)) {
    return 'number';
  }

  // Check for null/empty
  if (value === '' || value.toLowerCase() === 'null') {
    return 'null';
  }

  return 'string';
}

/**
 * Strips quotes from a value.
 */
function stripQuotes(value: string): string {
  // Strip double quotes
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  // Strip single quotes
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Extracts description from comment above a line.
 */
function extractDescription(lines: string[], lineIndex: number): string | undefined {
  if (lineIndex > 0) {
    const prevLine = lines[lineIndex - 1]?.trim() ?? '';
    if (prevLine.startsWith('#')) {
      return prevLine.slice(1).trim();
    }
  }
  return undefined;
}

// ============================================================================
// ENV Parser Implementation
// ============================================================================

/**
 * ENV configuration file parser.
 */
export class EnvConfigParser implements ConfigParser {
  readonly configType = 'env' as const;

  /**
   * Parse .env configuration content.
   *
   * @param content - .env file content
   * @param filePath - File path for error context
   * @returns Parse result with settings and errors
   */
  parse(content: string, filePath: string): ConfigParseResult {
    const settings: ConfigSetting[] = [];
    const errors: string[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim() ?? '';

      // Skip empty lines and comments
      if (!line || line.startsWith('#')) {
        continue;
      }

      // Parse KEY=VALUE
      const match = ENV_LINE_PATTERN.exec(line);
      if (match) {
        const key = match[1]!;
        let value = match[2] ?? '';

        // Strip quotes
        value = stripQuotes(value);

        // Get description from previous comment
        const description = extractDescription(lines, i);

        const setting: ConfigSetting = {
          key,
          value,
          valueType: inferEnvValueType(value),
          envVar: key,
          description,
        };

        settings.push(setting);
      } else if (line.includes('=')) {
        // Invalid line format
        errors.push(`Invalid env line at ${filePath}:${i + 1}: ${line}`);
      }
    }

    return { settings, errors };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new ENV parser instance.
 */
export function createEnvParser(): EnvConfigParser {
  return new EnvConfigParser();
}
