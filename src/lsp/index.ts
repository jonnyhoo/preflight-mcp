/**
 * LSP Module - External Language Server Integration
 *
 * Provides LSP client management for gopls, pyright, and rust-analyzer.
 *
 * @module lsp
 */

// Types
export type {
  SupportedLanguage,
  LspServerConfig,
  LspManagerConfig,
  LspRequest,
  LspLocation,
  LspDefinitionResult,
  LspReferencesResult,
  LspHoverResult,
  LspSymbolResult,
  LspSymbolInfo,
  LspDiagnosticResult,
  LspDiagnosticInfo,
} from './types.js';

export {
  getLanguageFromExtension,
  getLanguageId,
  LANGUAGE_IDS,
  EXTENSION_TO_LANGUAGE,
} from './types.js';

// URI utilities
export {
  pathToUri,
  uriToPath,
  normalizePath,
  toPosition,
  fromPosition,
  fromRange,
  toRange,
  fromLocation,
  toLocation,
  formatLocation,
  formatRelativeLocation,
} from './uri.js';

// Client
export { LspClient } from './lsp-client.js';

// Manager
export {
  LspManager,
  getLspManager,
  resetLspManager,
} from './lsp-manager.js';

// Handlers
export {
  getDefinition,
  getReferences,
  getHover,
  getDocumentSymbols,
  getWorkspaceSymbols,
  getDiagnostics,
} from './handlers.js';
