/**
 * JSON Configuration Parser
 *
 * Parses JSON configuration files and extracts settings.
 *
 * @module bundle/analyzers/config/parsers/json
 */

import type { ConfigParser, ConfigParseResult, ConfigSetting, ConfigValueType } from '../types.js';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Infers the value type from a JavaScript value.
 */
export function inferValueType(value: unknown): ConfigValueType {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'object') {
    return 'object';
  }
  return 'string';
}

/**
 * Recursively extracts settings from a nested object.
 */
function extractSettingsFromObject(
  obj: Record<string, unknown>,
  settings: ConfigSetting[],
  parentPath: string[] = []
): void {
  for (const [key, value] of Object.entries(obj)) {
    const currentPath = [...parentPath, key];
    const fullKey = currentPath.join('.');

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Recurse into nested objects
      extractSettingsFromObject(value as Record<string, unknown>, settings, currentPath);
    } else {
      // Leaf value - create setting
      settings.push({
        key: fullKey,
        value,
        valueType: inferValueType(value),
        nestedPath: currentPath,
      });
    }
  }
}

// ============================================================================
// JSON Parser Implementation
// ============================================================================

/**
 * JSON configuration file parser.
 */
export class JsonConfigParser implements ConfigParser {
  readonly configType = 'json' as const;

  /**
   * Parse JSON configuration content.
   *
   * @param content - JSON file content
   * @param filePath - File path for error context
   * @returns Parse result with settings and errors
   */
  parse(content: string, filePath: string): ConfigParseResult {
    const settings: ConfigSetting[] = [];
    const errors: string[] = [];

    try {
      const data = JSON.parse(content);

      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        extractSettingsFromObject(data as Record<string, unknown>, settings);
      } else if (Array.isArray(data)) {
        // Top-level array - treat as single setting
        settings.push({
          key: 'root',
          value: data,
          valueType: 'array',
          nestedPath: [],
        });
      } else {
        // Primitive value at root
        settings.push({
          key: 'root',
          value: data,
          valueType: inferValueType(data),
          nestedPath: [],
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`JSON parse error in ${filePath}: ${message}`);
    }

    return { settings, errors };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new JSON parser instance.
 */
export function createJsonParser(): JsonConfigParser {
  return new JsonConfigParser();
}
