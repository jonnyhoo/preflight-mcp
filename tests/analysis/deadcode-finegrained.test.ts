/**
 * Tests for Fine-grained Dead Code Detection
 *
 * Tests unused parameters, local variables, and private fields
 * for JS/TS, Python, Go, Java, and Rust.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { analyzeFineGrained } from '../../src/analysis/check/deadcode/fine-grained.js';
import { parseFileWasm } from '../../src/ast/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Test Fixtures
// ============================================================================

const FIXTURES = {
  typescript: `
class MyClass {
  private unusedField: string = 'unused';
  private usedField: string = 'used';
  #privateUnused: number = 42;
  #privateUsed: number = 0;

  method() {
    console.log(this.usedField);
    this.#privateUsed = 1;
  }
}

function withUnusedParam(used: string, unused: number): string {
  return used;
}

function withUnusedLocal(): void {
  const used = 'hello';
  const unused = 'world';
  console.log(used);
}

// Ignored: underscore prefix
function ignoredParams(_ignored: string, used: string): string {
  return used;
}

// Dynamic access should suppress private field warnings
class DynamicClass {
  private maybeUsed: string = 'dynamic';

  method(key: string) {
    return this[key as keyof this];
  }
}
`,

  javascript: `
class JsClass {
  #unusedPrivate = 'unused';
  #usedPrivate = 'used';

  method() {
    return this.#usedPrivate;
  }
}

function jsFunc(used, unused) {
  const localUsed = 'yes';
  const localUnused = 'no';
  return used + localUsed;
}
`,

  python: `
class MyClass:
    def __init__(self):
        self._unused_field = 'unused'
        self._used_field = 'used'

    def method(self):
        return self._used_field


def func_with_unused(used, unused):
    local_used = 'hello'
    local_unused = 'world'
    return used + local_used


def ignored_params(_ignored, used):
    return used


# Dynamic access should suppress warnings
class DynamicClass:
    def __init__(self):
        self._maybe_used = 'dynamic'

    def method(self, key):
        return getattr(self, key)
`,

  go: `
package main

type MyStruct struct {
    unusedField string
    UsedField   string
}

func (s *MyStruct) Method() string {
    return s.UsedField
}

func funcWithUnused(used string, unused int) string {
    localUsed := "hello"
    localUnused := "world"
    _ = localUnused
    return used + localUsed
}

func ignoredParams(_ string, used string) string {
    return used
}
`,

  java: `
public class MyClass {
    private String unusedField = "unused";
    private String usedField = "used";

    public String method() {
        return usedField;
    }

    public String funcWithUnused(String used, int unused) {
        String localUsed = "hello";
        String localUnused = "world";
        return used + localUsed;
    }
}
`,

  rust: `
struct MyStruct {
    unused_field: String,
    pub used_field: String,
}

impl MyStruct {
    fn method(&self) -> &str {
        &self.used_field
    }

    fn func_with_unused(used: &str, unused: i32) -> String {
        let local_used = "hello";
        let local_unused = "world";
        format!("{}{}", used, local_used)
    }
}

fn ignored_params(_ignored: &str, used: &str) -> &str {
    used
}
`,
};

// ============================================================================
// Helper Functions
// ============================================================================

async function analyzeFixture(
  content: string,
  ext: string
): Promise<ReturnType<typeof analyzeFineGrained>> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deadcode-test-'));
  const filePath = path.join(tmpDir, `test${ext}`);

  try {
    await fs.writeFile(filePath, content, 'utf8');
    const tree = await parseFileWasm(filePath, content);
    if (!tree) return [];

    const lang = ext === '.ts' || ext === '.tsx' ? 'typescript' :
                 ext === '.js' || ext === '.jsx' ? 'javascript' :
                 ext === '.py' ? 'python' :
                 ext === '.go' ? 'go' :
                 ext === '.java' ? 'java' :
                 ext === '.rs' ? 'rust' : null;

    if (!lang) return [];

    try {
      return analyzeFineGrained(tree, lang, filePath);
    } finally {
      tree.delete();
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('Fine-grained Dead Code Detection', () => {
  describe('TypeScript', () => {
    it('should detect unused private fields', async () => {
      const issues = await analyzeFixture(FIXTURES.typescript, '.ts');
      const privateFieldIssues = issues.filter(i => i.type === 'unused-private-field');

      expect(privateFieldIssues.some(i => i.symbolName === 'unusedField')).toBe(true);
      expect(privateFieldIssues.some(i => i.symbolName === '#privateUnused')).toBe(true);

      // Should NOT report used fields
      expect(privateFieldIssues.some(i => i.symbolName === 'usedField')).toBe(false);
      expect(privateFieldIssues.some(i => i.symbolName === '#privateUsed')).toBe(false);
    });

    it('should detect unused parameters', async () => {
      const issues = await analyzeFixture(FIXTURES.typescript, '.ts');
      const paramIssues = issues.filter(i => i.type === 'unused-parameter');

      expect(paramIssues.some(i => i.symbolName === 'unused')).toBe(true);
      expect(paramIssues.some(i => i.symbolName === 'used')).toBe(false);
    });

    it('should detect unused local variables', async () => {
      const issues = await analyzeFixture(FIXTURES.typescript, '.ts');
      const localIssues = issues.filter(i => i.type === 'unused-local-variable');

      expect(localIssues.some(i => i.symbolName === 'unused')).toBe(true);
      expect(localIssues.some(i => i.symbolName === 'used')).toBe(false);
    });

    it('should ignore underscore-prefixed names', async () => {
      const issues = await analyzeFixture(FIXTURES.typescript, '.ts');

      expect(issues.some(i => i.symbolName === '_ignored')).toBe(false);
    });

    it('should suppress private field warnings for classes with dynamic access', async () => {
      const issues = await analyzeFixture(FIXTURES.typescript, '.ts');
      const dynamicIssues = issues.filter(i => i.className === 'DynamicClass');

      expect(dynamicIssues.length).toBe(0);
    });
  });

  describe('JavaScript', () => {
    it('should detect unused private fields (#syntax)', async () => {
      const issues = await analyzeFixture(FIXTURES.javascript, '.js');
      const privateFieldIssues = issues.filter(i => i.type === 'unused-private-field');

      expect(privateFieldIssues.some(i => i.symbolName === '#unusedPrivate')).toBe(true);
      expect(privateFieldIssues.some(i => i.symbolName === '#usedPrivate')).toBe(false);
    });

    it('should detect unused parameters and locals', async () => {
      const issues = await analyzeFixture(FIXTURES.javascript, '.js');

      expect(issues.some(i => i.type === 'unused-parameter' && i.symbolName === 'unused')).toBe(true);
      expect(issues.some(i => i.type === 'unused-local-variable' && i.symbolName === 'localUnused')).toBe(true);
    });
  });

  describe('Python', () => {
    it('should detect unused private fields (_prefix)', async () => {
      const issues = await analyzeFixture(FIXTURES.python, '.py');
      const privateFieldIssues = issues.filter(i => i.type === 'unused-private-field');

      expect(privateFieldIssues.some(i => i.symbolName === '_unused_field')).toBe(true);
      expect(privateFieldIssues.some(i => i.symbolName === '_used_field')).toBe(false);
    });

    it('should detect unused parameters and locals', async () => {
      const issues = await analyzeFixture(FIXTURES.python, '.py');

      expect(issues.some(i => i.type === 'unused-parameter' && i.symbolName === 'unused')).toBe(true);
      expect(issues.some(i => i.type === 'unused-local-variable' && i.symbolName === 'local_unused')).toBe(true);
    });

    it('should suppress private field warnings for classes using getattr/setattr', async () => {
      const issues = await analyzeFixture(FIXTURES.python, '.py');
      const dynamicIssues = issues.filter(i => i.className === 'DynamicClass');

      expect(dynamicIssues.length).toBe(0);
    });
  });

  describe('Go', () => {
    it('should detect unused private struct fields (lowercase)', async () => {
      const issues = await analyzeFixture(FIXTURES.go, '.go');
      const privateFieldIssues = issues.filter(i => i.type === 'unused-private-field');

      expect(privateFieldIssues.some(i => i.symbolName === 'unusedField')).toBe(true);
      // UsedField is exported (uppercase), should not be reported
    });

    it('should detect unused parameters and locals', async () => {
      const issues = await analyzeFixture(FIXTURES.go, '.go');

      expect(issues.some(i => i.type === 'unused-parameter' && i.symbolName === 'unused')).toBe(true);
      // localUnused is assigned to _, so it may or may not be detected depending on implementation
    });
  });

  describe('Java', () => {
    it('should detect unused private fields', async () => {
      const issues = await analyzeFixture(FIXTURES.java, '.java');
      const privateFieldIssues = issues.filter(i => i.type === 'unused-private-field');

      expect(privateFieldIssues.some(i => i.symbolName === 'unusedField')).toBe(true);
      expect(privateFieldIssues.some(i => i.symbolName === 'usedField')).toBe(false);
    });

    it('should detect unused parameters and locals', async () => {
      const issues = await analyzeFixture(FIXTURES.java, '.java');

      expect(issues.some(i => i.type === 'unused-parameter' && i.symbolName === 'unused')).toBe(true);
      expect(issues.some(i => i.type === 'unused-local-variable' && i.symbolName === 'localUnused')).toBe(true);
    });
  });

  describe('Rust', () => {
    it('should detect unused private struct fields (non-pub)', async () => {
      const issues = await analyzeFixture(FIXTURES.rust, '.rs');
      const privateFieldIssues = issues.filter(i => i.type === 'unused-private-field');

      expect(privateFieldIssues.some(i => i.symbolName === 'unused_field')).toBe(true);
      // used_field is pub, should not be reported
    });

    it('should detect unused parameters and locals', async () => {
      const issues = await analyzeFixture(FIXTURES.rust, '.rs');

      expect(issues.some(i => i.type === 'unused-parameter' && i.symbolName === 'unused')).toBe(true);
      expect(issues.some(i => i.type === 'unused-local-variable' && i.symbolName === 'local_unused')).toBe(true);
    });

    it('should ignore underscore-prefixed names', async () => {
      const issues = await analyzeFixture(FIXTURES.rust, '.rs');

      expect(issues.some(i => i.symbolName === '_ignored')).toBe(false);
    });
  });
});
