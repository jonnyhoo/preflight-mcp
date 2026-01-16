/** LSP Manager - Multi-client pool management. @module lsp/lsp-manager */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { logger } from '../logging/index.js';
import { LspClient } from './lsp-client.js';
import type { LspManagerConfig, LspServerConfig, SupportedLanguage } from './types.js';
import { getLanguageFromExtension } from './types.js';

const WORKSPACE_MARKERS: Record<SupportedLanguage, string[]> = {
  python: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'], go: ['go.mod', 'go.work'], rust: ['Cargo.toml'],
};
const COMMON_MARKERS = ['.git', '.hg', '.svn'];

async function findWorkspaceRoot(filePath: string, language: SupportedLanguage): Promise<string> {
  const markers = [...WORKSPACE_MARKERS[language], ...COMMON_MARKERS];
  let dir = path.dirname(filePath);
  const root = path.parse(dir).root;
  while (dir !== root) {
    for (const marker of markers) { try { await fs.access(path.join(dir, marker)); return dir; } catch { /* continue */ } }
    dir = path.dirname(dir);
  }
  return path.dirname(filePath);
}

const DEFAULT_SERVERS: Record<SupportedLanguage, LspServerConfig> = {
  python: { language: 'python', command: 'pyright-langserver', args: ['--stdio'], extensions: ['.py', '.pyi'], timeoutMs: 30000, idleTimeoutMs: 300000 },
  go: { language: 'go', command: 'gopls', args: ['serve'], extensions: ['.go'], timeoutMs: 30000, idleTimeoutMs: 300000 },
  rust: { language: 'rust', command: 'rust-analyzer', args: [], extensions: ['.rs'], timeoutMs: 30000, idleTimeoutMs: 300000 },
};
const DEFAULT_CONFIG: LspManagerConfig = { maxConcurrency: 6, defaultTimeoutMs: 30000, idleTimeoutMs: 300000, debug: false, servers: DEFAULT_SERVERS };

interface ClientEntry { client: LspClient; lastUsed: number; refCount: number; idleTimer?: NodeJS.Timeout; }

export class LspManager {
  private config: LspManagerConfig;
  private clients: Map<string, ClientEntry> = new Map();
  private pendingRequests = 0;
  private requestQueue: Array<() => void> = [];

  constructor(config: Partial<LspManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config, servers: { ...DEFAULT_SERVERS, ...config.servers } };
  }

  async getClient(filePath: string, workspaceRoot?: string): Promise<LspClient> {
    const language = getLanguageFromExtension(filePath);
    if (!language) throw new Error(`Unsupported file type: ${filePath}`);
    const serverConfig = this.config.servers[language];
    if (!serverConfig) throw new Error(`No LSP server configured for: ${language}`);
    const root = workspaceRoot ?? (await findWorkspaceRoot(filePath, language));
    const key = `${language}:${root}`;

    let entry = this.clients.get(key);
    if (entry) { this.resetIdleTimer(key, entry); entry.refCount++; entry.lastUsed = Date.now(); return entry.client; }

    const client = new LspClient(serverConfig, root);
    await client.initialize();
    entry = { client, lastUsed: Date.now(), refCount: 1 };
    this.clients.set(key, entry);
    this.startIdleTimer(key, entry);
    logger.debug('Created new LSP client', { language, workspaceRoot: root });
    return client;
  }

  releaseClient(client: LspClient): void {
    for (const [, entry] of this.clients) { if (entry.client === client) { entry.refCount = Math.max(0, entry.refCount - 1); break; } }
  }

  async withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireSlot(); try { return await fn(); } finally { this.releaseSlot(); }
  }

  private acquireSlot(): Promise<void> {
    if (this.pendingRequests < this.config.maxConcurrency) { this.pendingRequests++; return Promise.resolve(); }
    return new Promise((r) => this.requestQueue.push(() => { this.pendingRequests++; r(); }));
  }

  private releaseSlot(): void { this.pendingRequests--; const next = this.requestQueue.shift(); if (next) next(); }

  private startIdleTimer(key: string, entry: ClientEntry): void {
    const idleMs = this.config.servers[entry.client.language]?.idleTimeoutMs ?? this.config.idleTimeoutMs;
    entry.idleTimer = setTimeout(() => { if (entry.refCount === 0) this.shutdownClient(key); }, idleMs);
    entry.idleTimer.unref?.();
  }

  private resetIdleTimer(key: string, entry: ClientEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    this.startIdleTimer(key, entry);
  }

  private async shutdownClient(key: string): Promise<void> {
    const entry = this.clients.get(key);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try { await entry.client.shutdown(); } catch (err) { logger.debug('Error shutting down LSP client', { key, error: err }); }
    this.clients.delete(key);
    logger.debug('Shut down idle LSP client', { key });
  }

  async shutdownAll(): Promise<void> { await Promise.all(Array.from(this.clients.keys()).map((k) => this.shutdownClient(k))); }
  get clientCount(): number { return this.clients.size; }
}

let globalManager: LspManager | null = null;
export function getLspManager(config?: Partial<LspManagerConfig>): LspManager { if (!globalManager) globalManager = new LspManager(config); return globalManager; }
export function resetLspManager(): void { if (globalManager) { globalManager.shutdownAll().catch((e) => logger.debug('Error during LSP manager reset', { error: e })); globalManager = null; } }
