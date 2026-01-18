import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..');
const storageDir = path.join(repoRoot, '.preflight-test-bundles');

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected non-empty string for ${label}`);
  }
  return value;
}

const client = new Client({ name: 'smoke-client', version: '0.0.0' });

const transport = new StdioClientTransport({
  command: 'node',
  args: [path.join(repoRoot, 'dist', 'index.js')],
  cwd: repoRoot,
  env: {
    PREFLIGHT_STORAGE_DIR: storageDir,
    PREFLIGHT_MAX_TOTAL_BYTES: String(5 * 1024 * 1024),
    PREFLIGHT_MAX_FILE_BYTES: String(256 * 1024),
  },
  stderr: 'inherit',
});

try {
  await fs.rm(storageDir, { recursive: true, force: true });

  await client.connect(transport);

  const tools = await client.listTools();
  console.log('tools:', tools.tools.map((t) => t.name));

  const templates = await client.listResourceTemplates();
  console.log('resourceTemplates:', templates.resourceTemplates.map((t) => t.uriTemplate));

  const createRes = await client.callTool({
    name: 'preflight_create_bundle',
    arguments: {
      repos: [{ kind: 'github', repo: 'octocat/Hello-World' }],
    },
  });

  console.log('create_bundle isError:', createRes.isError);
  console.log('create_bundle structuredContent:', createRes.structuredContent);
  if (createRes.isError || !createRes.structuredContent) {
    console.log('create_bundle content:', createRes.content);
    const msg = createRes.content?.find((c) => c.type === 'text')?.text ?? 'preflight_create_bundle failed';
    throw new Error(msg);
  }

  const bundleId = assertString(createRes.structuredContent?.bundleId, 'bundleId');
  const startHereUri = assertString(createRes.structuredContent?.resources?.startHere, 'resources.startHere');

  const bundlesIndex = await client.readResource({ uri: 'preflight://bundles' });
  console.log('read preflight://bundles ok:', bundlesIndex.contents?.[0]?.uri);

  const startHere = await client.readResource({ uri: startHereUri });
  console.log('read START_HERE ok:', startHere.contents?.[0]?.uri);

  const searchRes = await client.callTool({
    name: 'preflight_search_and_read',
    arguments: { bundleId, query: 'Hello', scope: 'docs', limit: 5 },
  });

  console.log('search_and_read:', searchRes.structuredContent);
  if (!Array.isArray(searchRes.structuredContent?.data?.hits) || searchRes.structuredContent.data.hits.length === 0) {
    throw new Error('Expected at least one search hit');
  }

  // Note: preflight_update_bundle is a non-core tool and not registered in core-only mode.
  // Skip testing it in the basic smoke test.

  const listRes = await client.callTool({
    name: 'preflight_list_bundles',
    arguments: {},
  });

  console.log('list_bundles:', listRes.structuredContent);

  console.log('OK');
} finally {
  await client.close().catch(() => undefined);
}
