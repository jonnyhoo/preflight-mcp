# preflight-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io/)

> **English** | [中文](./README.zh-CN.md)

An MCP (Model Context Protocol) **stdio** server that creates evidence-based preflight bundles for GitHub repositories and library documentation.

Each bundle contains:
- A local copy of repo docs + code (normalized text)
- A lightweight **full-text search index** (SQLite FTS5)
- Agent-facing entry files: `START_HERE.md`, `AGENTS.md`, and `OVERVIEW.md` (factual-only, with evidence pointers)

## Features

- **13 MCP tools** to create/update/repair/search/read bundles, generate evidence graphs, and manage trace links
- **Progress tracking**: Real-time progress reporting for long-running operations (create/update bundles)
- **Bundle integrity check**: Prevents operations on incomplete bundles with helpful error messages
- **De-duplication with in-progress lock**: Prevent duplicate bundle creation even during MCP timeouts
- **Global dependency graph**: Generate project-wide import relationship graphs
- **Batch file reading**: Read all key bundle files in a single call
- **Resilient GitHub fetching**: configurable git clone timeout + GitHub archive (zipball) fallback
- **Offline repair**: rebuild missing/empty derived artifacts (index/guides/overview) without re-fetching
- **Static facts extraction** via `analysis/FACTS.json` (non-LLM)
- **Resources** to read bundle files via `preflight://...` URIs
- **Multi-path mirror backup** for cloud storage redundancy
- **Resilient storage** with automatic failover when mounts are unavailable
- **Atomic bundle creation** with crash-safety and zero orphans
- **Fast background deletion** with 100-300x performance improvement
- **Auto-cleanup** on startup for historical orphan bundles

## Table of Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Tools](#tools-12-total)
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

Add to your MCP configuration file:

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

Or for local development:

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

Ask your AI assistant:

```
"Create a bundle for the repository octocat/Hello-World"
```

This will:
- Clone the repository
- Index all docs and code
- Generate searchable SQLite FTS5 index
- Create `START_HERE.md`, `AGENTS.md`, and `OVERVIEW.md`

### 3. Search the Bundle

```
"Search for 'GitHub' in the bundle"
```

### 4. Test Locally (Optional)

Run end-to-end smoke test:

```bash
npm run smoke
```

## Tools (13 total)

### `preflight_list_bundles`
List bundle IDs in storage.
- Triggers: "show bundles", "查看bundle", "有哪些bundle"

### `preflight_create_bundle`
Create a new bundle from GitHub repos or local directories.
- Triggers: "index this repo", "学习这个项目", "创建bundle"

Key semantics:
- **De-dup by default**: if a bundle already exists for the same normalized inputs, creation is rejected.
- Use `ifExists` to control behavior:
  - `error` (default): reject duplicate
  - `returnExisting`: return the existing bundle without fetching
  - `updateExisting`: update the existing bundle then return it
  - `createNew`: bypass de-duplication
- GitHub ingest uses **shallow clone**; if `git clone` fails, it will fall back to **GitHub archive (zipball)**.
- Supports `repos.kind: "local"` to ingest from a local directory.

Input (example):
- `repos`: `[{ kind: "github", repo: "owner/repo" }, { kind: "local", repo: "owner/repo", path: "/path/to/dir" }]`
- `libraries`: `["nextjs", "react"]` (Context7; optional)
- `topics`: `["routing", "api"]` (Context7 topic filter; optional)
- `ifExists`: `"error" | "returnExisting" | "updateExisting" | "createNew"`

**Note**: If the bundle contains code files, consider using `preflight_evidence_dependency_graph` for dependency analysis or `preflight_trace_upsert` for trace links.

### `preflight_read_file`
Read file(s) from bundle. Two modes:
- **Batch mode** (omit `file`): Returns ALL key files (OVERVIEW.md, START_HERE.md, AGENTS.md, manifest.json, repo READMEs) in one call
- **Single file mode** (provide `file`): Returns that specific file
- Triggers: "查看bundle", "bundle概览", "项目信息", "show bundle"
- Use `file: "manifest.json"` to get bundle metadata (repos, timestamps, tags, etc.)

### `preflight_delete_bundle`
Delete/remove a bundle permanently.
- Triggers: "删除bundle", "移除仓库"

### `preflight_update_bundle`
Refresh/sync a bundle with latest repo changes.
- Triggers: "更新bundle", "同步仓库", "刷新索引"

Optional parameters:
- `checkOnly`: If true, only check for updates without applying.
- `force`: If true, force rebuild even if no changes detected.

### `preflight_repair_bundle`
Offline repair for a bundle (no fetching): rebuild missing/empty derived artifacts.
- Rebuilds `indexes/search.sqlite3`, `START_HERE.md`, `AGENTS.md`, `OVERVIEW.md` when missing/empty.
- Use when: search fails due to index corruption, bundle files were partially deleted, etc.

### `preflight_search_bundle`
Full-text search across ingested docs/code (line-based SQLite FTS5).
- Triggers: "搜索bundle", "在仓库中查找", "搜代码"

Important: **this tool is strictly read-only**.
- To update: call `preflight_update_bundle`, then search again.
- To repair: call `preflight_repair_bundle`, then search again.

### `preflight_search_by_tags`
Search across multiple bundles filtered by tags (line-based SQLite FTS5).
- Triggers: "search in MCP bundles", "在MCP项目中搜索", "搜索所有agent"

Notes:
- This tool is read-only and **does not auto-repair**.
- If some bundles fail to search (e.g. missing/corrupt index), they will be reported in `warnings`.

Optional parameters:
- `tags`: Filter bundles by tags (e.g., `["mcp", "agents"]`)
- `scope`: Search scope (`docs`, `code`, or `all`)
- `limit`: Max total hits across all bundles

### `preflight_evidence_dependency_graph`
Generate an evidence-based dependency graph. Two modes:
- **Target mode** (provide `target.file`): Analyze a specific file's imports and callers
- **Global mode** (omit `target`): Generate project-wide import graph of all code files
- Deterministic output with source ranges for edges.
- Uses Tree-sitter parsing when `PREFLIGHT_AST_ENGINE=wasm`; falls back to regex extraction otherwise.
- Emits `imports` edges (file → module) and `imports_resolved` edges (file → internal file).

### `preflight_trace_upsert`
Upsert traceability links (commit↔ticket, symbol↔test, code↔doc, etc.) for a bundle.

### `preflight_trace_query`
Query traceability links (fast when `bundleId` is provided; can scan across bundles when omitted).

### `preflight_cleanup_orphans`
Remove incomplete or corrupted bundles (bundles without valid manifest.json).
- Triggers: "clean up broken bundles", "remove orphans", "清理孤儿bundle"

Parameters:
- `dryRun` (default: true): Only report orphans without deleting
- `minAgeHours` (default: 1): Only clean bundles older than N hours

Note: This is also automatically executed on server startup (background, non-blocking).

### `preflight_get_task_status`
Check status of bundle creation/update tasks (progress tracking).
- Triggers: "check progress", "what is the status", "查看任务状态", "下载进度"
- Query by `taskId` (from error), `fingerprint`, or `repos`
- Shows: phase, progress percentage, message, elapsed time

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
- `analysis/FACTS.json` (static analysis)
- `trace/trace.sqlite3` (traceability links; created on demand)
- `repos/<owner>/<repo>/raw/...`
- `repos/<owner>/<repo>/norm/...` (GitHub/local snapshots)
- `libraries/context7/<...>/meta.json`
- `libraries/context7/<...>/docs-page-1.md`

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

We welcome contributions! Please see our [Contributing Guide](./CONTRIBUTING.md) for details on:

- Development setup
- Code style guidelines
- Testing requirements
- Pull request process

Please also read our [Code of Conduct](./CODE_OF_CONDUCT.md) before contributing.

## Support

If you encounter any issues or have questions:

- **Issues**: [GitHub Issues](https://github.com/jonnyhoo/preflight-mcp/issues)
- **Discussions**: [GitHub Discussions](https://github.com/jonnyhoo/preflight-mcp/discussions)

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.

---

Made with ❤️ for the AI developer community
