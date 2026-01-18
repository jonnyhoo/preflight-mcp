/**
 * Configuration Pattern Extraction - Type Definitions
 *
 * Defines types for configuration file detection and parsing.
 * Supports JSON, YAML, ENV, Dockerfile, and other config formats.
 *
 * @module bundle/analyzers/config/types
 */

import type { AnalyzerOptions } from '../types.js';

// ============================================================================
// Config Type Enums
// ============================================================================

/**
 * Supported configuration file types.
 */
export type ConfigType =
  | 'json'
  | 'yaml'
  | 'toml'
  | 'env'
  | 'ini'
  | 'python'
  | 'javascript'
  | 'dockerfile'
  | 'docker-compose';

/**
 * Configuration purpose categories.
 */
export type ConfigPurpose =
  | 'database_configuration'
  | 'api_configuration'
  | 'logging_configuration'
  | 'docker_configuration'
  | 'ci_cd_configuration'
  | 'package_configuration'
  | 'typescript_configuration'
  | 'framework_configuration'
  | 'environment_configuration'
  | 'general_configuration';

/**
 * Value types for configuration settings.
 */
export type ConfigValueType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object'
  | 'null';

// ============================================================================
// Configuration Setting Types
// ============================================================================

/**
 * Individual configuration setting.
 */
export type ConfigSetting = {
  /** Setting key (may include nested path like "database.host") */
  key: string;
  /** Setting value */
  value: unknown;
  /** Inferred value type */
  valueType: ConfigValueType;
  /** Default value (if detected) */
  defaultValue?: unknown;
  /** Whether this setting appears required */
  required?: boolean;
  /** Associated environment variable (if detected) */
  envVar?: string;
  /** Description extracted from comments */
  description?: string;
  /** Validation rules (if detected) */
  validation?: Record<string, unknown>;
  /** Nested path components */
  nestedPath?: string[];
};

/**
 * Parsed configuration file.
 */
export type ConfigFile = {
  /** Absolute file path */
  filePath: string;
  /** Relative path from bundle root */
  relativePath: string;
  /** Configuration file type */
  configType: ConfigType;
  /** Inferred purpose */
  purpose: ConfigPurpose;
  /** Extracted settings */
  settings: ConfigSetting[];
  /** Detected configuration patterns */
  patterns: string[];
  /** Raw file content (optional) */
  rawContent?: string;
  /** Parse errors encountered */
  parseErrors: string[];
};

// ============================================================================
// Pattern Detection Types
// ============================================================================

/**
 * Known configuration pattern definition.
 */
export type ConfigPatternDefinition = {
  /** Keys that indicate this pattern */
  keys: string[];
  /** Minimum number of keys that must match */
  minMatch: number;
};

/**
 * Known configuration patterns.
 */
export const KNOWN_CONFIG_PATTERNS: Record<string, ConfigPatternDefinition> = {
  database_config: {
    keys: ['host', 'port', 'database', 'user', 'username', 'password', 'db_name', 'db_host', 'db_port'],
    minMatch: 3,
  },
  api_config: {
    keys: ['base_url', 'api_key', 'api_secret', 'timeout', 'retry', 'endpoint', 'api_url'],
    minMatch: 2,
  },
  logging_config: {
    keys: ['level', 'format', 'handler', 'file', 'console', 'log_level', 'log_file', 'log_format'],
    minMatch: 2,
  },
  cache_config: {
    keys: ['backend', 'ttl', 'max_size', 'redis', 'memcached', 'cache_timeout', 'cache_backend'],
    minMatch: 2,
  },
  email_config: {
    keys: ['smtp_host', 'smtp_port', 'email', 'from_email', 'mail_server', 'email_backend'],
    minMatch: 2,
  },
  auth_config: {
    keys: ['secret_key', 'jwt_secret', 'token', 'oauth', 'authentication', 'jwt_expiry'],
    minMatch: 1,
  },
  server_config: {
    keys: ['host', 'port', 'bind', 'workers', 'threads', 'server_host', 'server_port'],
    minMatch: 2,
  },
};

// ============================================================================
// File Detection Patterns
// ============================================================================

/**
 * Configuration file detection patterns by type.
 */
export type ConfigFilePatterns = {
  /** Glob patterns to match */
  patterns: string[];
  /** Exact filename matches */
  names: string[];
};

/**
 * Configuration file patterns by type.
 */
export const CONFIG_FILE_PATTERNS: Record<ConfigType, ConfigFilePatterns> = {
  json: {
    patterns: ['*.json'],
    names: ['config.json', 'settings.json', 'app.json', '.eslintrc.json', '.prettierrc.json', 'package.json', 'tsconfig.json', 'jsconfig.json'],
  },
  yaml: {
    patterns: ['*.yaml', '*.yml'],
    names: ['config.yml', 'settings.yml', '.travis.yml', '.gitlab-ci.yml', 'docker-compose.yml', 'docker-compose.yaml'],
  },
  toml: {
    patterns: ['*.toml'],
    names: ['pyproject.toml', 'Cargo.toml', 'config.toml'],
  },
  env: {
    patterns: ['.env*', '*.env'],
    names: ['.env', '.env.example', '.env.local', '.env.production', '.env.development', '.env.test'],
  },
  ini: {
    patterns: ['*.ini', '*.cfg'],
    names: ['config.ini', 'setup.cfg', 'tox.ini'],
  },
  python: {
    patterns: [],
    names: ['settings.py', 'config.py', 'configuration.py', 'constants.py'],
  },
  javascript: {
    patterns: ['*.config.js', '*.config.ts', '*.config.mjs'],
    names: ['config.js', 'next.config.js', 'vue.config.js', 'webpack.config.js', 'vite.config.ts'],
  },
  dockerfile: {
    patterns: ['Dockerfile*'],
    names: ['Dockerfile', 'Dockerfile.dev', 'Dockerfile.prod'],
  },
  'docker-compose': {
    patterns: ['docker-compose*.yml', 'docker-compose*.yaml'],
    names: ['docker-compose.yml', 'docker-compose.yaml'],
  },
};

/**
 * Directories to skip during config file search.
 */
export const CONFIG_SKIP_DIRS = new Set([
  'node_modules',
  'venv',
  'env',
  '.venv',
  '__pycache__',
  '.git',
  'build',
  'dist',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'htmlcov',
  'coverage',
  '.eggs',
]);

// ============================================================================
// Analyzer Output Types
// ============================================================================

/**
 * Configuration extraction report.
 */
export type ConfigExtractionReport = {
  /** Parsed configuration files */
  configFiles: ConfigFile[];
  /** Total files analyzed */
  totalFiles: number;
  /** Total settings extracted */
  totalSettings: number;
  /** Detected patterns mapped to file paths */
  detectedPatterns: Record<string, string[]>;
  /** Primary config purpose detected */
  primaryPurpose?: ConfigPurpose;
};

/**
 * Config Analyzer output type.
 */
export type ConfigOutput = ConfigExtractionReport;

// ============================================================================
// Analyzer Options
// ============================================================================

/**
 * Config Analyzer specific options.
 */
export type ConfigAnalyzerOptions = AnalyzerOptions & {
  /** Maximum config files to process */
  maxConfigFiles: number;
  /** Whether to include raw content in output */
  includeRawContent: boolean;
  /** Config types to detect (empty = all) */
  configTypes: ConfigType[];
  /** Whether to detect patterns */
  detectPatterns: boolean;
};

/**
 * Default options for Config Analyzer.
 */
export const DEFAULT_CONFIG_OPTIONS: Required<ConfigAnalyzerOptions> = {
  enabled: true,
  timeout: 30000,
  maxFiles: 0,
  includePatterns: [],
  excludePatterns: ['**/node_modules/**', '**/vendor/**', '**/.git/**', '**/dist/**', '**/build/**'],
  maxConfigFiles: 100,
  includeRawContent: false,
  configTypes: [], // Empty = detect all
  detectPatterns: true,
};

// ============================================================================
// Parser Interface
// ============================================================================

/**
 * Interface for configuration file parsers.
 */
export type ConfigParser = {
  /** Config type this parser handles */
  readonly configType: ConfigType;

  /**
   * Parse configuration file content.
   *
   * @param content - Raw file content
   * @param filePath - File path for context
   * @returns Extracted settings
   */
  parse(content: string, filePath: string): ConfigParseResult;
};

/**
 * Result of parsing a configuration file.
 */
export type ConfigParseResult = {
  /** Extracted settings */
  settings: ConfigSetting[];
  /** Parse errors encountered */
  errors: string[];
};
