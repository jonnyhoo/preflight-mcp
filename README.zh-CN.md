# preflight-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io/)

> [English](./README.md) | **中文**

一个 MCP (Model Context Protocol) **stdio** 服务器，用于为 GitHub 仓库与库文档生成“基于证据”的 preflight bundles。

每个 bundle 包含：
- 仓库文档 + 代码的本地副本（规范化文本）
- 轻量级 **全文搜索索引**（SQLite FTS5）
- 面向 Agent 的入口文件：`START_HERE.md`、`AGENTS.md`、`OVERVIEW.md`（仅事实，带证据指针）

## Features

- **16 个 MCP 工具**：create/update/repair/search/verify/evidence/trace/read/cleanup（外加 resources）
- **去重**：避免对相同的规范化输入重复索引
- **更可靠的 GitHub 获取**：可配置 git clone 超时 + GitHub archive（zipball）兜底
- **离线修复**：无需重新抓取，重建缺失/为空的派生物（index/guides/overview）
- **静态事实提取**：生成 `analysis/FACTS.json`（非 LLM）
- **基于证据的校验**：减少幻觉
- **Resources**：通过 `preflight://...` URI 读取 bundle 文件
- **多路径镜像备份**：云存储冗余
- **弹性存储**：挂载点不可用时自动故障转移
- **原子创建 + 零孤儿**：临时目录 + 原子重命名，崩溃安全
- **后台快速删除**：<100ms 响应，实际删除在后台进行
- **启动自动清理**：历史孤儿目录自动清理（非阻塞）

## Table of Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Architecture Improvements (v0.1.2)](#architecture-improvements-v012)
- [Upgrade to v0.1.2](#upgrade-to-v012)
- [Tools](#tools-16-total)
- [Environment Variables](#environment-variables)
- [Contributing](#contributing)
- [License](#license)

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

## Smoke test
Runs an end-to-end stdio client that:
- spawns the server
- calls `preflight_create_bundle`
- reads `preflight://bundles` and `START_HERE.md`
- searches the bundle
- calls `preflight_update_bundle`

Command:
- `npm run smoke`

Note: the smoke test clones `octocat/Hello-World` from GitHub, so it needs internet access.

## Architecture Improvements (v0.1.2)

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

## Upgrade to v0.1.2
- 无破坏性变更；升级后无需迁移步骤
- 建议：运行一次手动清理工具查看状态：
  ```json
  { "dryRun": true, "minAgeHours": 1 }
  ```
- 删除现在是后台执行；列表中不会出现 `.deleting.*` 目录

## Tools (16 total)

### `preflight_list_bundles`
List bundle IDs in storage.
- Triggers: "show bundles", "查看bundle", "有哪些bundle"

### `preflight_create_bundle`
Create a new bundle from one or more inputs.
- Triggers: "index this repo", "学习这个项目", "创建bundle"

Key semantics:
- **De-dup by default**: if a bundle already exists for the same normalized inputs, creation is rejected.
- Use `ifExists` to control behavior:
  - `error` (default): reject duplicate
  - `returnExisting`: return the existing bundle without fetching
  - `updateExisting`: update the existing bundle then return it
  - `createNew`: bypass de-duplication
- GitHub ingest uses **shallow clone**; if `git clone` fails, it will fall back to **GitHub archive (zipball)**.
- Supports `repos.kind: "local"` to ingest from a local directory (e.g. an extracted zip).

Input (example):
- `repos`: `[{ kind: "github", repo: "owner/repo" }, { kind: "local", repo: "owner/repo", path: "/path/to/dir" }, { kind: "deepwiki", url: "https://deepwiki.com/owner/repo" }]`
- `libraries`: `["nextjs", "react"]` (Context7; optional)
- `topics`: `["routing", "api"]` (Context7 topic filter; optional)
- `ifExists`: `"error" | "returnExisting" | "updateExisting" | "createNew"`

### `preflight_read_file`
Read a file from bundle (OVERVIEW.md, START_HERE.md, AGENTS.md, or any repo file).
- Triggers: "查看概览", "项目概览", "看README"

### `preflight_bundle_info`
Get bundle details: repos, update time, stats.
- Triggers: "bundle详情", "仓库信息"

### `preflight_delete_bundle`
Delete/remove a bundle permanently.
- Triggers: "删除bundle", "移除仓库"

### `preflight_update_bundle`
Refresh/sync a bundle with latest repo changes.
- Triggers: "更新bundle", "同步仓库", "刷新索引"

Optional parameters:
- `checkOnly`: If true, only check for updates without applying.
- `force`: If true, force rebuild even if no changes detected.

### `preflight_update_all_bundles`
Batch update all bundles at once.
- Triggers: "批量更新", "全部刷新"

### `preflight_find_bundle`
Check whether a bundle already exists for the given inputs (no fetching, no changes).
- Use when your UI/agent wants to decide whether to create/update.

### `preflight_repair_bundle`
Offline repair for a bundle (no fetching): rebuild missing/empty derived artifacts.
- Rebuilds `indexes/search.sqlite3`, `START_HERE.md`, `AGENTS.md`, `OVERVIEW.md` when missing/empty.
- Use when: search fails due to index corruption, bundle files were partially deleted, etc.

### `preflight_search_bundle`
Full-text search across ingested docs/code (line-based SQLite FTS5).
- Triggers: "搜索bundle", "在仓库中查找", "搜代码"

Important: **this tool is strictly read-only**.
- `ensureFresh` / `maxAgeHours` are **deprecated** and will error if provided.
- To update: call `preflight_update_bundle`, then search again.
- To repair: call `preflight_repair_bundle`, then search again.

### `preflight_cleanup_orphans`
删除不完整或损坏的 bundle（缺少有效 manifest.json）。
- 触发词："清理孤儿bundle", "删除坏目录"
- 参数：
  - `dryRun`（默认 true）：仅报告不删除
  - `minAgeHours`（默认 1）：只清理超过 N 小时的目录
- 输出：`totalFound`, `totalCleaned`, `details`
- 说明：服务启动时也会自动执行后台清理（非阻塞）

### `preflight_search_by_tags`
Search across multiple bundles filtered by tags (line-based SQLite FTS5).
- Triggers: "search in MCP bundles", "search in all bundles", "在MCP项目中搜索", "搜索所有agent"

Notes:
- This tool is read-only and **does not auto-repair**.
- If some bundles fail to search (e.g. missing/corrupt index), they will be reported in `warnings`.

Optional parameters:
- `tags`: Filter bundles by tags (e.g., `["mcp", "agents"]`)
- `scope`: Search scope (`docs`, `code`, or `all`)
- `limit`: Max total hits across all bundles

Output additions:
- `warnings?: [{ bundleId, kind, message }]` (non-fatal per-bundle errors)
- `warningsTruncated?: true` if warnings were capped

### `preflight_verify_claim`
Find evidence for a claim/statement in bundle.
- Triggers: "验证说法", "找证据", "这个对吗"

Important: **this tool is strictly read-only**.
- `ensureFresh` / `maxAgeHours` are **deprecated** and will error if provided.
- To update: call `preflight_update_bundle`, then verify again.
- To repair: call `preflight_repair_bundle`, then verify again.

### `preflight_evidence_dependency_graph`
生成目标文件/符号的“基于证据”的依赖图（imports + callers）。
- 输出确定性（best-effort），并为每条边提供可追溯 source range。
- `PREFLIGHT_AST_ENGINE=wasm` 时使用 Tree-sitter；否则回退到正则抽取。
- 既输出 `imports`（file → module），也会在可解析时输出 `imports_resolved`（file → file）。

### `preflight_trace_upsert`
写入/更新 bundle 级 traceability links（commit↔ticket、symbol↔test、code↔doc 等）。

### `preflight_trace_query`
查询 traceability links（提供 `bundleId` 时更快；省略时可跨 bundle 扫描，带上限）。

## Resources
### `preflight://bundles`
Static JSON listing of bundles and their main entry files.

### `preflight://bundle/{bundleId}/file/{encodedPath}`
Read a specific file inside a bundle.

Examples:
- `preflight://bundle/<id>/file/START_HERE.md`
- `preflight://bundle/<id>/file/repos%2Fowner%2Frepo%2Fnorm%2FREADME.md`

## Error semantics (stable, UI-friendly)
Most tool errors are wrapped with a stable, machine-parseable prefix:
- `[preflight_error kind=<kind>] <message>`

Common kinds:
- `bundle_not_found`
- `file_not_found`
- `invalid_path` (unsafe path traversal attempt)
- `permission_denied`
- `index_missing_or_corrupt`
- `deprecated_parameter`
- `unknown`

This is designed so UIs/agents can reliably decide whether to:
- call `preflight_update_bundle`
- call `preflight_repair_bundle`
- prompt the user for a different bundleId/path

## Environment variables
### Storage
- `PREFLIGHT_STORAGE_DIR`: bundle storage dir (default: `~/.preflight-mcp/bundles`)
- `PREFLIGHT_STORAGE_DIRS`: **multi-path mirror backup** (semicolon-separated, e.g., `D:\cloud1\preflight;E:\cloud2\preflight`)
- `PREFLIGHT_TMP_DIR`: temp checkout dir (default: OS temp `preflight-mcp/`)
- `PREFLIGHT_MAX_FILE_BYTES`: max bytes per file (default: 512 KiB)
- `PREFLIGHT_MAX_TOTAL_BYTES`: max bytes per repo ingest (default: 50 MiB)

### Analysis & evidence
- `PREFLIGHT_ANALYSIS_MODE`: Static analysis mode - `none` | `quick` | `full` (default: `full`). Controls generation of `analysis/FACTS.json`.
- `PREFLIGHT_AST_ENGINE`: AST engine used by some evidence tools - `wasm` (default) or `native`.

### Built-in HTTP API
- `PREFLIGHT_HTTP_ENABLED`: enable/disable REST API (default: true)
- `PREFLIGHT_HTTP_HOST`: REST listen host (default: 127.0.0.1)
- `PREFLIGHT_HTTP_PORT`: REST listen port (default: 37123)

### GitHub & Context7
- `GITHUB_TOKEN`: optional; used for GitHub API/auth patterns and GitHub archive fallback (public repos usually work without it)
- `PREFLIGHT_GIT_CLONE_TIMEOUT_MS`: optional; max time to allow `git clone` before failing over to archive (default: 5 minutes)
- `CONTEXT7_API_KEY`: optional; enables higher Context7 limits (runs without a key but may be rate-limited)
- `CONTEXT7_MCP_URL`: optional; defaults to Context7 MCP endpoint

## Bundle layout (on disk)
Inside a bundle directory:
- `manifest.json` (includes `fingerprint`, `displayName`, `tags`, and per-repo `source`)
- `START_HERE.md`
- `AGENTS.md`
- `OVERVIEW.md`
- `indexes/search.sqlite3`
- **`analysis/FACTS.json`** (static analysis)
- `trace/trace.sqlite3` (traceability links; created on demand)
- `repos/<owner>/<repo>/raw/...`
- `repos/<owner>/<repo>/norm/...` (GitHub/local snapshots)
- `deepwiki/<owner>/<repo>/norm/index.md` (DeepWiki sources)
- `deepwiki/<owner>/<repo>/meta.json`
- `libraries/context7/<...>/meta.json`
- `libraries/context7/<...>/docs-page-1.md` (or `topic-<topic>-page-1.md`)

## Multi-device sync & mirror backup

If you work from multiple computers or want redundant cloud backups:

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
Writes to all paths, reads from first available:
```powershell
# Windows - semicolon separated
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
- **Auto-failover**: If primary path is unavailable, automatically uses first available backup
- **Mirror sync**: All writes are mirrored to available backup paths
- **Mount recovery**: When a path comes back online, it syncs automatically on next write
- **Non-blocking**: Unavailable paths are skipped without errors

### Important notes
- **Avoid concurrent access**: Only use on one machine at a time (SQLite conflicts)
- **Wait for sync**: After updates, wait for cloud sync before switching machines

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
