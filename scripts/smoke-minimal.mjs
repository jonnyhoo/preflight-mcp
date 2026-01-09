import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..');

const client = new Client({ name: 'smoke-minimal-client', version: '0.0.0' });

const transport = new StdioClientTransport({
  command: 'node',
  args: [path.join(repoRoot, 'dist', 'index.js')],
  cwd: repoRoot,
  env: {
    PREFLIGHT_TOOLSET: 'minimal',
    PREFLIGHT_SEMANTIC_SEARCH: 'false',
    // Keep test bundles isolated if any are created by mistake.
    PREFLIGHT_STORAGE_DIR: path.join(repoRoot, '.preflight-test-bundles-minimal'),
  },
  stderr: 'inherit',
});

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const names = (tools.tools ?? []).map((t) => t.name).sort();

  console.log('tools:', names);
  const ok = names.length === 1 && names[0] === 'preflight_assistant';
  if (!ok) {
    throw new Error(`Expected exactly ['preflight_assistant'], got: ${JSON.stringify(names)}`);
  }

  console.log('OK');
} finally {
  await client.close().catch(() => undefined);
}
