# preflight-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io/)
[![npm version](https://img.shields.io/npm/v/preflight-mcp)](https://www.npmjs.com/package/preflight-mcp)

> [English](./README.md) | **中文**

**让你的 AI 助手秒懂任何代码仓库。**

Preflight-MCP 为 GitHub 仓库创建可搜索的知识库，让 Claude/GPT/Cursor 理解你的项目结构、快速定位代码、追踪依赖关系 —— 无需复制粘贴，不受 token 限制。

## 为什么需要 Preflight？

| 痛点 | Preflight 解决方案 |
|------|--------------------|
| 🤯 AI 记不住你的代码库 | 持久化、可搜索的知识包 |
| 📋 反复复制粘贴代码 | 一句话：「索引这个仓库」 |
| 🔍 AI 找不到相关文件 | 全文搜索 + 依赖图 |
| 🧩 大项目里迷失方向 | 自动生成 `START_HERE.md` 和 `OVERVIEW.md` |
| 🔗 不知道哪些测试覆盖哪些代码 | 追溯链接：代码↔测试↔文档 |

## 效果演示

```
你：「为 facebook/react 创建 bundle」

Preflight：✅ 已克隆，索引了 2,847 个文件，生成概览完成

你：「搜索 useState 的实现」

Preflight：📍 找到 23 处匹配：
  → packages/react/src/ReactHooks.js:24
  → packages/react-reconciler/src/ReactFiberHooks.js:1042
  ...

你：「哪些测试覆盖了 useState」

Preflight：🔗 追溯链接：
  → ReactHooks.js tested_by ReactHooksTest.js
  ...
```

## 核心功能

- 🚀 **一句话索引** — 「索引 owner/repo」即可创建完整知识包
- 🔍 **全文搜索** — SQLite FTS5 搜索全部代码和文档
- 🗺️ **依赖图** — 可视化 import 关系和文件依赖
- 🔗 **追溯链接** — 追踪代码↔测试↔文档关系
- 📖 **自动生成指南** — `START_HERE.md`、`AGENTS.md`、`OVERVIEW.md`
- ☁️ **云端同步** — 多路径镜像备份
- ⚡ **15 个 MCP 工具 + 5 个 prompts** — 完整的代码探索工具集

<details>
<summary><b>全部功能（点击展开）</b></summary>

- **进度追踪**：长时间操作的实时进度显示
- **Bundle 完整性检查**：防止对不完整 bundle 进行操作
- **去重机制**：即使超时也能防止重复创建
- **可靠的 GitHub 抓取**：git clone 超时 + archive 兜底
- **离线修复**：无需重新抓取即可重建派生文件
- **静态事实提取**：`analysis/FACTS.json`（非 LLM）
- **Resources**：通过 `preflight://...` URI 读取文件
- **原子操作**：崩溃安全，零孤儿目录
- **快速删除**：100-300 倍性能提升
- **自动清理**：启动时自动清理孤儿 bundle

</details>

## 目录

- [为什么需要 Preflight](#为什么需要-preflight)
- [效果演示](#效果演示)
- [核心功能](#核心功能)
- [快速开始](#quick-start)
- [工具](#tools-15-total)
- [Prompts](#prompts-5-total)
- [环境变量](#environment-variables)
- [贡献指南](#contributing)

## Requirements

- Node.js >= 18
- `git` available on PATH

## Installation

### From npm (after published)

```bash
npm install -g preflight-mcp
```

### Local Development

```bash
git clone https://github.com/jonnyhoo/preflight-mcp.git
cd preflight-mcp
npm install
npm run build
```

## Quick Start

### 1. Configure MCP Host (e.g., Claude Desktop)

在你的 MCP 配置文件中加入：

```json
{
  "mcpServers": {
    "preflight": {
      "command": "npx",
      "args": ["preflight-mcp"]
    }
  }
}
```

或（本地开发）直接指向构建产物：

```json
{
  "mcpServers": {
    "preflight": {
      "command": "node",
      "args": ["path/to/preflight-mcp/dist/index.js"]
    }
  }
}
```

### 2. Create Your First Bundle

对你的 AI 助手说：

```
"为仓库 octocat/Hello-World 创建 bundle"
```

它会：
- 克隆仓库
- 索引所有文档与代码
- 生成可搜索的 SQLite FTS5 索引
- 生成 `START_HERE.md`、`AGENTS.md`、`OVERVIEW.md`

### 3. Search the Bundle

```
"在 bundle 里搜索 'GitHub'"
```

### 4. Test Locally (Optional)

运行端到端 smoke 测试：

```bash
npm run smoke
```

这会测试 bundle 创建、搜索、更新等核心操作。

## Architecture

### 🚀 原子创建（Crash-safe）
- 在 `tmpDir/bundles-wip/` 下构建，校验通过后原子重命名到最终目录
- 失败会自动清理临时目录，避免产生孤儿目录
- 跨文件系统自动回退到 copy+delete

### ⚡ 后台删除（Fast Delete）
- 先将目录重命名为 `.deleting.{timestamp}`，响应<100ms
- 真正的删除在后台完成；启动时会清理残留的 `.deleting` 目录

### 🧹 启动自动清理（Auto-Cleanup）
- 启动时后台扫描并清理无效 bundle（无有效 manifest.json）
- 仅清理超过 1 小时的目录（安全阈值），非阻塞执行

### 🔍 UUID 严格校验
- 列表与清理逻辑只接受 UUID v4 作为 bundleId
- 会自动过滤 `#recycle`、`tmp`、`.deleting` 等非 bundle 目录

## Tools (15 total)

### `preflight_list_bundles`
列出所有 bundle。
- 触发词：「show bundles」「查看bundle」「有哪些bundle」「列出仓库」

### `preflight_create_bundle`
从一个或多个输入创建新 bundle。
- 触发词：「index this repo」「学习这个项目」「创建bundle」

关键语义：
- **默认去重**：如果相同规范化输入的 bundle 已存在，默认拒绝创建
- 使用 `ifExists` 控制行为：
  - `error`（默认）：拒绝重复
  - `returnExisting`：返回已存在的 bundle，不抓取（可替代原 `preflight_find_bundle`）
  - `updateExisting`：更新已存在的 bundle 后返回
  - `createNew`：绕过去重
- GitHub 抓取使用**浅克隆**；如果 `git clone` 失败，会回退到 **GitHub archive (zipball)**
- 支持 `repos.kind: "local"` 从本地目录（如解压后的 zip）抓取

输入示例：
- `repos`: `[{ kind: "github", repo: "owner/repo" }, { kind: "local", repo: "owner/repo", path: "/path/to/dir" }]`
- `libraries`: `["nextjs", "react"]`（Context7；可选）
- `topics`: `["routing", "api"]`（Context7 主题过滤；可选）
- `ifExists`: `"error" | "returnExisting" | "updateExisting" | "createNew"`

**💡 提示**：对于代码仓库，创建 bundle 后可进一步使用 `preflight_evidence_dependency_graph` 获取依赖图，或使用 `preflight_trace_upsert` 记录代码←→需求/测试的追溯链接。

### `preflight_read_file`
从 bundle 读取文件。两种模式：
- **批量模式**（省略 `file`）：返回所有关键文件
- **单文件模式**（提供 `file`）：返回指定文件
- **证据引用**：使用 `withLineNumbers: true` 获取 `N|行` 格式；使用 `ranges: ["20-80"]` 读取指定行
- 触发词：「查看概览」「项目概览」「bundle详情」「读取依赖图」

### `preflight_repo_tree`
获取仓库结构概览，避免浪费 token 搜索。
- 返回：ASCII 目录树、按扩展名/目录统计文件数、入口点候选
- 在深入分析前使用，了解项目布局
- 触发词：「项目结构」「文件分布」「show tree」

### `preflight_delete_bundle`
永久删除/移除一个 bundle。
- 触发词：「删除bundle」「移除仓库」

### `preflight_update_bundle`
用最新仓库变更刷新/同步 bundle。
- 触发词：「更新bundle」「同步仓库」「刷新索引」

可选参数：
- `checkOnly`：如为 true，仅检查是否有更新，不实际应用
- `force`：如为 true，即使未检测到变更也强制重建

### `preflight_repair_bundle`
离线修复 bundle（无需抓取）：重建缺失/为空的派生物。
- 重建 `indexes/search.sqlite3`、`START_HERE.md`、`AGENTS.md`、`OVERVIEW.md`（当缺失/为空时）
- 适用场景：搜索因索引损坏失败、bundle 文件被部分删除等

### `preflight_search_bundle`
跨已抓取的文档/代码进行全文搜索（基于行的 SQLite FTS5）。
- 触发词：「搜索bundle」「在仓库中查找」「搜代码」

重要：**此工具是严格只读的**。
- `ensureFresh` / `maxAgeHours` 已**弃用**，提供时会报错
- 更新：先调用 `preflight_update_bundle`，再搜索
- 修复：先调用 `preflight_repair_bundle`，再搜索

### `preflight_search_by_tags`
跨多个 bundle 按标签过滤搜索（基于行的 SQLite FTS5）。
- 触发词：「search in MCP bundles」「search in all bundles」「在MCP项目中搜索」「搜索所有agent」

说明：
- 此工具是只读的，**不会自动修复**
- 如果某些 bundle 搜索失败（如索引缺失/损坏），会在 `warnings` 中报告

可选参数：
- `tags`：按标签过滤 bundle（如 `["mcp", "agents"]`）
- `scope`：搜索范围（`docs`、`code` 或 `all`）
- `limit`：跨所有 bundle 的最大命中数

### `preflight_evidence_dependency_graph`
生成目标文件/符号的「基于证据」的依赖图（imports + callers）。
- 输出确定性（best-effort），并为每条边提供可追溯 source range
- `PREFLIGHT_AST_ENGINE=wasm` 时使用 Tree-sitter；否则回退到正则抽取
- 既输出 `imports`（file → module），也会在可解析时输出 `imports_resolved`（file → file）

### `preflight_trace_upsert`
写入/更新 bundle 级 traceability links（commit↔ticket、symbol↔test、code↔doc 等）。

### `preflight_trace_query`
查询 traceability links。
- 无匹配边时返回 `reason` 和 `nextSteps`（帮助 LLM 决定下一步）
- 提供 `bundleId` 时更快；省略时可跨 bundle 扫描

### `preflight_trace_export`
导出 trace links 到 `trace/trace.json`。
- 注意：每次 `trace_upsert` 后会自动导出，此工具仅用于手动刷新
- 触发词：「导出trace」「刷新trace.json」

### `preflight_cleanup_orphans`
删除不完整或损坏的 bundle（缺少有效 manifest.json）。
- 触发词：「清理孤儿bundle」「删除坏目录」
- 参数：
  - `dryRun`（默认 true）：仅报告不删除
  - `minAgeHours`（默认 1）：只清理超过 N 小时的目录
- 输出：`totalFound`, `totalCleaned`, `details`
- 说明：服务启动时也会自动执行后台清理（非阻塞）

### `preflight_get_task_status`
检查 bundle 创建/更新任务的状态（进度追踪）。
- 触发词：「查看进度」「任务状态」「下载进度」
- 通过 `taskId`、`fingerprint` 或 `repos` 查询
- 显示：阶段、进度百分比、消息、已用时间

## Prompts（5 个）

MCP prompts 提供交互式引导。调用这些 prompt 获取使用说明和示例。

### `preflight_menu`
主菜单，显示所有 Preflight 功能。
- 触发词：「preflight有什么功能」「有什么工具」「what can preflight do」

### `preflight_analyze_guide`
深入分析指南，包含分步流程和可复制的 prompt。
- 显示：Bundle 文件结构、推荐分析流程、示例 prompt
- 参数：`projectPath`（可选）

### `preflight_search_guide`
搜索功能指南。
- 显示：单 bundle 搜索、跨 bundle 按标签搜索、FTS5 语法提示
- 参数：`bundleId`（可选）

### `preflight_manage_guide`
Bundle 管理操作指南。
- 显示：列出、查看、更新、修复、删除 bundle 操作

### `preflight_trace_guide`
追溯链接指南。
- 显示：查询和创建代码↔测试、代码↔文档关系
- 参数：`bundleId`（可选）

## Resources

### `preflight://bundles`
静态 JSON，列出所有 bundle 及其主入口文件。

### `preflight://bundle/{bundleId}/file/{encodedPath}`
读取 bundle 内的特定文件。

示例：
- `preflight://bundle/<id>/file/START_HERE.md`
- `preflight://bundle/<id>/file/repos%2Fowner%2Frepo%2Fnorm%2FREADME.md`

## Error semantics (stable, UI-friendly)

大多数工具错误会包装为稳定、可机器解析的前缀：
- `[preflight_error kind=<kind>] <message>`

常见 kinds：
- `bundle_not_found`
- `file_not_found`
- `invalid_path`（不安全的路径遍历尝试）
- `permission_denied`
- `index_missing_or_corrupt`
- `deprecated_parameter`
- `unknown`

这样设计是为了让 UI/agent 能可靠地决定是否：
- 调用 `preflight_update_bundle`
- 调用 `preflight_repair_bundle`
- 提示用户提供不同的 bundleId/path

## Environment variables

### Storage
- `PREFLIGHT_STORAGE_DIR`：bundle 存储目录（默认：`~/.preflight-mcp/bundles`）
- `PREFLIGHT_STORAGE_DIRS`：**多路径镜像备份**（分号分隔，如 `D:\cloud1\preflight;E:\cloud2\preflight`）
- `PREFLIGHT_TMP_DIR`：临时检出目录（默认：OS temp `preflight-mcp/`）
- `PREFLIGHT_MAX_FILE_BYTES`：单文件最大字节（默认：512 KiB）
- `PREFLIGHT_MAX_TOTAL_BYTES`：单仓库抓取最大字节（默认：50 MiB）

### Analysis & evidence
- `PREFLIGHT_ANALYSIS_MODE`：静态分析模式 - `none` | `quick` | `full`（默认：`full`）。控制 `analysis/FACTS.json` 生成。
- `PREFLIGHT_AST_ENGINE`：部分证据工具使用的 AST 引擎 - `wasm`（默认）或 `native`。

### Built-in HTTP API
- `PREFLIGHT_HTTP_ENABLED`：启用/禁用 REST API（默认：true）
- `PREFLIGHT_HTTP_HOST`：REST 监听主机（默认：127.0.0.1）
- `PREFLIGHT_HTTP_PORT`：REST 监听端口（默认：37123）

### GitHub & Context7
- `GITHUB_TOKEN`：可选；用于 GitHub API/auth 模式和 GitHub archive 兜底（公开仓库通常不需要）
- `PREFLIGHT_GIT_CLONE_TIMEOUT_MS`：可选；`git clone` 最大等待时间，超时后切换到 archive（默认：5 分钟）
- `CONTEXT7_API_KEY`：可选；启用更高的 Context7 限制（无 key 也能运行但可能被限流）
- `CONTEXT7_MCP_URL`：可选；默认为 Context7 MCP 端点

## Bundle layout (on disk)

bundle 目录内部：
- `manifest.json`（含 `fingerprint`、`displayName`、`tags`，以及每个 repo 的 `source`）
- `START_HERE.md`
- `AGENTS.md`
- `OVERVIEW.md`
- `indexes/search.sqlite3`
- **`analysis/FACTS.json`**（静态分析）
- **`deps/dependency-graph.json`**（全局依赖图；按需生成）
- `trace/trace.sqlite3`（traceability links；按需创建）
- `trace/trace.json`（自动导出的 JSON，便于 LLM 直接读取）
- `repos/<owner>/<repo>/raw/...`
- `repos/<owner>/<repo>/norm/...`（GitHub/local 快照）
- `libraries/context7/<...>/meta.json`
- `libraries/context7/<...>/docs-page-1.md`（或 `topic-<topic>-page-1.md`）

## Multi-device sync & mirror backup

如果你在多台电脑上工作或需要冗余云备份：

### Single path (simple)
```powershell
# Windows
$env:PREFLIGHT_STORAGE_DIR = "D:\OneDrive\preflight-bundles"
```
```bash
# macOS/Linux
export PREFLIGHT_STORAGE_DIR="$HOME/Dropbox/preflight-bundles"
```

### Multi-path mirror (redundancy)
写入所有路径，从第一个可用路径读取：
```powershell
# Windows - 分号分隔
$env:PREFLIGHT_STORAGE_DIRS = "D:\OneDrive\preflight;E:\GoogleDrive\preflight"
```
```bash
# macOS/Linux
export PREFLIGHT_STORAGE_DIRS="$HOME/OneDrive/preflight;$HOME/Dropbox/preflight"
```

### MCP host config (Claude Desktop)
```json
{
  "mcpServers": {
    "preflight": {
      "command": "node",
      "args": ["path/to/preflight-mcp/dist/index.js"],
      "env": {
        "PREFLIGHT_STORAGE_DIRS": "D:\\cloud1\\preflight;E:\\cloud2\\preflight"
      }
    }
  }
}
```

### Resilient storage features
- **Auto-failover**：如果主路径不可用，自动使用第一个可用备份
- **Mirror sync**：所有写入会镜像到可用备份路径
- **Mount recovery**：路径恢复后，下次写入时自动同步
- **Non-blocking**：不可用路径会被跳过，不报错

### Important notes
- **避免并发访问**：同一时间只在一台机器上使用（SQLite 冲突）
- **等待同步**：更新后，切换机器前等待云同步完成

## Contributing

欢迎贡献！请查看 [Contributing Guide](./CONTRIBUTING.md) 了解：
- 开发环境搭建
- 代码风格
- 测试要求
- PR 流程

在贡献之前，也请阅读 [Code of Conduct](./CODE_OF_CONDUCT.md)。

## Support

如果你遇到问题或有疑问：

- **Issues**: [GitHub Issues](https://github.com/jonnyhoo/preflight-mcp/issues)
- **Discussions**: [GitHub Discussions](https://github.com/jonnyhoo/preflight-mcp/discussions)

## License

本项目基于 MIT License 发布，详见 [LICENSE](./LICENSE)。

MIT License 允许你：
- 商用
- 修改
- 分发
- 私用

唯一要求是保留原始版权与许可证声明。

## Acknowledgments

- Built on the [Model Context Protocol](https://modelcontextprotocol.io/)
- Uses SQLite FTS5 for efficient full-text search
- Inspired by the need for evidence-based AI assistance

---

Made with ❤️ for the AI developer community
