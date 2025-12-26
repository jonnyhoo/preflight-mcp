import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';

import { validateReport } from '../../src/analysis/validate.js';
import type { Claim } from '../../src/types/evidence.js';

describe('validateReport', () => {
  let root: string;
  let bundleRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'preflight-validate-'));
    bundleRoot = path.join(root, 'bundle');

    // Create bundle structure with a sample file
    const normDir = path.join(bundleRoot, 'repos', 'acme', 'demo', 'norm');
    await fs.mkdir(normDir, { recursive: true });
    await fs.writeFile(path.join(normDir, 'README.md'), '# Demo Project\n\nThis is a demo.\n', 'utf8');
    await fs.writeFile(path.join(normDir, 'main.ts'), 'export const main = 1;\n', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('validates claim with valid evidence file', async () => {
    const claims: Claim[] = [
      {
        id: 'claim-1',
        text: 'The project has a README',
        confidence: 0.95,
        kind: 'feature',
        status: 'supported',
        evidence: [
          {
            file: 'repos/acme/demo/norm/README.md',
            range: { startLine: 1, startCol: 1, endLine: 3, endCol: 1 },
          },
        ],
      },
    ];

    const result = await validateReport(bundleRoot, {
      bundleId: 'test-bundle',
      claims,
    });

    expect(result.passed).toBe(true);
    expect(result.validClaims).toBe(1);
    expect(result.invalidClaims).toBe(0);
    expect(result.issues.length).toBe(0);
  });

  it('detects missing evidence file', async () => {
    const claims: Claim[] = [
      {
        id: 'claim-1',
        text: 'This references a non-existent file',
        confidence: 0.9,
        kind: 'module',
        status: 'supported',
        evidence: [
          {
            file: 'repos/acme/demo/norm/nonexistent.ts',
            range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
          },
        ],
      },
    ];

    const result = await validateReport(bundleRoot, {
      bundleId: 'test-bundle',
      claims,
    });

    expect(result.passed).toBe(false);
    expect(result.invalidClaims).toBe(1);
    expect(result.issues.some(i => i.code === 'FILE_NOT_FOUND')).toBe(true);
  });

  it('detects supported claim with no evidence', async () => {
    const claims: Claim[] = [
      {
        id: 'claim-1',
        text: 'This claim has no evidence',
        confidence: 0.5,
        kind: 'unknown',
        status: 'supported',
        evidence: [],
      },
    ];

    const result = await validateReport(bundleRoot, {
      bundleId: 'test-bundle',
      claims,
    });

    expect(result.passed).toBe(false);
    expect(result.issues.some(i => i.code === 'SUPPORTED_NO_EVIDENCE')).toBe(true);
  });

  it('warns about inferred claim without whyInferred', async () => {
    const claims: Claim[] = [
      {
        id: 'claim-1',
        text: 'This is inferred',
        confidence: 0.6,
        kind: 'behavior',
        status: 'inferred',
        evidence: [],
      },
    ];

    const result = await validateReport(bundleRoot, {
      bundleId: 'test-bundle',
      claims,
      options: { verifyFileExists: false },
    });

    expect(result.issues.some(i => i.code === 'MISSING_WHY_INFERRED')).toBe(true);
    expect(result.issues.find(i => i.code === 'MISSING_WHY_INFERRED')?.severity).toBe('warning');
  });

  it('detects invalid line range (start > end)', async () => {
    const claims: Claim[] = [
      {
        id: 'claim-1',
        text: 'Invalid range claim',
        confidence: 0.9,
        kind: 'module',
        status: 'supported',
        evidence: [
          {
            file: 'repos/acme/demo/norm/main.ts',
            range: { startLine: 10, startCol: 1, endLine: 5, endCol: 1 }, // Invalid: start > end
          },
        ],
      },
    ];

    const result = await validateReport(bundleRoot, {
      bundleId: 'test-bundle',
      claims,
    });

    expect(result.passed).toBe(false);
    expect(result.issues.some(i => i.code === 'INVALID_LINE_RANGE')).toBe(true);
  });

  it('detects invalid line number (< 1)', async () => {
    const claims: Claim[] = [
      {
        id: 'claim-1',
        text: 'Zero line claim',
        confidence: 0.9,
        kind: 'module',
        status: 'supported',
        evidence: [
          {
            file: 'repos/acme/demo/norm/main.ts',
            range: { startLine: 0, startCol: 1, endLine: 1, endCol: 1 }, // Invalid: line 0
          },
        ],
      },
    ];

    const result = await validateReport(bundleRoot, {
      bundleId: 'test-bundle',
      claims,
    });

    expect(result.passed).toBe(false);
    expect(result.issues.some(i => i.code === 'INVALID_LINE_NUMBER')).toBe(true);
  });

  it('validates snippet hash when provided', async () => {
    const snippet = '# Demo Project';
    const correctHash = crypto.createHash('sha256').update(snippet, 'utf8').digest('hex');

    const claims: Claim[] = [
      {
        id: 'claim-1',
        text: 'Claim with valid snippet hash',
        confidence: 0.9,
        kind: 'feature',
        status: 'supported',
        evidence: [
          {
            file: 'repos/acme/demo/norm/README.md',
            range: { startLine: 1, startCol: 1, endLine: 1, endCol: 15 },
            snippet,
            snippetSha256: correctHash,
          },
        ],
      },
    ];

    const result = await validateReport(bundleRoot, {
      bundleId: 'test-bundle',
      claims,
    });

    expect(result.passed).toBe(true);
    expect(result.issues.length).toBe(0);
  });

  it('detects snippet hash mismatch', async () => {
    const claims: Claim[] = [
      {
        id: 'claim-1',
        text: 'Claim with wrong snippet hash',
        confidence: 0.9,
        kind: 'feature',
        status: 'supported',
        evidence: [
          {
            file: 'repos/acme/demo/norm/README.md',
            range: { startLine: 1, startCol: 1, endLine: 1, endCol: 15 },
            snippet: '# Demo Project',
            snippetSha256: 'wrong-hash-value',
          },
        ],
      },
    ];

    const result = await validateReport(bundleRoot, {
      bundleId: 'test-bundle',
      claims,
    });

    expect(result.passed).toBe(false);
    expect(result.issues.some(i => i.code === 'SNIPPET_HASH_MISMATCH')).toBe(true);
  });

  it('detects invalid confidence value', async () => {
    const claims: Claim[] = [
      {
        id: 'claim-1',
        text: 'Claim with invalid confidence',
        confidence: 1.5, // Invalid: > 1
        kind: 'feature',
        status: 'supported',
        evidence: [],
      },
    ];

    const result = await validateReport(bundleRoot, {
      bundleId: 'test-bundle',
      claims,
      options: { verifyFileExists: false },
    });

    expect(result.issues.some(i => i.code === 'INVALID_CONFIDENCE')).toBe(true);
  });

  it('respects strictMode option', async () => {
    const claims: Claim[] = [
      {
        id: 'claim-1',
        text: 'Inferred claim without reason',
        confidence: 0.6,
        kind: 'behavior',
        status: 'inferred',
        evidence: [],
      },
    ];

    // Without strict mode - warnings don't fail
    const normalResult = await validateReport(bundleRoot, {
      bundleId: 'test-bundle',
      claims,
      options: { verifyFileExists: false, strictMode: false },
    });
    expect(normalResult.passed).toBe(true);

    // With strict mode - warnings cause failure
    const strictResult = await validateReport(bundleRoot, {
      bundleId: 'test-bundle',
      claims,
      options: { verifyFileExists: false, strictMode: true },
    });
    expect(strictResult.passed).toBe(false);
  });

  it('generates correct summary', async () => {
    const claims: Claim[] = [
      {
        id: 'claim-1',
        text: 'Valid claim',
        confidence: 0.9,
        kind: 'feature',
        status: 'supported',
        evidence: [
          {
            file: 'repos/acme/demo/norm/README.md',
            range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
          },
        ],
      },
      {
        id: 'claim-2',
        text: 'Invalid claim',
        confidence: 0.5,
        kind: 'unknown',
        status: 'supported',
        evidence: [],
      },
    ];

    const result = await validateReport(bundleRoot, {
      bundleId: 'test-bundle',
      claims,
    });

    expect(result.summary).toContain('Total claims: 2');
    expect(result.summary).toContain('Valid: 1');
    expect(result.summary).toContain('Invalid: 1');
  });
});
