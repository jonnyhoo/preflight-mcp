import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..');
const storageDir = path.join(repoRoot, '.preflight-test-bundles-assistant');

const client = new Client({ name: 'smoke-assistant-client', version: '0.0.0' });

const transport = new StdioClientTransport({
  command: 'node',
  args: [path.join(repoRoot, 'dist', 'index.js')],
  cwd: repoRoot,
  env: {
    PREFLIGHT_STORAGE_DIR: storageDir,
    PREFLIGHT_TOOLSET: 'full',
    // Keep semantic off for smoke; embedding services may not be available.
    PREFLIGHT_SEMANTIC_SEARCH: 'false',
    PREFLIGHT_MAX_TOTAL_BYTES: String(10 * 1024 * 1024),
    PREFLIGHT_MAX_FILE_BYTES: String(512 * 1024),
  },
  stderr: 'inherit',
});

function assertString(v, label) {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`Expected non-empty string for ${label}`);
  return v;
}

try {
  await fs.rm(storageDir, { recursive: true, force: true });
  await client.connect(transport);

  // Create a local bundle for this repo.
  const createRes = await client.callTool({
    name: 'preflight_create_bundle',
    arguments: {
      repos: [{ kind: 'local', repo: 'local/preflight-mcp', path: repoRoot }],
      ifExists: 'returnExisting',
    },
  });
  if (createRes.isError || !createRes.structuredContent) {
    throw new Error(createRes.content?.find((c) => c.type === 'text')?.text ?? 'preflight_create_bundle failed');
  }

  const bundleId = assertString(createRes.structuredContent.bundleId, 'bundleId');

  // Create a temporary "paper".
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-assistant-'));
  const paperPath = path.join(tmpDir, 'paper.html');
  await fs.writeFile(
    paperPath,
    '<html><body><h1>Paper</h1><p>This paper proposes Method X for incremental indexing and paired retrieval.</p></body></html>',
    'utf8'
  );

  // Project-only assistant call.
  const proj = await client.callTool({
    name: 'preflight_assistant',
    arguments: {
      question: 'Where is preflight_assistant implemented?',
      intent: 'project',
      sources: { bundleIds: [bundleId] },
      limits: { maxEvidence: 6, includeOverviewFiles: true },
    },
  });
  console.log('assistant(project) ok:', proj.structuredContent?.ok);

  // Paper-only assistant call.
  const paper = await client.callTool({
    name: 'preflight_assistant',
    arguments: {
      question: 'Method X incremental indexing',
      intent: 'paper',
      sources: { docPaths: [paperPath] },
      limits: { maxEvidence: 6, includeOverviewFiles: false },
    },
  });
  console.log('assistant(paper) ok:', paper.structuredContent?.ok);

  // Pair assistant call.
  const pair = await client.callTool({
    name: 'preflight_assistant',
    arguments: {
      question: 'paired retrieval',
      intent: 'pair',
      sources: { bundleIds: [bundleId], docPaths: [paperPath] },
      limits: { maxEvidence: 8, includeOverviewFiles: true },
    },
  });
  console.log('assistant(pair) ok:', pair.structuredContent?.ok);

  console.log('OK');
} finally {
  await client.close().catch(() => undefined);
}
