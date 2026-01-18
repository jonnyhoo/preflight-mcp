/**
 * Tree-sitter AST Module - Type Definitions
 *
 * @module ast/types
 */

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
  | 'from'           // Python from ... import
  | 'use'            // Rust use
  | 'externCrate';   // Rust extern crate

export type SymbolKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'variable' | 'module';

export type SymbolOutline = {
  kind: SymbolKind;
  name: string;
  signature?: string;
  range: { startLine: number; endLine: number };
  exported: boolean;
  children?: SymbolOutline[];
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

export type ExtensionPointKind =
  | 'abstract-class'
  | 'protocol'
  | 'abstract-method'
  | 'interface'
  | 'func-type'
  | 'type-constraint'
  | 'trait'
  | 'enum'
  | 'macro';

export type ExtensionPoint = {
  kind: ExtensionPointKind;
  name: string;
  line: number;
  endLine: number;
  isPublic: boolean;
  methods?: Array<{
    name: string;
    line: number;
    signature?: string;
    isAbstract?: boolean;
    isDefault?: boolean;
  }>;
  bases?: string[];
  decorators?: string[];
  supertraits?: string[];
  variants?: string[];
  embedded?: string[];
  generics?: string;
};
