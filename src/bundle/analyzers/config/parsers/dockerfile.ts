/**
 * Dockerfile Configuration Parser
 *
 * Parses Dockerfile files and extracts ENV and ARG variables.
 *
 * @module bundle/analyzers/config/parsers/dockerfile
 */

import type { ConfigParser, ConfigParseResult, ConfigSetting } from '../types.js';

// ============================================================================
// Dockerfile Parser Implementation
// ============================================================================

/**
 * Dockerfile configuration parser.
 * Extracts ENV and ARG directives.
 */
export class DockerfileConfigParser implements ConfigParser {
  readonly configType = 'dockerfile' as const;

  /**
   * Parse Dockerfile content.
   *
   * @param content - Dockerfile content
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

      // Handle line continuations
      let fullLine = line;
      while (fullLine.endsWith('\\') && i + 1 < lines.length) {
        i++;
        fullLine = fullLine.slice(0, -1) + (lines[i]?.trim() ?? '');
      }

      // Parse ENV directives
      if (fullLine.startsWith('ENV ')) {
        this.parseEnvDirective(fullLine.slice(4), settings, filePath, i + 1);
      }
      // Parse ARG directives
      else if (fullLine.startsWith('ARG ')) {
        this.parseArgDirective(fullLine.slice(4), settings, filePath, i + 1);
      }
    }

    return { settings, errors };
  }

  /**
   * Parse ENV directive.
   * Supports both `ENV KEY=value` and `ENV KEY value` formats.
   */
  private parseEnvDirective(
    content: string,
    settings: ConfigSetting[],
    filePath: string,
    lineNumber: number
  ): void {
    content = content.trim();

    // Format: ENV KEY=value KEY2=value2
    if (content.includes('=')) {
      // Split by spaces, but respect quoted values
      const pairs = this.parseKeyValuePairs(content);
      for (const { key, value } of pairs) {
        settings.push({
          key: `ENV_${key}`,
          value,
          valueType: 'string',
          envVar: key,
          description: `Dockerfile ENV at line ${lineNumber}`,
        });
      }
    }
    // Format: ENV KEY value (single key-value, space separated)
    else {
      const spaceIndex = content.indexOf(' ');
      if (spaceIndex > 0) {
        const key = content.slice(0, spaceIndex);
        const value = content.slice(spaceIndex + 1).trim();
        settings.push({
          key: `ENV_${key}`,
          value,
          valueType: 'string',
          envVar: key,
          description: `Dockerfile ENV at line ${lineNumber}`,
        });
      }
    }
  }

  /**
   * Parse ARG directive.
   * Supports both `ARG KEY=default` and `ARG KEY` formats.
   */
  private parseArgDirective(
    content: string,
    settings: ConfigSetting[],
    filePath: string,
    lineNumber: number
  ): void {
    content = content.trim();

    // Format: ARG KEY=default
    if (content.includes('=')) {
      const [key, ...valueParts] = content.split('=');
      const value = valueParts.join('='); // Rejoin in case value contains =
      settings.push({
        key: `ARG_${key?.trim() ?? ''}`,
        value: value.trim() || null,
        valueType: value.trim() ? 'string' : 'null',
        description: `Dockerfile ARG at line ${lineNumber}`,
        defaultValue: value.trim() || undefined,
      });
    }
    // Format: ARG KEY (no default)
    else {
      settings.push({
        key: `ARG_${content}`,
        value: null,
        valueType: 'null',
        description: `Dockerfile ARG at line ${lineNumber}`,
        required: true,
      });
    }
  }

  /**
   * Parse key=value pairs from ENV line.
   * Handles quoted values.
   */
  private parseKeyValuePairs(content: string): Array<{ key: string; value: string }> {
    const pairs: Array<{ key: string; value: string }> = [];
    const regex = /(\w+)=(?:"([^"]*)"|'([^']*)'|(\S*))/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      const key = match[1]!;
      // Value is in group 2 (double quoted), 3 (single quoted), or 4 (unquoted)
      const value = match[2] ?? match[3] ?? match[4] ?? '';
      pairs.push({ key, value });
    }

    return pairs;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new Dockerfile parser instance.
 */
export function createDockerfileParser(): DockerfileConfigParser {
  return new DockerfileConfigParser();
}
