import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';

import { startHttpServer, type HttpServerHandle } from '../../src/http/server.js';
import type { PreflightConfig } from '../../src/config.js';

/**
 * Create a minimal config for testing the HTTP server.
 */
function createTestConfig(overrides: Partial<PreflightConfig> = {}): PreflightConfig {
  return {
    storageDir: '/tmp/test-storage',
    storageDirs: ['/tmp/test-storage'],
    tmpDir: '/tmp/test-tmp',
    githubToken: undefined,
    context7ApiKey: undefined,
    context7McpUrl: 'https://mcp.context7.com/mcp',
    gitCloneTimeoutMs: 60_000,
    maxFileBytes: 512 * 1024,
    maxTotalBytes: 50 * 1024 * 1024,
    analysisMode: 'quick',
    astEngine: 'wasm',
    httpEnabled: true,
    httpHost: '127.0.0.1',
    httpPort: 0, // Use random available port
    maxContext7Libraries: 20,
    maxContext7Topics: 10,
    maxFtsQueryTokens: 12,
    maxSkippedNotes: 50,
    defaultMaxAgeHours: 24,
    maxSearchLimit: 200,
    defaultSearchLimit: 30,
    inProgressLockTimeoutMs: 30 * 60_000,
    strictMode: false,
    semanticSearchEnabled: false,
    embeddingProvider: 'ollama',
    ollamaHost: 'http://localhost:11434',
    ollamaModel: 'nomic-embed-text',
    openaiApiKey: undefined,
    openaiModel: 'text-embedding-3-small',
    openaiBaseUrl: undefined,
    deepAnalysisMaxOverviewChars: 800,
    defaultSearchContextLines: 30,
    taskCleanupDelayMs: 60_000,
    manifestCacheTtlMs: 5 * 60_000,
    manifestCacheMaxSize: 100,
    ...overrides,
  };
}

/**
 * Helper to make HTTP requests to the test server.
 */
function makeRequest(
  host: string,
  port: number,
  method: string,
  path: string,
  body?: object
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: host,
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        try {
          const json = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode ?? 0, body: json });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe('HTTP Server', () => {
  let serverHandle: HttpServerHandle | null = null;
  let testPort: number;

  beforeAll(async () => {
    // Start server on a random port
    const config = createTestConfig({ httpPort: 0 });
    serverHandle = startHttpServer(config);

    // The server starts listening, we need to get the actual port
    // Since httpPort: 0 might not work as expected with the current implementation,
    // we'll use a fixed high port for testing
    const testConfig = createTestConfig({ httpPort: 47123 });
    if (serverHandle) {
      await serverHandle.close();
    }
    serverHandle = startHttpServer(testConfig);
    testPort = testConfig.httpPort;
  });

  afterAll(async () => {
    if (serverHandle) {
      await serverHandle.close();
    }
  });

  describe('Health endpoint', () => {
    it('should return 200 OK for GET /health', async () => {
      if (!serverHandle) {
        // Skip if server didn't start (port might be in use)
        return;
      }

      const response = await makeRequest(serverHandle.host, testPort, 'GET', '/health');
      expect(response.status).toBe(200);
      expect((response.body as any).ok).toBe(true);
      expect((response.body as any).name).toBe('preflight-mcp');
      expect((response.body as any).time).toBeDefined();
    });
  });

  describe('Not found handling', () => {
    it('should return 404 for unknown paths', async () => {
      if (!serverHandle) {
        return;
      }

      const response = await makeRequest(serverHandle.host, testPort, 'GET', '/unknown/path');
      expect(response.status).toBe(404);
      expect((response.body as any).error).toBeDefined();
      expect((response.body as any).error.message).toContain('Not found');
    });
  });

  describe('CORS support', () => {
    it('should handle OPTIONS preflight requests', async () => {
      if (!serverHandle) {
        return;
      }

      const response = await makeRequest(serverHandle.host, testPort, 'OPTIONS', '/api/v1/trace');
      expect(response.status).toBe(204);
    });
  });

  describe('Server lifecycle', () => {
    it('should start and stop without errors', async () => {
      const config = createTestConfig({ httpPort: 47124 });
      const handle = startHttpServer(config);

      expect(handle).not.toBeNull();
      expect(handle?.host).toBe('127.0.0.1');
      expect(handle?.port).toBe(47124);

      if (handle) {
        await handle.close();
      }
    });

    it('should return null when httpEnabled is false', () => {
      const config = createTestConfig({ httpEnabled: false });
      const handle = startHttpServer(config);

      expect(handle).toBeNull();
    });
  });
});
