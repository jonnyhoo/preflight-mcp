/**
 * Tree-sitter AST Module - Parser Core
 *
 * @module ast/parser
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { Language, Parser, type Tree } from 'web-tree-sitter';
import type { TreeSitterLanguageId } from './types.js';

const require = createRequire(import.meta.url);

let initPromise: Promise<void> | undefined;
const languageCache = new Map<TreeSitterLanguageId, Promise<Language>>();

function normalizeExt(p: string): string {
  return path.extname(p).toLowerCase();
}

/**
 * Determine language from file extension.
 */
export function languageForFile(filePath: string): TreeSitterLanguageId | null {
  const ext = normalizeExt(filePath);

  if (['.ts'].includes(ext)) return 'typescript';
  if (['.tsx'].includes(ext)) return 'tsx';
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'javascript';
  if (ext === '.py') return 'python';
  if (ext === '.go') return 'go';
  if (ext === '.java') return 'java';
  if (ext === '.rs') return 'rust';

  return null;
}

/**
 * Ensure tree-sitter WASM is initialized.
 */
export async function ensureInit(): Promise<void> {
  initPromise ??= Parser.init();
  await initPromise;
}

function wasmPathForLanguage(lang: TreeSitterLanguageId): string {
  const name = (() => {
    switch (lang) {
      case 'javascript':
        return 'tree-sitter-javascript.wasm';
      case 'typescript':
        return 'tree-sitter-typescript.wasm';
      case 'tsx':
        return 'tree-sitter-tsx.wasm';
      case 'python':
        return 'tree-sitter-python.wasm';
      case 'go':
        return 'tree-sitter-go.wasm';
      case 'java':
        return 'tree-sitter-java.wasm';
      case 'rust':
        return 'tree-sitter-rust.wasm';
    }
  })();

  return require.resolve(`@vscode/tree-sitter-wasm/wasm/${name}`);
}

/**
 * Load language grammar (cached).
 */
export async function loadLanguage(lang: TreeSitterLanguageId): Promise<Language> {
  const cached = languageCache.get(lang);
  if (cached) return cached;

  const promise = (async () => {
    await ensureInit();
    const wasmPath = wasmPathForLanguage(lang);
    return Language.load(wasmPath);
  })();

  languageCache.set(lang, promise);
  return promise;
}

/**
 * Parse a file and return the AST tree.
 * The caller is responsible for calling tree.delete() when done.
 */
export async function parseFileWasm(
  filePath: string,
  content: string
): Promise<Tree | null> {
  const lang = languageForFile(filePath);
  if (!lang) return null;

  const language = await loadLanguage(lang);

  const parser = new Parser();
  try {
    parser.setLanguage(language);
    const tree = parser.parse(content);
    return tree;
  } finally {
    parser.delete();
  }
}

export { Parser };
export type { Tree } from 'web-tree-sitter';
