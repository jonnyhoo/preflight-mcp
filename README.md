# preflight-mcp

> **English** | [中文](./README.zh-CN.md)

An MCP (Model Context Protocol) **stdio** server

Each bundle contains:
- A local copy of repo docs + code (normalized text)
- A lightweight **full-text search index** (SQLite FTS5)
- Agent-facing entry files: `START_HERE.md`, `AGENTS.md`, and `OVERVIEW.md` (factual-only, with evidence pointers)

## What you get
- **12 tools** to create/update/repair/search/verify/read bundles (plus resources)
- **De-duplication**: prevent repeated indexing of the same normalized inputs
- **Resilient GitHub fetching**: configurable git clone timeout + GitHub archive (zipball) fallback
- **Offline repair**: rebuild missing/empty derived artifacts (index/guides/overview) without re-fetching
- **Static facts extraction** via `analysis/FACTS.json` (non-LLM)
- **Evidence-based verification** to reduce hallucinations
- **Resources** to read bundle files via `preflight://...` URIs
- **Multi-path mirror backup** for cloud storage redundancy
- **Resilient storage** with automatic failover when mounts are unavailable

## Requirements
- Node.js >= 18
- `git` available on PATH

## Install
Local dev:
- `npm install`
- `npm run build`

Publish install (after you publish to npm):
- `npm install -g preflight-mcp`

## Use (stdio MCP server)
This server communicates over stdin/stdout, so you typically run it via an MCP host (e.g. mcp-hub).

Example MCP host command:
- `preflight-mcp`

Or, for local dev:
- `node dist/index.js`

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

## Tools (12 total)

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
