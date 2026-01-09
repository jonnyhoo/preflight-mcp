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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createBundle ifExists=updateExisting', () => {
  let root: string;
  let localRepoDir: string;
  let storageDir: string;
  let tmpDirPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'preflight-updexist-'));
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

  it('updates the existing bundle and returns the same bundleId', async () => {
    const cfg = makeCfg(storageDir, tmpDirPath);

    const first = await createBundle(cfg as any, {
      repos: [
        {
          kind: 'local',
          repo: 'acme/demo',
          path: localRepoDir,
        },
      ],
    });

    // Ensure updatedAt changes (avoid same-millisecond timestamps).
    await sleep(15);

    // Trigger update-in-place via create.
    const second = await createBundle(
      cfg as any,
      {
        repos: [
          {
            kind: 'local',
            repo: 'acme/demo',
            path: localRepoDir,
          },
        ],
      },
      { ifExists: 'updateExisting' }
    );

    expect(second.bundleId).toBe(first.bundleId);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
  });
});
