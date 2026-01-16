/**
 * URI and Position Conversion Utilities
 *
 * Handles path <-> file:// URI conversion and position indexing.
 * Uses node:url for proper Windows drive letter handling.
 *
 * @module lsp/uri
 */

import { pathToFileURL, fileURLToPath } from 'node:url';
import type { Position, Range, Location } from 'vscode-languageserver-protocol';
import type { LspLocation } from './types.js';

// ============================================================================
// Path <-> URI Conversion
// ============================================================================

/**
 * Convert a file path to a file:// URI.
 * Handles Windows drive letters correctly (file:///C:/...).
 */
export function pathToUri(filePath: string): string {
  return pathToFileURL(filePath).href;
}

/**
 * Convert a file:// URI to a file path.
 * Handles Windows drive letters correctly.
 */
export function uriToPath(uri: string): string {
  return fileURLToPath(uri);
}

/**
 * Normalize a file path for consistent comparison.
 * On Windows, converts backslashes to forward slashes and lowercases drive letter.
 */
export function normalizePath(filePath: string): string {
  let normalized = filePath.replace(/\\/g, '/');
  // Lowercase Windows drive letter for consistent comparison
  if (/^[A-Z]:/.test(normalized)) {
    normalized = normalized[0]!.toLowerCase() + normalized.slice(1);
  }
  return normalized;
}

// ============================================================================
// Position Conversion (1-indexed <-> 0-indexed)
// ============================================================================

/**
 * Convert 1-indexed line/column to LSP 0-indexed Position.
 */
export function toPosition(line: number, column: number): Position {
  return {
    line: Math.max(0, line - 1),
    character: Math.max(0, column - 1),
  };
}

/**
 * Convert LSP 0-indexed Position to 1-indexed line/column.
 */
export function fromPosition(position: Position): { line: number; column: number } {
  return {
    line: position.line + 1,
    column: position.character + 1,
  };
}

/**
 * Convert LSP Range to 1-indexed LspLocation (without filePath).
 */
export function fromRange(range: Range): Omit<LspLocation, 'filePath'> {
  return {
    line: range.start.line + 1,
    column: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

/**
 * Convert LspLocation to LSP Range (0-indexed).
 */
export function toRange(location: LspLocation): Range {
  return {
    start: toPosition(location.line, location.column),
    end: toPosition(
      location.endLine ?? location.line,
      location.endColumn ?? location.column
    ),
  };
}

/**
 * Convert LSP Location to LspLocation (1-indexed).
 */
export function fromLocation(location: Location): LspLocation {
  return {
    filePath: uriToPath(location.uri),
    ...fromRange(location.range),
  };
}

/**
 * Convert LspLocation to LSP Location (0-indexed).
 */
export function toLocation(location: LspLocation): Location {
  return {
    uri: pathToUri(location.filePath),
    range: toRange(location),
  };
}

// ============================================================================
// Location Formatting
// ============================================================================

/**
 * Format a location for display (file:line:column).
 */
export function formatLocation(location: LspLocation): string {
  const { filePath, line, column } = location;
  return `${filePath}:${line}:${column}`;
}

/**
 * Format a location with optional range (file:line:column[-endLine:endColumn]).
 */
export function formatLocationWithRange(location: LspLocation): string {
  const { filePath, line, column, endLine, endColumn } = location;
  let result = `${filePath}:${line}:${column}`;
  if (endLine !== undefined && endColumn !== undefined && (endLine !== line || endColumn !== column)) {
    result += `-${endLine}:${endColumn}`;
  }
  return result;
}

/**
 * Format a relative location (relative to workspaceRoot).
 */
export function formatRelativeLocation(
  location: LspLocation,
  workspaceRoot: string
): string {
  const normalizedFile = normalizePath(location.filePath);
  const normalizedRoot = normalizePath(workspaceRoot);
  
  let relativePath = normalizedFile;
  if (normalizedFile.startsWith(normalizedRoot)) {
    relativePath = normalizedFile.slice(normalizedRoot.length);
    if (relativePath.startsWith('/')) {
      relativePath = relativePath.slice(1);
    }
  }
  
  return `${relativePath}:${location.line}:${location.column}`;
}
