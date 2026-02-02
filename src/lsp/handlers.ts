/** LSP Handlers - High-level request wrappers with LLM-friendly output. @module lsp/handlers */
import type { Location, LocationLink, SymbolInformation, DocumentSymbol, Hover } from 'vscode-languageserver-protocol';
import { getLspManager, LspManager } from './lsp-manager.js';
import type { LspRequest, LspDefinitionResult, LspReferencesResult, LspHoverResult, LspSymbolResult, LspDiagnosticResult, LspLocation, LspSymbolInfo } from './types.js';
import { extractHoverText, symbolKindToString, diagnosticSeverityToString } from './types.js';
import { pathToUri, toPosition, fromLocation, uriToPath, fromRange } from './uri.js';

const fmtLoc = (l: LspLocation) => `${l.filePath}:${l.line}:${l.column}`;

export async function getDefinition(request: LspRequest, manager?: LspManager): Promise<LspDefinitionResult> {
  const mgr = manager ?? getLspManager();
  const { filePath, line = 1, column = 1 } = request;
  const client = await mgr.getClient(filePath);
  try {
    await client.waitForIndexing(30000); // Wait up to 30s for indexing
    await client.openFile(filePath);
    const result = await client.sendRequest<Location | Location[] | LocationLink[] | null>(
      'textDocument/definition',
      { textDocument: { uri: pathToUri(filePath) }, position: toPosition(line, column) }
    );
    const locations = normalizeLocations(result);
    const formatted = locations.length === 0 ? 'No definition found.'
      : locations.length === 1 ? `Definition: ${fmtLoc(locations[0]!)}`
      : `Definitions (${locations.length}):\n${locations.map((l) => `  ${fmtLoc(l)}`).join('\n')}`;
    return { locations, formatted };
  } finally { mgr.releaseClient(client); }
}

export async function getReferences(request: LspRequest, manager?: LspManager): Promise<LspReferencesResult> {
  const mgr = manager ?? getLspManager();
  const { filePath, line = 1, column = 1 } = request;
  const client = await mgr.getClient(filePath);
  try {
    await client.waitForIndexing(30000);
    await client.openFile(filePath);
    const result = await client.sendRequest<Location[] | null>(
      'textDocument/references',
      { textDocument: { uri: pathToUri(filePath) }, position: toPosition(line, column), context: { includeDeclaration: true } }
    );
    const locations = (result ?? []).map(fromLocation);
    const formatted = locations.length === 0 ? 'No references found.'
      : `References (${locations.length}):\n${locations.map((l) => `  ${fmtLoc(l)}`).join('\n')}`;
    return { locations, formatted };
  } finally { mgr.releaseClient(client); }
}

export async function getHover(request: LspRequest, manager?: LspManager): Promise<LspHoverResult> {
  const mgr = manager ?? getLspManager();
  const { filePath, line = 1, column = 1 } = request;
  const client = await mgr.getClient(filePath);
  try {
    await client.waitForIndexing(30000);
    await client.openFile(filePath);
    const result = await client.sendRequest<Hover | null>(
      'textDocument/hover',
      { textDocument: { uri: pathToUri(filePath) }, position: toPosition(line, column) }
    );
    if (!result) return { content: '', formatted: 'No hover information available.' };
    const content = extractHoverText(result.contents);
    const range = result.range ? { filePath, ...fromRange(result.range) } : undefined;
    return { content, range, formatted: content || 'No hover information available.' };
  } finally { mgr.releaseClient(client); }
}

export async function getDocumentSymbols(request: LspRequest, manager?: LspManager): Promise<LspSymbolResult> {
  const mgr = manager ?? getLspManager();
  const { filePath } = request;
  const client = await mgr.getClient(filePath);
  try {
    await client.waitForIndexing(30000);
    await client.openFile(filePath);
    const result = await client.sendRequest<SymbolInformation[] | DocumentSymbol[] | null>(
      'textDocument/documentSymbol', { textDocument: { uri: pathToUri(filePath) } }
    );
    const symbols = normalizeSymbols(result, filePath);
    return { symbols, formatted: formatSymbols(symbols) };
  } finally { mgr.releaseClient(client); }
}

export async function getWorkspaceSymbols(request: LspRequest, manager?: LspManager): Promise<LspSymbolResult> {
  const mgr = manager ?? getLspManager();
  const { filePath, symbol = '' } = request;
  const client = await mgr.getClient(filePath);
  try {
    await client.waitForIndexing(30000);
    const result = await client.sendRequest<SymbolInformation[] | null>('workspace/symbol', { query: symbol });
    const symbols: LspSymbolInfo[] = (result ?? []).map((s) => ({
      name: s.name, kind: symbolKindToString(s.kind), location: fromLocation(s.location), containerName: s.containerName,
    }));
    return { symbols, formatted: formatSymbols(symbols) };
  } finally { mgr.releaseClient(client); }
}

export async function getDiagnostics(request: LspRequest, manager?: LspManager): Promise<LspDiagnosticResult> {
  const mgr = manager ?? getLspManager();
  const { filePath } = request;
  const client = await mgr.getClient(filePath);
  try {
    await client.waitForIndexing(30000);
    await client.openFile(filePath);
    await client.syncFile(filePath); // Trigger didChange to get diagnostics from tsserver
    await new Promise((r) => setTimeout(r, 1000)); // Wait for diagnostics to be published
    const diagnostics = client.getDiagnostics(filePath).map((d) => ({
      severity: diagnosticSeverityToString(d.severity), message: d.message,
      location: { filePath, ...fromRange(d.range) }, source: d.source, code: d.code as string | number | undefined,
    }));
    diagnostics.sort((a, b) => ({ error: 0, warning: 1, info: 2, hint: 3 }[a.severity] - { error: 0, warning: 1, info: 2, hint: 3 }[b.severity]));
    const formatted = diagnostics.length === 0 ? 'No diagnostics.'
      : `Diagnostics (${diagnostics.length}):\n${diagnostics.map((d) => `  [${d.severity}] ${fmtLoc(d.location)}: ${d.message}`).join('\n')}`;
    return { diagnostics, formatted };
  } finally { mgr.releaseClient(client); }
}

function normalizeLocations(result: Location | Location[] | LocationLink[] | null): LspLocation[] {
  if (!result) return [];
  const locs = Array.isArray(result) ? result : [result];
  return locs.map((loc) => 'targetUri' in loc ? {
    filePath: uriToPath(loc.targetUri), line: loc.targetRange.start.line + 1, column: loc.targetRange.start.character + 1,
    endLine: loc.targetRange.end.line + 1, endColumn: loc.targetRange.end.character + 1,
  } : fromLocation(loc));
}

function normalizeSymbols(result: SymbolInformation[] | DocumentSymbol[] | null, filePath: string): LspSymbolInfo[] {
  if (!result || result.length === 0) return [];
  if ('location' in result[0]!) {
    return (result as SymbolInformation[]).map((s) => ({
      name: s.name, kind: symbolKindToString(s.kind), location: fromLocation(s.location), containerName: s.containerName,
    }));
  }
  const symbols: LspSymbolInfo[] = [];
  const flatten = (items: DocumentSymbol[], container?: string) => {
    for (const item of items) {
      symbols.push({ name: item.name, kind: symbolKindToString(item.kind), location: { filePath, ...fromRange(item.range) }, containerName: container });
      if (item.children) flatten(item.children, item.name);
    }
  };
  flatten(result as DocumentSymbol[]);
  return symbols;
}

function formatSymbols(symbols: LspSymbolInfo[]): string {
  if (symbols.length === 0) return 'No symbols found.';
  return `Symbols (${symbols.length}):\n${symbols.map((s) => `  [${s.kind}] ${s.name}${s.containerName ? ` (in ${s.containerName})` : ''} - ${s.location.filePath}:${s.location.line}`).join('\n')}`;
}
