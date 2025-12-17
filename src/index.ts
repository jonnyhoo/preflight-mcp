#!/usr/bin/env node
import { startServer } from './server.js';

startServer().catch((err) => {
  // Stdio MCP servers should write logs to stderr.
  console.error('[preflight-mcp] fatal:', err);
  process.exitCode = 1;
});
