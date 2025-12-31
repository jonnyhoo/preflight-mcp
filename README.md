# preflight-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io/)
[![npm version](https://img.shields.io/npm/v/preflight-mcp)](https://www.npmjs.com/package/preflight-mcp)

> **English** | [中文](./README.zh-CN.md)

**Give your AI assistant deep knowledge of any codebase — in seconds.**

Preflight-MCP creates searchable, indexed knowledge bundles from GitHub repos, so Claude/GPT/Cursor can understand your project structure, find relevant code, and trace dependencies — without copy-pasting or token limits.

## Why Preflight?

| Problem | Preflight Solution |
|---------|--------------------|
| 🤯 AI forgets your codebase context | Persistent, searchable bundles |
| 📋 Copy-pasting code into chat | One command: `"index this repo"` |
| 🔍 AI can't find related files | Full-text search + dependency graph |
| 🧩 Lost in large projects | Auto-generated `START_HERE.md` & `OVERVIEW.md` |
| 🔗 No idea what tests cover what | Trace links: code↔test↔doc |

## Demo

```
You: "Create a bundle for the repository facebook/react"

Preflight: ✅ Cloned, indexed 2,847 files, generated overview

You: "Search for 'useState' implementation"

Preflight: 📍 Found 23 matches:
  → packages/react/src/ReactHooks.js:24
  → packages/react-reconciler/src/ReactFiberHooks.js:1042
  ...

You: "Show me what tests cover useState"

Preflight: 🔗 Trace links:
  → ReactHooks.js tested_by ReactHooksTest.js
  ...
```

## Core Features

- 🚀 **One-command indexing** — `"index owner/repo"` creates a complete knowledge bundle
- 🔍 **Full-text search** — SQLite FTS5 search across all code and docs
- 🧠 **Semantic search** *(optional)* — Vector-based similarity search via Ollama (local) or OpenAI
- 🗺️ **Dependency graph** — Visualize imports and file relationships
- 🔗 **Trace links** — Track code↔test↔doc relationships
- 📖 **Auto-generated guides** — `START_HERE.md`, `AGENTS.md`, `OVERVIEW.md`
- ☁️ **Cloud sync** — Multi-path mirror backup for redundancy
- 🧠 **EDDA (Evidence-Driven Deep Analysis)** — Auto-generate auditable claims with evidence
- ⚡ **17 MCP tools + 5 prompts** — Streamlined toolkit optimized for LLM use
- 📄 **Cursor pagination** — Handle large result sets efficiently (RFC v2)
- 🧠 **LLM-friendly** — Auto-compressed outputs, unified interfaces (v0.6.0)

<details>
<summary><b>All Features (click to expand)</b></summary>

- **Progress tracking**: Real-time progress for long-running operations
- **Bundle integrity check**: Prevents operations on incomplete bundles
- **De-duplication**: Prevent duplicate bundle creation even during timeouts
- **Resilient GitHub fetching**: Git clone timeout + archive fallback
- **Offline repair**: Rebuild derived artifacts without re-fetching
- **Static facts extraction**: `analysis/FACTS.json` (non-LLM)
- **Resources**: Read bundle files via `preflight://...` URIs
- **Atomic operations**: Crash-safety with zero orphans
- **Fast deletion**: 100-300x performance improvement
- **Auto-cleanup**: Removes orphan bundles on startup

</details>

## Table of Contents

- [Why Preflight?](#why-preflight)
- [Demo](#demo)
- [Core Features](#core-features)
- [Quick Start](#quick-start)
- [Tools](#tools-21-total)
- [Prompts](#prompts-5-total)
- [Environment Variables](#environment-variables)
- [Contributing](#contributing)

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

## Tools (17 active + 5 deprecated)

### `preflight_list_bundles`
List bundle IDs in storage.
- **Markdown output** (v0.6.0): LLM-friendly structured format
- **Cursor pagination** (v0.5.0): Use `cursor` parameter for large bundle lists
- Triggers: "show bundles", "查看bundle", "有哪些bundle"

### `preflight_get_overview` *(NEW v0.6.0)*
⭐ **START HERE** - Get project overview in one call.
- Returns: OVERVIEW.md + START_HERE.md + AGENTS.md
- Simplest entry point for exploring any bundle
- Triggers: "了解项目", "项目概览", "what is this project", "show overview"

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
Read file(s) from bundle. Multiple modes:
- **Batch mode** (omit `file`): Returns ALL key files (OVERVIEW.md, START_HERE.md, AGENTS.md, manifest.json, deps/dependency-graph.json, repo READMEs) in one call
- **Single file mode** (provide `file`): Returns that specific file
- **Evidence citation**: Use `withLineNumbers: true` to get `N|line` format; use `ranges: ["20-80"]` to read specific lines
- Triggers: "查看bundle", "bundle概览", "项目信息", "show bundle", "读取依赖图"

**NEW in v0.5.3 - Symbol outline & reading:**
- `outline: true`: Returns symbol structure (function/class/method/interface/type/enum) with line ranges
  - Supports: `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.rs`
  - 90%+ token savings for understanding file structure
- `symbol: "name"`: Read a specific symbol by name
  - Format: `"functionName"` or `"ClassName.methodName"`
  - Auto-includes context lines and returns with line numbers

**Example - Outline mode:**
```
[src/server.ts] Outline (15 top-level symbols, typescript):
├── ⚡function startServer(): Promise<void> :174-200
├── ⚡class McpServer :205-400
│   ├── method registerTool :210-250
│   └── method start :380-400
└── ⚡interface Config :45-71
```
(`⚡` = exported)

### `preflight_repo_tree`
Get repository structure overview without wasting tokens on search.
- Returns: ASCII directory tree, file count by extension/directory, entry point candidates
- Default depth: 6 (v0.3.1+, was 4) - shows 2-3 levels under `norm/` directory
- Use BEFORE deep analysis to understand project layout
- Triggers: "show project structure", "what files are in this repo", "项目结构", "文件分布"

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

### `preflight_search_bundle` *(DEPRECATED)*
⚠️ **Use `preflight_search_and_read` instead** with `readContent: false` for index-only searches.

Full-text search across ingested docs/code (line-based SQLite FTS5).

### `preflight_search_by_tags`
Search across multiple bundles filtered by tags (line-based SQLite FTS5).
- **Cursor pagination** (v0.5.0): Use `cursor` parameter for large result sets
- Triggers: "search in MCP bundles", "在MCP项目中搜索", "搜索所有agent"

Notes:
- This tool is read-only and **does not auto-repair**.
- If some bundles fail to search (e.g. missing/corrupt index), they will be reported in `warnings`.

Optional parameters:
- `tags`: Filter bundles by tags (e.g., `["mcp", "agents"]`)
- `scope`: Search scope (`docs`, `code`, or `all`)
- `limit`: Max total hits across all bundles
- `cursor`: Pagination cursor for fetching next page

### `preflight_dependency_graph` *(UNIFIED v0.6.0)*
Get or generate dependency graph for a bundle.
- **Auto-generates** if not cached, returns cached version if available
- `scope: "global"` (default): Project-wide dependency graph
- `scope: "target"` with `targetFile`: Dependencies for a specific file
- `format: "summary"` (default): Top nodes, aggregated by directory
- `format: "full"`: Complete graph data with coverage report
- Triggers: "show dependencies", "看依赖图", "import graph"

### `preflight_evidence_dependency_graph` *(DEPRECATED)*
⚠️ **Use `preflight_dependency_graph` instead** - simpler interface with same functionality.

### `preflight_trace_upsert`
Create or update traceability links (code↔test, code↔doc, file↔requirement).
- **Proactive use**: LLM automatically records discovered relationships during code analysis
- Common link types: `tested_by`, `implements`, `documents`, `relates_to`, `depends_on`
- **Auto-exports** to `trace/trace.json` after each upsert for direct LLM reading

### `preflight_trace_query`
Query traceability links (code↔test, code↔doc, commit↔ticket).
- **Proactive use**: LLM automatically queries trace links when analyzing specific files
- **Cursor pagination** (v0.5.0): Use `cursor` parameter for large result sets
- Returns `reason` and `nextSteps` when no edges found (helps LLM decide next action)
- Fast when `bundleId` is provided; can scan across bundles when omitted.

### `preflight_trace_export` *(DEPRECATED)*
⚠️ trace.json is auto-exported after each `trace_upsert`. Use `preflight_read_file` with `file: "trace/trace.json"` to read.

### `preflight_suggest_traces` *(DEPRECATED)*
⚠️ Use `preflight_deep_analyze_bundle` for test detection, then `preflight_trace_upsert` manually.

### `preflight_deep_analyze_bundle` *(Enhanced v0.6.0)*
One-call deep analysis aggregating tree, search, deps, traces, **overview content**, and **test detection**.
- Returns unified evidence pack with LLM-friendly summary
- **Summary now includes OVERVIEW.md excerpt** (v0.6.0) - one call for complete context
- **Now includes OVERVIEW.md, START_HERE.md, AGENTS.md, README content** (v0.5.1)
- **Auto-detects test frameworks** (jest, vitest, pytest, go, mocha) (v0.5.1)
- **Generates copyable `nextCommands`** for follow-up actions (v0.5.1)
- Auto-generates **claims** with evidence references
- Tracks analysis progress via **checklistStatus**
- Reports unanswered questions as **openQuestions**
- Triggers: "deep analyze", "comprehensive analysis", "深度分析", "快速了解项目"

**New in v0.5.1 - Aggregated content (reduces round-trips):**
- `includeOverview` (default: true): Include OVERVIEW.md, START_HERE.md, AGENTS.md
- `includeReadme` (default: true): Include repo README.md
- `includeTests` (default: true): Detect test directories and frameworks

Output includes:
- `overviewContent`: `{overview, startHere, agents, readme}` - bundle documentation content
- `testInfo`: `{detected, framework, testDirs, testFileCount, configFiles, hint}` - test detection result
- `nextCommands[]`: Copyable tool calls for next steps (can be directly used as arguments)
- `claims[]`: Auto-generated findings with evidence
- `checklistStatus`: Analysis progress (repo_tree, deps, entrypoints, etc.)
- `openQuestions[]`: Questions with `nextEvidenceToFetch` hints
- `summary`: Markdown summary with checklist and key findings

**Example `nextCommands` output:**
```json
[
  { "tool": "preflight_search_bundle", "description": "Search for specific code", "args": { "bundleId": "...", "query": "<填入关键词>" } },
  { "tool": "preflight_read_file", "description": "Read core module", "args": { "bundleId": "...", "file": "src/server.ts" } }
]
```

### `preflight_validate_report` *(NEW v0.4.0)*
Validate claims and evidence chains for auditability.
- Checks: missing evidence, invalid file references, broken snippet hashes
- Returns `passed: boolean` and detailed `issues[]`
- Triggers: "validate claims", "audit report", "验证报告"

Parameters:
- `claims[]`: Claims to validate (with evidence)
- `verifySnippets`: Check SHA256 hashes (default: true)
- `verifyFileExists`: Check evidence files exist (default: true)
- `strictMode`: Treat warnings as errors (default: false)

### `preflight_read_files` *(DEPRECATED)*
⚠️ Use multiple `preflight_read_file` calls, or use `preflight_search_and_read`.

### `preflight_search_and_read` *(Enhanced v0.6.0)*
Search + excerpt in one call - the **primary search tool**.
- Combines search with automatic context extraction
- **`readContent: false`** (v0.6.0): Index-only search (replaces `preflight_search_bundle`)
- **RFC v2 unified envelope**: Returns `ok`, `meta`, `data`, `evidence[]`
- Triggers: "search and show code", "find and read", "搜索并读取"

Parameters:
- `bundleId`: Bundle ID
- `query`: Search query
- `contextLines`: Lines of context around matches (default: 30)
- `readContent`: If false, return metadata only without reading files (default: true)
- `format`: `"json"` (default) or `"text"`


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

## Prompts (5 total)

MCP prompts provide interactive guidance for users. Call these to get usage instructions and example prompts.

### `preflight_menu`
Main menu showing all Preflight features.
- Triggers: "preflight有什么功能", "有什么工具", "what can preflight do", "show menu"

### `preflight_analyze_guide`
Deep analysis guide with step-by-step workflow and copyable prompts.
- Shows: Bundle file structure, recommended analysis flow, example prompts
- Args: `projectPath` (optional)

### `preflight_search_guide`
Search functionality guide.
- Shows: Single bundle search, cross-bundle search by tags, FTS5 syntax tips
- Args: `bundleId` (optional)

### `preflight_manage_guide`
Bundle management operations guide.
- Shows: List, view, update, repair, delete bundle operations

### `preflight_trace_guide`
Traceability links guide.
- Shows: Query and create code↔test, code↔doc relationships
- Args: `bundleId` (optional)

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
- `cursor_invalid` *(v0.5.0)*
- `cursor_expired` *(v0.5.0)*
- `rate_limited` *(v0.5.0)*
- `timeout` *(v0.5.0)*
- `pagination_required` *(v0.5.0)*
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

### Semantic Search (Optional)
Semantic search provides vector-based similarity search using embeddings. **Disabled by default** to maintain zero-dependency design.

- `PREFLIGHT_SEMANTIC_SEARCH`: enable semantic search (default: `false`)
- `PREFLIGHT_EMBEDDING_PROVIDER`: `ollama` (local, default) or `openai` (cloud)
- `PREFLIGHT_OLLAMA_HOST`: Ollama server (default: `http://localhost:11434`)
- `PREFLIGHT_OLLAMA_MODEL`: embedding model (default: `nomic-embed-text`)
- `OPENAI_API_KEY`: required if using OpenAI provider
- `PREFLIGHT_OPENAI_MODEL`: OpenAI model (default: `text-embedding-3-small`)

**Quick start (local, zero cloud dependency):**
```bash
# 1. Install Ollama and pull an embedding model
ollama pull nomic-embed-text

# 2. Enable semantic search
export PREFLIGHT_SEMANTIC_SEARCH=true
```

> **TODO:** Integrate `sqlite-vec` for ANN (Approximate Nearest Neighbor) indexing to improve search performance on large codebases.

## Bundle layout (on disk)

Inside a bundle directory:
- `manifest.json` (includes `fingerprint`, `displayName`, `tags`, and per-repo `source`)
- `START_HERE.md`
- `AGENTS.md`
- `OVERVIEW.md`
- `indexes/search.sqlite3`
- `indexes/semantic.sqlite3` *(optional, when semantic search enabled)*
- `analysis/FACTS.json` (static analysis)
- `deps/dependency-graph.json` (global import graph; generated on demand)
- `trace/trace.sqlite3` (traceability links; created on demand)
- `trace/trace.json` (**NEW**: auto-exported JSON for direct LLM reading)
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
