# preflight-mcp

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://opensource.org/licenses/AGPL-3.0)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io/)
[![npm version](https://img.shields.io/npm/v/preflight-mcp)](https://www.npmjs.com/package/preflight-mcp)

> **English** | [中文](./README.zh-CN.md)

**Give your AI assistant deep knowledge of any codebase — in seconds.**

Preflight-MCP creates searchable, indexed knowledge bundles from GitHub repos, so Claude/GPT/Cursor can understand your project structure, find relevant code, and trace dependencies — without copy-pasting or token limits.

## Why Preflight?

| Problem | Preflight Solution |
|---------|-------------------|
| 🤯 AI forgets your codebase context | Persistent, searchable bundles |
| 📋 Copy-pasting code into chat | One command: `"index this repo"` |
| 🔍 AI can't find related files | Full-text search + dependency graph |
| 🧩 Lost in large projects | Auto-generated `START_HERE.md` & `OVERVIEW.md` |
| 🔗 No idea what tests cover what | Trace links: code↔test↔doc |
| 📄 Can't read PDF/Word docs | **NEW** Document parsing with multimodal extraction |
| 🖼️ Images/tables ignored | **NEW** Multimodal content search |

## What's New in v0.7.2

### 🔗 Function-Level Call Graph Analysis
Build and query call graphs for deep code understanding:
- **Multi-language support** — TypeScript, Python, Go, Rust
- **Call hierarchy** — Who calls this function? What does it call?
- **Code extraction** — Extract function with all dependencies
- **Interface summary** — Generate API documentation automatically

### 📄 Document Parsing
Parse complex documents and extract structured content:
- **PDF** — Text, images, tables, equations (OCR supported)
- **Word (.docx)** — Full content extraction with formatting
- **Excel (.xlsx)** — Sheet data as structured tables
- **PowerPoint (.pptx)** — Slide content and embedded media
- **HTML** — Clean text extraction with structure preservation

### 🖼️ Multimodal Content Processing
Extract and index visual content from documents:
- **Images** — Captions, alt-text, extracted text (OCR)
- **Tables** — Structured data with headers and cells
- **Equations** — LaTeX/MathML extraction
- **Diagrams** — Flowcharts, architecture diagrams

### 🧠 Intelligent Tool Router
LLM-friendly tool selection with bilingual keywords:
- Automatic tool recommendation based on task description
- Workflow suggestions for complex tasks
- Chinese/English keyword support

## Demo

```
You: "Create a bundle for the repository facebook/react"

Preflight: ✅ Cloned, indexed 2,847 files, generated overview

You: "Search for 'useState' implementation"

Preflight: 📍 Found 23 matches:
  → packages/react/src/ReactHooks.js:24
  → packages/react-reconciler/src/ReactFiberHooks.js:1042
  ...

You: "Parse the design spec PDF and find all architecture diagrams"

Preflight: 📄 Parsed design-spec.pdf (45 pages)
  → Found 8 diagrams: system architecture, data flow, ...
  → Extracted 12 tables with specifications
```

## Core Features

- 🚀 **One-command indexing** — `"index owner/repo"` creates a complete knowledge bundle
- 🔍 **Full-text search** — SQLite FTS5 search across all code and docs
- 📄 **Document parsing** — PDF, Word, Excel, PowerPoint, HTML support
- 🖼️ **Multimodal search** — Search images, tables, equations by description
- 🧠 **Semantic search** *(optional)* — Vector-based similarity search via Ollama/OpenAI
- 🗺️ **Dependency graph** — Visualize imports and file relationships
- 🔗 **Trace links** — Track code↔test↔doc relationships
- 📖 **Auto-generated guides** — `START_HERE.md`, `AGENTS.md`, `OVERVIEW.md`
- ☁️ **Cloud sync** — Multi-path mirror backup for redundancy
- 🧠 **EDDA (Evidence-Driven Deep Analysis)** — Auto-generate auditable claims with evidence
- ⚡ **22 MCP tools + 6 prompts** — Streamlined toolkit optimized for LLM use
- 🧠 **Intelligent routing** — Auto-suggest tools based on task
- 🔗 **Call graph analysis** — Function-level dependency tracking (v0.7.2)

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
- [What's New in v0.7.2](#whats-new-in-v072)
- [Demo](#demo)
- [Core Features](#core-features)
- [Quick Start](#quick-start)
- [Tools](#tools-25-active)
- [Prompts](#prompts-6-total)
- [Call Graph Analysis](#call-graph-analysis)
- [Document Parsing](#document-parsing)
- [Multimodal Search](#multimodal-search)
- [Environment Variables](#environment-variables)
- [Contributing](#contributing)

## Requirements

- Node.js >= 18
- `git` available on PATH

## Installation

### From npm

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

### 3. Parse Documents

```
"Parse the design document at /path/to/spec.pdf"
```

### 4. Search Multimodal Content

```
"Search for architecture diagrams in the bundle"
```

## Tools (22 active)

### Call Graph Tools (NEW v0.7.2)

#### `preflight_build_call_graph`
Build a function-level call graph for multi-language projects.
- **Languages**: TypeScript, JavaScript, Python, Go, Rust
- Auto-detects project languages
- Triggers: "build call graph", "构建调用图"

#### `preflight_query_call_graph`
Query call relationships for a specific function or method.
- **Directions**: callers, callees, or both
- Find who calls this function and what it calls
- Triggers: "who calls", "查询调用关系"

#### `preflight_extract_code`
Extract a function and its dependencies as self-contained code.
- **Formats**: minimal (signatures), full (code), markdown (documented)
- Include transitive dependencies
- Triggers: "extract function", "提取代码"

#### `preflight_interface_summary`
Generate interface summary for a file or project.
- Lists all exported functions/classes
- Includes signatures and documentation
- Triggers: "interface summary", "接口文档"

### Document & Multimodal Tools

#### `preflight_parse_document`
Parse PDF, Word, Excel, PowerPoint, or HTML documents.
- Extracts text, images, tables, equations
- Supports OCR for scanned documents
- Output formats: markdown, json, text
- Triggers: "parse document", "解析文档", "read PDF"

#### `preflight_search_modal`
Search multimodal content (images, tables, equations) in bundles.
- Full-text search on descriptions
- Filter by content type
- Keyword-based filtering
- Triggers: "search images", "找图片", "search tables"

#### `preflight_analyze_modal`
Analyze and process multimodal content in a bundle.
- Image captioning and OCR
- Table structure extraction
- Equation parsing
- Triggers: "analyze images", "分析表格"

### Core Bundle Tools

#### `preflight_list_bundles`
List bundle IDs in storage.
- **Markdown output**: LLM-friendly structured format
- **Cursor pagination**: Use `cursor` parameter for large bundle lists
- Triggers: "show bundles", "查看bundle", "有哪些bundle"

#### `preflight_get_overview`
⭐ **START HERE** - Get project overview in one call.
- Returns: OVERVIEW.md + START_HERE.md + AGENTS.md
- Simplest entry point for exploring any bundle
- Triggers: "了解项目", "项目概览", "what is this project"

#### `preflight_create_bundle`
Create a new bundle from GitHub repos or local directories.
- De-dup by default with `ifExists` control
- Git clone with archive fallback
- Triggers: "index this repo", "学习这个项目", "创建bundle"

#### `preflight_read_file`
Read file(s) from bundle with symbol outline support.
- Batch mode: Returns all key files in one call
- Symbol outline: 90%+ token savings for file structure
- Triggers: "查看bundle", "读取文件"

#### `preflight_repo_tree`
Get repository structure overview.
- ASCII directory tree
- File count by extension
- Entry point candidates
- Triggers: "project structure", "项目结构"

#### `preflight_search_and_read`
Search + excerpt in one call - the **primary search tool**.
- RFC v2 unified envelope: `ok`, `meta`, `data`, `evidence[]`
- Triggers: "search and show code", "搜索并读取"

#### `preflight_search_by_tags`
Search across multiple bundles filtered by tags.
- Cursor pagination for large result sets
- Triggers: "search in MCP bundles", "搜索所有agent"

#### `preflight_dependency_graph`
Get or generate dependency graph for a bundle.
- Global or target-file scope
- Summary or full format
- Triggers: "show dependencies", "看依赖图"

#### `preflight_deep_analyze_bundle`
One-call deep analysis with test detection.
- Returns unified evidence pack
- Auto-generates claims with evidence
- Triggers: "deep analyze", "深度分析"

#### `preflight_trace_upsert` / `preflight_trace_query`
Create and query traceability links (code↔test↔doc).
- Auto-exports to `trace/trace.json`
- Triggers: "trace links", "追溯链接"

#### `preflight_update_bundle` / `preflight_repair_bundle` / `preflight_delete_bundle`
Bundle lifecycle management tools.

#### `preflight_validate_report`
Validate claims and evidence chains for auditability.

#### `preflight_cleanup_orphans`
Remove incomplete or corrupted bundles.

#### `preflight_get_task_status`
Check status of bundle creation/update tasks.

## Prompts (6 total)

### `preflight_router` (NEW v0.7.0)
Intelligent tool selection guide.
- Auto-recommend tools based on task description
- Workflow suggestions
- Triggers: "which tool should I use", "推荐工具"

### `preflight_menu`
Main menu showing all Preflight features.
- Triggers: "preflight有什么功能", "what can preflight do"

### `preflight_analyze_guide`
Deep analysis guide with step-by-step workflow.

### `preflight_search_guide`
Search functionality guide with FTS5 syntax tips.

### `preflight_manage_guide`
Bundle management operations guide.

### `preflight_trace_guide`
Traceability links guide.

## Call Graph Analysis

### Supported Languages

| Language | Adapter | Features |
|----------|---------|----------|
| TypeScript/JS | TS Language Service | Full type info, references, definitions |
| Python | tree-sitter | Functions, classes, decorators, docstrings |
| Go | tree-sitter | Functions, interfaces, methods, Go doc |
| Rust | tree-sitter | fn, impl, traits, structs, enums, macros |

### Usage Examples

```
"Build a call graph for /path/to/project"
"Who calls the processData function?"
"Extract the handleRequest function with all dependencies"
"Generate interface summary for src/api/"
```

### Output Formats

- **Query results**: Caller/callee relationships with file locations
- **Code extraction**: Self-contained code with dependencies
- **Interface summary**: API documentation in markdown

## Document Parsing

### Supported Formats

| Format | Extension | Features |
|--------|-----------|----------|
| PDF | `.pdf` | Text, images, tables, equations, OCR |
| Word | `.docx` | Full text, formatting, embedded media |
| Excel | `.xlsx` | All sheets as structured tables |
| PowerPoint | `.pptx` | Slides, speaker notes, media |
| HTML | `.html` | Clean text, structure preservation |
| Markdown | `.md` | Native support |
| Text | `.txt` | Plain text |

### Usage

```
"Parse /path/to/document.pdf and extract all tables"
```

Response includes:
- Full text content in markdown format
- Extracted images with metadata
- Tables as structured data
- Equations in LaTeX format

## Multimodal Search

### Search by Content Type

```
"Search for all architecture diagrams in bundle xyz"
"Find tables containing 'API endpoints'"
"Search equations related to 'gradient descent'"
```

### Filter Options

- `scope`: `all`, `image`, `table`, `equation`, `diagram`
- `keywords`: Filter by specific keywords
- `limit`: Max results (default: 20)

## Environment Variables

### Storage
- `PREFLIGHT_STORAGE_DIR`: bundle storage dir (default: `~/.preflight-mcp/bundles`)
- `PREFLIGHT_STORAGE_DIRS`: multi-path mirror backup (semicolon-separated)
- `PREFLIGHT_TMP_DIR`: temp checkout dir
- `PREFLIGHT_MAX_FILE_BYTES`: max bytes per file (default: 512 KiB)
- `PREFLIGHT_MAX_TOTAL_BYTES`: max bytes per repo ingest (default: 50 MiB)

### Analysis & Evidence
- `PREFLIGHT_ANALYSIS_MODE`: `none` | `quick` | `full` (default: `full`)
- `PREFLIGHT_AST_ENGINE`: `wasm` (default) or `native`

### Built-in HTTP API
- `PREFLIGHT_HTTP_ENABLED`: enable/disable REST API (default: true)
- `PREFLIGHT_HTTP_HOST`: REST listen host (default: 127.0.0.1)
- `PREFLIGHT_HTTP_PORT`: REST listen port (default: 37123)

### GitHub & Context7
- `GITHUB_TOKEN`: optional; used for GitHub API/auth
- `PREFLIGHT_GIT_CLONE_TIMEOUT_MS`: max git clone time (default: 5 minutes)
- `CONTEXT7_API_KEY`: optional; enables higher Context7 limits

### Semantic Search (Optional)
- `PREFLIGHT_SEMANTIC_SEARCH`: enable semantic search (default: `false`)
- `PREFLIGHT_EMBEDDING_PROVIDER`: `ollama` (local) or `openai` (cloud)
- `PREFLIGHT_OLLAMA_HOST`: Ollama server (default: `http://localhost:11434`)
- `PREFLIGHT_OLLAMA_MODEL`: embedding model (default: `nomic-embed-text`)
- `OPENAI_API_KEY`: required if using OpenAI provider

## Bundle Layout

Inside a bundle directory:
- `manifest.json` — Bundle metadata and fingerprint
- `START_HERE.md` — Quick start guide
- `AGENTS.md` — Agent-specific instructions
- `OVERVIEW.md` — Project overview
- `indexes/search.sqlite3` — Full-text search index
- `indexes/modal.sqlite3` — Multimodal content index (v0.7.0)
- `analysis/FACTS.json` — Static analysis results
- `deps/dependency-graph.json` — Import graph
- `trace/trace.sqlite3` — Traceability links
- `repos/<owner>/<repo>/norm/...` — Normalized source files

## Multi-device Sync

### Single Path
```bash
export PREFLIGHT_STORAGE_DIR="$HOME/Dropbox/preflight-bundles"
```

### Multi-path Mirror
```bash
export PREFLIGHT_STORAGE_DIRS="$HOME/OneDrive/preflight;$HOME/Dropbox/preflight"
```

## Contributing

We welcome contributions! Please see our [Contributing Guide](./CONTRIBUTING.md) for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/jonnyhoo/preflight-mcp/issues)
- **Discussions**: [GitHub Discussions](https://github.com/jonnyhoo/preflight-mcp/discussions)

## License

This project is licensed under the AGPL-3.0 License - see the [LICENSE](./LICENSE) file for details.

---

Made with ❤️ for the AI developer community
