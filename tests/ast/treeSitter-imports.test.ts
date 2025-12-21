import { describe, it, expect } from '@jest/globals';

import { extractImportRefsWasm } from '../../src/ast/treeSitter.js';

describe('tree-sitter WASM import extraction (multi-language)', () => {
  it('extracts imports from Python', async () => {
    const code = [
      'import os',
      'import os.path as op',
      'from collections import defaultdict',
      'from pkg.sub import x as y',
      '',
    ].join('\n');

    const res = await extractImportRefsWasm('src/main.py', code);
    expect(res?.language).toBe('python');

    const modules = (res?.imports ?? []).map((i) => i.module);
    expect(modules).toEqual(expect.arrayContaining(['os', 'os.path', 'collections', 'pkg.sub']));
  });

  it('extracts relative imports from Python', async () => {
    const code = [
      'from . import foo, bar as baz',
      'from .. import qux',
      'from .pkg.sub import x',
      'from .foo import thing',
      '',
    ].join('\n');

    const res = await extractImportRefsWasm('pkg/mod.py', code);
    expect(res?.language).toBe('python');

    const modules = (res?.imports ?? []).map((i) => i.module);
    expect(modules).toEqual(expect.arrayContaining(['.foo', '.bar', '..qux', '.pkg.sub']));
  });

  it('extracts imports from Go', async () => {
    const code = [
      'package main',
      'import "fmt"',
      'import (',
      '  "net/http"',
      '  alias "example.com/x"',
      ')',
      '',
    ].join('\n');

    const res = await extractImportRefsWasm('src/main.go', code);
    expect(res?.language).toBe('go');

    const modules = (res?.imports ?? []).map((i) => i.module);
    expect(modules).toEqual(expect.arrayContaining(['fmt', 'net/http', 'example.com/x']));
  });

  it('extracts imports from Java', async () => {
    const code = [
      'package com.acme;',
      'import java.util.List;',
      'import static java.util.Collections.*;',
      'public class Demo {}',
      '',
    ].join('\n');

    const res = await extractImportRefsWasm('src/Demo.java', code);
    expect(res?.language).toBe('java');

    const modules = (res?.imports ?? []).map((i) => i.module);
    expect(modules).toEqual(expect.arrayContaining(['java.util.List', 'java.util.Collections.*']));
  });

  it('extracts use/extern crate from Rust', async () => {
    const code = [
      'use std::collections::HashMap;',
      'use crate::{foo, bar};',
      'use crate::foo::{Bar, Baz};',
      'extern crate serde;',
      'mod inner;',
      '',
    ].join('\n');

    const res = await extractImportRefsWasm('src/lib.rs', code);
    expect(res?.language).toBe('rust');

    const modules = (res?.imports ?? []).map((i) => i.module);
    expect(modules).toEqual(
      expect.arrayContaining(['std::collections::HashMap', 'crate::foo', 'crate::bar', 'serde'])
    );
  });
});
