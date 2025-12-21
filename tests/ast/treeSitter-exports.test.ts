import { describe, it, expect } from '@jest/globals';

import { extractExportedSymbolsWasm } from '../../src/ast/treeSitter.js';

describe('tree-sitter WASM export extraction (multi-language)', () => {
  it('extracts exports from JS/TS (ESM + CommonJS best-effort)', async () => {
    const code = [
      'export const a = 1;',
      'export default function hi() {}',
      'export { a as b };',
      'module.exports.foo = 1;',
      'exports.bar = 2;',
      'module.exports = {};',
      '',
    ].join('\n');

    const res = await extractExportedSymbolsWasm('src/index.cjs', code);
    expect(res?.language).toBe('javascript');

    const symbols = res?.exports ?? [];
    expect(symbols).toEqual(expect.arrayContaining(['a', 'b', 'default', 'foo', 'bar']));
  });

  it('extracts exports from Python (__all__ + public defs/classes)', async () => {
    const code = [
      "__all__ = ['A', 'b']",
      'class Foo:',
      '  pass',
      'def bar():',
      '  return 1',
      'def _private():',
      '  return 2',
      '',
    ].join('\n');

    const res = await extractExportedSymbolsWasm('src/main.py', code);
    expect(res?.language).toBe('python');

    const symbols = res?.exports ?? [];
    expect(symbols).toEqual(expect.arrayContaining(['A', 'b', 'Foo', 'bar']));
    expect(symbols).not.toEqual(expect.arrayContaining(['_private']));
  });

  it('extracts exports from Go (exported identifiers)', async () => {
    const code = [
      'package main',
      'type Foo struct{}',
      'func Bar() {}',
      'func baz() {}',
      '',
    ].join('\n');

    const res = await extractExportedSymbolsWasm('src/main.go', code);
    expect(res?.language).toBe('go');

    const symbols = res?.exports ?? [];
    expect(symbols).toEqual(expect.arrayContaining(['Foo', 'Bar']));
    expect(symbols).not.toEqual(expect.arrayContaining(['baz']));
  });

  it('extracts exports from Java (public top-level types)', async () => {
    const code = [
      'package com.acme;',
      'public class Demo {}',
      'class Private {}',
      'public interface IFoo {}',
      '',
    ].join('\n');

    const res = await extractExportedSymbolsWasm('src/Demo.java', code);
    expect(res?.language).toBe('java');

    const symbols = res?.exports ?? [];
    expect(symbols).toEqual(expect.arrayContaining(['Demo', 'IFoo']));
    expect(symbols).not.toEqual(expect.arrayContaining(['Private']));
  });

  it('extracts exports from Rust (pub items)', async () => {
    const code = [
      'use std::collections::HashMap;',
      'pub fn hello() {}',
      'fn private() {}',
      'pub struct Foo {}',
      'pub mod pubmod {}',
      '',
    ].join('\n');

    const res = await extractExportedSymbolsWasm('src/lib.rs', code);
    expect(res?.language).toBe('rust');

    const symbols = res?.exports ?? [];
    expect(symbols).toEqual(expect.arrayContaining(['hello', 'Foo', 'pubmod']));
    expect(symbols).not.toEqual(expect.arrayContaining(['private']));
  });
});
