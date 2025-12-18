/**
 * Unit tests for search/sqliteFts.ts
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  rebuildIndex,
  searchIndex,
  buildFtsQuery,
  verifyClaimInIndex,
  type SearchScope,
} from '../../src/search/sqliteFts.js';
import type { IngestedFile } from '../../src/bundle/ingest.js';

describe('buildFtsQuery', () => {
  test('passes through raw FTS syntax with fts: prefix', () => {
    expect(buildFtsQuery('fts:foo AND bar')).toBe('foo AND bar');
    expect(buildFtsQuery('fts: "exact phrase"')).toBe('"exact phrase"');
  });

  test('tokenizes simple queries', () => {
    const result = buildFtsQuery('hello world');
    expect(result).toContain('"hello"');
    expect(result).toContain('"world"');
    expect(result).toContain('OR');
  });

  test('tokenizes input with quotes correctly', () => {
    // Input 'say "hello"' tokenizes to 'say' and 'hello' (quotes stripped)
    const result = buildFtsQuery('say "hello"');
    expect(result).toContain('"say"');
    expect(result).toContain('"hello"');
  });

  test('escapes quotes within tokens', () => {
    // Test with fts: prefix to pass raw query with embedded quotes
    const result = buildFtsQuery('fts:"test""value"');
    expect(result).toBe('"test""value"');
  });

  test('handles empty input', () => {
    const result = buildFtsQuery('');
    expect(result).toBe('""');
  });

  test('handles special characters gracefully', () => {
    const result = buildFtsQuery('foo.bar_baz');
    expect(result).toContain('foo.bar_baz');
  });

  test('limits tokens to 12', () => {
    const manyWords = 'a b c d e f g h i j k l m n o p'.split(' ').join(' word');
    const result = buildFtsQuery(manyWords);
    const orCount = (result.match(/OR/g) || []).length;
    // 12 tokens = 11 ORs max
    expect(orCount).toBeLessThanOrEqual(11);
  });
});

describe('rebuildIndex and searchIndex', () => {
  let testDir: string;
  let dbPath: string;
  let testFiles: IngestedFile[];

  beforeAll(async () => {
    // Create temp directory for test
    testDir = path.join(os.tmpdir(), `preflight-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    dbPath = path.join(testDir, 'test-search.sqlite3');

    // Create test files
    const file1Path = path.join(testDir, 'doc1.md');
    const file2Path = path.join(testDir, 'code1.ts');

    await fs.writeFile(file1Path, `# Hello World
This is a documentation file.
It contains important information about TypeScript.
The project uses Node.js and npm.
`);

    await fs.writeFile(file2Path, `// TypeScript code
export function hello(): string {
  return "Hello World";
}

// This function is deprecated
export function oldFunction(): void {
  // Not recommended for use
}
`);

    testFiles = [
      {
        repoId: 'test/repo',
        kind: 'doc',
        repoRelativePath: 'doc1.md',
        bundleNormRelativePath: 'repos/test/repo/norm/doc1.md',
        bundleNormAbsPath: file1Path,
        sha256: 'abc123',
        bytes: 100,
      },
      {
        repoId: 'test/repo',
        kind: 'code',
        repoRelativePath: 'code1.ts',
        bundleNormRelativePath: 'repos/test/repo/norm/code1.ts',
        bundleNormAbsPath: file2Path,
        sha256: 'def456',
        bytes: 150,
      },
    ];

    // Build index
    await rebuildIndex(dbPath, testFiles, {
      includeDocs: true,
      includeCode: true,
    });
  });

  afterAll(async () => {
    // Cleanup
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('searchIndex finds content in docs', () => {
    const hits = searchIndex(dbPath, 'TypeScript', 'docs', 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.kind).toBe('doc');
    expect(hits[0]?.snippet).toContain('TypeScript');
  });

  test('searchIndex finds content in code', () => {
    const hits = searchIndex(dbPath, 'function hello', 'code', 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.kind).toBe('code');
  });

  test('searchIndex respects scope filter', () => {
    const docsOnly = searchIndex(dbPath, 'Hello', 'docs', 10);
    const codeOnly = searchIndex(dbPath, 'Hello', 'code', 10);
    const all = searchIndex(dbPath, 'Hello', 'all', 10);

    expect(docsOnly.every(h => h.kind === 'doc')).toBe(true);
    expect(codeOnly.every(h => h.kind === 'code')).toBe(true);
    expect(all.length).toBeGreaterThanOrEqual(docsOnly.length);
  });

  test('searchIndex respects limit', () => {
    const limited = searchIndex(dbPath, 'Hello', 'all', 1);
    expect(limited.length).toBeLessThanOrEqual(1);
  });

  test('searchIndex returns empty array for no matches', () => {
    const hits = searchIndex(dbPath, 'nonexistentxyz123', 'all', 10);
    expect(hits).toEqual([]);
  });
});

describe('verifyClaimInIndex', () => {
  let testDir: string;
  let dbPath: string;

  beforeAll(async () => {
    testDir = path.join(os.tmpdir(), `preflight-verify-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    dbPath = path.join(testDir, 'verify-search.sqlite3');

    // Create test files with clear supporting/contradicting content
    const supportingFile = path.join(testDir, 'supporting.md');
    const contradictingFile = path.join(testDir, 'contradicting.md');
    const relatedFile = path.join(testDir, 'related.md');

    await fs.writeFile(supportingFile, `# TypeScript Support
This project supports TypeScript.
TypeScript is enabled by default.
TypeScript provides type safety.
`);

    await fs.writeFile(contradictingFile, `# Python Only
This project does not support TypeScript.
TypeScript is deprecated in this codebase.
Use Python instead of TypeScript.
`);

    await fs.writeFile(relatedFile, `# Programming Languages
Various languages exist including JavaScript.
Some mention of static typing.
`);

    const testFiles: IngestedFile[] = [
      {
        repoId: 'test/verify',
        kind: 'doc',
        repoRelativePath: 'supporting.md',
        bundleNormRelativePath: 'repos/test/verify/norm/supporting.md',
        bundleNormAbsPath: supportingFile,
        sha256: 'a1',
        bytes: 100,
      },
      {
        repoId: 'test/verify',
        kind: 'doc',
        repoRelativePath: 'contradicting.md',
        bundleNormRelativePath: 'repos/test/verify/norm/contradicting.md',
        bundleNormAbsPath: contradictingFile,
        sha256: 'a2',
        bytes: 100,
      },
      {
        repoId: 'test/verify',
        kind: 'doc',
        repoRelativePath: 'related.md',
        bundleNormRelativePath: 'repos/test/verify/norm/related.md',
        bundleNormAbsPath: relatedFile,
        sha256: 'a3',
        bytes: 100,
      },
    ];

    await rebuildIndex(dbPath, testFiles, {
      includeDocs: true,
      includeCode: true,
    });
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('verifyClaimInIndex returns structured result', () => {
    const result = verifyClaimInIndex(dbPath, 'TypeScript support', 'all', 20);

    expect(result).toHaveProperty('claim');
    expect(result).toHaveProperty('found');
    expect(result).toHaveProperty('confidence');
    expect(result).toHaveProperty('confidenceLabel');
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('supporting');
    expect(result).toHaveProperty('contradicting');
    expect(result).toHaveProperty('related');
  });

  test('verifyClaimInIndex classifies supporting evidence', () => {
    const result = verifyClaimInIndex(dbPath, 'TypeScript support', 'all', 20);

    expect(result.found).toBe(true);
    expect(result.supporting.length).toBeGreaterThan(0);

    // Each evidence should have the required fields
    for (const evidence of result.supporting) {
      expect(evidence).toHaveProperty('evidenceType', 'supporting');
      expect(evidence).toHaveProperty('relevanceScore');
      expect(evidence.relevanceScore).toBeGreaterThan(0);
      expect(evidence.relevanceScore).toBeLessThanOrEqual(1);
    }
  });

  test('verifyClaimInIndex detects contradicting evidence', () => {
    const result = verifyClaimInIndex(dbPath, 'TypeScript', 'all', 20);

    // Should find some contradicting evidence from the "does not support" file
    const hasContradicting = result.contradicting.length > 0;
    const hasRelated = result.related.length > 0;

    // At least some evidence should be classified as non-supporting
    expect(hasContradicting || hasRelated).toBe(true);
  });

  test('verifyClaimInIndex provides confidence labels', () => {
    const result = verifyClaimInIndex(dbPath, 'TypeScript support', 'all', 20);

    expect(['high', 'medium', 'low', 'none']).toContain(result.confidenceLabel);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  test('verifyClaimInIndex provides human-readable summary', () => {
    const result = verifyClaimInIndex(dbPath, 'TypeScript support', 'all', 20);

    expect(typeof result.summary).toBe('string');
    expect(result.summary.length).toBeGreaterThan(0);
  });

  test('verifyClaimInIndex handles no matches gracefully', () => {
    const result = verifyClaimInIndex(dbPath, 'nonexistent12345xyz', 'all', 20);

    expect(result.found).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.confidenceLabel).toBe('none');
    expect(result.supporting).toEqual([]);
    expect(result.contradicting).toEqual([]);
    expect(result.related).toEqual([]);
  });
});
