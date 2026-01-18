/**
 * Configuration Pattern Analyzer Tests
 *
 * Tests for the configuration pattern extraction module.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  createConfigAnalyzer,
  extractConfig,
  createJsonParser,
  createYamlParser,
  createEnvParser,
  createDockerfileParser,
  createConfigFileDetector,
  createConfigPatternDetector,
  inferValueType,
  type ConfigFile,
} from '../../../src/bundle/analyzers/config/index.js';
import type { AnalyzerInput, IngestedFile, BundleManifest } from '../../../src/bundle/analyzers/types.js';

// ESM compat
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Test Helpers
// ============================================================================

function createMockFile(relativePath: string, bundleRoot: string): IngestedFile {
  return {
    repoRelativePath: relativePath,
    bundleNormRelativePath: `repos/test/norm/${relativePath}`,
    bundleNormAbsPath: path.join(bundleRoot, relativePath),
    kind: 'code',
    repoId: 'test/repo',
  };
}

function createMockManifest(): BundleManifest {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    description: 'Test bundle',
    repos: {},
    layout: {
      version: 1,
      dirs: {
        root: '/tmp/bundle',
        repos: '/tmp/bundle/repos',
        analysis: '/tmp/bundle/analysis',
      },
    },
  };
}

function createMockInput(bundleRoot: string, files: IngestedFile[]): AnalyzerInput {
  return {
    bundleRoot,
    files,
    manifest: createMockManifest(),
  };
}

// ============================================================================
// JSON Parser Tests
// ============================================================================

describe('JsonConfigParser', () => {
  const parser = createJsonParser();

  it('should parse simple JSON object', () => {
    const content = JSON.stringify({ host: 'localhost', port: 3000 });
    const result = parser.parse(content, 'config.json');

    expect(result.errors).toHaveLength(0);
    expect(result.settings).toHaveLength(2);
    expect(result.settings.find((s) => s.key === 'host')?.value).toBe('localhost');
    expect(result.settings.find((s) => s.key === 'port')?.value).toBe(3000);
  });

  it('should parse nested JSON objects', () => {
    const content = JSON.stringify({
      database: {
        host: 'localhost',
        port: 5432,
      },
    });
    const result = parser.parse(content, 'config.json');

    expect(result.errors).toHaveLength(0);
    expect(result.settings).toHaveLength(2);
    expect(result.settings.find((s) => s.key === 'database.host')?.value).toBe('localhost');
    expect(result.settings.find((s) => s.key === 'database.port')?.value).toBe(5432);
  });

  it('should infer correct value types', () => {
    const content = JSON.stringify({
      string: 'hello',
      integer: 42,
      float: 3.14,
      boolean: true,
      array: [1, 2, 3],
      null: null,
    });
    const result = parser.parse(content, 'config.json');

    expect(result.settings.find((s) => s.key === 'string')?.valueType).toBe('string');
    expect(result.settings.find((s) => s.key === 'integer')?.valueType).toBe('integer');
    expect(result.settings.find((s) => s.key === 'float')?.valueType).toBe('number');
    expect(result.settings.find((s) => s.key === 'boolean')?.valueType).toBe('boolean');
    expect(result.settings.find((s) => s.key === 'array')?.valueType).toBe('array');
    expect(result.settings.find((s) => s.key === 'null')?.valueType).toBe('null');
  });

  it('should handle parse errors gracefully', () => {
    const result = parser.parse('{ invalid json }', 'config.json');

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('JSON parse error');
  });
});

// ============================================================================
// YAML Parser Tests
// ============================================================================

describe('YamlConfigParser', () => {
  const parser = createYamlParser();

  it('should parse simple YAML', () => {
    const content = `
host: localhost
port: 3000
`;
    const result = parser.parse(content, 'config.yml');

    expect(result.errors).toHaveLength(0);
    expect(result.settings).toHaveLength(2);
    expect(result.settings.find((s) => s.key === 'host')?.value).toBe('localhost');
    expect(result.settings.find((s) => s.key === 'port')?.value).toBe(3000);
  });

  it('should parse nested YAML', () => {
    const content = `
database:
  host: localhost
  port: 5432
`;
    const result = parser.parse(content, 'config.yml');

    expect(result.errors).toHaveLength(0);
    expect(result.settings.find((s) => s.key === 'database.host')?.value).toBe('localhost');
    expect(result.settings.find((s) => s.key === 'database.port')?.value).toBe(5432);
  });

  it('should handle parse errors gracefully', () => {
    const content = `
invalid:
  - yaml
  content:
`;
    const result = parser.parse(content, 'config.yml');
    // May or may not error depending on yaml parser tolerance
    // Just ensure it doesn't throw
    expect(result).toBeDefined();
  });
});

// ============================================================================
// ENV Parser Tests
// ============================================================================

describe('EnvConfigParser', () => {
  const parser = createEnvParser();

  it('should parse simple env file', () => {
    const content = `
DATABASE_HOST=localhost
DATABASE_PORT=5432
`;
    const result = parser.parse(content, '.env');

    expect(result.errors).toHaveLength(0);
    expect(result.settings).toHaveLength(2);
    expect(result.settings.find((s) => s.key === 'DATABASE_HOST')?.value).toBe('localhost');
    expect(result.settings.find((s) => s.key === 'DATABASE_PORT')?.value).toBe('5432');
  });

  it('should handle quoted values', () => {
    const content = `
SECRET="my secret value"
SINGLE='single quoted'
`;
    const result = parser.parse(content, '.env');

    expect(result.settings.find((s) => s.key === 'SECRET')?.value).toBe('my secret value');
    expect(result.settings.find((s) => s.key === 'SINGLE')?.value).toBe('single quoted');
  });

  it('should skip comments and empty lines', () => {
    const content = `
# This is a comment
DATABASE_HOST=localhost

# Another comment
DATABASE_PORT=5432
`;
    const result = parser.parse(content, '.env');

    expect(result.settings).toHaveLength(2);
  });

  it('should extract description from comment above', () => {
    const content = `
# Database host
DATABASE_HOST=localhost
`;
    const result = parser.parse(content, '.env');

    expect(result.settings[0]?.description).toBe('Database host');
  });

  it('should infer value types', () => {
    const content = `
STRING_VAL=hello
INT_VAL=42
BOOL_TRUE=true
BOOL_FALSE=false
`;
    const result = parser.parse(content, '.env');

    expect(result.settings.find((s) => s.key === 'STRING_VAL')?.valueType).toBe('string');
    expect(result.settings.find((s) => s.key === 'INT_VAL')?.valueType).toBe('integer');
    expect(result.settings.find((s) => s.key === 'BOOL_TRUE')?.valueType).toBe('boolean');
    expect(result.settings.find((s) => s.key === 'BOOL_FALSE')?.valueType).toBe('boolean');
  });
});

// ============================================================================
// Dockerfile Parser Tests
// ============================================================================

describe('DockerfileConfigParser', () => {
  const parser = createDockerfileParser();

  it('should parse ENV directives', () => {
    const content = `
FROM node:18
ENV NODE_ENV=production
ENV PORT=3000
`;
    const result = parser.parse(content, 'Dockerfile');

    expect(result.errors).toHaveLength(0);
    expect(result.settings).toHaveLength(2);
    expect(result.settings.find((s) => s.key === 'ENV_NODE_ENV')?.value).toBe('production');
    expect(result.settings.find((s) => s.key === 'ENV_PORT')?.value).toBe('3000');
  });

  it('should parse ARG directives', () => {
    const content = `
FROM node:18
ARG BUILD_VERSION=1.0.0
ARG NODE_VERSION
`;
    const result = parser.parse(content, 'Dockerfile');

    expect(result.settings).toHaveLength(2);
    expect(result.settings.find((s) => s.key === 'ARG_BUILD_VERSION')?.value).toBe('1.0.0');
    expect(result.settings.find((s) => s.key === 'ARG_NODE_VERSION')?.value).toBeNull();
  });

  it('should handle space-separated ENV format', () => {
    const content = `
ENV APP_NAME myapp
`;
    const result = parser.parse(content, 'Dockerfile');

    expect(result.settings.find((s) => s.key === 'ENV_APP_NAME')?.value).toBe('myapp');
  });

  it('should skip comments', () => {
    const content = `
# This is a comment
FROM node:18
# Another comment
ENV PORT=3000
`;
    const result = parser.parse(content, 'Dockerfile');

    expect(result.settings).toHaveLength(1);
  });
});

// ============================================================================
// Config File Detector Tests
// ============================================================================

describe('ConfigFileDetector', () => {
  const detector = createConfigFileDetector();

  it('should detect JSON config files', () => {
    expect(detector.detectConfigType('package.json')).toBe('json');
    expect(detector.detectConfigType('tsconfig.json')).toBe('json');
    expect(detector.detectConfigType('config.json')).toBe('json');
  });

  it('should detect YAML config files', () => {
    expect(detector.detectConfigType('config.yml')).toBe('yaml');
    expect(detector.detectConfigType('config.yaml')).toBe('yaml');
    expect(detector.detectConfigType('.travis.yml')).toBe('yaml');
  });

  it('should detect ENV files', () => {
    expect(detector.detectConfigType('.env')).toBe('env');
    expect(detector.detectConfigType('.env.local')).toBe('env');
    expect(detector.detectConfigType('.env.production')).toBe('env');
  });

  it('should detect Dockerfile', () => {
    expect(detector.detectConfigType('Dockerfile')).toBe('dockerfile');
    expect(detector.detectConfigType('Dockerfile.dev')).toBe('dockerfile');
  });

  it('should detect docker-compose files', () => {
    expect(detector.detectConfigType('docker-compose.yml')).toBe('docker-compose');
    expect(detector.detectConfigType('docker-compose.yaml')).toBe('docker-compose');
  });

  it('should return null for non-config files', () => {
    expect(detector.detectConfigType('main.ts')).toBeNull();
    expect(detector.detectConfigType('readme.md')).toBeNull();
    expect(detector.detectConfigType('index.js')).toBeNull();
  });

  it('should infer correct purpose', () => {
    expect(detector.inferPurpose('database/config.json', 'json')).toBe('database_configuration');
    expect(detector.inferPurpose('api/settings.json', 'json')).toBe('api_configuration');
    expect(detector.inferPurpose('.env', 'env')).toBe('environment_configuration');
    expect(detector.inferPurpose('Dockerfile', 'dockerfile')).toBe('docker_configuration');
    expect(detector.inferPurpose('package.json', 'json')).toBe('package_configuration');
    expect(detector.inferPurpose('tsconfig.json', 'json')).toBe('typescript_configuration');
  });
});

// ============================================================================
// Config Pattern Detector Tests
// ============================================================================

describe('ConfigPatternDetector', () => {
  const detector = createConfigPatternDetector();

  it('should detect database_config pattern', () => {
    const configFile: ConfigFile = {
      filePath: '/tmp/config.json',
      relativePath: 'config.json',
      configType: 'json',
      purpose: 'general_configuration',
      settings: [
        { key: 'host', value: 'localhost', valueType: 'string' },
        { key: 'port', value: 5432, valueType: 'integer' },
        { key: 'database', value: 'mydb', valueType: 'string' },
        { key: 'user', value: 'admin', valueType: 'string' },
      ],
      patterns: [],
      parseErrors: [],
    };

    const patterns = detector.detectPatterns(configFile);

    expect(patterns).toContain('database_config');
    expect(patterns).toContain('server_config'); // host + port
  });

  it('should detect api_config pattern', () => {
    const configFile: ConfigFile = {
      filePath: '/tmp/api.json',
      relativePath: 'api.json',
      configType: 'json',
      purpose: 'api_configuration',
      settings: [
        { key: 'base_url', value: 'https://api.example.com', valueType: 'string' },
        { key: 'api_key', value: 'key123', valueType: 'string' },
        { key: 'timeout', value: 5000, valueType: 'integer' },
      ],
      patterns: [],
      parseErrors: [],
    };

    const patterns = detector.detectPatterns(configFile);

    expect(patterns).toContain('api_config');
  });

  it('should detect auth_config pattern', () => {
    const configFile: ConfigFile = {
      filePath: '/tmp/auth.json',
      relativePath: 'auth.json',
      configType: 'json',
      purpose: 'general_configuration',
      settings: [{ key: 'jwt_secret', value: 'secret123', valueType: 'string' }],
      patterns: [],
      parseErrors: [],
    };

    const patterns = detector.detectPatterns(configFile);

    expect(patterns).toContain('auth_config');
  });

  it('should return empty array for unrecognized patterns', () => {
    const configFile: ConfigFile = {
      filePath: '/tmp/random.json',
      relativePath: 'random.json',
      configType: 'json',
      purpose: 'general_configuration',
      settings: [
        { key: 'foo', value: 'bar', valueType: 'string' },
        { key: 'baz', value: 123, valueType: 'integer' },
      ],
      patterns: [],
      parseErrors: [],
    };

    const patterns = detector.detectPatterns(configFile);

    expect(patterns).toHaveLength(0);
  });
});

// ============================================================================
// inferValueType Tests
// ============================================================================

describe('inferValueType', () => {
  it('should correctly infer types', () => {
    expect(inferValueType(null)).toBe('null');
    expect(inferValueType(true)).toBe('boolean');
    expect(inferValueType(false)).toBe('boolean');
    expect(inferValueType(42)).toBe('integer');
    expect(inferValueType(3.14)).toBe('number');
    expect(inferValueType('hello')).toBe('string');
    expect(inferValueType([1, 2, 3])).toBe('array');
    expect(inferValueType({ a: 1 })).toBe('object');
  });
});

// ============================================================================
// ConfigAnalyzer Integration Tests
// ============================================================================

describe('ConfigAnalyzer', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(tmpdir(), 'preflight-config-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should analyze JSON config file', async () => {
    // Create test config file
    const configContent = JSON.stringify({
      database: {
        host: 'localhost',
        port: 5432,
      },
    });
    await fs.writeFile(path.join(tmpDir, 'config.json'), configContent);

    const files = [createMockFile('config.json', tmpDir)];
    const input = createMockInput(tmpDir, files);
    const analyzer = createConfigAnalyzer();

    const result = await analyzer.analyze(input);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.totalFiles).toBe(1);
    expect(result.data!.totalSettings).toBe(2);
    expect(result.data!.configFiles[0]?.configType).toBe('json');
  });

  it('should analyze .env config file', async () => {
    const envContent = `
DATABASE_HOST=localhost
DATABASE_PORT=5432
DEBUG=true
`;
    await fs.writeFile(path.join(tmpDir, '.env'), envContent);

    const files = [createMockFile('.env', tmpDir)];
    const input = createMockInput(tmpDir, files);
    const analyzer = createConfigAnalyzer();

    const result = await analyzer.analyze(input);

    expect(result.success).toBe(true);
    expect(result.data!.totalFiles).toBe(1);
    expect(result.data!.totalSettings).toBe(3);
    expect(result.data!.configFiles[0]?.purpose).toBe('environment_configuration');
  });

  it('should detect patterns across multiple files', async () => {
    // Database config
    const dbConfig = JSON.stringify({
      host: 'localhost',
      port: 5432,
      database: 'mydb',
      user: 'admin',
    });
    await fs.writeFile(path.join(tmpDir, 'database.json'), dbConfig);

    // API config
    const apiConfig = JSON.stringify({
      base_url: 'https://api.example.com',
      api_key: 'key123',
      timeout: 5000,
    });
    await fs.writeFile(path.join(tmpDir, 'api.json'), apiConfig);

    const files = [
      createMockFile('database.json', tmpDir),
      createMockFile('api.json', tmpDir),
    ];
    const input = createMockInput(tmpDir, files);

    const result = await extractConfig(input, { detectPatterns: true });

    expect(result.success).toBe(true);
    expect(result.data!.detectedPatterns).toBeDefined();
    expect(Object.keys(result.data!.detectedPatterns).length).toBeGreaterThan(0);
  });

  it('should handle empty file list', async () => {
    const input = createMockInput(tmpDir, []);
    const analyzer = createConfigAnalyzer();

    const result = await analyzer.analyze(input);

    expect(result.success).toBe(true);
    expect(result.data!.totalFiles).toBe(0);
    expect(result.data!.totalSettings).toBe(0);
  });

  it('should respect maxConfigFiles option', async () => {
    // Create multiple config files
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(
        path.join(tmpDir, `config${i}.json`),
        JSON.stringify({ key: `value${i}` })
      );
    }

    const files = Array.from({ length: 5 }, (_, i) =>
      createMockFile(`config${i}.json`, tmpDir)
    );
    const input = createMockInput(tmpDir, files);

    const result = await extractConfig(input, { maxConfigFiles: 2 });

    expect(result.success).toBe(true);
    expect(result.data!.totalFiles).toBe(2);
  });

  it('should filter by config types', async () => {
    await fs.writeFile(path.join(tmpDir, 'config.json'), '{}');
    await fs.writeFile(path.join(tmpDir, '.env'), 'KEY=value');

    const files = [
      createMockFile('config.json', tmpDir),
      createMockFile('.env', tmpDir),
    ];
    const input = createMockInput(tmpDir, files);

    const result = await extractConfig(input, { configTypes: ['json'] });

    expect(result.success).toBe(true);
    expect(result.data!.totalFiles).toBe(1);
    expect(result.data!.configFiles[0]?.configType).toBe('json');
  });

  it('should include raw content when requested', async () => {
    const content = '{"key": "value"}';
    await fs.writeFile(path.join(tmpDir, 'config.json'), content);

    const files = [createMockFile('config.json', tmpDir)];
    const input = createMockInput(tmpDir, files);

    const result = await extractConfig(input, { includeRawContent: true });

    expect(result.success).toBe(true);
    expect(result.data!.configFiles[0]?.rawContent).toBe(content);
  });

  it('should not include raw content by default', async () => {
    await fs.writeFile(path.join(tmpDir, 'config.json'), '{"key": "value"}');

    const files = [createMockFile('config.json', tmpDir)];
    const input = createMockInput(tmpDir, files);

    const result = await extractConfig(input);

    expect(result.success).toBe(true);
    expect(result.data!.configFiles[0]?.rawContent).toBeUndefined();
  });

  it('should return metadata with analyzer info', async () => {
    const files = [createMockFile('config.json', tmpDir)];
    await fs.writeFile(path.join(tmpDir, 'config.json'), '{}');

    const input = createMockInput(tmpDir, files);
    const result = await extractConfig(input);

    expect(result.metadata.analyzerName).toBe('config-analyzer');
    expect(result.metadata.version).toBe('1.0.0');
    expect(result.metadata.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should handle parse errors gracefully', async () => {
    await fs.writeFile(path.join(tmpDir, 'invalid.json'), '{ invalid json }');

    const files = [createMockFile('invalid.json', tmpDir)];
    const input = createMockInput(tmpDir, files);

    const result = await extractConfig(input);

    expect(result.success).toBe(true); // Still succeeds overall
    expect(result.data!.configFiles[0]?.parseErrors.length).toBeGreaterThan(0);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some((e) => e.recoverable)).toBe(true);
  });
});
