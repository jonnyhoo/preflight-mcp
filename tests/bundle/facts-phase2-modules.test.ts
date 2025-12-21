import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { extractBundleFacts } from '../../src/bundle/facts.js';
import { type IngestedFile } from '../../src/bundle/ingest.js';

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

async function writeBundleNormFile(params: {
  root: string;
  repoId: string;
  repoRelativePathPosix: string;
  content: string;
}): Promise<IngestedFile> {
  const [owner, repo] = params.repoId.split('/');
  const normalized = params.content.replace(/\r\n/g, '\n');

  const bundleNormRelativePath = `repos/${owner}/${repo}/norm/${params.repoRelativePathPosix}`;
  const bundleNormAbsPath = path.join(
    params.root,
    ...bundleNormRelativePath.split('/').filter(Boolean)
  );

  await fs.mkdir(path.dirname(bundleNormAbsPath), { recursive: true });
  await fs.writeFile(bundleNormAbsPath, normalized, 'utf8');

  return {
    repoId: params.repoId,
    kind: 'code',
    repoRelativePath: params.repoRelativePathPosix,
    bundleNormRelativePath,
    bundleNormAbsPath,
    sha256: sha256Hex(normalized),
    bytes: Buffer.byteLength(normalized, 'utf8'),
  };
}

describe('facts Phase2 module analysis (Tree-sitter integration)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'preflight-facts-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('analyzes .cjs/.java/.rs modules and extracts imports/exports via WASM', async () => {
    const repoId = 'acme/demo';

    const files: IngestedFile[] = [
      await writeBundleNormFile({
        root,
        repoId,
        repoRelativePathPosix: 'src/index.cjs',
        content: [
          "const leftPad = require('left-pad');",
          'module.exports.foo = () => leftPad("x");',
          '',
        ].join('\n'),
      }),
      await writeBundleNormFile({
        root,
        repoId,
        repoRelativePathPosix: 'src/Demo.java',
        content: [
          'package com.acme;',
          'import java.util.List;',
          'public class Demo {}',
          '',
        ].join('\n'),
      }),
      await writeBundleNormFile({
        root,
        repoId,
        repoRelativePathPosix: 'src/lib.rs',
        content: [
          'use std::collections::HashMap;',
          'pub fn hello() {}',
          'pub struct Foo {}',
          '',
        ].join('\n'),
      }),
    ];

    const facts = await extractBundleFacts({
      bundleRoot: root,
      repos: [{ repoId, files }],
      enablePhase2: true,
    });

    expect(facts.modules).toBeTruthy();
    expect(facts.modules!.length).toBe(3);

    const modCjs = facts.modules!.find((m) => m.path.endsWith('/src/index.cjs'));
    expect(modCjs).toBeTruthy();
    expect(modCjs!.imports).toEqual(expect.arrayContaining(['left-pad']));
    expect(modCjs!.exports).toEqual(expect.arrayContaining(['foo']));

    const modJava = facts.modules!.find((m) => m.path.endsWith('/src/Demo.java'));
    expect(modJava).toBeTruthy();
    expect(modJava!.imports).toEqual(expect.arrayContaining(['java.util.List']));
    expect(modJava!.exports).toEqual(expect.arrayContaining(['Demo']));

    const modRust = facts.modules!.find((m) => m.path.endsWith('/src/lib.rs'));
    expect(modRust).toBeTruthy();
    expect(modRust!.imports).toEqual(expect.arrayContaining(['std::collections::HashMap']));
    expect(modRust!.exports).toEqual(expect.arrayContaining(['hello', 'Foo']));
  });

  it('resolves local JS/TS relative imports and uses them for role detection', async () => {
    const repoId = 'acme/ts-demo';

    const files: IngestedFile[] = [
      await writeBundleNormFile({
        root,
        repoId,
        repoRelativePathPosix: 'src/a.ts',
        content: [
          "import { b } from './b';",
          'console.log(b);',
          '',
        ].join('\n'),
      }),
      await writeBundleNormFile({
        root,
        repoId,
        repoRelativePathPosix: 'src/c.ts',
        content: [
          "import { b } from './b';",
          'console.log(b);',
          '',
        ].join('\n'),
      }),
      await writeBundleNormFile({
        root,
        repoId,
        repoRelativePathPosix: 'src/b.ts',
        content: [
          'export const b = 1;',
          '',
        ].join('\n'),
      }),
    ];

    const facts = await extractBundleFacts({
      bundleRoot: root,
      repos: [{ repoId, files }],
      enablePhase2: true,
    });

    const modB = facts.modules!.find((m) => m.path.endsWith('/src/b.ts'));
    expect(modB).toBeTruthy();

    // Imported by 2 modules -> classified as core.
    expect(modB!.role).toBe('core');
  });

  it('resolves local Go module imports via go.mod for role detection', async () => {
    const repoId = 'acme/go-demo';

    const files: IngestedFile[] = [
      await writeBundleNormFile({
        root,
        repoId,
        repoRelativePathPosix: 'go.mod',
        content: ['module example.com/acme/demo', 'go 1.21', ''].join('\n'),
      }),
      await writeBundleNormFile({
        root,
        repoId,
        repoRelativePathPosix: 'pkg/foo/foo.go',
        content: ['package foo', '', 'func Foo() {}', ''].join('\n'),
      }),
      await writeBundleNormFile({
        root,
        repoId,
        repoRelativePathPosix: 'cmd/a/main.go',
        content: [
          'package main',
          '',
          'import "example.com/acme/demo/pkg/foo"',
          '',
          'func main() { foo.Foo() }',
          '',
        ].join('\n'),
      }),
      await writeBundleNormFile({
        root,
        repoId,
        repoRelativePathPosix: 'cmd/b/main.go',
        content: [
          'package main',
          '',
          'import "example.com/acme/demo/pkg/foo"',
          '',
          'func main() { foo.Foo() }',
          '',
        ].join('\n'),
      }),
    ];

    const facts = await extractBundleFacts({
      bundleRoot: root,
      repos: [{ repoId, files }],
      enablePhase2: true,
    });

    const modFoo = facts.modules!.find((m) => m.path.endsWith('/pkg/foo/foo.go'));
    expect(modFoo).toBeTruthy();

    // Imported by 2 modules -> classified as core.
    expect(modFoo!.role).toBe('core');
  });

  it('resolves local Rust crate:: imports for role detection', async () => {
    const repoId = 'acme/rust-demo';

    const files: IngestedFile[] = [
      await writeBundleNormFile({
        root,
        repoId,
        repoRelativePathPosix: 'src/lib.rs',
        content: ['mod foo;', 'mod a;', 'mod b;', ''].join('\n'),
      }),
      await writeBundleNormFile({
        root,
        repoId,
        repoRelativePathPosix: 'src/foo.rs',
        content: ['pub fn foo() {}', ''].join('\n'),
      }),
      await writeBundleNormFile({
        root,
        repoId,
        repoRelativePathPosix: 'src/a.rs',
        content: ['use crate::foo;', ''].join('\n'),
      }),
      await writeBundleNormFile({
        root,
        repoId,
        repoRelativePathPosix: 'src/b.rs',
        content: ['use crate::foo;', ''].join('\n'),
      }),
    ];

    const facts = await extractBundleFacts({
      bundleRoot: root,
      repos: [{ repoId, files }],
      enablePhase2: true,
    });

    const modFoo = facts.modules!.find((m) => m.path.endsWith('/src/foo.rs'));
    expect(modFoo).toBeTruthy();

    // Imported by 2 modules -> classified as core.
    expect(modFoo!.role).toBe('core');
  });

  it('resolves local Python relative imports for role detection', async () => {
    const repoId = 'acme/py-demo';

    const files: IngestedFile[] = [
      await writeBundleNormFile({
        root,
        repoId,
        repoRelativePathPosix: 'pkg/__init__.py',
        content: [''].join('\n'),
      }),
      await writeBundleNormFile({
        root,
        repoId,
        repoRelativePathPosix: 'pkg/foo.py',
        content: ['def foo():', '  return 1', ''].join('\n'),
      }),
      await writeBundleNormFile({
        root,
        repoId,
        repoRelativePathPosix: 'pkg/a.py',
        content: ['from . import foo', ''].join('\n'),
      }),
      await writeBundleNormFile({
        root,
        repoId,
        repoRelativePathPosix: 'pkg/b.py',
        content: ['from . import foo', ''].join('\n'),
      }),
    ];

    const facts = await extractBundleFacts({
      bundleRoot: root,
      repos: [{ repoId, files }],
      enablePhase2: true,
    });

    const modFoo = facts.modules!.find((m) => m.path.endsWith('/pkg/foo.py'));
    expect(modFoo).toBeTruthy();

    // Imported by 2 modules -> classified as core.
    expect(modFoo!.role).toBe('core');
  });
});
