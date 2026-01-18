/**
 * Configuration Pattern Detector
 *
 * Detects common configuration patterns by analyzing setting keys.
 * Identifies patterns like database_config, api_config, auth_config, etc.
 *
 * @module bundle/analyzers/config/pattern-detector
 */

import type { ConfigFile, ConfigPatternDefinition } from './types.js';
import { KNOWN_CONFIG_PATTERNS } from './types.js';

// ============================================================================
// Config Pattern Detector
// ============================================================================

/**
 * Detects configuration patterns in parsed config files.
 */
export class ConfigPatternDetector {
  private readonly patterns: Record<string, ConfigPatternDefinition>;

  constructor(customPatterns?: Record<string, ConfigPatternDefinition>) {
    this.patterns = {
      ...KNOWN_CONFIG_PATTERNS,
      ...customPatterns,
    };
  }

  /**
   * Detect patterns in a config file based on its settings.
   *
   * @param configFile - Parsed config file with settings
   * @returns List of detected pattern names
   */
  detectPatterns(configFile: ConfigFile): string[] {
    const detected: string[] = [];

    // Extract all setting keys (lowercase for matching)
    const settingKeys = new Set(configFile.settings.map((s) => this.normalizeKey(s.key)));

    // Check each known pattern
    for (const [patternName, patternDef] of Object.entries(this.patterns)) {
      const patternKeys = new Set(patternDef.keys.map((k) => k.toLowerCase()));
      const minMatch = patternDef.minMatch;

      // Count matches (keys that exist in both sets)
      let matches = 0;
      for (const key of settingKeys) {
        if (this.keyMatchesPattern(key, patternKeys)) {
          matches++;
        }
      }

      if (matches >= minMatch) {
        detected.push(patternName);
      }
    }

    return detected;
  }

  /**
   * Detect patterns across multiple config files.
   *
   * @param configFiles - List of parsed config files
   * @returns Map of pattern names to file paths that contain them
   */
  detectPatternsAcrossFiles(configFiles: ConfigFile[]): Record<string, string[]> {
    const patternToFiles: Record<string, string[]> = {};

    for (const configFile of configFiles) {
      const patterns = this.detectPatterns(configFile);

      for (const pattern of patterns) {
        if (!patternToFiles[pattern]) {
          patternToFiles[pattern] = [];
        }
        patternToFiles[pattern].push(configFile.relativePath);
      }
    }

    return patternToFiles;
  }

  /**
   * Normalize a setting key for pattern matching.
   * Extracts the last part of nested keys (e.g., "database.host" -> "host").
   */
  private normalizeKey(key: string): string {
    // Split by common separators and get last part
    const parts = key.toLowerCase().split(/[._-]/);
    return parts[parts.length - 1] ?? key.toLowerCase();
  }

  /**
   * Check if a key matches any pattern key.
   * Supports partial matching for compound keys.
   */
  private keyMatchesPattern(key: string, patternKeys: Set<string>): boolean {
    // Direct match
    if (patternKeys.has(key)) {
      return true;
    }

    // Check if key contains any pattern key
    for (const patternKey of patternKeys) {
      if (key.includes(patternKey) || patternKey.includes(key)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Add a custom pattern definition.
   *
   * @param name - Pattern name
   * @param definition - Pattern definition
   */
  addPattern(name: string, definition: ConfigPatternDefinition): void {
    this.patterns[name] = definition;
  }

  /**
   * Get all registered pattern names.
   */
  getPatternNames(): string[] {
    return Object.keys(this.patterns);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new ConfigPatternDetector instance.
 *
 * @param customPatterns - Optional custom patterns to add
 */
export function createConfigPatternDetector(
  customPatterns?: Record<string, ConfigPatternDefinition>
): ConfigPatternDetector {
  return new ConfigPatternDetector(customPatterns);
}
