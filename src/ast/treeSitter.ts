import path from 'node:path';
import { createRequire } from 'node:module';

import { Language, Parser, type Node } from 'web-tree-sitter';

export type TreeSitterLanguageId =
  | 'javascript'
  | 'typescript'
  | 'tsx'
  | 'python'
  | 'go'
  | 'java'
  | 'rust';

export type ImportKind =
  | 'import'
  | 'exportFrom'
  | 'dynamicImport'
  | 'require'
  | 'pythonImport'
  | 'pythonFrom'
  | 'goImport'
  | 'javaImport'
  | 'rustUse'
  | 'rustExternCrate';

// Symbol outline types for code structure extraction
export type SymbolKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'variable';

export type SymbolOutline = {
  kind: SymbolKind;
  name: string;
  signature?: string;  // e.g. "(a: number, b: string): boolean"
  range: { startLine: number; endLine: number };
  exported: boolean;
  children?: SymbolOutline[];  // For class methods
};

export type ImportRef = {
  language: TreeSitterLanguageId;
  kind: ImportKind;
  module: string;
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
};

const require = createRequire(import.meta.url);

let initPromise: Promise<void> | undefined;
const languageCache = new Map<TreeSitterLanguageId, Promise<Language>>();

function normalizeExt(p: string): string {
  return path.extname(p).toLowerCase();
}

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

async function ensureInit(): Promise<void> {
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

async function loadLanguage(lang: TreeSitterLanguageId): Promise<Language> {
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

function rangeFromNode(n: Node): {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
} {
  return {
    startLine: n.startPosition.row + 1,
    startCol: n.startPosition.column + 1,
    endLine: n.endPosition.row + 1,
    endCol: n.endPosition.column + 1,
  };
}

function firstStringFragment(node: Node): Node | null {
  const frags = node.descendantsOfType('string_fragment');
  return frags[0] ?? null;
}

function firstOfTypes(node: Node, types: string[]): Node | null {
  for (const t of types) {
    const found = node.descendantsOfType(t);
    if (found[0]) return found[0];
  }
  return null;
}

function extractImportsJsTs(root: Node, lang: TreeSitterLanguageId): ImportRef[] {
  const out: ImportRef[] = [];

  for (const st of root.descendantsOfType(['import_statement', 'export_statement'])) {
    const source = st.childForFieldName('source');
    if (!source) continue;

    const frag = firstStringFragment(source);
    if (!frag) continue;

    out.push({
      language: lang,
      kind: st.type === 'export_statement' ? 'exportFrom' : 'import',
      module: frag.text,
      range: rangeFromNode(frag),
    });
  }

  for (const call of root.descendantsOfType('call_expression')) {
    const fn = call.childForFieldName('function');
    if (!fn) continue;

    const args = call.childForFieldName('arguments');
    const arg0 = args?.namedChild(0);
    if (!arg0 || arg0.type !== 'string') continue;

    const frag = firstStringFragment(arg0);
    if (!frag) continue;

    // Dynamic import: import("x")
    if (fn.type === 'import') {
      out.push({
        language: lang,
        kind: 'dynamicImport',
        module: frag.text,
        range: rangeFromNode(frag),
      });
      continue;
    }

    // CommonJS require: require("x")
    if (fn.type === 'identifier' && fn.text === 'require') {
      out.push({
        language: lang,
        kind: 'require',
        module: frag.text,
        range: rangeFromNode(frag),
      });
    }
  }

  return out;
}

function extractImportsPython(root: Node): ImportRef[] {
  const out: ImportRef[] = [];

  for (const st of root.descendantsOfType('import_statement')) {
    const name = st.childForFieldName('name');
    if (!name) continue;

    const dotted = name.type === 'aliased_import' ? name.childForFieldName('name') : name;
    if (!dotted) continue;

    out.push({
      language: 'python',
      kind: 'pythonImport',
      module: dotted.text,
      range: rangeFromNode(dotted),
    });
  }

  for (const st of root.descendantsOfType('import_from_statement')) {
    const modName = st.childForFieldName('module_name');
    if (!modName) continue;

    // For relative imports like `from . import foo`, tree-sitter gives module_name = `.` (relative_import)
    // and then repeats `name:` fields for each imported identifier. Expand these into `.foo` so downstream
    // consumers can resolve local imports.
    if (modName.type === 'relative_import') {
      const hasExplicitModule = modName.descendantsOfType('dotted_name')[0] != null;
      if (!hasExplicitModule) {
        const prefix = modName.text;
        const names = st.childrenForFieldName('name');

        let expanded = false;
        for (const n of names) {
          const base = n.type === 'aliased_import' ? n.childForFieldName('name') : n;
          if (!base) continue;

          // `from . import *`
          if (base.text === '*') continue;

          expanded = true;
          out.push({
            language: 'python',
            kind: 'pythonFrom',
            module: `${prefix}${base.text}`,
            range: rangeFromNode(base),
          });
        }

        if (expanded) continue;
      }
    }

    out.push({
      language: 'python',
      kind: 'pythonFrom',
      module: modName.text,
      range: rangeFromNode(modName),
    });
  }

  return out;
}

function extractImportsGo(root: Node): ImportRef[] {
  const out: ImportRef[] = [];

  for (const spec of root.descendantsOfType('import_spec')) {
    const p = spec.childForFieldName('path');
    if (!p) continue;

    const content = firstOfTypes(p, [
      'interpreted_string_literal_content',
      'raw_string_literal_content',
    ]);

    if (!content) continue;

    out.push({
      language: 'go',
      kind: 'goImport',
      module: content.text,
      range: rangeFromNode(content),
    });
  }

  return out;
}

function extractImportsJava(root: Node): ImportRef[] {
  const out: ImportRef[] = [];

  for (const decl of root.descendantsOfType('import_declaration')) {
    const scoped = decl.namedChild(0);
    if (!scoped || scoped.type !== 'scoped_identifier') continue;

    const asterisk = decl.descendantsOfType('asterisk')[0];

    if (asterisk) {
      out.push({
        language: 'java',
        kind: 'javaImport',
        module: `${scoped.text}.*`,
        range: {
          startLine: scoped.startPosition.row + 1,
          startCol: scoped.startPosition.column + 1,
          endLine: asterisk.endPosition.row + 1,
          endCol: asterisk.endPosition.column + 1,
        },
      });
    } else {
      out.push({
        language: 'java',
        kind: 'javaImport',
        module: scoped.text,
        range: rangeFromNode(scoped),
      });
    }
  }

  return out;
}

function extractImportsRust(root: Node): ImportRef[] {
  const out: ImportRef[] = [];

  const unwrapUseAsClause = (n: Node): Node => {
    if (n.type !== 'use_as_clause') return n;
    return (n.childForFieldName('path') ?? n.namedChild(0) ?? n);
  };

  const rootNodeForUseListItem = (n: Node): Node | null => {
    const unwrapped = unwrapUseAsClause(n);

    if (unwrapped.type === 'scoped_use_list') {
      return unwrapped.childForFieldName('path') ?? null;
    }

    if (
      unwrapped.type === 'identifier' ||
      unwrapped.type === 'scoped_identifier' ||
      unwrapped.type === 'crate' ||
      unwrapped.type === 'self' ||
      unwrapped.type === 'super'
    ) {
      return unwrapped;
    }

    return null;
  };

  for (const decl of root.descendantsOfType('use_declaration')) {
    const arg = decl.childForFieldName('argument');
    if (!arg) continue;

    if (arg.type === 'scoped_use_list') {
      const p = arg.childForFieldName('path') ?? arg;
      const list = arg.childForFieldName('list');

      // Special-case: `use crate::{foo, bar};` / `use super::{foo, bar};` / `use self::{foo, bar};`
      // These are very common for local module imports and should be expanded.
      if (list && (p.type === 'crate' || p.type === 'super' || p.type === 'self')) {
        for (const item of list.namedChildren) {
          const rootNode = rootNodeForUseListItem(item);
          if (!rootNode) continue;

          // `use crate::{self, foo};` doesn't add a meaningful module target for our purposes.
          if (rootNode.type === 'self') continue;

          out.push({
            language: 'rust',
            kind: 'rustUse',
            module: `${p.text}::${rootNode.text}`,
            range: rangeFromNode(rootNode),
          });
        }
        continue;
      }

      // Default behavior: treat the `path` as the imported module.
      out.push({
        language: 'rust',
        kind: 'rustUse',
        module: p.text,
        range: rangeFromNode(p),
      });
      continue;
    }

    out.push({
      language: 'rust',
      kind: 'rustUse',
      module: arg.text,
      range: rangeFromNode(arg),
    });
  }

  for (const decl of root.descendantsOfType('extern_crate_declaration')) {
    const name = decl.childForFieldName('name');
    if (!name) continue;

    out.push({
      language: 'rust',
      kind: 'rustExternCrate',
      module: name.text,
      range: rangeFromNode(name),
    });
  }

  return out;
}

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

function extractExportsJsTs(root: Node): string[] {
  const out = new Set<string>();

  // ES module exports
  for (const st of root.descendantsOfType('export_statement')) {
    if (/^\s*export\s+default\b/.test(st.text)) {
      out.add('default');
    }

    const clause = st.descendantsOfType('export_clause')[0];
    if (clause) {
      for (const spec of clause.descendantsOfType('export_specifier')) {
        const alias = spec.childForFieldName('alias');
        const name = (alias ?? spec.childForFieldName('name'));
        if (name) out.add(name.text);
      }
      continue;
    }

    // export function/class/type/interface/enum ...
    const direct = st.namedChildren;
    for (const child of direct) {
      if (
        child.type === 'function_declaration' ||
        child.type === 'class_declaration' ||
        child.type === 'interface_declaration' ||
        child.type === 'type_alias_declaration' ||
        child.type === 'enum_declaration'
      ) {
        const name = child.childForFieldName('name');
        if (name) out.add(name.text);
      }

      if (child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
        for (const decl of child.descendantsOfType('variable_declarator')) {
          const name = decl.childForFieldName('name');
          if (name && name.type === 'identifier') out.add(name.text);
        }
      }
    }
  }

  // CommonJS exports (best-effort): module.exports / exports.foo
  for (const asn of root.descendantsOfType('assignment_expression')) {
    const left = asn.childForFieldName('left');
    if (!left) continue;

    // exports.foo = ...
    if (left.type === 'member_expression') {
      const obj = left.childForFieldName('object');
      const prop = left.childForFieldName('property');
      if (obj?.type === 'identifier' && obj.text === 'exports' && prop) {
        out.add(prop.text);
        continue;
      }

      // module.exports = ...
      if (obj?.type === 'identifier' && obj.text === 'module' && prop && prop.text === 'exports') {
        out.add('default');
        continue;
      }

      // module.exports.foo = ...
      if (obj?.type === 'member_expression' && prop) {
        const obj2 = obj.childForFieldName('object');
        const prop2 = obj.childForFieldName('property');
        if (obj2?.type === 'identifier' && obj2.text === 'module' && prop2?.text === 'exports') {
          out.add(prop.text);
        }
      }
    }
  }

  return Array.from(out);
}

function unquoteStringLiteral(raw: string): string | null {
  let t = raw.trim();

  // Handles prefixes like r"..", f'..', etc.
  t = t.replace(/^[rRuUbBfF]+/, '');

  const q = t[0];
  if (q !== '"' && q !== "'") return null;
  if (t.length < 2 || t[t.length - 1] !== q) return null;

  return t.slice(1, -1);
}

function extractExportsPython(root: Node): string[] {
  const out = new Set<string>();

  // __all__ = ['a', 'b'] (literal only)
  for (const asn of root.descendantsOfType(['assignment', 'assignment_statement'])) {
    // Keep this conservative: only accept module-level assignments.
    // NOTE: web-tree-sitter node wrappers are not guaranteed to be referentially stable,
    // so avoid `=== root` checks.
    const parent = asn.parent;
    const grandParent = parent?.parent;
    const isTopLevel =
      (parent !== null && parent.parent === null) ||
      (grandParent !== null && grandParent?.parent === null);

    if (!isTopLevel) continue;

    const left = asn.childForFieldName('left') ?? asn.namedChild(0);
    if (!left || left.text !== '__all__') continue;

    const right = asn.childForFieldName('right') ?? asn.namedChild(asn.namedChildCount - 1);

    let listOrTuple: Node | null = null;
    if (right) {
      listOrTuple =
        right.type === 'list' || right.type === 'tuple'
          ? right
          : right.type === 'parenthesized_expression'
            ? (right.descendantsOfType('list')[0] ?? right.descendantsOfType('tuple')[0] ?? null)
            : null;
    }

    // Fallback: different python grammars may not expose assignment fields consistently.
    if (!listOrTuple) {
      listOrTuple = firstOfTypes(asn, ['list', 'tuple']);
    }

    if (!listOrTuple) continue;

    for (const s of listOrTuple.descendantsOfType('string')) {
      const inner = unquoteStringLiteral(s.text);
      if (inner) out.add(inner);
    }
  }

  // Top-level defs/classes (heuristic for public API)
  for (const child of root.namedChildren) {
    if (child.type === 'function_definition' || child.type === 'class_definition') {
      const name = child.childForFieldName('name');
      const n = name?.text ?? '';
      if (n && !n.startsWith('_')) out.add(n);
    }
  }

  return Array.from(out);
}

function extractExportsGo(root: Node): string[] {
  const out = new Set<string>();

  const topLevel = root.namedChildren;

  for (const n of topLevel) {
    if (n.type === 'function_declaration' || n.type === 'method_declaration') {
      const name = n.childForFieldName('name') ?? n.descendantsOfType('identifier')[0];
      const t = name?.text ?? '';
      if (t && /^[A-Z]/.test(t)) out.add(t);
    }

    if (n.type === 'type_declaration') {
      for (const spec of n.descendantsOfType('type_spec')) {
        const name = spec.childForFieldName('name') ?? spec.descendantsOfType('type_identifier')[0];
        const t = name?.text ?? '';
        if (t && /^[A-Z]/.test(t)) out.add(t);
      }
    }
  }

  return Array.from(out);
}

function extractExportsJava(root: Node): string[] {
  const out = new Set<string>();

  for (const n of root.namedChildren) {
    if (
      n.type !== 'class_declaration' &&
      n.type !== 'interface_declaration' &&
      n.type !== 'enum_declaration' &&
      n.type !== 'record_declaration'
    ) {
      continue;
    }

    const mods = n.childForFieldName('modifiers') ?? n.namedChild(0);
    if (mods && !mods.text.includes('public')) continue;

    const name = n.childForFieldName('name');
    if (name) out.add(name.text);
  }

  return Array.from(out);
}

function hasRustPubVisibility(n: Node): boolean {
  const first = n.namedChild(0);
  if (first?.type === 'visibility_modifier' && first.text.startsWith('pub')) return true;
  const vis = n.childForFieldName('visibility');
  if (vis?.type === 'visibility_modifier' && vis.text.startsWith('pub')) return true;
  return false;
}

function extractExportsRust(root: Node): string[] {
  const out = new Set<string>();

  const candidates = [
    'function_item',
    'struct_item',
    'enum_item',
    'trait_item',
    'type_item',
    'const_item',
    'static_item',
    'mod_item',
  ];

  for (const n of root.namedChildren) {
    if (!candidates.includes(n.type)) continue;
    if (!hasRustPubVisibility(n)) continue;

    const name = n.childForFieldName('name');
    if (name) out.add(name.text);
  }

  return Array.from(out);
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

export async function extractImportRefsWasm(
  filePath: string,
  normalizedContent: string
): Promise<{ language: TreeSitterLanguageId; imports: ImportRef[] } | null> {
  const res = await extractModuleSyntaxWasm(filePath, normalizedContent);
  if (!res) return null;
  return { language: res.language, imports: res.imports };
}

export async function extractExportedSymbolsWasm(
  filePath: string,
  normalizedContent: string
): Promise<{ language: TreeSitterLanguageId; exports: string[] } | null> {
  const res = await extractModuleSyntaxWasm(filePath, normalizedContent);
  if (!res) return null;
  return { language: res.language, exports: res.exports };
}

// ============================================================================
// Outline extraction (symbol structure for code navigation)
// ============================================================================

/**
 * Check if a node is preceded by an export keyword (for JS/TS).
 */
function isExportedJsTs(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  
  // Direct export: export function foo() {}
  if (parent.type === 'export_statement') return true;
  
  // export default function foo() {}
  if (parent.type === 'export_statement' && parent.text.includes('default')) return true;
  
  return false;
}

/**
 * Extract function signature from a function declaration node.
 */
function extractFunctionSignatureJsTs(node: Node): string | undefined {
  const params = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('return_type');
  
  if (!params) return undefined;
  
  let sig = params.text;
  if (returnType) {
    sig += `: ${returnType.text}`;
  }
  
  return sig;
}

/**
 * Extract method signature from a method definition node.
 */
function extractMethodSignatureJsTs(node: Node): string | undefined {
  const params = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('return_type');
  
  if (!params) return undefined;
  
  let sig = params.text;
  if (returnType) {
    sig += `: ${returnType.text}`;
  }
  
  return sig;
}

/**
 * Extract class methods as children.
 */
function extractClassMethodsJsTs(classNode: Node): SymbolOutline[] {
  const methods: SymbolOutline[] = [];
  const body = classNode.childForFieldName('body');
  if (!body) return methods;
  
  for (const child of body.namedChildren) {
    if (child.type === 'method_definition' || child.type === 'public_field_definition') {
      const name = child.childForFieldName('name');
      if (!name) continue;
      
      const isMethod = child.type === 'method_definition';
      
      methods.push({
        kind: isMethod ? 'method' : 'variable',
        name: name.text,
        signature: isMethod ? extractMethodSignatureJsTs(child) : undefined,
        range: {
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        },
        exported: true,  // Class members are implicitly accessible
      });
    }
  }
  
  return methods;
}

/**
 * Extract outline from JavaScript/TypeScript/TSX files.
 */
function extractOutlineJsTs(root: Node, lang: TreeSitterLanguageId): SymbolOutline[] {
  const outline: SymbolOutline[] = [];
  
  // Collect all exported names for checking
  const exportedNames = new Set<string>();
  for (const st of root.descendantsOfType('export_statement')) {
    // export { name1, name2 }
    const clause = st.descendantsOfType('export_clause')[0];
    if (clause) {
      for (const spec of clause.descendantsOfType('export_specifier')) {
        const name = spec.childForFieldName('name');
        if (name) exportedNames.add(name.text);
      }
    }
  }
  
  for (const child of root.namedChildren) {
    // Handle export statements
    let actualNode = child;
    let isExported = false;
    
    if (child.type === 'export_statement') {
      isExported = true;
      // Get the actual declaration inside
      const decl = child.namedChildren.find(n => 
        n.type !== 'export_clause' && 
        n.type !== 'string' &&
        n.type !== 'comment'
      );
      if (decl) {
        actualNode = decl;
      } else {
        continue;  // export { ... } without declaration
      }
    }
    
    const name = actualNode.childForFieldName('name');
    
    switch (actualNode.type) {
      case 'function_declaration': {
        if (!name) continue;
        outline.push({
          kind: 'function',
          name: name.text,
          signature: extractFunctionSignatureJsTs(actualNode),
          range: {
            startLine: actualNode.startPosition.row + 1,
            endLine: actualNode.endPosition.row + 1,
          },
          exported: isExported || exportedNames.has(name.text),
        });
        break;
      }
      
      case 'class_declaration': {
        if (!name) continue;
        const children = extractClassMethodsJsTs(actualNode);
        outline.push({
          kind: 'class',
          name: name.text,
          range: {
            startLine: actualNode.startPosition.row + 1,
            endLine: actualNode.endPosition.row + 1,
          },
          exported: isExported || exportedNames.has(name.text),
          children: children.length > 0 ? children : undefined,
        });
        break;
      }
      
      case 'interface_declaration': {
        if (!name) continue;
        outline.push({
          kind: 'interface',
          name: name.text,
          range: {
            startLine: actualNode.startPosition.row + 1,
            endLine: actualNode.endPosition.row + 1,
          },
          exported: isExported || exportedNames.has(name.text),
        });
        break;
      }
      
      case 'type_alias_declaration': {
        if (!name) continue;
        outline.push({
          kind: 'type',
          name: name.text,
          range: {
            startLine: actualNode.startPosition.row + 1,
            endLine: actualNode.endPosition.row + 1,
          },
          exported: isExported || exportedNames.has(name.text),
        });
        break;
      }
      
      case 'enum_declaration': {
        if (!name) continue;
        outline.push({
          kind: 'enum',
          name: name.text,
          range: {
            startLine: actualNode.startPosition.row + 1,
            endLine: actualNode.endPosition.row + 1,
          },
          exported: isExported || exportedNames.has(name.text),
        });
        break;
      }
      
      case 'lexical_declaration':
      case 'variable_declaration': {
        // const/let/var declarations
        for (const decl of actualNode.descendantsOfType('variable_declarator')) {
          const varName = decl.childForFieldName('name');
          if (!varName || varName.type !== 'identifier') continue;
          
          // Check if it's an arrow function
          const value = decl.childForFieldName('value');
          const isArrowFn = value?.type === 'arrow_function';
          
          outline.push({
            kind: isArrowFn ? 'function' : 'variable',
            name: varName.text,
            signature: isArrowFn ? extractFunctionSignatureJsTs(value) : undefined,
            range: {
              startLine: decl.startPosition.row + 1,
              endLine: decl.endPosition.row + 1,
            },
            exported: isExported || exportedNames.has(varName.text),
          });
        }
        break;
      }
    }
  }
  
  return outline;
}

/**
 * Extract function signature from Python function definition.
 */
function extractFunctionSignaturePython(node: Node): string | undefined {
  const params = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('return_type');
  
  if (!params) return undefined;
  
  let sig = params.text;
  if (returnType) {
    sig += ` -> ${returnType.text}`;
  }
  
  return sig;
}

/**
 * Extract class methods for Python.
 */
function extractClassMethodsPython(classNode: Node): SymbolOutline[] {
  const methods: SymbolOutline[] = [];
  const body = classNode.childForFieldName('body');
  if (!body) return methods;
  
  for (const child of body.namedChildren) {
    if (child.type === 'function_definition') {
      const name = child.childForFieldName('name');
      if (!name) continue;
      
      const methodName = name.text;
      // Skip private methods (starting with __) except __init__
      const isPrivate = methodName.startsWith('_') && methodName !== '__init__';
      
      methods.push({
        kind: 'method',
        name: methodName,
        signature: extractFunctionSignaturePython(child),
        range: {
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        },
        exported: !isPrivate,
      });
    }
  }
  
  return methods;
}

/**
 * Extract outline from Python files.
 */
function extractOutlinePython(root: Node): SymbolOutline[] {
  const outline: SymbolOutline[] = [];
  
  // Check __all__ for explicit exports
  const exportedNames = new Set<string>();
  for (const asn of root.descendantsOfType(['assignment', 'assignment_statement'])) {
    const left = asn.childForFieldName('left') ?? asn.namedChild(0);
    if (!left || left.text !== '__all__') continue;
    
    const right = asn.childForFieldName('right') ?? asn.namedChild(asn.namedChildCount - 1);
    if (!right) continue;
    
    // Extract names from list/tuple
    for (const s of right.descendantsOfType('string')) {
      const inner = s.text.replace(/^['"]|['"]$/g, '');
      if (inner) exportedNames.add(inner);
    }
  }
  
  const hasExplicitAll = exportedNames.size > 0;
  
  for (const child of root.namedChildren) {
    switch (child.type) {
      case 'function_definition': {
        const name = child.childForFieldName('name');
        if (!name) continue;
        
        const funcName = name.text;
        // Public if: in __all__, or doesn't start with _ (when no __all__)
        const isPublic = hasExplicitAll 
          ? exportedNames.has(funcName)
          : !funcName.startsWith('_');
        
        outline.push({
          kind: 'function',
          name: funcName,
          signature: extractFunctionSignaturePython(child),
          range: {
            startLine: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
          },
          exported: isPublic,
        });
        break;
      }
      
      case 'class_definition': {
        const name = child.childForFieldName('name');
        if (!name) continue;
        
        const className = name.text;
        const isPublic = hasExplicitAll
          ? exportedNames.has(className)
          : !className.startsWith('_');
        
        const methods = extractClassMethodsPython(child);
        
        outline.push({
          kind: 'class',
          name: className,
          range: {
            startLine: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
          },
          exported: isPublic,
          children: methods.length > 0 ? methods : undefined,
        });
        break;
      }
    }
  }
  
  return outline;
}

/**
 * Extract outline from Go files.
 */
function extractOutlineGo(root: Node): SymbolOutline[] {
  const outline: SymbolOutline[] = [];
  
  for (const child of root.namedChildren) {
    switch (child.type) {
      case 'function_declaration': {
        const name = child.childForFieldName('name');
        if (!name) continue;
        
        const funcName = name.text;
        // Go: exported if starts with uppercase
        const isExported = /^[A-Z]/.test(funcName);
        
        // Extract signature
        const params = child.childForFieldName('parameters');
        const result = child.childForFieldName('result');
        let sig = params?.text || '()';
        if (result) sig += ` ${result.text}`;
        
        outline.push({
          kind: 'function',
          name: funcName,
          signature: sig,
          range: {
            startLine: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
          },
          exported: isExported,
        });
        break;
      }
      
      case 'method_declaration': {
        const name = child.childForFieldName('name');
        if (!name) continue;
        
        const methodName = name.text;
        const isExported = /^[A-Z]/.test(methodName);
        
        // Get receiver type
        const receiver = child.childForFieldName('receiver');
        const params = child.childForFieldName('parameters');
        const result = child.childForFieldName('result');
        
        let sig = params?.text || '()';
        if (result) sig += ` ${result.text}`;
        if (receiver) sig = `${receiver.text} ${sig}`;
        
        outline.push({
          kind: 'method',
          name: methodName,
          signature: sig,
          range: {
            startLine: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
          },
          exported: isExported,
        });
        break;
      }
      
      case 'type_declaration': {
        // type Foo struct { ... } or type Bar interface { ... }
        for (const spec of child.descendantsOfType('type_spec')) {
          const name = spec.childForFieldName('name');
          if (!name) continue;
          
          const typeName = name.text;
          const isExported = /^[A-Z]/.test(typeName);
          
          // Determine kind based on type definition
          const typeNode = spec.childForFieldName('type');
          let kind: SymbolKind = 'type';
          if (typeNode?.type === 'struct_type') kind = 'class';  // Treat struct as class
          else if (typeNode?.type === 'interface_type') kind = 'interface';
          
          outline.push({
            kind,
            name: typeName,
            range: {
              startLine: spec.startPosition.row + 1,
              endLine: spec.endPosition.row + 1,
            },
            exported: isExported,
          });
        }
        break;
      }
    }
  }
  
  return outline;
}

/**
 * Extract outline from Rust files.
 */
function extractOutlineRust(root: Node): SymbolOutline[] {
  const outline: SymbolOutline[] = [];
  
  for (const child of root.namedChildren) {
    switch (child.type) {
      case 'function_item': {
        const name = child.childForFieldName('name');
        if (!name) continue;
        
        const funcName = name.text;
        const isExported = hasRustPubVisibility(child);
        
        // Extract signature
        const params = child.childForFieldName('parameters');
        const returnType = child.childForFieldName('return_type');
        let sig = params?.text || '()';
        if (returnType) sig += ` -> ${returnType.text}`;
        
        outline.push({
          kind: 'function',
          name: funcName,
          signature: sig,
          range: {
            startLine: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
          },
          exported: isExported,
        });
        break;
      }
      
      case 'struct_item': {
        const name = child.childForFieldName('name');
        if (!name) continue;
        
        const structName = name.text;
        const isExported = hasRustPubVisibility(child);
        
        outline.push({
          kind: 'class',  // Treat struct as class
          name: structName,
          range: {
            startLine: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
          },
          exported: isExported,
        });
        break;
      }
      
      case 'enum_item': {
        const name = child.childForFieldName('name');
        if (!name) continue;
        
        const enumName = name.text;
        const isExported = hasRustPubVisibility(child);
        
        outline.push({
          kind: 'enum',
          name: enumName,
          range: {
            startLine: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
          },
          exported: isExported,
        });
        break;
      }
      
      case 'trait_item': {
        const name = child.childForFieldName('name');
        if (!name) continue;
        
        const traitName = name.text;
        const isExported = hasRustPubVisibility(child);
        
        outline.push({
          kind: 'interface',  // Treat trait as interface
          name: traitName,
          range: {
            startLine: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
          },
          exported: isExported,
        });
        break;
      }
      
      case 'type_item': {
        const name = child.childForFieldName('name');
        if (!name) continue;
        
        const typeName = name.text;
        const isExported = hasRustPubVisibility(child);
        
        outline.push({
          kind: 'type',
          name: typeName,
          range: {
            startLine: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
          },
          exported: isExported,
        });
        break;
      }
      
      case 'impl_item': {
        // Extract methods from impl blocks
        const typeNode = child.childForFieldName('type');
        const typeName = typeNode?.text || 'impl';
        
        // Find all function_items inside the impl
        const body = child.childForFieldName('body');
        if (!body) continue;
        
        const methods: SymbolOutline[] = [];
        for (const item of body.namedChildren) {
          if (item.type === 'function_item') {
            const name = item.childForFieldName('name');
            if (!name) continue;
            
            const methodName = name.text;
            const isExported = hasRustPubVisibility(item);
            
            const params = item.childForFieldName('parameters');
            const returnType = item.childForFieldName('return_type');
            let sig = params?.text || '()';
            if (returnType) sig += ` -> ${returnType.text}`;
            
            methods.push({
              kind: 'method',
              name: methodName,
              signature: sig,
              range: {
                startLine: item.startPosition.row + 1,
                endLine: item.endPosition.row + 1,
              },
              exported: isExported,
            });
          }
        }
        
        if (methods.length > 0) {
          outline.push({
            kind: 'class',  // impl block as a class-like container
            name: `impl ${typeName}`,
            range: {
              startLine: child.startPosition.row + 1,
              endLine: child.endPosition.row + 1,
            },
            exported: true,  // impl blocks are always "public" in terms of structure
            children: methods,
          });
        }
        break;
      }
    }
  }
  
  return outline;
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
  
  // Supported languages: JS/TS, Python, Go, Rust
  if (!['javascript', 'typescript', 'tsx', 'python', 'go', 'rust'].includes(lang)) {
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
      let outline: SymbolOutline[];
      
      switch (lang) {
        case 'python':
          outline = extractOutlinePython(root);
          break;
        case 'go':
          outline = extractOutlineGo(root);
          break;
        case 'rust':
          outline = extractOutlineRust(root);
          break;
        default:
          outline = extractOutlineJsTs(root, lang);
      }
      
      return { language: lang, outline };
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}
