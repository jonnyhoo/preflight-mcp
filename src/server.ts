/**
 * Preflight MCP Server - Main entry point.
 *
 * This file sets up the MCP server, registers resources and tools,
 * and connects via stdio transport.
 *
 * LLM guidance is provided via the `instructions` field in the MCP initialize response,
 * which is automatically sent to clients on connection.
 *
 * Tools are organized into modules under ./server/tools/:
 * - bundleTools: create/list/delete/get_overview/read_file/repo_tree
 * - searchTools: search_and_read
 * - lspTools: lsp
 * - checkTools: preflight_check (unified: duplicates, doccheck, deadcode, circular, complexity)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { getConfig } from './config.js';
import { configureManifestCache } from './bundle/manifest.js';
import {
  getBundlePathsForId,
  getEffectiveStorageDir,
  listBundles,
} from './bundle/service.js';
import { safeJoin, toBundleFileUri } from './mcp/uris.js';
import { logger } from './logging/logger.js';
import { cleanupOnStartup } from './bundle/cleanup.js';
import { startHttpServer } from './http/server.js';
// Tool registration functions
import {
  registerBundleTools,
  registerSearchTools,
  registerLspTools,
  registerCheckTools,
  registerDistillTools,
  registerRagTools,
  registerArxivTools,
  registerMemoryTools,
} from './server/tools/index.js';

// Read version from package.json at startup
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
let PACKAGE_VERSION = '0.0.0';
try {
  const pkgJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  PACKAGE_VERSION = pkgJson.version ?? '0.0.0';
} catch {
  // Fallback if package.json cannot be read
}

export async function startServer(): Promise<void> {
  const cfg = getConfig();

  // Configure manifest cache with settings from config
  configureManifestCache(cfg.manifestCacheTtlMs, cfg.manifestCacheMaxSize);

  // Run orphan bundle cleanup on startup (non-blocking, best-effort)
  cleanupOnStartup(cfg).catch((err) => {
    logger.debug('Startup cleanup failed (non-critical)', err instanceof Error ? err : undefined);
  });

  // Start built-in REST API (best-effort). This must not interfere with MCP stdio transport.
  startHttpServer(cfg);

  const server = new McpServer(
    {
      name: 'preflight-mcp',
      version: PACKAGE_VERSION,
      description: 'Create evidence-based preflight bundles for repositories (docs + code) with SQLite FTS search.',
    },
    {
      capabilities: {
        resources: {
          listChanged: true,
        },
      },
      instructions: [
        'Preflight MCP — Tool Usage Guide',
        '',
        'WORKFLOW: To analyze a project, follow these steps in order:',
        '1. preflight_create_bundle → index a local path, GitHub repo, or web docs site',
        '2. preflight_get_overview → read OVERVIEW.md + START_HERE.md (always do this after creating)',
        '3. preflight_search_and_read → search for specific code or text',
        '4. preflight_check → run code quality checks (duplicates, deadcode, complexity)',
        '5. preflight_lsp → precise navigation (definition, references, symbols)',
        '',
        'DECISION TREE:',
        '- Need a bundleId? → preflight_list_bundles',
        '- New project/repo? → preflight_create_bundle, then preflight_get_overview',
        '- Search code/docs? → preflight_search_and_read (needs bundleId)',
        '- Read a specific file? → preflight_read_file (needs bundleId)',
        '- Go to definition / find references? → preflight_lsp (needs bundleId)',
        '- Check code quality? → preflight_check (needs local path)',
        '- Crawl web documentation? → preflight_create_bundle with kind="web"',
        '- Semantic search (RAG)? → preflight_rag',
        '',
        'RULES:',
        '- Most tools require a bundleId. Get one via preflight_list_bundles or preflight_create_bundle first.',
        '- After preflight_create_bundle, ALWAYS call preflight_get_overview next.',
        '- preflight_search_and_read is the primary search tool. Prefer it over preflight_rag for keyword searches.',
        '- preflight_lsp requires LOCAL file paths, not bundle paths.',
      ].join('\n'),
    }
  );

  // ==========================================================================
  // RESOURCES
  // ==========================================================================

  // Resource template to read any file inside a bundle.
  // URI format: preflight://bundle/{bundleId}/file/{encodedPath}
  server.registerResource(
    'bundle-file',
    new ResourceTemplate('preflight://bundle/{bundleId}/file/{encodedPath}', {
      list: undefined,
      complete: {
        bundleId: async (value) => {
          const effectiveDir = await getEffectiveStorageDir(cfg);
          const ids = await listBundles(effectiveDir);
          return ids.filter((id) => id.startsWith(value)).slice(0, 50);
        },
      },
    }),
    {
      title: 'Preflight bundle file',
      description: 'Reads a specific file from a preflight bundle by bundleId and encoded path.',
      mimeType: 'text/plain',
    },
    async (uri, vars) => {
      const bundleId = String(vars['bundleId'] ?? '');
      const encodedPath = String(vars['encodedPath'] ?? '');
      const rel = decodeURIComponent(encodedPath);

      const effectiveDir = await getEffectiveStorageDir(cfg);
      const bundleRoot = getBundlePathsForId(effectiveDir, bundleId).rootDir;
      const absPath = safeJoin(bundleRoot, rel);

      const text = await fs.readFile(absPath, 'utf8');
      const mimeType = absPath.endsWith('.md') ? 'text/markdown' : 'text/plain';

      return {
        contents: [
          {
            uri: uri.href,
            mimeType,
            text,
          },
        ],
      };
    }
  );

  // A small static resource that lists bundles.
  server.registerResource(
    'bundles-index',
    'preflight://bundles',
    {
      title: 'Preflight bundles index',
      description: 'Lists available bundle IDs and their main entry files.',
      mimeType: 'application/json',
    },
    async () => {
      const effectiveDir = await getEffectiveStorageDir(cfg);
      const ids = await listBundles(effectiveDir);
      const items = ids.map((id) => ({
        bundleId: id,
        startHere: toBundleFileUri({ bundleId: id, relativePath: 'START_HERE.md' }),
        agents: toBundleFileUri({ bundleId: id, relativePath: 'AGENTS.md' }),
        overview: toBundleFileUri({ bundleId: id, relativePath: 'OVERVIEW.md' }),
        manifest: toBundleFileUri({ bundleId: id, relativePath: 'manifest.json' }),
      }));
      return {
        contents: [
          {
            uri: 'preflight://bundles',
            mimeType: 'application/json',
            text: JSON.stringify({ bundles: items }, null, 2),
          },
        ],
      };
    }
  );

  // Backward-compatible resource for clients that bypass templates.
  server.registerResource(
    'bundle-file-compat',
    'preflight://bundle-file',
    {
      title: 'Bundle file (compat)',
      description: 'Compatibility resource. Prefer preflight://bundle/{bundleId}/file/{encodedPath}.',
      mimeType: 'text/plain',
    },
    async () => {
      return {
        contents: [
          {
            uri: 'preflight://bundle-file',
            mimeType: 'text/plain',
            text: 'Use preflight://bundle/{bundleId}/file/{encodedPath} to read bundle files.',
          },
        ],
      };
    }
  );

  // ==========================================================================
  // TOOLS - Register all tools from modules
  // ==========================================================================

  const deps = { server, cfg };

  // Core tools:
  // - Bundle management: create_bundle, list_bundles, delete_bundle (3)
  // - Reading: get_overview, read_file, search_and_read, repo_tree (4)
  // - Navigation: lsp (1, conditional on cfg.lsp.enabled)
  // - Quality check: preflight_check (1, unified: duplicates, doccheck, deadcode, circular, complexity)

  // LSP for precise navigation (1) - FIRST for visibility
  if (cfg.lsp.enabled) {
    registerLspTools(deps);
  }

  // Core bundle tools (6): create, list, delete, get_overview, read_file, repo_tree
  registerBundleTools(deps, { coreOnly: true });

  // Core search tools (1): search_and_read
  registerSearchTools(deps);

  // Unified code quality check tool (1): duplicates, doccheck, deadcode, circular, complexity
  registerCheckTools(deps);

  // Distill tools (1): generate_card
  registerDistillTools(deps);

  // RAG tools (1): preflight_rag (index + query)
  registerRagTools(deps);

  // arXiv search tools (1): preflight_arxiv_search
  registerArxivTools(deps);

  // Memory tools (1): preflight_memory (requires PREFLIGHT_MEMORY_ENABLED=true)
  if (cfg.memoryEnabled) {
    registerMemoryTools(deps);
  }

  // ==========================================================================
  // CONNECT & SHUTDOWN
  // ==========================================================================

  // Connect via stdio.
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown: flush and close logger on process exit signals
  const gracefulShutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    try {
      await logger.close();
    } catch {
      // Ignore close errors during shutdown
    }
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // Handle uncaught exceptions - log and exit
  process.on('uncaughtException', async (err) => {
    logger.fatal('Uncaught exception', err);
    try {
      await logger.close();
    } catch {
      // Ignore
    }
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason) => {
    logger.fatal('Unhandled rejection', reason instanceof Error ? reason : new Error(String(reason)));
    try {
      await logger.close();
    } catch {
      // Ignore
    }
    process.exit(1);
  });
}
