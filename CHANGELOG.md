# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
