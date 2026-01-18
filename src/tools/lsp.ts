/**
 * LSP Tool - Language server protocol operations for Python/Go/Rust.
 * @module tools/lsp
 */
import * as z from 'zod';
import { getConfig, type LspConfig } from '../config.js';
import {
  getLspManager,
  resetLspManager,
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

export const lspToolDescription = `Precise code navigation via language servers. Use for go-to-definition, find-references on LOCAL projects.

IMPORTANT: Requires REAL file paths (e.g., /home/user/project/src/main.ts), NOT bundle paths. Project must exist locally with dependencies installed.

Actions: definition, references, hover, symbols, diagnostics
Supported: .py, .go, .rs, .ts, .tsx, .js, .jsx

Use preflight_assistant for bundle-based search instead.`;
const OVERALL_TIMEOUT_GRACE_MS = 4000;
const MIN_OVERALL_TIMEOUT_MS = 12000;

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
function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('timed out') || msg.includes('timeout');
}

function withOverallTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

async function runWithRetry<T>(opts: {
  label: string;
  timeoutMs: number;
  retryOnTimeout: boolean;
  onTimeout: () => Promise<void>;
  action: () => Promise<T>;
}): Promise<T> {
  try {
    return await withOverallTimeout(opts.action(), opts.timeoutMs, opts.label);
  } catch (err) {
    if (opts.retryOnTimeout && isTimeoutError(err)) {
      await opts.onTimeout();
      return await withOverallTimeout(opts.action(), opts.timeoutMs, opts.label);
    }
    throw err;
  }
}

export function createLspHandler() {

  return async (input: LspInput): Promise<LspOutput> => {
    const cfg = getConfig();
    const managerConfig = buildLspManagerConfig(cfg.lsp);
    let manager = getLspManager(managerConfig);
    const overallTimeoutMs = Math.max(cfg.lsp.timeoutMs + OVERALL_TIMEOUT_GRACE_MS, MIN_OVERALL_TIMEOUT_MS);
    const run = async <T>(label: string, action: () => Promise<T>): Promise<T> => runWithRetry({
      label,
      timeoutMs: overallTimeoutMs,
      retryOnTimeout: true,
      onTimeout: async () => {
        await manager.shutdownAll();
        resetLspManager();
        manager = getLspManager(managerConfig);
      },
      action,
    });
    const { action, file, line, column, symbol } = input;

    try {
      const request = { filePath: file, line, column, symbol };

      switch (action) {
        case 'definition': {
          if (!line || !column) return { success: false, action, error: 'line and column required for definition' };
          const res = await run('definition', () => manager.withConcurrencyLimit(() => getDefinition(request, manager)));
          return { success: true, action, result: res.formatted };
        }
        case 'references': {
          if (!line || !column) return { success: false, action, error: 'line and column required for references' };
          const res = await run('references', () => manager.withConcurrencyLimit(() => getReferences(request, manager)));
          return { success: true, action, result: res.formatted };
        }
        case 'hover': {
          if (!line || !column) return { success: false, action, error: 'line and column required for hover' };
          const res = await run('hover', () => manager.withConcurrencyLimit(() => getHover(request, manager)));
          return { success: true, action, result: res.formatted };
        }
        case 'symbols': {
          const res = symbol
            ? await run('workspaceSymbols', () => manager.withConcurrencyLimit(() => getWorkspaceSymbols(request, manager)))
            : await run('documentSymbols', () => manager.withConcurrencyLimit(() => getDocumentSymbols(request, manager)));
          return { success: true, action, result: res.formatted };
        }
        case 'diagnostics': {
          const res = await run('diagnostics', () => manager.withConcurrencyLimit(() => getDiagnostics(request, manager)));
          return { success: true, action, result: res.formatted };
        }
        default:
          return { success: false, action, error: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isTimeoutError(err)) {
        return {
          success: false,
          action,
          error: `LSP timed out after ${overallTimeoutMs}ms. Server was restarted; please retry. (You can increase PREFLIGHT_LSP_TIMEOUT_MS for large projects.)`,
        };
      }
      return { success: false, action, error: msg };
    }
  };
}
