# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.4] - 2025-12-28

### Added
- **Smart Auto-Focus Tree View**: `preflight_repo_tree` now automatically focuses to `repos/{source}/{repo}/norm/` for single-repo bundles
  - Eliminates the "empty tree" problem where deep bundle structure consumed all depth budget
  - Shows `📍 Auto-focused to: {path}` indicator when active
  - Can be disabled with `autoFocusSingleRepo: false`
- **Consistency Warning in Deep Analyze**: When file tree count differs significantly from dependency graph module count (>50% discrepancy), shows warning: `⚠️ File tree truncated due to depth limit`
- **Enhanced Trace Discovery**: When tests detected but no trace links exist, `preflight_deep_analyze_bundle` now suggests both `preflight_suggest_traces` and `preflight_trace_upsert` workflow

### Changed
- `RepoTreeResult` type now includes `autoFocused?: { enabled: boolean; path?: string }` field
- Improved user guidance when tree/dependency data appears inconsistent

## [0.5.3] - 2025-12-28

### Added
- **Symbol outline extraction**: `preflight_read_file` now supports `outline: true` parameter
  - Returns function/class/method/interface/type/enum with line ranges
  - Supports TypeScript, JavaScript, TSX, Python, Go, and Rust
  - Dramatically reduces token consumption for understanding file structure
- **Symbol-based reading**: `preflight_read_file` now supports `symbol: "name"` parameter
  - Directly read a specific function/class/method by name
  - Supports `"ClassName.methodName"` format for class methods
  - Auto-includes 2 lines of context before the symbol
- **Tree-sitter AST parsing** for outline extraction:
  - TypeScript/JavaScript: function, class, method, interface, type, enum, arrow functions
  - Python: function, class, methods, respects `__all__` for exports
  - Go: func, method, struct (as class), interface, type declarations
  - Rust: fn, struct, enum, trait, type, impl blocks with methods, `pub` visibility detection

### Changed
- **Token efficiency**: Large file analysis now possible with 90%+ token savings using outline mode
- **API simplification**: Single `preflight_read_file` tool handles content, outline, and symbol reading

### Technical Details
- New exports from `src/ast/treeSitter.ts`: `SymbolKind`, `SymbolOutline`, `extractOutlineWasm()`
- New test file: `tests/ast/outline.test.ts` (9 test cases)

## [0.5.0] - 2025-12-26

### Added
- **RFC v2: LLM-first Architecture Rewrite**
  - **New tools**: `preflight_read_files` (batch file reading) and `preflight_search_and_read` (search + excerpt)
  - **Cursor pagination**: `preflight_list_bundles`, `preflight_search_bundle`, `preflight_search_by_tags`, `preflight_trace_query` now support cursor-based pagination
  - **Evidence-first design**: `preflight_repo_tree`, `preflight_evidence_dependency_graph`, `preflight_deep_analyze_bundle` now return `evidence[]` arrays
  - **Unified response envelope**: New infrastructure in `src/mcp/envelope.ts` and `src/mcp/responseBuilder.ts`
  - **Path redaction**: `src/mcp/pathRedaction.ts` for sanitizing sensitive paths in responses
  - **Extended error codes**: Added `cursor_invalid`, `cursor_expired`, `cursor_tool_mismatch`, `rate_limited`, `timeout`, `pagination_required`, `validation_error`, `partial_success`

### Changed
- **Safety defaults**: `preflight_trace_upsert` now defaults to `dryRun=true` to prevent accidental writes
- **Tool count**: 22 tools total (added 2 new aggregation tools)
- **Schema version**: Introduced `SCHEMA_VERSION = '2.0'` for RFC v2 responses

### Technical Details
- New files: `src/mcp/envelope.ts`, `src/mcp/responseBuilder.ts`, `src/mcp/cursor.ts`, `src/mcp/pathRedaction.ts`
- New tools: `src/tools/readFiles.ts`, `src/tools/searchAndRead.ts`
- Extended: `src/mcp/responseMeta.ts`, `src/mcp/errorKinds.ts`
- Upgraded MCP SDK to 0.5.0 (peer dependency)

## [0.2.5] - 2025-12-26

### Added
- **New MCP tool**: `preflight_repo_tree` - Get repository structure overview with ASCII tree, file statistics, and entry point candidates
- **New MCP tool**: `preflight_trace_export` - Manually export trace links to JSON (auto-export already happens on trace_upsert)
- **Evidence citation support**: `preflight_read_file` now supports `withLineNumbers: true` and `ranges: ["20-80"]` for precise evidence gathering
- **Coverage report**: `preflight_evidence_dependency_graph` (global mode) returns `coverageReport` explaining what was analyzed and skipped
- **Trace query guidance**: `preflight_trace_query` returns `reason` and `nextSteps` when no edges found
- **Large file handling**: Configurable `maxFileSizeBytes`, `largeFileStrategy`, `truncateLines` options for dependency graph

### Changed
- **Tool count**: 15 tools total (added `preflight_repo_tree`, `preflight_trace_export`)
- **Tool descriptions**: Enhanced LLM guidance for all tools with recommended workflows
- **Trace writing rules**: `preflight_trace_upsert` description now includes clear rules for when to write trace links

### Fixed
- Trace query now provides actionable guidance when no matching edges found

## [0.1.5] - 2025-12-24

### Added
- **User-facing warnings**: Bundle creation now returns `warnings` array when network issues occur
- **Git→ZIP fallback feedback**: Clear notification when git clone fails and ZIP download is used
- **Repair unfixable issues**: `preflight_repair_bundle` now reports issues it cannot fix (e.g., empty repos/)

### Changed
- **Bundle creation response**: Now shows detailed warnings about network fallbacks instead of just JSON
- **Repair response**: Clearly distinguishes "nothing to repair" from "cannot repair offline"
- **Error messages**: Both git and ZIP failures now show actionable suggestions

### Fixed
- **BUNDLE_IN_PROGRESS schema error**: Fixed `repos` field type conflict in in-progress response (renamed to `requestedRepos`)
- **Temp file cleanup**: Better cleanup of temp checkouts directory after bundle creation (success or failure)
- **Misleading repair messages**: Repair no longer says "OK" when repos/ is empty and unfixable

## [0.1.4] - 2025-12-24

### Added
- **Progress tracking**: Real-time progress reporting for `preflight_create_bundle` and `preflight_update_bundle`
- **New MCP tool**: `preflight_get_task_status` - Check progress of bundle creation/update tasks
- **In-progress lock mechanism**: Prevents duplicate bundle creation during MCP timeouts
- **Bundle integrity check**: `assertBundleComplete()` validates bundle completeness before operations
- **Global dependency graph mode**: Omit `target` parameter in `preflight_evidence_dependency_graph` to generate project-wide import graph
- **Batch file reading**: Omit `file` parameter in `preflight_read_file` to read all key files in one call

### Changed
- **`preflight_read_file`**: Now supports batch mode (omit `file` to get all key files)
- **`preflight_evidence_dependency_graph`**: Now supports global mode (omit `target` for project-wide graph)
- **Error messages**: Improved guidance when target file not found (distinguishes path format errors vs incomplete bundles)
- **Tools count**: 13 tools (merged `preflight_read_bundle_overview` into `preflight_read_file`)

### Fixed
- Duplicate bundle creation when MCP client times out but server continues working
- Operations on incomplete bundles now fail early with helpful error messages
- LLM repeatedly trying to fix path errors now gets clear guidance

## [0.1.3] - 2025-12-23

### Added
- **New MCP tools**:
  - `preflight_evidence_dependency_graph` - Deterministic evidence-based dependency graph (imports + callers)
  - `preflight_trace_upsert` / `preflight_trace_query` - Per-bundle traceability links (SQLite)

### Changed
- **Tools Count**: Reduced from 16 to 12 total tools (streamlined API)
- **`preflight_read_file`**: Now supports reading `manifest.json` for bundle details (replaces `preflight_bundle_info`)
- **`preflight_create_bundle`**: Added LLM prompts suggesting `preflight_evidence_dependency_graph` and `preflight_trace_upsert` for code repos

### Removed
- **`preflight_bundle_info`**: Merged into `preflight_read_file` (use `file="manifest.json"`)
- **`preflight_find_bundle`**: Use `preflight_create_bundle` with `ifExists="returnExisting"` instead
- **`preflight_update_all_bundles`**: Removed (batch updates can be done via individual `preflight_update_bundle` calls)
- **`preflight_verify_claim`**: Removed (use `preflight_search_bundle` + LLM analysis instead)
- **DeepWiki support**: Completely removed (repos.kind: "deepwiki" no longer supported)
- Removed ad-hoc test utility scripts that were not part of npm scripts

## [0.1.2] - 2025-12-20

### Added
- **New MCP Tool**: `preflight_cleanup_orphans` - Manual cleanup of orphan bundles with dry-run mode
- **Atomic Bundle Creation**: Temporary directory + atomic rename pattern for crash-safety
- **Auto-Cleanup on Startup**: Automatic orphan bundle cleanup on MCP server startup
- **UUID Validation**: Strict filtering by UUID v4 format in list and cleanup operations
- **Technical Documentation**:
  - `ISSUES_ANALYSIS.md` - Root cause analysis of bundle lifecycle issues
  - `IMPLEMENTATION_SUMMARY.md` - Detailed implementation of architecture improvements
  - `CLEANUP_STRATEGY.md` - MCP-specific cleanup design principles

### Changed
- **Bundle Creation**: Now uses temporary directory (`tmpDir/bundles-wip/`) with atomic move to final location
- **Bundle Deletion**: 100-300x performance improvement using rename + background deletion pattern
- **List Operation**: Now filters out non-UUID directories (`#recycle`, `tmp`, `.deleting`)
- **Tools Count**: Updated from 12 to 13 total tools

### Fixed
- **Cross-filesystem Support**: Added fallback to copy+delete when rename fails (EXDEV error)
- **Orphan Bundle Prevention**: Zero orphan bundles through atomic creation
- **Delete Timeout**: No longer blocks on large bundle deletion
- **Crash Safety**: Temp directories automatically cleaned up on server restart

### Performance
- **Delete Operation**: <100ms response time (previously 10-30 seconds)
- **Startup Overhead**: <10ms when no orphans present
- **Creation Safety**: No orphan bundles on any failure scenario

### Technical Details
- Added `src/bundle/cleanup.ts` for centralized cleanup logic
- Modified `src/bundle/service.ts` for atomic creation and fast deletion
- Modified `src/server.ts` for startup cleanup integration
- Removed obsolete test scripts used during development

## [0.1.1] - 2025-12-19

### Added
- **New MCP tools**:
  - `preflight_find_bundle`: Check whether a bundle exists for given inputs (no fetching)
  - `preflight_repair_bundle`: Offline repair for missing/empty derived artifacts
- **Custom Error Types** (`src/errors.ts`): Structured error handling with error codes and context
- **Centralized Utils** (`src/utils/index.ts`): Common utility functions to reduce code duplication
- **Differentiated Claim Verification**: `verify_claim` tool now provides:
  - Evidence classification (supporting/contradicting/related)
  - Confidence scoring (0-1 with labels: high/medium/low/none)
  - Human-readable verification summary
- **Unit Tests**: Added comprehensive tests for `sqliteFts.ts` search functions
- **Configuration Externalization**: Previously hardcoded values now configurable via environment variables:
  - `PREFLIGHT_MAX_CONTEXT7_LIBRARIES`
  - `PREFLIGHT_MAX_FTS_QUERY_TOKENS`
  - `PREFLIGHT_DEFAULT_MAX_AGE_HOURS`
  - And more...

### Changed
- **S3StorageAdapter**: Marked as experimental/unimplemented with clear TODO notes
- **All comments**: Translated from Chinese to English for consistency
- **Documentation**: Consolidated multiple scattered docs into standard GitHub structure

### Fixed
- npm package now includes the full tool set (12 tools) in published `dist/`.
- Empty catch blocks now properly logged instead of silently ignored

## [0.1.0] - 2024-12-18

### Added
- **10 MCP Tools** for bundle management:
  - `preflight_list_bundles`: List all bundles with metadata
  - `preflight_create_bundle`: Create from GitHub repos or DeepWiki
  - `preflight_read_file`: Read bundle files (OVERVIEW.md, START_HERE.md, etc.)
  - `preflight_bundle_info`: Get bundle details and stats
  - `preflight_delete_bundle`: Remove bundles permanently
  - `preflight_update_bundle`: Refresh with latest repo changes
  - `preflight_update_all_bundles`: Batch update all bundles
  - `preflight_search_bundle`: Full-text search in single bundle
  - `preflight_search_by_tags`: Cross-bundle search filtered by tags
  - `preflight_verify_claim`: Find evidence for claims

- **Multi-path Mirror Backup**: `PREFLIGHT_STORAGE_DIRS` for redundant cloud storage
- **Resilient Storage**: Auto-failover when mount points become unavailable
- **Auto-tagging System**: Intelligent tag detection based on:
  - Repository name patterns (mcp, agent, scraper, etc.)
  - Framework detection (React, Express, Puppeteer, etc.)
  - File patterns (Dockerfile, GitHub Actions, etc.)
- **Bundle Validation**: Automatic completeness verification after creation
- **Failed Bundle Cleanup**: Automatic cleanup when creation fails
- **SQLite FTS5 Search**: Line-based full-text search index
- **Static Analysis**: `analysis/FACTS.json` generation (non-LLM)
- **Agent-facing Entry Files**: START_HERE.md, AGENTS.md, OVERVIEW.md

### Technical Details
- TypeScript with strict mode enabled
- ESM modules with Node.js >= 18
- SQLite via better-sqlite3 for FTS5 support
- Zod for runtime schema validation
- MCP SDK for protocol compliance

## Architecture

```
src/
├── bundle/          # Bundle creation, ingestion, analysis
├── context7/        # Context7 library integration
├── core/            # Task scheduler
├── jobs/            # Automated jobs (cleanup, health check)
├── logging/         # Structured logging system
├── mcp/             # MCP URI handling
├── search/          # SQLite FTS5 search
├── server/          # MCP server setup
├── storage/         # Storage adapters
├── utils/           # Common utilities
├── errors.ts        # Custom error types
├── config.ts        # Configuration management
├── index.ts         # Entry point
└── server.ts        # Main server with tool definitions
```

## Deployment Options

- **Local**: `node dist/index.js` with stdio transport
- **Docker**: See `Dockerfile` and `docker-compose.yml`
- **Kubernetes**: See `k8s-deployment.yaml`

For detailed deployment instructions, see [README.md](./README.md).
