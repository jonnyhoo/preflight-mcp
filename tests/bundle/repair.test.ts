import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createBundle, repairBundle } from '../../src/bundle/service.js';

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

describe('repair bundle (offline)', () => {
  let root: string;
  let localRepoDir: string;
  let storageDir: string;
  let tmpDirPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'preflight-repair-'));
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

  it('repairs missing/empty derived artifacts without fetching', async () => {
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

    const bundleRoot = path.join(storageDir, summary.bundleId);
    const manifestPath = path.join(bundleRoot, 'manifest.json');
    const indexPath = path.join(bundleRoot, 'indexes', 'search.sqlite3');
    const overviewPath = path.join(bundleRoot, 'OVERVIEW.md');
    const startHerePath = path.join(bundleRoot, 'START_HERE.md');

    const manifestBefore = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

    // Corrupt derived artifacts.
    await fs.rm(indexPath, { force: true });
    await fs.rm(overviewPath, { force: true });
    await fs.writeFile(startHerePath, '', 'utf8');

    const result = await repairBundle(cfg as any, summary.bundleId, { mode: 'repair' });

    expect(result.repaired).toBe(true);
    expect(result.before.isValid).toBe(false);
    expect(result.after.isValid).toBe(true);

    await expect(fs.stat(indexPath)).resolves.toBeDefined();
    await expect(fs.stat(overviewPath)).resolves.toBeDefined();
    await expect(fs.stat(startHerePath)).resolves.toBeDefined();

    const manifestAfter = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    expect(manifestAfter.bundleId).toBe(summary.bundleId);
    expect(manifestAfter.updatedAt).not.toBe(manifestBefore.updatedAt);
  });

  it('validate mode does not modify bundle', async () => {
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

    const bundleRoot = path.join(storageDir, summary.bundleId);
    const manifestPath = path.join(bundleRoot, 'manifest.json');
    const manifestBefore = await fs.readFile(manifestPath, 'utf8');

    const result = await repairBundle(cfg as any, summary.bundleId, { mode: 'validate' });

    expect(result.mode).toBe('validate');
    expect(result.repaired).toBe(false);

    const manifestAfter = await fs.readFile(manifestPath, 'utf8');
    expect(manifestAfter).toBe(manifestBefore);
  });
});
