/**
 * YAML Configuration Parser
 *
 * Parses YAML configuration files and extracts settings.
 * Uses js-yaml for parsing.
 *
 * @module bundle/analyzers/config/parsers/yaml
 */

import yaml from 'js-yaml';

import type { ConfigParser, ConfigParseResult, ConfigSetting, ConfigValueType } from '../types.js';
import { inferValueType } from './json.js';

// ============================================================================
// Helper Functions
// ============================================================================

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
// YAML Parser Implementation
// ============================================================================

/**
 * YAML configuration file parser.
 */
export class YamlConfigParser implements ConfigParser {
  readonly configType = 'yaml' as const;

  /**
   * Parse YAML configuration content.
   *
   * @param content - YAML file content
   * @param filePath - File path for error context
   * @returns Parse result with settings and errors
   */
  parse(content: string, filePath: string): ConfigParseResult {
    const settings: ConfigSetting[] = [];
    const errors: string[] = [];

    try {
      const data = yaml.load(content);

      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        extractSettingsFromObject(data as Record<string, unknown>, settings);
      } else if (Array.isArray(data)) {
        // Top-level array
        settings.push({
          key: 'root',
          value: data,
          valueType: 'array',
          nestedPath: [],
        });
      } else if (data !== undefined) {
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
      errors.push(`YAML parse error in ${filePath}: ${message}`);
    }

    return { settings, errors };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new YAML parser instance.
 */
export function createYamlParser(): YamlConfigParser {
  return new YamlConfigParser();
}
