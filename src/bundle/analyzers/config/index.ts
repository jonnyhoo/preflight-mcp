/**
 * Configuration Pattern Extraction Module
 *
 * Extracts configuration patterns from config files in the codebase.
 * Supports JSON, YAML, ENV, Dockerfile, and other config formats.
 *
 * @module bundle/analyzers/config
 */

import * as fs from 'node:fs/promises';

import { BaseAnalyzer } from '../base-analyzer.js';
import type { AnalyzerInput, AnalyzerOutput, AnalyzerErrorInfo, AnalyzerHighlight } from '../types.js';

import { ConfigFileDetector, createConfigFileDetector } from './detector.js';
import { ConfigPatternDetector, createConfigPatternDetector } from './pattern-detector.js';
import { JsonConfigParser, createJsonParser, inferValueType } from './parsers/json.js';
import { YamlConfigParser, createYamlParser } from './parsers/yaml.js';
import { EnvConfigParser, createEnvParser } from './parsers/env.js';
import { DockerfileConfigParser, createDockerfileParser } from './parsers/dockerfile.js';

import {
  type ConfigType,
  type ConfigPurpose,
  type ConfigValueType,
  type ConfigSetting,
  type ConfigFile,
  type ConfigExtractionReport,
  type ConfigOutput,
  type ConfigAnalyzerOptions,
  type ConfigParser,
  type ConfigParseResult,
  type ConfigPatternDefinition,
  DEFAULT_CONFIG_OPTIONS,
  CONFIG_FILE_PATTERNS,
  CONFIG_SKIP_DIRS,
  KNOWN_CONFIG_PATTERNS,
} from './types.js';

// ============================================================================
// Re-exports
// ============================================================================

export {
  // Types
  type ConfigType,
  type ConfigPurpose,
  type ConfigValueType,
  type ConfigSetting,
  type ConfigFile,
  type ConfigExtractionReport,
  type ConfigOutput,
  type ConfigAnalyzerOptions,
  type ConfigParser,
  type ConfigParseResult,
  type ConfigPatternDefinition,
  // Constants
  DEFAULT_CONFIG_OPTIONS,
  CONFIG_FILE_PATTERNS,
  CONFIG_SKIP_DIRS,
  KNOWN_CONFIG_PATTERNS,
  // Detector classes
  ConfigFileDetector,
  ConfigPatternDetector,
  // Parser classes
  JsonConfigParser,
  YamlConfigParser,
  EnvConfigParser,
  DockerfileConfigParser,
  // Factory functions
  createConfigFileDetector,
  createConfigPatternDetector,
  createJsonParser,
  createYamlParser,
  createEnvParser,
  createDockerfileParser,
  // Utility functions
  inferValueType,
};

// ============================================================================
// Config Analyzer
// ============================================================================

/**
 * Configuration Pattern Analyzer.
 *
 * Analyzes configuration files in a codebase to extract settings and detect patterns.
 * Supports multiple config formats and identifies configuration purposes.
 *
 * @example
 * ```ts
 * const analyzer = createConfigAnalyzer({
 *   maxConfigFiles: 50,
 *   detectPatterns: true,
 * });
 *
 * const result = await analyzer.analyze({
 *   bundleRoot: '/path/to/bundle',
 *   files: ingestedFiles,
 *   manifest: bundleManifest,
 * });
 *
 * console.log(result.data?.detectedPatterns);
 * console.log(result.data?.totalSettings);
 * ```
 */
export class ConfigAnalyzer extends BaseAnalyzer<ConfigOutput, ConfigAnalyzerOptions> {
  readonly name = 'config-analyzer';
  readonly version = '1.0.0';
  readonly description = 'Extracts configuration patterns from config files';

  private readonly fileDetector: ConfigFileDetector;
  private readonly patternDetector: ConfigPatternDetector;
  private readonly parsers: Map<ConfigType, ConfigParser>;

  constructor(options?: Partial<ConfigAnalyzerOptions>) {
    super(options);
    this.fileDetector = createConfigFileDetector();
    this.patternDetector = createConfigPatternDetector();
    this.parsers = this.initializeParsers();
  }

  protected getDefaultOptions(): Required<ConfigAnalyzerOptions> {
    return DEFAULT_CONFIG_OPTIONS;
  }

  /**
   * Initialize parsers for each supported config type.
   */
  private initializeParsers(): Map<ConfigType, ConfigParser> {
    const parsers = new Map<ConfigType, ConfigParser>();

    parsers.set('json', createJsonParser());
    parsers.set('yaml', createYamlParser());
    parsers.set('env', createEnvParser());
    parsers.set('dockerfile', createDockerfileParser());
    // docker-compose uses yaml parser
    parsers.set('docker-compose', createYamlParser());

    return parsers;
  }

  /**
   * Analyze configuration files in the bundle.
   */
  async analyze(input: AnalyzerInput): Promise<AnalyzerOutput<ConfigOutput>> {
    const startTime = Date.now();
    const errors: AnalyzerErrorInfo[] = [];

    // Validate input
    const validationErrors = this.validateInput(input);
    if (validationErrors.length > 0) {
      return this.createFailureOutput(validationErrors, this.createMetadata(startTime, 0));
    }

    const logger = this.getLogger();
    logger.info('Starting configuration extraction', {
      bundleRoot: input.bundleRoot,
      fileCount: input.files.length,
    });

    try {
      // Filter files based on options
      const files = this.filterFiles(input.files);

      // Find configuration files
      const configFiles = this.fileDetector.findConfigFiles(
        files,
        this.options.maxConfigFiles,
        this.options.configTypes
      );

      logger.debug('Found config files', { count: configFiles.length });

      // Parse each config file
      let totalSettings = 0;
      for (const configFile of configFiles) {
        try {
          await this.parseConfigFile(configFile);
          totalSettings += configFile.settings.length;

          // Detect patterns if enabled
          if (this.options.detectPatterns) {
            configFile.patterns = this.patternDetector.detectPatterns(configFile);
          }

          // Strip raw content if not requested
          if (!this.options.includeRawContent) {
            configFile.rawContent = undefined;
          }

          // Collect parse errors that were recorded but didn't throw
          if (configFile.parseErrors.length > 0) {
            for (const parseError of configFile.parseErrors) {
              errors.push({
                code: 'PARSE_ERROR',
                message: parseError,
                file: configFile.relativePath,
                recoverable: true,
              });
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn('Failed to parse config file', {
            file: configFile.relativePath,
            error: message,
          });
          configFile.parseErrors.push(message);
          errors.push({
            code: 'PARSE_ERROR',
            message: `Failed to parse ${configFile.relativePath}: ${message}`,
            file: configFile.relativePath,
            recoverable: true,
          });
        }
      }

      // Aggregate patterns across files
      const detectedPatterns = this.options.detectPatterns
        ? this.patternDetector.detectPatternsAcrossFiles(configFiles)
        : {};

      // Determine primary purpose
      const primaryPurpose = this.determinePrimaryPurpose(configFiles);

      const report: ConfigExtractionReport = {
        configFiles,
        totalFiles: configFiles.length,
        totalSettings,
        detectedPatterns,
        primaryPurpose,
      };

      logger.info('Configuration extraction complete', {
        filesAnalyzed: configFiles.length,
        totalSettings,
        patternsDetected: Object.keys(detectedPatterns).length,
        durationMs: Date.now() - startTime,
      });

      // Generate summary and highlights
      const summary = this.generateSummary(report);
      const highlights = this.generateHighlights(configFiles, detectedPatterns);

      return this.createSuccessOutput(
        report,
        this.createMetadata(startTime, configFiles.length),
        summary,
        highlights,
        errors.length > 0 ? errors : undefined
      );
    } catch (err) {
      logger.error('Configuration extraction failed', err instanceof Error ? err : new Error(String(err)));

      return this.createFailureOutput(
        [this.errorToInfo(err)],
        this.createMetadata(startTime, 0)
      );
    }
  }

  /**
   * Parse a configuration file and populate its settings.
   */
  private async parseConfigFile(configFile: ConfigFile): Promise<void> {
    // Read file content
    const content = await fs.readFile(configFile.filePath, 'utf-8');
    configFile.rawContent = content;

    // Get appropriate parser
    const parser = this.parsers.get(configFile.configType);
    if (!parser) {
      configFile.parseErrors.push(`No parser available for type: ${configFile.configType}`);
      return;
    }

    // Parse content
    const result = parser.parse(content, configFile.filePath);
    configFile.settings = result.settings;
    configFile.parseErrors.push(...result.errors);
  }

  /**
   * Determine the primary configuration purpose based on all config files.
   */
  private determinePrimaryPurpose(configFiles: ConfigFile[]): ConfigPurpose | undefined {
    if (configFiles.length === 0) {
      return undefined;
    }

    // Count purposes
    const purposeCounts = new Map<ConfigPurpose, number>();
    for (const file of configFiles) {
      const count = purposeCounts.get(file.purpose) ?? 0;
      purposeCounts.set(file.purpose, count + 1);
    }

    // Find most common (excluding general_configuration)
    let maxCount = 0;
    let primaryPurpose: ConfigPurpose | undefined;

    for (const [purpose, count] of purposeCounts) {
      if (purpose !== 'general_configuration' && count > maxCount) {
        maxCount = count;
        primaryPurpose = purpose;
      }
    }

    return primaryPurpose;
  }

  /**
   * Generate a brief summary of the analysis results.
   */
  private generateSummary(report: ConfigExtractionReport): string {
    if (report.totalFiles === 0) {
      return 'No configuration files found in the project.';
    }

    const parts: string[] = [];
    parts.push(`Found ${report.totalFiles} config files with ${report.totalSettings} settings.`);

    if (report.primaryPurpose) {
      parts.push(`Primary purpose: ${report.primaryPurpose}.`);
    }

    const patternCount = Object.keys(report.detectedPatterns).length;
    if (patternCount > 0) {
      parts.push(`${patternCount} configuration patterns detected.`);
    }

    return parts.join(' ');
  }

  /**
   * Generate highlights from important config files and patterns.
   */
  private generateHighlights(
    configFiles: ConfigFile[],
    detectedPatterns: Record<string, string[]>
  ): AnalyzerHighlight[] {
    const highlights: AnalyzerHighlight[] = [];

    // Highlight important config files
    const importantFiles = configFiles
      .filter((f) => f.settings.length > 0)
      .sort((a, b) => b.settings.length - a.settings.length)
      .slice(0, 3);

    for (const file of importantFiles) {
      highlights.push({
        type: file.configType,
        description: `${file.relativePath}: ${file.settings.length} settings (${file.purpose})`,
        confidence: 0.9,
        file: file.relativePath,
        context: {
          purpose: file.purpose,
          settingCount: file.settings.length,
        },
      });
    }

    // Highlight detected patterns
    for (const [pattern, files] of Object.entries(detectedPatterns)) {
      if (highlights.length >= 5) break;
      highlights.push({
        type: 'pattern',
        description: `${pattern} pattern found in ${files.length} file(s)`,
        confidence: 0.8,
        context: {
          patternName: pattern,
          files: files.slice(0, 3),
        },
      });
    }

    return highlights.slice(0, 5);
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Creates a new ConfigAnalyzer instance.
 *
 * @param options - Optional configuration options
 * @returns New analyzer instance
 *
 * @example
 * ```ts
 * const analyzer = createConfigAnalyzer();
 * const result = await analyzer.analyze(input);
 * ```
 */
export function createConfigAnalyzer(options?: Partial<ConfigAnalyzerOptions>): ConfigAnalyzer {
  return new ConfigAnalyzer(options);
}

/**
 * Convenience function to extract configuration patterns.
 * Creates an analyzer instance and runs extraction in one call.
 *
 * @param input - Analyzer input
 * @param options - Optional configuration options
 * @returns Extraction result
 */
export async function extractConfig(
  input: AnalyzerInput,
  options?: Partial<ConfigAnalyzerOptions>
): Promise<AnalyzerOutput<ConfigOutput>> {
  const analyzer = createConfigAnalyzer(options);
  return analyzer.analyze(input);
}
