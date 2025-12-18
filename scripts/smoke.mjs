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
    name: 'preflight_search_bundle',
    arguments: { bundleId, query: 'Hello', scope: 'docs', limit: 5 },
  });

  console.log('search_bundle:', searchRes.structuredContent);
  if (!Array.isArray(searchRes.structuredContent?.hits) || searchRes.structuredContent.hits.length === 0) {
    throw new Error('Expected at least one search hit');
  }

  const updateRes = await client.callTool({
    name: 'preflight_update_bundle',
    arguments: { bundleId },
  });

  console.log('update_bundle isError:', updateRes.isError);
  console.log('update_bundle structuredContent:', updateRes.structuredContent);
  if (updateRes.isError || !updateRes.structuredContent) {
    console.log('update_bundle content:', updateRes.content);
    const msg = updateRes.content?.find((c) => c.type === 'text')?.text ?? 'preflight_update_bundle failed';
    throw new Error(msg);
  }

  const listRes = await client.callTool({
    name: 'preflight_list_bundles',
    arguments: {},
  });

  console.log('list_bundles:', listRes.structuredContent);

  // Test preflight_analyze_bundle
  const analyzeRes = await client.callTool({
    name: 'preflight_analyze_bundle',
    arguments: { bundleId, mode: 'quick', regenerate: false },
  });

  console.log('analyze_bundle:', analyzeRes.content?.[0]?.type === 'text' ? 'OK' : 'ERROR');
  if (analyzeRes.content?.[0]?.type === 'text') {
    const txt = analyzeRes.content[0].text;
    if (!txt.includes('FACTS.json') && !txt.includes('analysis')) {
      throw new Error('Expected analysis output');
    }
  }

  console.log('OK');
} finally {
  await client.close().catch(() => undefined);
}
