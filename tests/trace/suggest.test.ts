import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { suggestTestedByTraces } from '../../src/trace/suggest.js';

describe('suggestTestedByTraces', () => {
  let root: string;
  let bundleRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'preflight-suggest-'));
    bundleRoot = path.join(root, 'bundle');

    // Create bundle structure
    const normDir = path.join(bundleRoot, 'repos', 'acme', 'demo', 'norm');
    await fs.mkdir(path.join(normDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(normDir, 'tests'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('matches Python test_*.py pattern', async () => {
    const normDir = path.join(bundleRoot, 'repos', 'acme', 'demo', 'norm');
    await fs.writeFile(path.join(normDir, 'src', 'foo.py'), 'def foo(): pass\n', 'utf8');
    await fs.writeFile(path.join(normDir, 'src', 'test_foo.py'), 'def test_foo(): pass\n', 'utf8');

    const result = await suggestTestedByTraces(bundleRoot, {
      bundleId: 'test-bundle',
      edgeType: 'tested_by',
      scope: 'repo',
      minConfidence: 0.8,
      limit: 10,
      skipExisting: false,
    });

    expect(result.suggestions.length).toBe(1);
    expect(result.suggestions[0]?.source.id).toContain('foo.py');
    expect(result.suggestions[0]?.target.id).toContain('test_foo.py');
    expect(result.suggestions[0]?.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.suggestions[0]?.method).toBe('exact');
  });

  it('matches Python *_test.py pattern', async () => {
    const normDir = path.join(bundleRoot, 'repos', 'acme', 'demo', 'norm');
    await fs.writeFile(path.join(normDir, 'src', 'bar.py'), 'def bar(): pass\n', 'utf8');
    await fs.writeFile(path.join(normDir, 'src', 'bar_test.py'), 'def test_bar(): pass\n', 'utf8');

    const result = await suggestTestedByTraces(bundleRoot, {
      bundleId: 'test-bundle',
      edgeType: 'tested_by',
      scope: 'repo',
      minConfidence: 0.8,
      limit: 10,
      skipExisting: false,
    });

    expect(result.suggestions.length).toBe(1);
    expect(result.suggestions[0]?.source.id).toContain('bar.py');
    expect(result.suggestions[0]?.target.id).toContain('bar_test.py');
  });

  it('matches TypeScript *.test.ts pattern', async () => {
    const normDir = path.join(bundleRoot, 'repos', 'acme', 'demo', 'norm');
    await fs.writeFile(path.join(normDir, 'src', 'utils.ts'), 'export const x = 1;\n', 'utf8');
    await fs.writeFile(path.join(normDir, 'src', 'utils.test.ts'), 'test("x", () => {});\n', 'utf8');

    const result = await suggestTestedByTraces(bundleRoot, {
      bundleId: 'test-bundle',
      edgeType: 'tested_by',
      scope: 'repo',
      minConfidence: 0.8,
      limit: 10,
      skipExisting: false,
    });

    expect(result.suggestions.length).toBe(1);
    expect(result.suggestions[0]?.source.id).toContain('utils.ts');
    expect(result.suggestions[0]?.target.id).toContain('utils.test.ts');
  });

  it('matches Go *_test.go pattern', async () => {
    const normDir = path.join(bundleRoot, 'repos', 'acme', 'demo', 'norm');
    await fs.writeFile(path.join(normDir, 'src', 'main.go'), 'package main\n', 'utf8');
    await fs.writeFile(path.join(normDir, 'src', 'main_test.go'), 'package main\nfunc TestMain(t *testing.T) {}\n', 'utf8');

    const result = await suggestTestedByTraces(bundleRoot, {
      bundleId: 'test-bundle',
      edgeType: 'tested_by',
      scope: 'repo',
      minConfidence: 0.8,
      limit: 10,
      skipExisting: false,
    });

    expect(result.suggestions.length).toBe(1);
    expect(result.suggestions[0]?.source.id).toContain('main.go');
    expect(result.suggestions[0]?.target.id).toContain('main_test.go');
  });

  it('respects minConfidence filter', async () => {
    const normDir = path.join(bundleRoot, 'repos', 'acme', 'demo', 'norm');
    await fs.writeFile(path.join(normDir, 'src', 'foo.py'), 'def foo(): pass\n', 'utf8');
    await fs.writeFile(path.join(normDir, 'src', 'test_foo.py'), 'def test_foo(): pass\n', 'utf8');

    const result = await suggestTestedByTraces(bundleRoot, {
      bundleId: 'test-bundle',
      edgeType: 'tested_by',
      scope: 'repo',
      minConfidence: 0.99, // Very high threshold
      limit: 10,
      skipExisting: false,
    });

    expect(result.suggestions.length).toBe(0);
  });

  it('respects limit parameter', async () => {
    const normDir = path.join(bundleRoot, 'repos', 'acme', 'demo', 'norm');
    
    // Create multiple test pairs
    for (let i = 1; i <= 5; i++) {
      await fs.writeFile(path.join(normDir, 'src', `mod${i}.py`), `def mod${i}(): pass\n`, 'utf8');
      await fs.writeFile(path.join(normDir, 'src', `test_mod${i}.py`), `def test_mod${i}(): pass\n`, 'utf8');
    }

    const result = await suggestTestedByTraces(bundleRoot, {
      bundleId: 'test-bundle',
      edgeType: 'tested_by',
      scope: 'repo',
      minConfidence: 0.8,
      limit: 2,
      skipExisting: false,
    });

    expect(result.suggestions.length).toBe(2);
    expect(result.matchedPairs).toBeGreaterThanOrEqual(2);
  });

  it('generates valid upsertPayload', async () => {
    const normDir = path.join(bundleRoot, 'repos', 'acme', 'demo', 'norm');
    await fs.writeFile(path.join(normDir, 'src', 'api.ts'), 'export const api = 1;\n', 'utf8');
    await fs.writeFile(path.join(normDir, 'src', 'api.test.ts'), 'test("api", () => {});\n', 'utf8');

    const result = await suggestTestedByTraces(bundleRoot, {
      bundleId: 'my-bundle',
      edgeType: 'tested_by',
      scope: 'repo',
      minConfidence: 0.8,
      limit: 10,
      skipExisting: false,
    });

    expect(result.suggestions.length).toBe(1);
    const payload = result.suggestions[0]?.upsertPayload;
    expect(payload).toBeDefined();
    expect(payload?.bundleId).toBe('my-bundle');
    expect(payload?.dryRun).toBe(true);
    expect(payload?.edges).toHaveLength(1);
    expect(payload?.edges[0]?.type).toBe('tested_by');
    expect(payload?.edges[0]?.source.type).toBe('file');
    expect(payload?.edges[0]?.target.type).toBe('file');
  });

  it('returns empty suggestions when no test files match', async () => {
    const normDir = path.join(bundleRoot, 'repos', 'acme', 'demo', 'norm');
    await fs.writeFile(path.join(normDir, 'src', 'main.ts'), 'export const x = 1;\n', 'utf8');
    await fs.writeFile(path.join(normDir, 'src', 'helper.ts'), 'export const h = 2;\n', 'utf8');

    const result = await suggestTestedByTraces(bundleRoot, {
      bundleId: 'test-bundle',
      edgeType: 'tested_by',
      scope: 'repo',
      minConfidence: 0.8,
      limit: 10,
      skipExisting: false,
    });

    expect(result.suggestions.length).toBe(0);
    expect(result.scannedFiles).toBeGreaterThan(0);
  });
});
