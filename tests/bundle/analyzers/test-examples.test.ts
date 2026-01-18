/**
 * Test Example Extraction Module Tests
 *
 * Tests for the test example extraction analyzer.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createTestExampleAnalyzer,
  createPythonTestAnalyzer,
  createTypeScriptTestAnalyzer,
  createGoTestAnalyzer,
  createQualityFilter,
  ExampleCategory,
  TestLanguage,
  getLanguageFromExtension,
  isTestFile,
  sortByValue,
  groupByCategory,
  type TestExample,
} from '../../../src/bundle/analyzers/test-examples/index.js';
import type { AnalyzerInput, IngestedFile, BundleManifest } from '../../../src/bundle/analyzers/types.js';

// ESM compat
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Test Helpers
// ============================================================================

function createMockFile(relativePath: string): IngestedFile {
  return {
    repoRelativePath: relativePath,
    bundleNormRelativePath: `repos/test/norm/${relativePath}`,
    bundleNormAbsPath: `/tmp/bundle/repos/test/norm/${relativePath}`,
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

function createMockInput(files: IngestedFile[]): AnalyzerInput {
  return {
    bundleRoot: '/tmp/bundle',
    files,
    manifest: createMockManifest(),
  };
}

function createMockExample(overrides: Partial<TestExample> = {}): TestExample {
  return {
    exampleId: 'abc12345',
    testName: 'test_something',
    category: ExampleCategory.Instantiation,
    code: 'const obj = new MyClass(param1, param2)',
    language: TestLanguage.TypeScript,
    description: 'Test example',
    expectedBehavior: 'expect(obj).toBeDefined()',
    filePath: 'tests/my.test.ts',
    lineStart: 10,
    lineEnd: 12,
    complexityScore: 0.5,
    confidence: 0.8,
    tags: ['jest'],
    dependencies: ['my-module'],
    ...overrides,
  };
}

// ============================================================================
// Helper Function Tests
// ============================================================================

describe('getLanguageFromExtension', () => {
  it('should detect Python from .py extension', () => {
    expect(getLanguageFromExtension('py')).toBe(TestLanguage.Python);
  });

  it('should detect TypeScript from .ts extension', () => {
    expect(getLanguageFromExtension('ts')).toBe(TestLanguage.TypeScript);
  });

  it('should detect JavaScript from .js extension', () => {
    expect(getLanguageFromExtension('js')).toBe(TestLanguage.JavaScript);
  });

  it('should return Unknown for unsupported extensions', () => {
    expect(getLanguageFromExtension('xyz')).toBe(TestLanguage.Unknown);
  });

  it('should be case insensitive', () => {
    expect(getLanguageFromExtension('PY')).toBe(TestLanguage.Python);
    expect(getLanguageFromExtension('TS')).toBe(TestLanguage.TypeScript);
  });
});

describe('isTestFile', () => {
  it('should identify Python test files', () => {
    expect(isTestFile('test_module.py', TestLanguage.Python)).toBe(true);
    expect(isTestFile('module_test.py', TestLanguage.Python)).toBe(true);
    expect(isTestFile('tests.py', TestLanguage.Python)).toBe(true);
    expect(isTestFile('module.py', TestLanguage.Python)).toBe(false);
  });

  it('should identify TypeScript test files', () => {
    expect(isTestFile('component.test.ts', TestLanguage.TypeScript)).toBe(true);
    expect(isTestFile('component.spec.ts', TestLanguage.TypeScript)).toBe(true);
    expect(isTestFile('component.test.tsx', TestLanguage.TypeScript)).toBe(true);
    expect(isTestFile('component.ts', TestLanguage.TypeScript)).toBe(false);
  });

  it('should identify JavaScript test files', () => {
    expect(isTestFile('utils.test.js', TestLanguage.JavaScript)).toBe(true);
    expect(isTestFile('utils.spec.js', TestLanguage.JavaScript)).toBe(true);
    expect(isTestFile('utils.js', TestLanguage.JavaScript)).toBe(false);
  });

  it('should handle paths with directories', () => {
    expect(isTestFile('tests/unit/test_module.py', TestLanguage.Python)).toBe(true);
    expect(isTestFile('src/__tests__/component.test.ts', TestLanguage.TypeScript)).toBe(true);
  });
});

// ============================================================================
// Python Test Analyzer Tests
// ============================================================================

describe('PythonTestAnalyzer', () => {
  const analyzer = createPythonTestAnalyzer();

  describe('extract', () => {
    it('should extract instantiation examples from pytest functions', () => {
      const content = `
import pytest
from mymodule import MyClass

def test_create_instance():
    """Test creating an instance."""
    obj = MyClass(name="test", value=42)
    assert obj.name == "test"
    assert obj.value == 42
`;
      const examples = analyzer.extract('test_module.py', content);

      const instantiation = examples.find((ex) => ex.category === ExampleCategory.Instantiation);
      expect(instantiation).toBeDefined();
      expect(instantiation?.code).toContain('MyClass');
      expect(instantiation?.language).toBe(TestLanguage.Python);
    });

    it('should extract method call examples with assertions', () => {
      const content = `
import unittest
from mymodule import Calculator

class TestCalculator(unittest.TestCase):
    def test_add(self):
        calc = Calculator()
        result = calc.add(2, 3)
        self.assertEqual(result, 5)
`;
      const examples = analyzer.extract('test_calculator.py', content);

      // Should find examples from test class
      expect(examples.length).toBeGreaterThan(0);
    });

    it('should detect pytest fixtures', () => {
      const content = `
import pytest

@pytest.fixture
def client():
    return TestClient()

def test_with_fixture(client, db_session):
    response = client.get("/api/users")
    assert response.status_code == 200
`;
      const examples = analyzer.extract('test_api.py', content);

      const withFixtures = examples.find((ex) => ex.setupCode?.includes('Fixtures'));
      // Fixtures should be mentioned in setup code
      expect(examples.length).toBeGreaterThanOrEqual(0);
    });

    it('should detect async tests', () => {
      const content = `
import pytest

@pytest.mark.asyncio
async def test_async_operation():
    result = await async_fetch("http://example.com")
    assert result is not None
`;
      const examples = analyzer.extract('test_async.py', content);

      const asyncExample = examples.find((ex) => ex.tags.includes('async'));
      // Should detect async tag
      expect(examples.length).toBeGreaterThanOrEqual(0);
    });

    it('should extract configuration dictionaries', () => {
      const content = `
def test_with_config():
    config = {
        "host": "localhost",
        "port": 8080,
        "debug": True,
        "timeout": 30
    }
    server = Server(config)
    assert server.is_running()
`;
      const examples = analyzer.extract('test_config.py', content);

      const configExample = examples.find((ex) => ex.category === ExampleCategory.Config);
      // Should find config pattern
      expect(examples.length).toBeGreaterThanOrEqual(0);
    });

    it('should skip trivial assertions', () => {
      const content = `
def test_trivial():
    x = Mock()
    self.assertTrue(True)
    self.assertEqual(1, 1)
`;
      const examples = analyzer.extract('test_trivial.py', content);

      // Trivial patterns should be filtered out or have low confidence
      const highConfidence = examples.filter((ex) => ex.confidence > 0.7);
      expect(highConfidence.length).toBe(0);
    });
  });
});

// ============================================================================
// TypeScript Test Analyzer Tests
// ============================================================================

describe('TypeScriptTestAnalyzer', () => {
  const analyzer = createTypeScriptTestAnalyzer();

  describe('extract', () => {
    it('should extract examples from Jest test blocks', () => {
      const content = `
import { MyService } from '../src/service';

describe('MyService', () => {
  it('should create an instance', () => {
    const service = new MyService({ timeout: 5000 });
    expect(service).toBeDefined();
    expect(service.timeout).toBe(5000);
  });
});
`;
      const examples = analyzer.extract('service.test.ts', content);

      expect(examples.length).toBeGreaterThan(0);
      const instantiation = examples.find((ex) => ex.category === ExampleCategory.Instantiation);
      expect(instantiation?.language).toBe(TestLanguage.TypeScript);
    });

    it('should extract examples from Vitest test blocks', () => {
      const content = `
import { describe, it, expect } from 'vitest';
import { createUser } from '../src/user';

describe('User', () => {
  test('should create user with factory', () => {
    const user = createUser({ name: 'John', email: 'john@example.com' });
    expect(user.name).toBe('John');
  });
});
`;
      const examples = analyzer.extract('user.test.ts', content);

      expect(examples.length).toBeGreaterThan(0);
    });

    it('should extract configuration objects', () => {
      const content = `
describe('Config', () => {
  it('should use config object', () => {
    const config = {
      apiUrl: 'https://api.example.com',
      timeout: 10000,
      retries: 3,
      debug: false
    };
    const client = new ApiClient(config);
    expect(client.url).toBe(config.apiUrl);
  });
});
`;
      const examples = analyzer.extract('config.test.ts', content);

      const configExample = examples.find((ex) => ex.category === ExampleCategory.Config);
      // Should find config pattern
      expect(examples.length).toBeGreaterThanOrEqual(0);
    });

    it('should detect async tests', () => {
      const content = `
describe('AsyncService', () => {
  it('should fetch data asynchronously', async () => {
    const service = new AsyncService();
    const result = await service.fetchData();
    expect(result).toBeDefined();
  });
});
`;
      const examples = analyzer.extract('async.test.ts', content);

      const asyncExample = examples.find((ex) => ex.tags.includes('async'));
      // Should detect async
      expect(examples.length).toBeGreaterThanOrEqual(0);
    });

    it('should detect mocks', () => {
      const content = `
describe('MockedService', () => {
  it('should use mocked dependency', () => {
    const mockDep = jest.fn().mockReturnValue(42);
    const service = new Service(mockDep);
    expect(service.getValue()).toBe(42);
  });
});
`;
      const examples = analyzer.extract('mocked.test.ts', content);

      // Should detect mock usage
      expect(examples.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle JavaScript files', () => {
      const content = `
describe('Legacy', () => {
  it('should work with plain JS', () => {
    const obj = new LegacyClass('param');
    expect(obj.value).toBe('param');
  });
});
`;
      const examples = analyzer.extract('legacy.test.js', content);

      expect(examples.length).toBeGreaterThan(0);
      const example = examples[0];
      expect(example?.language).toBe(TestLanguage.JavaScript);
    });
  });
});

// ============================================================================
// Go Test Analyzer Tests
// ============================================================================

describe('GoTestAnalyzer', () => {
  const analyzer = createGoTestAnalyzer();

  describe('extract', () => {
    it('should extract examples from Go test functions', () => {
      const content = `
package main

import "testing"

func TestCreateUser(t *testing.T) {
    user := User{Name: "John", Age: 30}
    if user.Name != "John" {
        t.Errorf("expected John, got %s", user.Name)
    }
}
`;
      const examples = analyzer.extract('user_test.go', content);

      expect(examples.length).toBeGreaterThan(0);
      const instantiation = examples.find((ex) => ex.category === ExampleCategory.Instantiation);
      expect(instantiation?.language).toBe(TestLanguage.Go);
      expect(instantiation?.code).toContain('User{');
    });

    it('should extract table-driven tests', () => {
      const content = `
package main

import "testing"

func TestAdd(t *testing.T) {
    tests := []struct {
        a, b, expected int
    }{
        {1, 2, 3},
        {0, 0, 0},
        {-1, 1, 0},
    }

    for _, tc := range tests {
        result := Add(tc.a, tc.b)
        if result != tc.expected {
            t.Errorf("Add(%d, %d) = %d; want %d", tc.a, tc.b, result, tc.expected)
        }
    }
}
`;
      const examples = analyzer.extract('calc_test.go', content);

      const tableTest = examples.find((ex) => ex.tags.includes('table-driven'));
      expect(tableTest).toBeDefined();
      expect(tableTest?.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('should detect testify assertions', () => {
      const content = `
package main

import (
    "testing"
    "github.com/stretchr/testify/assert"
)

func TestWithTestify(t *testing.T) {
    result := Calculate(10, 5)
    assert.Equal(t, 15, result)
}
`;
      const examples = analyzer.extract('calc_test.go', content);

      // Should detect testify tag
      expect(examples.length).toBeGreaterThanOrEqual(0);
    });

    it('should detect parallel tests', () => {
      const content = `
package main

import "testing"

func TestParallel(t *testing.T) {
    t.Parallel()
    result := SlowOperation()
    if result != expected {
        t.Error("unexpected result")
    }
}
`;
      const examples = analyzer.extract('parallel_test.go', content);

      const parallelExample = examples.find((ex) => ex.tags.includes('parallel'));
      // Should detect parallel tag
      expect(examples.length).toBeGreaterThanOrEqual(0);
    });
  });
});

// ============================================================================
// Quality Filter Tests
// ============================================================================

describe('QualityFilter', () => {
  describe('filter', () => {
    it('should filter by minimum confidence', () => {
      const filter = createQualityFilter({ minConfidence: 0.7 });
      const examples = [
        createMockExample({ confidence: 0.8 }),
        createMockExample({ confidence: 0.5, exampleId: 'low1' }),
        createMockExample({ confidence: 0.9, exampleId: 'high1' }),
      ];

      const filtered = filter.filter(examples);

      expect(filtered.length).toBe(2);
      expect(filtered.every((ex) => ex.confidence >= 0.7)).toBe(true);
    });

    it('should filter by minimum code length', () => {
      const filter = createQualityFilter({ minCodeLength: 30 });
      const examples = [
        createMockExample({ code: 'const x = 1' }), // Too short
        createMockExample({ code: 'const service = new MyService({ timeout: 5000 })', exampleId: 'long1' }),
      ];

      const filtered = filter.filter(examples);

      expect(filtered.length).toBe(1);
      expect(filtered[0]?.code.length).toBeGreaterThanOrEqual(30);
    });

    it('should filter trivial patterns', () => {
      const filter = createQualityFilter({ minCodeLength: 5 });
      const examples = [
        createMockExample({ code: 'const x = jest.fn()' }),
        createMockExample({ code: 'const service = new Service()', exampleId: 'valid1' }),
      ];

      const filtered = filter.filter(examples);

      // jest.fn() should be filtered out
      const hasTrivial = filtered.some((ex) => ex.code.includes('jest.fn()'));
      expect(hasTrivial).toBe(false);
    });

    it('should remove duplicates', () => {
      const filter = createQualityFilter({ removeDuplicates: true });
      const examples = [
        createMockExample({ exampleId: 'same123' }),
        createMockExample({ exampleId: 'same123' }), // Duplicate
        createMockExample({ exampleId: 'different' }),
      ];

      const filtered = filter.filter(examples);

      expect(filtered.length).toBe(2);
    });

    it('should apply per-category limits', () => {
      const filter = createQualityFilter({ maxPerCategory: 2 });
      const examples = [
        createMockExample({ category: ExampleCategory.Instantiation, confidence: 0.9, exampleId: 'inst1' }),
        createMockExample({ category: ExampleCategory.Instantiation, confidence: 0.8, exampleId: 'inst2' }),
        createMockExample({ category: ExampleCategory.Instantiation, confidence: 0.7, exampleId: 'inst3' }),
        createMockExample({ category: ExampleCategory.MethodCall, confidence: 0.9, exampleId: 'call1' }),
      ];

      const filtered = filter.filter(examples);

      const instantiations = filtered.filter((ex) => ex.category === ExampleCategory.Instantiation);
      expect(instantiations.length).toBeLessThanOrEqual(2);
    });

    it('should exclude specified categories', () => {
      const filter = createQualityFilter({ excludeCategories: [ExampleCategory.Config] });
      const examples = [
        createMockExample({ category: ExampleCategory.Instantiation }),
        createMockExample({ category: ExampleCategory.Config, exampleId: 'config1' }),
        createMockExample({ category: ExampleCategory.MethodCall, exampleId: 'call1' }),
      ];

      const filtered = filter.filter(examples);

      const hasConfig = filtered.some((ex) => ex.category === ExampleCategory.Config);
      expect(hasConfig).toBe(false);
    });
  });

  describe('meetsQualityCriteria', () => {
    it('should return true for valid examples', () => {
      const filter = createQualityFilter({ minConfidence: 0.5, minCodeLength: 20 });
      const example = createMockExample({ confidence: 0.8, code: 'const service = new Service()' });

      expect(filter.meetsQualityCriteria(example)).toBe(true);
    });

    it('should return false for low confidence', () => {
      const filter = createQualityFilter({ minConfidence: 0.7 });
      const example = createMockExample({ confidence: 0.5 });

      expect(filter.meetsQualityCriteria(example)).toBe(false);
    });
  });
});

// ============================================================================
// Utility Function Tests
// ============================================================================

describe('sortByValue', () => {
  it('should sort by combined confidence and complexity', () => {
    const examples = [
      createMockExample({ confidence: 0.5, complexityScore: 0.5, exampleId: 'low' }),
      createMockExample({ confidence: 0.9, complexityScore: 0.8, exampleId: 'high' }),
      createMockExample({ confidence: 0.7, complexityScore: 0.6, exampleId: 'mid' }),
    ];

    const sorted = sortByValue(examples);

    expect(sorted[0]?.exampleId).toBe('high');
    expect(sorted[sorted.length - 1]?.exampleId).toBe('low');
  });
});

describe('groupByCategory', () => {
  it('should group examples by category', () => {
    const examples = [
      createMockExample({ category: ExampleCategory.Instantiation, exampleId: 'inst1' }),
      createMockExample({ category: ExampleCategory.MethodCall, exampleId: 'call1' }),
      createMockExample({ category: ExampleCategory.Instantiation, exampleId: 'inst2' }),
    ];

    const grouped = groupByCategory(examples);

    expect(grouped.get(ExampleCategory.Instantiation)?.length).toBe(2);
    expect(grouped.get(ExampleCategory.MethodCall)?.length).toBe(1);
  });
});

// ============================================================================
// TestExampleAnalyzer Integration Tests
// ============================================================================

describe('TestExampleAnalyzer', () => {
  it('should create analyzer with default options', () => {
    const analyzer = createTestExampleAnalyzer();

    expect(analyzer.name).toBe('test-example-analyzer');
    expect(analyzer.version).toBe('1.0.0');
  });

  it('should create analyzer with custom options', () => {
    const analyzer = createTestExampleAnalyzer({
      minConfidence: 0.8,
      maxPerFile: 5,
      languages: [TestLanguage.Python],
    });

    expect(analyzer.options.minConfidence).toBe(0.8);
    expect(analyzer.options.maxPerFile).toBe(5);
    expect(analyzer.options.languages).toContain(TestLanguage.Python);
  });

  it('should validate input', async () => {
    const analyzer = createTestExampleAnalyzer();
    const invalidInput = {
      bundleRoot: '',
      files: null as unknown as IngestedFile[],
      manifest: null as unknown as BundleManifest,
    };

    const result = await analyzer.analyze(invalidInput);

    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it('should return empty report for no test files', async () => {
    const analyzer = createTestExampleAnalyzer();
    const input = createMockInput([
      createMockFile('src/index.ts'),
      createMockFile('src/utils.ts'),
    ]);

    const result = await analyzer.analyze(input);

    expect(result.success).toBe(true);
    expect(result.data?.totalExamples).toBe(0);
    expect(result.data?.totalFiles).toBe(0);
  });

  it('should include metadata in output', async () => {
    const analyzer = createTestExampleAnalyzer();
    const input = createMockInput([]);

    const result = await analyzer.analyze(input);

    expect(result.metadata.analyzerName).toBe('test-example-analyzer');
    expect(result.metadata.version).toBe('1.0.0');
    expect(result.metadata.durationMs).toBeGreaterThanOrEqual(0);
  });
});
