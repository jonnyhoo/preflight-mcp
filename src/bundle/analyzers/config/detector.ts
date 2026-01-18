/**
 * Configuration File Detector
 *
 * Identifies configuration files in a codebase by analyzing file names,
 * extensions, and path patterns.
 *
 * @module bundle/analyzers/config/detector
 */

import * as path from 'node:path';

import { minimatch } from 'minimatch';

import type { IngestedFile } from '../types.js';

import {
  type ConfigType,
  type ConfigPurpose,
  type ConfigFile,
  CONFIG_FILE_PATTERNS,
  CONFIG_SKIP_DIRS,
} from './types.js';

// ============================================================================
// Config File Detector
// ============================================================================

/**
 * Detects configuration files in a codebase.
 */
export class ConfigFileDetector {
  /**
   * Find configuration files from a list of ingested files.
   *
   * @param files - List of ingested files
   * @param maxFiles - Maximum number of config files to return
   * @param configTypes - Config types to detect (empty = all)
   * @returns List of detected config files
   */
  findConfigFiles(
    files: IngestedFile[],
    maxFiles: number = 100,
    configTypes: ConfigType[] = []
  ): ConfigFile[] {
    const configFiles: ConfigFile[] = [];
    const typesToDetect = configTypes.length > 0 ? new Set(configTypes) : null;

    for (const file of files) {
      if (maxFiles > 0 && configFiles.length >= maxFiles) {
        break;
      }

      // Skip files in excluded directories
      if (this.shouldSkipFile(file.repoRelativePath)) {
        continue;
      }

      // Detect config type
      const configType = this.detectConfigType(file.repoRelativePath);
      if (!configType) {
        continue;
      }

      // Filter by requested types
      if (typesToDetect && !typesToDetect.has(configType)) {
        continue;
      }

      // Create config file entry
      const configFile: ConfigFile = {
        filePath: file.bundleNormAbsPath,
        relativePath: file.repoRelativePath,
        configType,
        purpose: this.inferPurpose(file.repoRelativePath, configType),
        settings: [],
        patterns: [],
        parseErrors: [],
      };

      configFiles.push(configFile);
    }

    return configFiles;
  }

  // Detection priority order (more specific types first)
  private static readonly DETECTION_ORDER: ConfigType[] = [
    'docker-compose', // Must be before yaml
    'dockerfile',
    'json',
    'yaml',
    'toml',
    'env',
    'ini',
    'python',
    'javascript',
  ];

  /**
   * Detects configuration file type from file path.
   *
   * @param filePath - File path to analyze
   * @returns Config type or null if not a config file
   */
  detectConfigType(filePath: string): ConfigType | null {
    const filename = path.basename(filePath).toLowerCase();
    const normalizedPath = filePath.replace(/\\/g, '/');

    // Check each config type in priority order
    for (const configType of ConfigFileDetector.DETECTION_ORDER) {
      const patterns = CONFIG_FILE_PATTERNS[configType];
      if (!patterns) continue;

      // Check exact name matches first (higher priority)
      for (const name of patterns.names) {
        if (filename === name.toLowerCase()) {
          return configType;
        }
      }

      // Check glob patterns
      for (const pattern of patterns.patterns) {
        if (minimatch(filename, pattern, { nocase: true })) {
          return configType;
        }
        // Also check full path for patterns like docker-compose*.yml
        if (minimatch(normalizedPath, `**/${pattern}`, { nocase: true })) {
          return configType;
        }
      }
    }

    return null;
  }

  /**
   * Infers configuration purpose from file path and type.
   *
   * @param filePath - File path
   * @param configType - Detected config type
   * @returns Inferred purpose
   */
  inferPurpose(filePath: string, configType: ConfigType): ConfigPurpose {
    const pathLower = filePath.toLowerCase();
    const filename = path.basename(filePath).toLowerCase();

    // Database configs
    if (this.pathContainsAny(pathLower, ['database', 'db', 'postgres', 'mysql', 'mongo', 'redis'])) {
      return 'database_configuration';
    }

    // API configs
    if (this.pathContainsAny(pathLower, ['api', 'rest', 'graphql', 'endpoint'])) {
      return 'api_configuration';
    }

    // Logging configs
    if (this.pathContainsAny(pathLower, ['log', 'logger', 'logging'])) {
      return 'logging_configuration';
    }

    // Docker configs
    if (configType === 'dockerfile' || configType === 'docker-compose') {
      return 'docker_configuration';
    }
    if (filename.includes('docker')) {
      return 'docker_configuration';
    }

    // CI/CD configs
    if (
      this.pathContainsAny(pathLower, [
        '.travis',
        '.gitlab',
        '.github',
        'ci',
        'cd',
        'jenkins',
        'circleci',
      ])
    ) {
      return 'ci_cd_configuration';
    }

    // Package configs
    if (['package.json', 'pyproject.toml', 'cargo.toml', 'setup.py', 'setup.cfg'].includes(filename)) {
      return 'package_configuration';
    }

    // TypeScript/JavaScript configs
    if (['tsconfig.json', 'jsconfig.json'].includes(filename)) {
      return 'typescript_configuration';
    }

    // Framework configs
    if (
      this.pathContainsAny(filename, [
        'next.config',
        'vue.config',
        'webpack.config',
        'vite.config',
        'babel.config',
        'jest.config',
      ])
    ) {
      return 'framework_configuration';
    }

    // Environment configs
    if (configType === 'env' || filename.startsWith('.env')) {
      return 'environment_configuration';
    }

    return 'general_configuration';
  }

  /**
   * Checks if file should be skipped based on path.
   */
  private shouldSkipFile(filePath: string): boolean {
    const parts = filePath.replace(/\\/g, '/').split('/');
    return parts.some((part) => CONFIG_SKIP_DIRS.has(part));
  }

  /**
   * Checks if path contains any of the given substrings.
   */
  private pathContainsAny(path: string, substrings: string[]): boolean {
    return substrings.some((s) => path.includes(s));
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new ConfigFileDetector instance.
 */
export function createConfigFileDetector(): ConfigFileDetector {
  return new ConfigFileDetector();
}
