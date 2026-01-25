/**
 * Preflight MCP Server - Main entry point.
 * 
 * This file sets up the MCP server, registers resources, tools, and prompts,
 * and connects via stdio transport.
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
import * as z from 'zod';

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
import { generateRoutingPrompt, routeQuery, suggestWorkflow } from './prompts/toolRouter.js';

// Tool registration functions
import {
  registerBundleTools,
  registerSearchTools,
  registerLspTools,
  registerCheckTools,
  registerDistillTools,
  registerRagTools,
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
        prompts: {
          listChanged: true,
        },
      },
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

  // Core bundle tools (6): create, list, delete, get_overview, read_file, repo_tree
  registerBundleTools(deps, { coreOnly: true });

  // Core search tools (1): search_and_read
  registerSearchTools(deps, { coreOnly: true });

  // LSP for precise navigation (1)
  if (cfg.lsp.enabled) {
    registerLspTools(deps);
  }

  // Unified code quality check tool (1): duplicates, doccheck, deadcode, circular, complexity
  registerCheckTools(deps);

  // Distill tools (1): generate_card
  registerDistillTools(deps);

  // RAG tools (1): preflight_rag (index + query)
  registerRagTools(deps);

  // ==========================================================================
  // PROMPTS - Interactive guidance for users
  // ==========================================================================

  // Tool Router prompt - intelligent tool selection
  server.registerPrompt(
    'preflight_router',
    {
      title: 'Tool Router',
      description: 'Intelligent tool selection guide. Use when: "which tool should I use", "help me choose", "what tool for X", "推荐工具", "用哪个工具".',
      argsSchema: {
        task: z.string().optional().describe('Description of what you want to accomplish'),
      },
    },
    async (args) => {
      let content = generateRoutingPrompt();
      
      if (args.task) {
        const suggestedTools = routeQuery(args.task);
        const workflow = suggestWorkflow(args.task);
        
        content += `\n\n---\n## Task Analysis: "${args.task}"\n\n`;
        content += `**Recommended tools:**\n`;
        for (const tool of suggestedTools) {
          content += `- \`${tool.name}\` - ${tool.description}\n`;
        }
        content += `\n**Suggested workflow:**\n`;
        for (const step of workflow) {
          content += `${step}\n`;
        }
      }
      
      return {
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: content },
          },
        ],
      };
    }
  );

  // Main menu prompt - shows all available features
  server.registerPrompt(
    'preflight_menu',
    {
      title: 'Preflight 功能菜单',
      description: '显示 Preflight 所有可用功能的交互式菜单。Use when: "preflight有什么功能", "有什么工具", "what can preflight do", "show menu".',
    },
    async () => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `🛠️ **Preflight 功能菜单**

请选择您需要的功能：

**1. 📂 深入分析项目** ⭐推荐
创建 bundle → 查看概览 → 综合分析 → 精确定位（LSP）
工具链: preflight_create_bundle → preflight_get_overview → preflight_search_and_read → preflight_lsp

**2. 🔍 搜索代码/文档**
在已索引的项目中全文搜索代码和文档
工具: preflight_search_and_read

**3. 🔎 代码质量检查**
检测重复代码、死代码、循环依赖、复杂度热点
工具: preflight_check

**4. 📋 管理 bundles**
列出、删除已有的 bundle
工具: preflight_list_bundles, preflight_delete_bundle

---
🎯 **标准工作流（分析新项目）:**
1. preflight_create_bundle → 索引项目
2. preflight_get_overview → 了解项目概览
3. preflight_search_and_read → 搜索具体代码/文档
4. preflight_check → 检查代码质量
5. preflight_lsp → 精确定位（定义、引用等）

💡 分析结果保存在 bundle 的 analysis/*.json 中`,
            },
          },
        ],
      };
    }
  );

  // Deep analysis guide prompt
  server.registerPrompt(
    'preflight_analyze_guide',
    {
      title: '深入分析项目指南',
      description: '提供深入分析项目的操作指南和示例 prompt。Use when user selected "深入分析" or wants to analyze a project.',
      argsSchema: {
        projectPath: z.string().optional().describe('项目路径或 GitHub 仓库地址（可选）'),
      },
    },
    async (args) => {
      const pathExample = args.projectPath || 'E:\\coding\\my-project 或 owner/repo';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `📊 **深入分析项目指南**

**⭐ 标准分析流程（直接执行）:**

\`\`\`
请对 ${pathExample} 进行深度分析：

1. preflight_create_bundle - 创建 bundle 索引项目
2. preflight_get_overview - 读取项目概览
3. preflight_build_call_graph - 构建函数调用关系图
4. 分析总结：
   - 项目核心功能
   - 主要模块及调用关系
   - 入口函数和关键路径
\`\`\`

**📚 Bundle 文件结构:**
| 文件 | 内容 |
|------|------|
| \`OVERVIEW.md\` | 项目概览和结构总结 |
| \`START_HERE.md\` | 入口文件和关键路径 |
| \`AGENTS.md\` | AI Agent 使用指南 |
| \`analysis/*.json\` | 设计模式、架构、测试示例、配置、文档冲突

---
💡 **示例查询:**
- "深入分析" → 读取 bundle 中的 analysis/*.json 文件
- "谁调用了 handleRequest？" → preflight_lsp action=references`
            },
          },
        ],
      };
    }
  );

  // Search guide prompt
  server.registerPrompt(
    'preflight_search_guide',
    {
      title: '搜索代码/文档指南',
      description: '提供搜索功能的操作指南和示例 prompt。Use when user selected "搜索" or wants to search in bundles.',
      argsSchema: {
        bundleId: z.string().optional().describe('要搜索的 bundle ID（可选）'),
      },
    },
    async (args) => {
      const bundleHint = args.bundleId ? `bundle \`${args.bundleId}\`` : '指定的 bundle';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `🔍 **搜索代码/文档指南**

**搜索模式：**

**1. 单 bundle 搜索**（需要先知道 bundleId）
\`\`\`
在 ${bundleHint} 中搜索 "config parser"
\`\`\`

**2. 跨 bundle 搜索**（按 tags 过滤）
\`\`\`
在所有 MCP 相关项目中搜索 "tool registration"
在标签为 agent 的项目中搜索 "LLM"
\`\`\`

**3. 列出所有 bundle**（不确定有哪些时）
\`\`\`
列出所有 bundle
或: preflight list bundles
\`\`\`

---
💡 搜索支持 FTS5 全文语法，如：\`config AND parser\`、\`\"exact phrase\"\``
            },
          },
        ],
      };
    }
  );

  // Manage bundles guide prompt
  server.registerPrompt(
    'preflight_manage_guide',
    {
      title: '管理 bundles 指南',
      description: '提供 bundle 管理操作的指南。Use when user selected "管理" or wants to manage bundles.',
    },
    async () => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `📋 **管理 Bundles 指南**

**常用操作：**

**列出所有 bundle**
\`\`\`
列出所有 bundle
或: 查看有哪些项目已索引
\`\`\`

**查看 bundle 详情**
\`\`\`
查看 bundle {bundleId} 的概览
或: 读取 bundle {bundleId}
\`\`\`

**更新 bundle**（同步最新代码）
\`\`\`
更新 bundle {bundleId}
或: 检查 {bundleId} 是否有更新
\`\`\`

**修复 bundle**（重建索引）
\`\`\`
修复 bundle {bundleId}
或: 重建 {bundleId} 的搜索索引
\`\`\`

**删除 bundle**
\`\`\`
删除 bundle {bundleId}
\`\`\`

---
💡 先运行「列出所有 bundle」获取 bundleId 列表`,
            },
          },
        ],
      };
    }
  );

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
