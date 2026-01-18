/**
 * LSP Module Type Definitions
 * @module lsp/types
 */
import type { Hover } from 'vscode-languageserver-protocol';

export type SupportedLanguage = 'python' | 'go' | 'rust' | 'typescript';

export const LANGUAGE_IDS: Record<SupportedLanguage, string> = { python: 'python', go: 'go', rust: 'rust', typescript: 'typescript' };

export const EXTENSION_TO_LANGUAGE: Record<string, SupportedLanguage> = {
  '.py': 'python', '.pyi': 'python', '.go': 'go', '.rs': 'rust',
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'typescript', '.jsx': 'typescript',
};

export interface LspServerConfig {
  language: SupportedLanguage;
  command: string;
  args: string[];
  env?: Record<string, string>;
  extensions: string[];
  timeoutMs: number;
  idleTimeoutMs: number;
}

export interface LspManagerConfig {
  maxConcurrency: number;
  defaultTimeoutMs: number;
  idleTimeoutMs: number;
  debug: boolean;
  servers: Partial<Record<SupportedLanguage, LspServerConfig>>;
}

export interface LspRequest {
  filePath: string;
  line?: number;
  column?: number;
  symbol?: string;
}

export interface LspLocation {
  filePath: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface LspDefinitionResult { locations: LspLocation[]; formatted: string; }
export interface LspReferencesResult { locations: LspLocation[]; formatted: string; }
export interface LspHoverResult { content: string; range?: LspLocation; formatted: string; }
export interface LspSymbolResult { symbols: LspSymbolInfo[]; formatted: string; }
export interface LspSymbolInfo { name: string; kind: string; location: LspLocation; containerName?: string; }
export interface LspDiagnosticResult { diagnostics: LspDiagnosticInfo[]; formatted: string; }
export interface LspDiagnosticInfo {
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  location: LspLocation;
  source?: string;
  code?: string | number;
}

export interface OpenedFile { uri: string; version: number; languageId: string; }
export interface ClientKey { language: SupportedLanguage; workspaceRoot: string; }

export function getLanguageFromExtension(filePath: string): SupportedLanguage | null {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

export function getLanguageId(language: SupportedLanguage): string {
  return LANGUAGE_IDS[language];
}

export function extractHoverText(contents: Hover['contents']): string {
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) return contents.map((c) => (typeof c === 'string' ? c : c.value)).join('\n\n');
  if ('value' in contents) return contents.value;
  return '';
}

const SYMBOL_KINDS = ['', 'File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field',
  'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant', 'String', 'Number', 'Boolean',
  'Array', 'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter'];

export function symbolKindToString(kind: number): string {
  return SYMBOL_KINDS[kind] ?? 'Unknown';
}

export function diagnosticSeverityToString(severity: number | undefined): 'error' | 'warning' | 'info' | 'hint' {
  return severity === 1 ? 'error' : severity === 2 ? 'warning' : severity === 4 ? 'hint' : 'info';
}
