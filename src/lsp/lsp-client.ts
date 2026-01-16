/** LSP Client - Single language server process management. @module lsp/lsp-client */
import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createMessageConnection, MessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import { InitializeRequest, MarkupKind } from 'vscode-languageserver-protocol';
import type { InitializeParams, InitializeResult, ServerCapabilities, Diagnostic, PublishDiagnosticsParams } from 'vscode-languageserver-protocol';
import { logger } from '../logging/index.js';
import type { LspServerConfig, OpenedFile, SupportedLanguage } from './types.js';
import { pathToUri, uriToPath } from './uri.js';

const DEFAULT_TIMEOUT_MS = 8000;

export class LspClient {
  private config: LspServerConfig;
  private workspaceRoot: string;
  private process: ChildProcess | null = null;
  private connection: MessageConnection | null = null;
  private capabilities: ServerCapabilities | null = null;
  private openedFiles: Map<string, OpenedFile> = new Map();
  private diagnosticsCache: Map<string, Diagnostic[]> = new Map();
  private initialized = false;
  private shuttingDown = false;

  constructor(config: LspServerConfig, workspaceRoot: string) {
    this.config = config;
    this.workspaceRoot = workspaceRoot;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    logger.debug('Spawning LSP server', { language: this.config.language, command: this.config.command });

    this.process = spawn(this.config.command, this.config.args, {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...this.config.env }, cwd: this.workspaceRoot,
    });
    this.process.stderr?.on('data', (data: Buffer) => logger.debug(`[LSP ${this.config.language}] ${data.toString().trim()}`));
    this.process.on('error', (err) => logger.error(`LSP process error: ${this.config.language}`, err));
    this.process.on('exit', (code, signal) => {
      if (!this.shuttingDown) logger.warn(`LSP process exited unexpectedly`, { language: this.config.language, code, signal });
      this.cleanup();
    });

    this.connection = createMessageConnection(new StreamMessageReader(this.process.stdout!), new StreamMessageWriter(this.process.stdin!));
    this.connection.onNotification('textDocument/publishDiagnostics', (params: PublishDiagnosticsParams) => {
      this.diagnosticsCache.set(params.uri, params.diagnostics);
    });
    this.connection.listen();

    const initParams: InitializeParams = {
      processId: process.pid, rootUri: pathToUri(this.workspaceRoot),
      capabilities: this.getClientCapabilities(),
      workspaceFolders: [{ uri: pathToUri(this.workspaceRoot), name: 'workspace' }],
    };
    const result = await this.sendRequest<InitializeResult>(InitializeRequest.type.method, initParams);
    this.capabilities = result.capabilities;
    this.connection.sendNotification('initialized', {});
    this.initialized = true;
    logger.debug('LSP server initialized', { language: this.config.language });
  }

  async shutdown(): Promise<void> {
    if (!this.initialized || this.shuttingDown) return;
    this.shuttingDown = true;
    try {
      for (const [uri] of this.openedFiles) await this.closeFile(uriToPath(uri));
      if (this.connection) { await this.sendRequest('shutdown', null, 3000); this.connection.sendNotification('exit'); }
    } catch (err) { logger.debug('Error during LSP shutdown', { error: err }); }
    finally { this.cleanup(); }
  }

  private cleanup(): void {
    this.connection?.dispose(); this.connection = null;
    if (this.process && !this.process.killed) this.process.kill('SIGTERM');
    this.process = null; this.openedFiles.clear(); this.diagnosticsCache.clear(); this.initialized = false;
  }

  async openFile(filePath: string): Promise<void> {
    if (!this.connection) throw new Error('LSP not initialized');
    const uri = pathToUri(filePath);
    if (this.openedFiles.has(uri)) return;
    const content = await fs.readFile(filePath, 'utf-8');
    this.connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: this.config.language, version: 1, text: content } });
    this.openedFiles.set(uri, { uri, version: 1, languageId: this.config.language });
  }

  async closeFile(filePath: string): Promise<void> {
    if (!this.connection) return;
    const uri = pathToUri(filePath);
    if (!this.openedFiles.has(uri)) return;
    this.connection.sendNotification('textDocument/didClose', { textDocument: { uri } });
    this.openedFiles.delete(uri);
  }

  async syncFile(filePath: string): Promise<void> {
    if (!this.connection) throw new Error('LSP not initialized');
    const uri = pathToUri(filePath);
    const file = this.openedFiles.get(uri);
    if (!file) { await this.openFile(filePath); return; }
    const content = await fs.readFile(filePath, 'utf-8');
    const newVersion = file.version + 1;
    this.connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: newVersion }, contentChanges: [{ text: content }] });
    file.version = newVersion;
  }

  async sendRequest<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (!this.connection) throw new Error('LSP not initialized');
    const timeout = timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`LSP request timed out: ${method}`)), timeout);
      this.connection!.sendRequest(method, params).then((r) => { clearTimeout(timer); resolve(r as T); }).catch((e) => { clearTimeout(timer); reject(e); });
    });
  }

  get serverCapabilities(): ServerCapabilities | null { return this.capabilities; }
  get isInitialized(): boolean { return this.initialized; }
  get language(): SupportedLanguage { return this.config.language; }
  getDiagnostics(filePath: string): Diagnostic[] { return this.diagnosticsCache.get(pathToUri(filePath)) ?? []; }
  getAllDiagnostics(): Map<string, Diagnostic[]> { return new Map(this.diagnosticsCache); }

  private getClientCapabilities() {
    return {
      textDocument: {
        synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: false },
        completion: { dynamicRegistration: false }, hover: { dynamicRegistration: false, contentFormat: [MarkupKind.PlainText] },
        definition: { dynamicRegistration: false }, references: { dynamicRegistration: false },
        documentSymbol: { dynamicRegistration: false }, publishDiagnostics: { relatedInformation: true }, callHierarchy: { dynamicRegistration: false },
      },
      workspace: { workspaceFolders: true, symbol: { dynamicRegistration: false } },
    };
  }
}
