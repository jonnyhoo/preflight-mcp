import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createBundle } from '../../src/bundle/service.js';
import { generateDependencyGraph } from '../../src/evidence/dependencyGraph.js';

function makeCfg(storageDir: string, tmpDirPath: string, astEngine: 'wasm' | 'native') {
  return {
    storageDir,
    storageDirs: [storageDir],
    tmpDir: tmpDirPath,
    context7McpUrl: 'https://mcp.context7.com/mcp',
    maxFileBytes: 512 * 1024,
    maxTotalBytes: 50 * 1024 * 1024,
    analysisMode: 'none',
    astEngine,
    httpEnabled: false,
    httpHost: '127.0.0.1',
    httpPort: 0,
    maxContext7Libraries: 20,
    maxContext7Topics: 10,
    maxFtsQueryTokens: 12,
    maxSkippedNotes: 50,
    defaultMaxAgeHours: 24,
    maxSearchLimit: 200,
    defaultSearchLimit: 30,
  } as const;
}

describe('dependency graph import extraction (WASM vs heuristic)', () => {
  let root: string;
  let localRepoDir: string;
  let storageDir: string;
  let tmpDirPath: string;
  let bundleId: string;

  const targetFile = 'repos/acme/demo/norm/src/index.ts';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'preflight-evidence-'));
    localRepoDir = path.join(root, 'repo');
    storageDir = path.join(root, 'bundles');
    tmpDirPath = path.join(root, 'tmp');

    await fs.mkdir(path.join(localRepoDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(localRepoDir, 'README.md'), '# Demo\n', 'utf8');

    // Include a unicode character before imports to ensure byte-offset -> (line,col) mapping works.
    const indexTs = `// π unicode comment\nimport x from "./dep";\nimport "./side";\nconst m = import("./dyn");\nexport { x } from "./exp";\n`;
    await fs.writeFile(path.join(localRepoDir, 'src', 'index.ts'), indexTs, 'utf8');
    await fs.writeFile(path.join(localRepoDir, 'src', 'dep.ts'), 'export const x = 1;\n', 'utf8');
    await fs.writeFile(path.join(localRepoDir, 'src', 'side.ts'), 'export const side = true;\n', 'utf8');
    await fs.writeFile(path.join(localRepoDir, 'src', 'dyn.ts'), 'export const dyn = true;\n', 'utf8');
    await fs.writeFile(path.join(localRepoDir, 'src', 'exp.ts'), 'export const exp = true;\n', 'utf8');

    await fs.mkdir(path.join(localRepoDir, 'py_pkg'), { recursive: true });
    await fs.writeFile(path.join(localRepoDir, 'py_pkg', '__init__.py'), '', 'utf8');
    await fs.writeFile(path.join(localRepoDir, 'py_pkg', 'foo.py'), 'def foo():\n  return 1\n', 'utf8');
    await fs.writeFile(path.join(localRepoDir, 'py_pkg', 'mod.py'), 'from . import foo\n', 'utf8');
    await fs.writeFile(path.join(localRepoDir, 'py_pkg', 'mod_abs.py'), 'from py_pkg.foo import foo\n', 'utf8');

    const cfg = makeCfg(storageDir, tmpDirPath, 'wasm');
    const summary = await createBundle(cfg as any, {
      repos: [
        {
          kind: 'local',
          repo: 'acme/demo',
          path: localRepoDir,
        },
      ],
    });

    bundleId = summary.bundleId;
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('uses WASM parsing to include dynamic import and marks edges as exact', async () => {
    const cfg = makeCfg(storageDir, tmpDirPath, 'wasm');

    const res = await generateDependencyGraph(cfg as any, {
      bundleId,
      target: { file: targetFile },
      options: { timeBudgetMs: 25_000, maxFiles: 50, maxNodes: 200, maxEdges: 200 },
    });

    const edges = res.facts.edges.filter((e) => e.type === 'imports');
    const modules = edges
      .map((e) => e.to)
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.replace(/^module:/, ''));

    expect(modules).toEqual(expect.arrayContaining(['./dep', './side', './dyn', './exp']));
    expect(edges.every((e) => e.method === 'exact')).toBe(true);

    const depEdge = edges.find((e) => e.to === 'module:./dep');
    expect(depEdge).toBeTruthy();
    expect(depEdge!.sources[0]!.range).toEqual({ startLine: 2, startCol: 16, endLine: 2, endCol: 21 });
  });

  it('emits imports_resolved edges for local imports that can be mapped to bundle files', async () => {
    const cfg = makeCfg(storageDir, tmpDirPath, 'wasm');

    const res = await generateDependencyGraph(cfg as any, {
      bundleId,
      target: { file: targetFile },
      options: { timeBudgetMs: 25_000, maxFiles: 50, maxNodes: 300, maxEdges: 400 },
    });

    const edges = res.facts.edges.filter((e) => e.type === 'imports_resolved');
    const files = edges
      .map((e) => e.to)
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.replace(/^file:/, ''));

    expect(files).toEqual(
      expect.arrayContaining([
        'repos/acme/demo/norm/src/dep.ts',
        'repos/acme/demo/norm/src/side.ts',
        'repos/acme/demo/norm/src/dyn.ts',
        'repos/acme/demo/norm/src/exp.ts',
      ])
    );
  });

  it('resolves Python relative imports to bundle files (imports_resolved)', async () => {
    const cfg = makeCfg(storageDir, tmpDirPath, 'wasm');

    const res = await generateDependencyGraph(cfg as any, {
      bundleId,
      target: { file: 'repos/acme/demo/norm/py_pkg/mod.py' },
      options: { timeBudgetMs: 25_000, maxFiles: 50, maxNodes: 200, maxEdges: 200 },
    });

    const edges = res.facts.edges.filter((e) => e.type === 'imports_resolved');
    const files = edges
      .map((e) => e.to)
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.replace(/^file:/, ''));

    expect(files).toEqual(expect.arrayContaining(['repos/acme/demo/norm/py_pkg/foo.py']));
  });

  it('resolves Python absolute imports to bundle files (imports_resolved)', async () => {
    const cfg = makeCfg(storageDir, tmpDirPath, 'wasm');

    const res = await generateDependencyGraph(cfg as any, {
      bundleId,
      target: { file: 'repos/acme/demo/norm/py_pkg/mod_abs.py' },
      options: { timeBudgetMs: 25_000, maxFiles: 50, maxNodes: 200, maxEdges: 200 },
    });

    const edges = res.facts.edges.filter((e) => e.type === 'imports_resolved');
    const files = edges
      .map((e) => e.to)
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.replace(/^file:/, ''));

    expect(files).toEqual(expect.arrayContaining(['repos/acme/demo/norm/py_pkg/foo.py']));
  });

  it('falls back to heuristic extraction when astEngine=native and omits dynamic import', async () => {
    const cfg = makeCfg(storageDir, tmpDirPath, 'native');

    const res = await generateDependencyGraph(cfg as any, {
      bundleId,
      target: { file: targetFile },
      options: { timeBudgetMs: 25_000, maxFiles: 50, maxNodes: 200, maxEdges: 200 },
    });

    const edges = res.facts.edges.filter((e) => e.type === 'imports');
    const modules = edges
      .map((e) => e.to)
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.replace(/^module:/, ''));

    expect(modules).toEqual(expect.arrayContaining(['./dep', './side', './exp']));
    expect(modules).not.toEqual(expect.arrayContaining(['./dyn']));
    expect(edges.every((e) => e.method === 'heuristic')).toBe(true);
  });
});
