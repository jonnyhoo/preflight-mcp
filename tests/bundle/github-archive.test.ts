import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import AdmZip from 'adm-zip';

import { downloadAndExtractGitHubArchive } from '../../src/bundle/githubArchive.js';

function makeCfg(): any {
  return {
    storageDir: 'unused',
    storageDirs: ['unused'],
    tmpDir: 'unused',
    context7McpUrl: 'https://mcp.context7.com/mcp',
    gitCloneTimeoutMs: 1000,
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
  };
}

describe('github archive helper', () => {
  let root: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'preflight-gh-archive-'));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('downloads (mocked) and extracts a zipball and returns the extracted repo root', async () => {
    // Create a small zipball with a single top-level directory.
    const zip = new AdmZip();
    zip.addFile('octocat-Hello-World-deadbeef/README.md', Buffer.from('# Hello\n', 'utf8'));
    const zipBuf = zip.toBuffer();

    const calls: string[] = [];

    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      calls.push(u);

      if (u.startsWith('https://api.github.com/repos/octocat/Hello-World') && !u.includes('/zipball/')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ default_branch: 'main' }),
        } as any;
      }

      if (u.includes('/zipball/')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Map([['content-length', String(zipBuf.length)]]),
          arrayBuffer: async () => zipBuf,
        } as any;
      }

      throw new Error(`Unexpected fetch URL: ${u}`);
    }) as any;

    const { repoRoot, refUsed } = await downloadAndExtractGitHubArchive({
      cfg: makeCfg(),
      owner: 'octocat',
      repo: 'Hello-World',
      destDir: root,
    });

    expect(refUsed).toBe('main');

    const readme = await fs.readFile(path.join(repoRoot, 'README.md'), 'utf8');
    expect(readme).toContain('Hello');

    // Sanity: we should have called repo-info and zipball.
    expect(calls.some((c) => c.includes('/repos/octocat/Hello-World') && !c.includes('/zipball/'))).toBe(true);
    expect(calls.some((c) => c.includes('/zipball/'))).toBe(true);
  });
});
