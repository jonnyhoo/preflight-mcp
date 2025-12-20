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

- **12 MCP tools** to create/update/repair/search/verify/read bundles (plus resources)
- **De-duplication**: prevent repeated indexing of the same normalized inputs
- **Resilient GitHub fetching**: configurable git clone timeout + GitHub archive (zipball) fallback
- **Offline repair**: rebuild missing/empty derived artifacts (index/guides/overview) without re-fetching
- **Static facts extraction** via `analysis/FACTS.json` (non-LLM)
- **Evidence-based verification** to reduce hallucinations
- **Resources** to read bundle files via `preflight://...` URIs
- **Multi-path mirror backup** for cloud storage redundancy
- **Resilient storage** with automatic failover when mounts are unavailable
- **Atomic bundle creation** with crash-safety and zero orphans
- **Fast background deletion** with 100-300x performance improvement
- **Auto-cleanup** on startup for historical orphan bundles

## Architecture Improvements (v0.1.2)

### 🚀 Atomic Bundle Creation
**Problem**: Bundle creation failures could leave incomplete orphan directories.

**Solution**: Temporary directory + atomic rename pattern:
1. Create bundle in `tmpDir/bundles-wip/` (invisible to list)
2. Validate completeness before making visible
3. Atomic rename/move to final location
4. Automatic cleanup on any failure

**Benefits**:
- ✅ Zero orphan bundles
- 🔒 Crash-safe (temp dirs auto-cleaned)
- 📏 Validation before visibility
- 🔄 Cross-filesystem fallback

### ⚡ Fast Background Deletion
**Problem**: Deleting large bundles could timeout (10+ seconds).

**Solution**: Rename + background deletion:
1. Instant rename to `.deleting.{timestamp}` (<100ms)
2. Background deletion (fire-and-forget)
3. Automatic cleanup of `.deleting` dirs on startup

**Benefits**:
- ⚡ 100-300x faster response (<100ms)
- 🔄 No blocking operations
- 👁️ Invisible to list (non-UUID format)
- 🛡️ Fallback to direct delete on rename failure

### 🔧 Auto-Cleanup on Startup
**Problem**: Historical orphan bundles need manual cleanup.

**Solution**: Automatic cleanup on MCP server startup:
1. Scans storage directories for invalid bundles
2. Checks manifest.json validity
3. Deletes orphans older than 1 hour (safety margin)
4. Cleans `.deleting` residues

**Benefits**:
- 🤖 Fully automatic
- 🛡️ Safe with 1-hour age threshold
- ⚡ Fast when no orphans (<10ms)
- 🚫 Non-blocking background execution

### 🧹 Manual Cleanup Tool
**New Tool**: `preflight_cleanup_orphans`

Manually trigger orphan cleanup with full control:
```json
{
  "dryRun": true,        // Only report, don't delete
  "minAgeHours": 1      // Age threshold
}
```

### 🔍 UUID Validation
List and cleanup now strictly filter by UUID format:
- ✅ Only valid UUID v4 bundle IDs
- 🚫 Filters out system directories (`#recycle`, `tmp`)
- 🚫 Filters out `.deleting` directories
- 🛡️ Protects user custom directories

For technical details, see:
- [ISSUES_ANALYSIS.md](./ISSUES_ANALYSIS.md) - Root cause analysis
- [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md) - Implementation details
- [CLEANUP_STRATEGY.md](./CLEANUP_STRATEGY.md) - MCP-specific cleanup design

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

This will test bundle creation, search, and update operations.

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

## Tools (13 total)

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

### `preflight_cleanup_orphans`
Remove incomplete or corrupted bundles (bundles without valid manifest.json).
- Triggers: "clean up broken bundles", "remove orphans", "清理孤儿bundle"

Parameters:
- `dryRun` (default: true): Only report orphans without deleting
- `minAgeHours` (default: 1): Only clean bundles older than N hours

Output:
- `totalFound`: Number of orphan bundles found
- `totalCleaned`: Number of orphan bundles deleted
- `details`: Per-directory breakdown

Note: This is also automatically executed on server startup (background, non-blocking).

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

### Analysis
- `PREFLIGHT_ANALYSIS_MODE`: Static analysis mode - `none` or `quick` (default: `quick`). Generates `analysis/FACTS.json`.

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

The MIT License allows you to:
- Use commercially
- Modify
- Distribute
- Use privately

With the only requirement being to include the original copyright and license notice.

## Acknowledgments

- Built on the [Model Context Protocol](https://modelcontextprotocol.io/)
- Uses SQLite FTS5 for efficient full-text search
- Inspired by the need for evidence-based AI assistance

---

Made with ❤️ for the AI developer community
