import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { type PreflightConfig } from '../config.js';
import { logger } from '../logging/logger.js';

export type ConnectedContext7Client = {
  client: Client;
  close: () => Promise<void>;
};

export async function connectContext7(cfg: PreflightConfig): Promise<ConnectedContext7Client> {
  const url = new URL(cfg.context7McpUrl);

  const headers: Record<string, string> = {};
  // Context7 supports running without a key (rate-limited). If present, pass it.
  if (cfg.context7ApiKey) {
    headers['CONTEXT7_API_KEY'] = cfg.context7ApiKey;
  }

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers,
    },
    reconnectionOptions: {
      // Keep retries low to avoid hanging bundle generation.
      initialReconnectionDelay: 500,
      maxReconnectionDelay: 2000,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 1,
    },
  });

  const client = new Client({ name: 'preflight-context7', version: '0.1.3' });
  await client.connect(transport);

  return {
    client,
    close: async () => {
      await client.close().catch((err) => {
        logger.debug('Context7 client close failed (non-critical)', err instanceof Error ? err : undefined);
      });
    },
  };
}
