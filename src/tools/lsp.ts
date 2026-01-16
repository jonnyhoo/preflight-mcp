/**
 * LSP Tool - Language server protocol operations for Python/Go/Rust.
 * @module tools/lsp
 */
import * as z from 'zod';
import { getConfig, type LspConfig } from '../config.js';
import {
  getLspManager,
  getDefinition,
  getReferences,
  getHover,
  getDocumentSymbols,
  getWorkspaceSymbols,
  getDiagnostics,
  type LspManagerConfig,
  type LspServerConfig,
} from '../lsp/index.js';

export const LspAction = z.enum(['definition', 'references', 'hover', 'symbols', 'diagnostics']);
export type LspAction = z.infer<typeof LspAction>;

export const LspInputSchema = {
  action: LspAction.describe('LSP action: definition, references, hover, symbols, diagnostics'),
  file: z.string().describe('Absolute or relative file path'),
  line: z.number().int().positive().optional().describe('1-indexed line number (required for definition/references/hover)'),
  column: z.number().int().positive().optional().describe('1-indexed column number (required for definition/references/hover)'),
  symbol: z.string().optional().describe('Symbol name for workspace symbol search'),
};

export type LspInput = {
  action: LspAction;
  file: string;
  line?: number;
  column?: number;
  symbol?: string;
};

export type LspOutput = {
  success: boolean;
  action: LspAction;
  result?: string;
  error?: string;
};

export const lspToolDescription = `Query language servers (gopls/pyright/rust-analyzer) for code intelligence.

Actions:
- definition: Go to definition at file:line:column
- references: Find all references at file:line:column
- hover: Get type/documentation info at file:line:column
- symbols: List document symbols (no line/column needed)
- diagnostics: Get file diagnostics (no line/column needed)

Supported: Python (.py), Go (.go), Rust (.rs)
Auto-detects languageId and workspaceRoot from file path.`;

/** Build LspManagerConfig from PreflightConfig.lsp */
function buildLspManagerConfig(lspCfg: LspConfig): LspManagerConfig {
  const servers: Partial<Record<'python' | 'go' | 'rust', LspServerConfig>> = {
    python: {
      language: 'python',
      command: lspCfg.pythonCommand,
      args: lspCfg.pythonArgs ? lspCfg.pythonArgs.split(/\s+/) : [],
      extensions: ['.py', '.pyi'],
      timeoutMs: lspCfg.timeoutMs,
      idleTimeoutMs: lspCfg.idleMs,
    },
    go: {
      language: 'go',
      command: lspCfg.goCommand,
      args: lspCfg.goArgs ? lspCfg.goArgs.split(/\s+/) : [],
      extensions: ['.go'],
      timeoutMs: lspCfg.timeoutMs,
      idleTimeoutMs: lspCfg.idleMs,
    },
    rust: {
      language: 'rust',
      command: lspCfg.rustCommand,
      args: lspCfg.rustArgs ? lspCfg.rustArgs.split(/\s+/) : [],
      extensions: ['.rs'],
      timeoutMs: lspCfg.timeoutMs,
      idleTimeoutMs: lspCfg.idleMs,
    },
  };
  return {
    maxConcurrency: lspCfg.maxConcurrency,
    defaultTimeoutMs: lspCfg.timeoutMs,
    idleTimeoutMs: lspCfg.idleMs,
    debug: false,
    servers,
  };
}

export function createLspHandler() {
  const cfg = getConfig();
  const manager = getLspManager(buildLspManagerConfig(cfg.lsp));

  return async (input: LspInput): Promise<LspOutput> => {
    const { action, file, line, column, symbol } = input;

    try {
      const request = { filePath: file, line, column, symbol };

      switch (action) {
        case 'definition': {
          if (!line || !column) return { success: false, action, error: 'line and column required for definition' };
          const res = await manager.withConcurrencyLimit(() => getDefinition(request, manager));
          return { success: true, action, result: res.formatted };
        }
        case 'references': {
          if (!line || !column) return { success: false, action, error: 'line and column required for references' };
          const res = await manager.withConcurrencyLimit(() => getReferences(request, manager));
          return { success: true, action, result: res.formatted };
        }
        case 'hover': {
          if (!line || !column) return { success: false, action, error: 'line and column required for hover' };
          const res = await manager.withConcurrencyLimit(() => getHover(request, manager));
          return { success: true, action, result: res.formatted };
        }
        case 'symbols': {
          const res = symbol
            ? await manager.withConcurrencyLimit(() => getWorkspaceSymbols(request, manager))
            : await manager.withConcurrencyLimit(() => getDocumentSymbols(request, manager));
          return { success: true, action, result: res.formatted };
        }
        case 'diagnostics': {
          const res = await manager.withConcurrencyLimit(() => getDiagnostics(request, manager));
          return { success: true, action, result: res.formatted };
        }
        default:
          return { success: false, action, error: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, action, error: msg };
    }
  };
}
