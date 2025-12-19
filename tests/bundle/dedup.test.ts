import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import {
  computeCreateInputFingerprint,
  findBundleByInputs,
} from '../../src/bundle/service.js';

function iso(d: Date): string {
  return d.toISOString();
}

function makeCfg(storageDir: string) {
  // Minimal PreflightConfig for dedup logic.
  return {
    storageDir,
    storageDirs: [storageDir],
    tmpDir: path.join(storageDir, '_tmp'),
    context7McpUrl: 'https://mcp.context7.com/mcp',
    maxFileBytes: 512 * 1024,
    maxTotalBytes: 50 * 1024 * 1024,
    analysisMode: 'none',
    maxContext7Libraries: 20,
    maxContext7Topics: 10,
    maxFtsQueryTokens: 12,
    maxSkippedNotes: 50,
    defaultMaxAgeHours: 24,
    maxSearchLimit: 200,
    defaultSearchLimit: 30,
  } as const;
}

describe('bundle de-duplication', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'preflight-dedup-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('computes the same fingerprint for equivalent GitHub repo identifiers and unordered lists', () => {
    const a = computeCreateInputFingerprint({
      repos: [{ kind: 'github', repo: 'octocat/Hello-World' }],
      libraries: ['React', 'NextJS'],
      topics: ['Routing', 'API'],
    });

    const b = computeCreateInputFingerprint({
      repos: [{ kind: 'github', repo: 'https://github.com/octocat/Hello-World' }],
      libraries: ['nextjs', 'react'],
      topics: ['api', 'routing'],
    });

    expect(a).toBe(b);
  });

  it('finds an existing bundle by scanning manifests and seeds the dedup index', async () => {
    const cfg = makeCfg(root);

    const bundleId = 'bundle-1';
    const createdAt = iso(new Date('2025-01-01T00:00:00Z'));
    const updatedAt = iso(new Date('2025-01-02T00:00:00Z'));

    const bundleDir = path.join(root, bundleId);
    await fs.mkdir(bundleDir, { recursive: true });

    await fs.writeFile(
      path.join(bundleDir, 'manifest.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          bundleId,
          createdAt,
          updatedAt,
          inputs: {
            repos: [{ kind: 'github', repo: 'octocat/Hello-World' }],
            libraries: undefined,
            topics: undefined,
          },
          repos: [
            {
              kind: 'github',
              id: 'octocat/Hello-World',
              headSha: 'deadbeef',
              fetchedAt: updatedAt,
            },
          ],
          index: { backend: 'sqlite-fts5-lines', includeDocs: true, includeCode: true },
        },
        null,
        2
      ) + '\n',
      'utf8'
    );

    const found = await findBundleByInputs(cfg as any, {
      repos: [{ kind: 'github', repo: 'https://github.com/octocat/Hello-World' }],
    });

    expect(found).toBe(bundleId);

    // Index should be seeded.
    const idxPath = path.join(root, '.preflight-dedup-index.json');
    const idxRaw = await fs.readFile(idxPath, 'utf8');
    const idx = JSON.parse(idxRaw);

    const fp = computeCreateInputFingerprint({
      repos: [{ kind: 'github', repo: 'octocat/Hello-World' }],
    });

    expect(idx.schemaVersion).toBe(1);
    expect(idx.byFingerprint[fp].bundleId).toBe(bundleId);
  });
});
