# preflight-mcp

[English](#english) | [中文](#中文)

---

# English

## What is Preflight MCP?

Preflight MCP is a Model Context Protocol (MCP) server that transforms codebases, documents, and papers into persistent, searchable bundles for LLM agents. It returns citation-ready evidence with line numbers.

### Highlights
- Sources: GitHub repos, local directories, PDF/DOCX/HTML
- Paper + Code Pairing: search both sides jointly
- Static Analysis: design patterns, architecture, test examples, configs, doc-code conflicts
- Hybrid Search: SQLite FTS5 + optional semantic search
- LSP: code intelligence for Python/Go/Rust/TypeScript
- Incremental indexing: re-index only changed files

## Architecture

```
MCP Server (resources + tools) → Bundle System (ingest, analyzers, search)
```

- Ingest: repository/doc ingestion and normalization
- Analyzers: GoF patterns, architectural, test examples, config, conflicts
- Search: FTS (always) + Semantic (optional)
- LSP: external language servers (optional)

## Tools
- Bundle: create_bundle, list_bundles, delete_bundle
- Reading: get_overview, read_file, repo_tree, search_and_read
- Code intel: lsp (if enabled)
- Code quality: preflight_check (unified: duplicates, doccheck, deadcode, circular dependencies, complexity)

## Quick Start

Add to your MCP client config:
```json
{
  "mcpServers": {
    "preflight": {
      "command": "npx",
      "args": ["preflight-mcp"],
      "env": {
        "PREFLIGHT_LSP_ENABLED": "true",
        "PREFLIGHT_SEMANTIC_SEARCH": "true"
      }
    }
  }
}
```

## Usage: Standard Workflow

1. **Create bundle**: `preflight_create_bundle` with GitHub repo or local path
2. **Get overview**: `preflight_get_overview` to understand project structure
3. **Search**: `preflight_search_and_read` to find specific code/docs
4. **Navigate**: `preflight_lsp` for precise code navigation (definitions, references)

### Examples
- Create bundle from local repo:
```json
{ "repos": [{ "kind": "local", "repo": "myorg/myproj", "path": "C:\\code\\myproj" }] }
```
- Create bundle from GitHub:
```json
{ "repos": [{ "kind": "github", "repo": "owner/repo" }] }
```

### Analysis Files
Bundles include static analysis results in `analysis/` directory:
- `gof-patterns.json` - GoF design patterns
- `architectural.json` - architecture patterns
- `test-examples.json` - extracted test examples
- `config.json` - configuration analysis
- `doc-conflicts.json` - documentation inconsistencies

## Bundle Layout
```
OVERVIEW.md, START_HERE.md, AGENTS.md
analysis/{gof-patterns.json, architectural.json, test-examples.json, config.json, doc-conflicts.json, SUMMARY.json}
search.db, manifest.json, repos/*
```

## VLM Distillation (Experimental)

Extract structured content (formulas, tables, code) from PDFs using Vision-Language Models.

### Setup
Create `~/.preflight/config.json`:
```json
{
  "vlmApiBase": "https://your-vlm-api/v1",
  "vlmApiKey": "your-api-key",
  "vlmModel": "qwen3-vl-plus",
  "vlmEnabled": true
}
```

### Usage
```bash
# Extract from specific page
npx tsx scripts/vlm-extract.ts paper.pdf --page 6

# Extract from page range
npx tsx scripts/vlm-extract.ts paper.pdf --start 5 --end 10

# Save to file
npx tsx scripts/vlm-extract.ts paper.pdf --page 6 --output tables.md
```

### Options
- `--page <n>` - Extract from specific page
- `--start/--end <n>` - Page range
- `--describe` - Ask VLM to describe page content first
- `--no-formulas/--no-tables/--no-code` - Skip specific content types
- `--force-all` - Extract from all pages (skip smart detection)

### Programmatic API
```typescript
import { extractFromPDF, formatAsMarkdown } from './src/distill/vlm-extractor.js';

const result = await extractFromPDF('paper.pdf', {
  startPage: 6,
  endPage: 6,
  extractTables: true,
});

console.log(formatAsMarkdown(result));
```

## Configuration

Environment variables (common):
- PREFLIGHT_STORAGE_DIR, PREFLIGHT_STORAGE_DIRS
- PREFLIGHT_ANALYSIS_MODE=none|quick|full
- PREFLIGHT_MAX_FILE_BYTES (default 512KB)
- PREFLIGHT_MAX_TOTAL_BYTES (default 50MB)

Semantic search:
- PREFLIGHT_SEMANTIC_SEARCH=true
- PREFLIGHT_EMBEDDING_PROVIDER=ollama|openai
- PREFLIGHT_OLLAMA_HOST, PREFLIGHT_OLLAMA_MODEL
- PREFLIGHT_OPENAI_API_KEY, PREFLIGHT_OPENAI_MODEL, PREFLIGHT_OPENAI_BASE_URL (optional)

LSP:
- PREFLIGHT_LSP_ENABLED=true
- Commands: pyright-langserver | gopls | rust-analyzer

HTTP API:
- PREFLIGHT_HTTP_ENABLED=true, PREFLIGHT_HTTP_PORT=37123

## Development
```
npm install
npm run typecheck
npm run build
npm test
npm run smoke
```

## Deployment Examples

### Claude Desktop
```json
{
  "mcpServers": {
    "preflight": {
      "command": "node",
      "args": ["path/to/preflight-mcp/dist/index.js"],
      "env": {
        "PREFLIGHT_STORAGE_DIR": "~/.preflight-mcp/bundles"
      }
    }
  }
}
```

### Cursor
```json
{
  "mcp": {
    "servers": {
      "preflight": {
        "command": "node",
        "args": ["path/to/preflight-mcp/dist/index.js"]
      }
    }
  }
}
```

### Docker
```bash
docker run -e PREFLIGHT_STORAGE_DIR=/bundles -v /host/bundles:/bundles preflight-mcp
```

### Kubernetes
See `k8s-deployment.yaml` and `docker-compose.yml` in repo.

## License
AGPL-3.0

---

# 中文

## 简介
Preflight MCP 是一个 MCP 服务器，把代码仓库、文档和论文转换为可搜索的 bundle，返回带行号的可引用证据。

### 特性
- 多源支持：GitHub、本地目录、PDF/DOCX/HTML
- 论文+代码配对检索
- 静态分析：设计模式、架构、测试示例、配置、文档冲突
- 混合检索：FTS + 语义搜索（可选）
- LSP：Python/Go/Rust/TypeScript 代码智能
- 增量索引：只重建变更文件

## 架构与工具
- 工具：create/list/delete bundle，get_overview/read_file/repo_tree/search_and_read，lsp，preflight_check（统一代码质量检查：重复代码、文档一致性、死代码、循环依赖、复杂度）

## 快速开始
```json
{
  "mcpServers": { "preflight": { "command": "npx", "args": ["preflight-mcp"] } }
}
```

## 标准工作流
1. `preflight_create_bundle` → 创建 bundle
2. `preflight_get_overview` → 了解项目结构
3. `preflight_search_and_read` → 搜索代码/文档
4. `preflight_lsp` → 精确导航（定义、引用等）

## 分析文件
Bundle 包含 `analysis/` 目录下的静态分析结果：
- `gof-patterns.json` - 设计模式
- `architectural.json` - 架构模式
- `test-examples.json` - 测试示例
- `config.json` - 配置分析
- `doc-conflicts.json` - 文档冲突

## VLM 知识蒸馏（实验功能）

使用视觉语言模型从 PDF 中提取结构化内容（公式、表格、代码）。

### 配置
创建 `~/.preflight/config.json`：
```json
{
  "vlmApiBase": "https://your-vlm-api/v1",
  "vlmApiKey": "your-api-key",
  "vlmModel": "qwen3-vl-plus",
  "vlmEnabled": true
}
```

### 用法
```bash
# 提取指定页
npx tsx scripts/vlm-extract.ts paper.pdf --page 6

# 提取页面范围
npx tsx scripts/vlm-extract.ts paper.pdf --start 5 --end 10

# 保存到文件
npx tsx scripts/vlm-extract.ts paper.pdf --page 6 --output tables.md
```

### 选项
- `--page <n>` - 提取特定页面
- `--start/--end <n>` - 页面范围
- `--describe` - 先让 VLM 描述页面内容
- `--no-formulas/--no-tables/--no-code` - 跳过特定内容类型
- `--force-all` - 提取所有页面（跳过智能检测）

### 编程接口
```typescript
import { extractFromPDF, formatAsMarkdown } from './src/distill/vlm-extractor.js';

const result = await extractFromPDF('paper.pdf', {
  startPage: 6,
  endPage: 6,
  extractTables: true,
});

console.log(formatAsMarkdown(result));
```

## 配置
- 基本：`PREFLIGHT_STORAGE_DIR(S)`、`PREFLIGHT_ANALYSIS_MODE`
- 语义：`PREFLIGHT_SEMANTIC_SEARCH`、嵌入提供商与模型
- LSP：`PREFLIGHT_LSP_ENABLED` 与语言服务器
- HTTP：`PREFLIGHT_HTTP_ENABLED`, `PREFLIGHT_HTTP_PORT`

## 开发
```
npm install && npm run typecheck && npm run build && npm test
```

## 许可证
AGPL-3.0
