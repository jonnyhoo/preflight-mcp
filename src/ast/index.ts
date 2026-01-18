/**
 * Tree-sitter AST Module
 *
 * Unified interface for AST parsing and code analysis using tree-sitter.
 *
 * @module ast
 */

import { Parser } from 'web-tree-sitter';

// Re-export types
export * from './types.js';

// Re-export parser utilities
export { languageForFile, parseFileWasm, Parser } from './parser.js';

// Re-export Tree type
export type { Tree } from 'web-tree-sitter';

// Import internal functions
import { languageForFile, loadLanguage } from './parser.js';
import type { TreeSitterLanguageId, ImportRef, SymbolOutline, ExtensionPoint } from './types.js';

// Import language-specific extractors
import {
  extractImportsJsTs,
  extractExportsJsTs,
  extractOutlineJsTs,
  extractExtensionPointsJsTs,
} from './languages/javascript.js';

import {
  extractImportsPython,
  extractExportsPython,
  extractOutlinePython,
  extractExtensionPointsPython,
} from './languages/python.js';

import {
  extractImportsGo,
  extractExportsGo,
  extractOutlineGo,
  extractExtensionPointsGo,
} from './languages/go.js';

import {
  extractImportsRust,
  extractExportsRust,
  extractOutlineRust,
  extractExtensionPointsRust,
} from './languages/rust.js';

import {
  extractImportsJava,
  extractExportsJava,
  extractOutlineJava,
  extractExtensionPointsJava,
} from './languages/java.js';

import type { Node } from 'web-tree-sitter';

// ============================================================================
// Internal dispatch functions
// ============================================================================

function extractImports(root: Node, lang: TreeSitterLanguageId): ImportRef[] {
  switch (lang) {
    case 'javascript':
    case 'typescript':
    case 'tsx':
      return extractImportsJsTs(root, lang);
    case 'python':
      return extractImportsPython(root);
    case 'go':
      return extractImportsGo(root);
    case 'java':
      return extractImportsJava(root);
    case 'rust':
      return extractImportsRust(root);
  }
}

function extractExports(root: Node, lang: TreeSitterLanguageId): string[] {
  switch (lang) {
    case 'javascript':
    case 'typescript':
    case 'tsx':
      return extractExportsJsTs(root);
    case 'python':
      return extractExportsPython(root);
    case 'go':
      return extractExportsGo(root);
    case 'java':
      return extractExportsJava(root);
    case 'rust':
      return extractExportsRust(root);
  }
}

function extractOutline(root: Node, lang: TreeSitterLanguageId): SymbolOutline[] {
  switch (lang) {
    case 'javascript':
    case 'typescript':
    case 'tsx':
      return extractOutlineJsTs(root, lang);
    case 'python':
      return extractOutlinePython(root);
    case 'go':
      return extractOutlineGo(root);
    case 'java':
      return extractOutlineJava(root);
    case 'rust':
      return extractOutlineRust(root);
  }
}

function extractExtensionPoints(root: Node, lang: TreeSitterLanguageId): ExtensionPoint[] {
  switch (lang) {
    case 'javascript':
    case 'typescript':
    case 'tsx':
      return extractExtensionPointsJsTs(root, lang);
    case 'python':
      return extractExtensionPointsPython(root);
    case 'go':
      return extractExtensionPointsGo(root);
    case 'java':
      return extractExtensionPointsJava(root);
    case 'rust':
      return extractExtensionPointsRust(root);
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Extract imports and exports from a source file.
 */
export async function extractModuleSyntaxWasm(
  filePath: string,
  normalizedContent: string
): Promise<{ language: TreeSitterLanguageId; imports: ImportRef[]; exports: string[] } | null> {
  const lang = languageForFile(filePath);
  if (!lang) return null;

  const language = await loadLanguage(lang);

  const parser = new Parser();
  try {
    parser.setLanguage(language);

    const tree = parser.parse(normalizedContent);
    if (!tree) return { language: lang, imports: [], exports: [] };

    try {
      const root = tree.rootNode;
      return {
        language: lang,
        imports: extractImports(root, lang),
        exports: extractExports(root, lang),
      };
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

/**
 * Extract import references from a source file.
 */
export async function extractImportRefsWasm(
  filePath: string,
  normalizedContent: string
): Promise<{ language: TreeSitterLanguageId; imports: ImportRef[] } | null> {
  const res = await extractModuleSyntaxWasm(filePath, normalizedContent);
  if (!res) return null;
  return { language: res.language, imports: res.imports };
}

/**
 * Extract exported symbols from a source file.
 */
export async function extractExportedSymbolsWasm(
  filePath: string,
  normalizedContent: string
): Promise<{ language: TreeSitterLanguageId; exports: string[] } | null> {
  const res = await extractModuleSyntaxWasm(filePath, normalizedContent);
  if (!res) return null;
  return { language: res.language, exports: res.exports };
}

/**
 * Extract symbol outline from a source file.
 * Returns null if the file type is not supported.
 */
export async function extractOutlineWasm(
  filePath: string,
  normalizedContent: string
): Promise<{ language: TreeSitterLanguageId; outline: SymbolOutline[] } | null> {
  const lang = languageForFile(filePath);
  if (!lang) return null;

  if (!['javascript', 'typescript', 'tsx', 'python', 'go', 'rust', 'java'].includes(lang)) {
    return null;
  }

  const language = await loadLanguage(lang);

  const parser = new Parser();
  try {
    parser.setLanguage(language);

    const tree = parser.parse(normalizedContent);
    if (!tree) return { language: lang, outline: [] };

    try {
      const root = tree.rootNode;
      return { language: lang, outline: extractOutline(root, lang) };
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

/**
 * Extract extension points from a source file using tree-sitter.
 * Returns null if the file type is not supported.
 */
export async function extractExtensionPointsWasm(
  filePath: string,
  normalizedContent: string
): Promise<{ language: TreeSitterLanguageId; extensionPoints: ExtensionPoint[] } | null> {
  const lang = languageForFile(filePath);
  if (!lang) return null;

  if (!['python', 'go', 'rust', 'java', 'javascript', 'typescript', 'tsx'].includes(lang)) {
    return null;
  }

  const language = await loadLanguage(lang);

  const parser = new Parser();
  try {
    parser.setLanguage(language);

    const tree = parser.parse(normalizedContent);
    if (!tree) return { language: lang, extensionPoints: [] };

    try {
      const root = tree.rootNode;
      return { language: lang, extensionPoints: extractExtensionPoints(root, lang) };
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}
