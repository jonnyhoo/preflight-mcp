import { describe, it, expect } from '@jest/globals';

import { runSearchByTags } from '../../src/tools/searchByTags.js';

describe('runSearchByTags', () => {
  it('returns hits from healthy bundles and warnings for failing bundles', async () => {
    const res = await runSearchByTags({
      bundleIds: ['a', 'b'],
      query: 'hello',
      scope: 'all',
      limit: 50,
      readManifestForBundleId: async (bundleId) => ({
        displayName: bundleId === 'a' ? 'Bundle A' : 'Bundle B',
        tags: ['x'],
      }),
      searchIndexForBundleId: (bundleId) => {
        if (bundleId === 'b') {
          throw new Error('SqliteError: SQLITE_CANTOPEN: unable to open database file');
        }
        return [
          {
            kind: 'doc',
            repo: 'acme/demo',
            path: 'repos/acme/demo/norm/README.md',
            lineNo: 1,
            snippet: 'hello',
          },
        ];
      },
      toUri: (bundleId, p) => `preflight://bundle/${bundleId}/file/${encodeURIComponent(p)}`,
    });

    expect(res.hits.length).toBe(1);
    expect(res.hits[0]!.bundleId).toBe('a');

    expect(res.warnings).toBeDefined();
    expect(res.warnings!.length).toBe(1);
    expect(res.warnings![0]!.bundleId).toBe('b');
    expect(res.warnings![0]!.kind).toBe('index_missing_or_corrupt');
    expect(res.warnings![0]!.message).toContain('[preflight_error kind=index_missing_or_corrupt]');
  });

  it('emits warning when manifest read fails during tag filtering and caps warnings', async () => {
    const res = await runSearchByTags({
      bundleIds: ['a', 'b', 'c'],
      query: 'x',
      tags: ['t'],
      scope: 'all',
      limit: 10,
      maxWarnings: 1,
      readManifestForBundleId: async (bundleId) => {
        if (bundleId === 'b' || bundleId === 'c') {
          const err: any = new Error('ENOENT: no such file or directory');
          err.code = 'ENOENT';
          throw err;
        }
        return { displayName: bundleId, tags: ['t'] };
      },
      searchIndexForBundleId: () => [],
      toUri: () => 'x',
    });

    expect(res.warnings).toBeDefined();
    expect(res.warnings!.length).toBe(1);
    expect(res.warnings![0]!.kind).toBe('file_not_found');
    expect(res.warningsTruncated).toBe(true);
  });
});
