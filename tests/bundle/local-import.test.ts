import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createBundle } from '../../src/bundle/service.js';

function makeCfg(storageDir: string, tmpDirPath: string) {
  return {
    storageDir,
    storageDirs: [storageDir],
    tmpDir: tmpDirPath,
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

describe('local repo import', () => {
  let root: string;
  let localRepoDir: string;
  let storageDir: string;
  let tmpDirPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'preflight-local-'));
    localRepoDir = path.join(root, 'repo');
    storageDir = path.join(root, 'bundles');
    tmpDirPath = path.join(root, 'tmp');

    await fs.mkdir(path.join(localRepoDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(localRepoDir, 'README.md'), '# Demo\n', 'utf8');
    await fs.writeFile(path.join(localRepoDir, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates a bundle from a local directory input', async () => {
    const cfg = makeCfg(storageDir, tmpDirPath);

    const summary = await createBundle(cfg as any, {
      repos: [
        {
          kind: 'local',
          repo: 'acme/demo',
          path: localRepoDir,
        },
      ],
    });

    expect(summary.bundleId).toBeTruthy();
    expect(summary.repos.length).toBe(1);
    expect(summary.repos[0]!.kind).toBe('local');
    expect(summary.repos[0]!.id).toBe('acme/demo');

    const bundleRoot = path.join(storageDir, summary.bundleId);
    const manifestPath = path.join(bundleRoot, 'manifest.json');
    const overviewPath = path.join(bundleRoot, 'OVERVIEW.md');
    const startHerePath = path.join(bundleRoot, 'START_HERE.md');
    const agentsPath = path.join(bundleRoot, 'AGENTS.md');
    const indexPath = path.join(bundleRoot, 'indexes', 'search.sqlite3');
    const repoNormReadme = path.join(bundleRoot, 'repos', 'acme', 'demo', 'norm', 'README.md');

    await expect(fs.stat(manifestPath)).resolves.toBeDefined();
    await expect(fs.stat(overviewPath)).resolves.toBeDefined();
    await expect(fs.stat(startHerePath)).resolves.toBeDefined();
    await expect(fs.stat(agentsPath)).resolves.toBeDefined();
    await expect(fs.stat(indexPath)).resolves.toBeDefined();
    await expect(fs.stat(repoNormReadme)).resolves.toBeDefined();

    const manifestRaw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestRaw);
    expect(Array.isArray(manifest.repos)).toBe(true);
    expect(manifest.repos[0].source).toBe('local');
  });
});
