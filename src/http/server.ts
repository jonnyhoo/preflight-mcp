import http from 'node:http';
import { URL } from 'node:url';

import { type PreflightConfig } from '../config.js';
import { logger } from '../logging/logger.js';
import { wrapPreflightError } from '../mcp/errorKinds.js';

export type HttpServerHandle = {
  host: string;
  port: number;
  close: () => Promise<void>;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

function sendJson(res: http.ServerResponse, status: number, body: JsonValue): void {
  const text = JSON.stringify(body, null, 2);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

async function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error(`Request body too large (>${maxBytes} bytes)`);
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

export function startHttpServer(cfg: PreflightConfig): HttpServerHandle | null {
  if (!cfg.httpEnabled) {
    logger.info('REST API disabled (PREFLIGHT_HTTP_ENABLED=false)');
    return null;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      const url = new URL(req.url ?? '/', `http://${cfg.httpHost}:${cfg.httpPort}`);
      const pathname = url.pathname;

      // Basic CORS (local development convenience). Keep permissive but local-only by default host.
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
      if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (method === 'GET' && pathname === '/health') {
        sendJson(res, 200, { ok: true, name: 'preflight-mcp', time: new Date().toISOString() });
        return;
      }

      sendJson(res, 404, { error: { message: `Not found: ${method} ${pathname}` } });
    } catch (err) {
      const wrapped = wrapPreflightError(err);
      sendJson(res, 400, { error: { message: wrapped.message } });
    }
  });

  server.on('error', (err) => {
    // Non-fatal: MCP should still work.
    logger.warn(`REST server error: ${err instanceof Error ? err.message : String(err)}`);
  });

  try {
    server.listen(cfg.httpPort, cfg.httpHost, () => {
      logger.info(`REST API listening on http://${cfg.httpHost}:${cfg.httpPort}`);
    });

    // Allow process to exit if stdio transport closes.
    server.unref();

    return {
      host: cfg.httpHost,
      port: cfg.httpPort,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    };
  } catch (err) {
    // Binding failures should not crash MCP.
    logger.warn(`Failed to start REST API server: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
