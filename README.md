# Preflight MCP

An MCP server that transforms codebases, documents, and papers into searchable bundles for LLM agents.

## Features

- **Multi-source Ingestion**: GitHub repos, local directories, PDFs, Office documents, web documentation sites
- **Hybrid Search**: SQLite FTS5 full-text search + optional semantic vector search
- **Static Analysis**: Design patterns, architecture detection, test examples, config analysis
- **Code Intelligence**: LSP integration for Python/Go/Rust/TypeScript (definitions, references, hover)
- **Code Quality**: Unified checks for duplicates, dead code, circular deps, complexity, security
- **RAG Support**: ChromaDB integration for knowledge retrieval with cross-validation
- **ArXiv Integration**: Search and download academic papers with translation support
- **Memory System**: 3-layer long-term memory (episodic, semantic, procedural) with garbage collection
- **Knowledge Distillation**: Extract and summarize project knowledge cards
- **PDF Intelligence**: MinerU/VLM integration for high-quality PDF parsing and formula/table extraction

## Quick Start

Add to your MCP client config:

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

## Standard Workflow

```
1. preflight_create_bundle   → Create bundle from source
2. preflight_get_overview    → Understand project structure
3. preflight_search_and_read → Find specific code/docs
4. preflight_lsp             → Navigate code (definitions, references) (requires LSP enabled)
5. preflight_check           → Check code quality
```

## Tools Reference

**工具数量：**
- 默认配置（未启用LSP和Memory）：**16个工具**
- 完整配置（启用LSP和Memory）：**18个工具**

### Bundle Management (9)

| Tool | Description |
|------|-------------|
| `preflight_create_bundle` | Create bundle from GitHub, local path, web docs, or PDF |
| `preflight_list_bundles` | List all available bundles |
| `preflight_delete_bundle` | Delete a bundle |
| `preflight_get_overview` | ⭐ Get project overview (START HERE) |
| `preflight_read_file` | Read specific file from bundle |
| `preflight_repo_tree` | View directory structure |
| `preflight_update_bundle` | Update existing bundle from source |
| `preflight_cleanup_orphans` | Clean up orphaned files from storage |
| `preflight_get_task_status` | Get status of async bundle operations |

### Search (1)

| Tool | Description |
|------|-------------|
| `preflight_search_and_read` | Full-text search with context |

### Code Intelligence (2)

| Tool | Description |
|------|-------------|
| `preflight_lsp` | Go-to-definition, find references, hover, symbols (requires `PREFLIGHT_LSP_ENABLED=true`) |
| `preflight_check` | Code quality checks (duplicates, deadcode, circular, complexity, security) |

### Knowledge Distillation (3)

| Tool | Description |
|------|-------------|
| `preflight_generate_card` | Extract knowledge card from bundle (requires LLM config) |
| `preflight_rag` | Index to ChromaDB and RAG query, supports cross-validation (requires ChromaDB + embedding config) |
| `preflight_rag_manage` | Manage ChromaDB: list indexed content, stats, delete by hash or delete all |

### Memory System (1)

| Tool | Description |
|------|-------------|
| `preflight_memory` | Manage 3-layer long-term memory system (episodic, semantic, procedural) (requires `PREFLIGHT_MEMORY_ENABLED=true`) |

### ArXiv (2)

| Tool | Description |
|------|-------------|
| `preflight_arxiv_search` | Search arXiv papers by preset, query, or ID with translation support |
| `preflight_arxiv_download` | Download arXiv papers as PDF files to local directory |
|------|-------------|
| `preflight_create_bundle` | Create bundle from GitHub, local path, web docs, or PDF |
| `preflight_list_bundles` | List all available bundles |
| `preflight_delete_bundle` | Delete a bundle |
| `preflight_get_overview` | ⭐ Get project overview (START HERE) |
| `preflight_read_file` | Read specific file from bundle |
| `preflight_repo_tree` | View directory structure |
| `preflight_update_bundle` | Update existing bundle from source |
| `preflight_cleanup_orphans` | Clean up orphaned files from storage |
| `preflight_get_task_status` | Get status of async bundle operations |

### Search (1)
| Tool | Description |
|------|-------------|
| `preflight_search_and_read` | Full-text search with context |

### Code Intelligence (2)
| Tool | Description |
|------|-------------|
| `preflight_lsp` | Go-to-definition, find references, hover, symbols (requires `PREFLIGHT_LSP_ENABLED=true`) |
| `preflight_check` | Code quality checks (duplicates, deadcode, circular, complexity, security) |

### Knowledge Distillation (3)
| Tool | Description |
|------|-------------|
| `preflight_generate_card` | Extract knowledge card from bundle (requires LLM config) |
| `preflight_rag` | Index to ChromaDB and RAG query, supports cross-validation (requires ChromaDB + embedding config) |
| `preflight_rag_manage` | Manage ChromaDB: list indexed content, stats, delete by hash or delete all |

### Memory System (1)
| Tool | Description |
|------|-------------|
| `preflight_memory` | Manage 3-layer long-term memory system (episodic, semantic, procedural) (requires `PREFLIGHT_MEMORY_ENABLED=true`) |

### ArXiv (2)
| Tool | Description |
|------|-------------|
| `preflight_arxiv_search` | Search arXiv papers by preset, query, or ID with translation support |
| `preflight_arxiv_download` | Download arXiv papers as PDF files to local directory |

| Tool | Description |
|------|-------------|
| `preflight_create_bundle` | Create bundle from GitHub, local path, web docs, or PDF |
| `preflight_list_bundles` | List all available bundles |
| `preflight_delete_bundle` | Delete a bundle |
| `preflight_get_overview` | ⭐ Get project overview (START HERE) |
| `preflight_read_file` | Read specific file from bundle |
| `preflight_repo_tree` | View directory structure |
| `preflight_update_bundle` | Update existing bundle from source |
| `preflight_cleanup_orphans` | Clean up orphaned files from storage |
| `preflight_get_task_status` | Get status of async bundle operations |

### Search (1)

| Tool | Description |
|------|-------------|
| `preflight_search_and_read` | Full-text search with context |

### Code Intelligence (2)

| Tool | Description |
|------|-------------|
| `preflight_lsp` | Go-to-definition, find references, hover, symbols (requires `PREFLIGHT_LSP_ENABLED=true`) |
| `preflight_check` | Code quality checks (duplicates, deadcode, circular, complexity, security) |

### Knowledge Distillation (3)

| Tool | Description |
|------|-------------|
| `preflight_generate_card` | Extract knowledge card from bundle (requires LLM config) |
| `preflight_rag` | Index to ChromaDB and RAG query, supports cross-validation (requires ChromaDB + embedding config) |
| `preflight_rag_manage` | Manage ChromaDB: list indexed content, stats, delete by hash or delete all |

### Memory System (1)

| Tool | Description |
|------|-------------|
| `preflight_memory` | Manage 3-layer long-term memory system (episodic, semantic, procedural) |

### ArXiv (2)

| Tool | Description |
|------|-------------|
| `preflight_arxiv_search` | Search arXiv papers by preset, query, or ID with translation support |
| `preflight_arxiv_download` | Download arXiv papers as PDF files to local directory |

## Tool Examples

### Create Bundle

```json
// GitHub repo
{"repos": [{"kind": "github", "repo": "owner/repo"}]}

// Local directory
{"repos": [{"kind": "local", "repo": "local/myproj", "path": "C:\\code\\myproj"}]}

// Web documentation
{"repos": [{"kind": "web", "url": "https://docs.example.com"}]}

// PDF (online or local)
{"repos": [{"kind": "pdf", "url": "https://arxiv.org/pdf/2512.14982"}]}
{"repos": [{"kind": "pdf", "path": "C:\\docs\\paper.pdf"}]}
```

### Search and Read

```json
{"bundleId": "abc123", "query": "authentication middleware", "scope": "code"}
```

### Code Quality Check

```json
{"path": "/home/user/project", "checks": ["security", "deadcode", "circular"]}
```

Available checks:
- `duplicates` - Copy-paste detection (150+ languages)
- `doccheck` - Documentation-code consistency
- `deadcode` - Unused files and exports
- `circular` - Circular import dependencies
- `complexity` - High complexity functions
- `errorprone` - Error-prone patterns
- `security` - Security vulnerabilities

### LSP Navigation

```json
{"action": "definition", "file": "/path/to/file.py", "line": 42, "column": 10}
{"action": "references", "file": "/path/to/file.ts", "line": 15, "column": 5}
```

Supported: `.py`, `.go`, `.rs`, `.ts`, `.tsx`, `.js`, `.jsx`

### RAG Query & Cross-Validation

```json
// Index bundle
{"bundleId": "abc123", "index": true}

// Query with hierarchical expansion (default)
{"bundleId": "abc123", "question": "What is the main contribution?"}

// Cross-validation: call twice, compare answers
{"bundleId": "abc123", "question": "..."}  // First: default LLM
{"bundleId": "abc123", "question": "...", "useVerifierLlm": true}  // Second: verifier LLM
```

### RAG Management

```json
// List all indexed content
{"action": "list"}

// View statistics
{"action": "stats"}

// Delete by content hash
{"action": "delete", "contentHash": "77b44fcb..."}

// Delete ALL indexed content (use with caution)
{"action": "delete_all"}
```

### ArXiv Search and Download

```json
// Search with preset (AI mainstream papers from last 2 days, brief mode)
{"preset": "ai_mainstream", "daysBack": 2, "brief": true}

// Search with custom query
{"query": "ti:\"reinforcement learning\" AND cat:cs.AI", "maxResults": 20}

// Get full details by ID
{"idList": ["2301.07041", "2312.12456"]}

// Translate titles and summaries to Chinese
{"preset": "ai_mainstream", "daysBack": 1, "translate": true}

// Save results to file
{"preset": "llm", "daysBack": 7, "outputFile": "papers.md"}

// Download PDFs
{"idList": ["2601.20732", "2601.20745"], "outputDir": "D:/papers/"}
```

### Memory Management

The 3-layer long-term memory system stores information across:
- L1: Episodic Memory (conversations, events, summaries)
- L2: Semantic Memory (facts, relations, entities) 
- L3: Procedural Memory (preferences, habits, patterns)

```json
// Add memory
{"action": "add", "layer": "episodic", "content": "User prefers TypeScript over JavaScript", "metadata": {"type": "preference", "tags": ["coding-style"]}}

// Search memories
{"action": "search", "query": "coding preferences", "layers": ["semantic", "procedural"]}

// Get memory statistics
{"action": "stats"}

// List memories
{"action": "list", "layer": "procedural", "limit": 10}

// Update memory metadata
{"action": "update", "memoryId": "mem_pro_xxx", "metadata": {"category": "workflow"}, "mergeMode": "replace"}

// Delete memory
{"action": "delete", "memoryId": "mem_epi_xxx"}

// Extract facts from memories
{"action": "reflect", "reflectType": "extract_facts", "sourceIds": ["mem_epi_1", "mem_epi_2"]}

// Extract patterns from semantic memories
{"action": "reflect", "reflectType": "extract_patterns"}

// Compress episodic memories
{"action": "reflect", "reflectType": "compress", "compressStrategy": {"layer": "episodic", "maxCount": 10}}

// Garbage collect old/unused memories
{"action": "gc", "gcOptions": {"layers": ["episodic"], "maxAgeDays": 30, "minAccessCount": 1, "dryRun": false}}
```

Memory system features:
- PII/Secret detection to prevent storing sensitive information
- Confidence gating (semantic < 0.6, procedural < 0.8 rejected)
- Conflict detection for semantic relations
- Access count batching (60s flush interval)
- Per-user isolation with machine fingerprint (override with PREFLIGHT_USER_ID)
- Garbage collection for old/unused memories with configurable filters

## Configuration

### Config File

Create `~/.preflight/config.json` (Windows: `C:\Users\<username>\.preflight\config.json`):

```json
{
  "vlmEnabled": true,
  "vlmApiBase": "https://api.openai.com/v1",
  "vlmApiKey": "sk-xxx",
  "vlmModel": "gpt-4o",

  "llmEnabled": true,
  "llmApiBase": "https://api.openai.com/v1",
  "llmApiKey": "sk-xxx",
  "llmModel": "gpt-4o-mini",

  "verifierLlmApiBase": "https://api.openai.com/v1",
  "verifierLlmApiKey": "sk-xxx",
  "verifierLlmModel": "gpt-4o",

  "embeddingEnabled": true,
  "embeddingProvider": "openai",
  "embeddingApiBase": "https://api.openai.com/v1",
  "embeddingApiKey": "sk-xxx",
  "embeddingModel": "text-embedding-3-small",

  "chromaUrl": "http://localhost:8000",

  "pdfChunkingStrategy": "semantic",
  "pdfChunkLevel": 2,

  "mineruEnabled": true,
  "mineruApiBase": "https://mineru.net",
  "mineruApiKey": "your-mineru-key",

  "memory": {
    "enabled": true,
    "userId": "optional-user-override"
  }
}
```

| Model | Purpose |
|-------|--------|
| VLM | PDF extraction (formulas, tables) |
| LLM | Knowledge card generation, RAG answer synthesis |
| Verifier LLM | RAG cross-validation (optional, for higher reliability) |
| Embedding | Semantic search |

### PDF Chunking Strategy

Control how PDFs are split into chunks for RAG:

| Option | Values | Default | Description |
|--------|--------|---------|-------------|
| `pdfChunkingStrategy` | `semantic`, `token-based`, `hybrid` | `semantic` | Chunking algorithm |
| `pdfChunkLevel` | `1`, `2`, `3`, `4` | `2` | Heading level to split at |

**Strategies:**
- `semantic` - Split by markdown headings only, no token limits (recommended for long-context models)
- `token-based` - Legacy mode, split by fixed token count
- `hybrid` - Semantic split with warnings for oversized chunks

**Chunk Levels:**
- `1` - Split by `#` (chapters) → ~10-20 chunks per paper
- `2` - Split by `##` (sections) → ~50-80 chunks per paper (**recommended**)
- `3` - Split by `###` (subsections) → ~100-150 chunks per paper
- `4` - Split by `####` (paragraphs) → finer granularity

The semantic strategy preserves complete sections with figures, formulas, and tables intact.

> ⚠️ Do NOT use "thinking" models (o1, DeepSeek-R1) for LLM - they output reasoning in `reasoning_content` instead of `content`.

### Environment Variables

```bash
# Storage
PREFLIGHT_STORAGE_DIR=~/.preflight-mcp/bundles
PREFLIGHT_STORAGE_DIRS=/path/to/storage1;/path/to/storage2  # Multiple storage (semicolon-separated)
PREFLIGHT_ANALYSIS_MODE=none|quick|full

# Limits
PREFLIGHT_MAX_FILE_BYTES=524288      # 512KB
PREFLIGHT_MAX_TOTAL_BYTES=52428800   # 50MB

# Semantic Search
PREFLIGHT_SEMANTIC_SEARCH=true
PREFLIGHT_EMBEDDING_PROVIDER=ollama|openai
PREFLIGHT_OLLAMA_HOST=http://localhost:11434
PREFLIGHT_OLLAMA_MODEL=nomic-embed-text
PREFLIGHT_OPENAI_API_KEY=sk-xxx

# LSP
PREFLIGHT_LSP_ENABLED=true

# HTTP API
PREFLIGHT_HTTP_ENABLED=true
PREFLIGHT_HTTP_PORT=37123

# VLM (Vision-Language Model for PDF analysis)
PREFLIGHT_VLM_ENABLED=true
VLM_API_KEY=sk-xxx

# LLM (for knowledge cards and RAG synthesis)
PREFLIGHT_LLM_ENABLED=true
PREFLIGHT_LLM_API_KEY=sk-xxx

# Verifier LLM (for RAG cross-validation)
PREFLIGHT_VERIFIER_LLM_API_KEY=sk-xxx

# MinerU (PDF parsing API)
PREFLIGHT_MINERU_ENABLED=true
PREFLIGHT_MINERU_API_KEY=your-key

# Memory System
PREFLIGHT_MEMORY_ENABLED=true
PREFLIGHT_USER_ID=optional-user-override

# PDF Chunking
PREFLIGHT_PDF_CHUNK_STRATEGY=semantic|token-based|hybrid
PREFLIGHT_PDF_CHUNK_LEVEL=2  # 1=chapter, 2=section, 3=subsection, 4=paragraph

# ChromaDB
PREFLIGHT_CHROMA_URL=http://localhost:8000
```

**Priority**: Environment variables > config.json > defaults

## Bundle Layout

```
bundle/
├── OVERVIEW.md          # Project summary
├── START_HERE.md        # Quick start guide
├── AGENTS.md            # Agent-specific guidance
├── manifest.json        # Bundle metadata
├── search.db            # FTS5 search index
├── analysis/
│   ├── gof-patterns.json
│   ├── architectural.json
│   ├── test-examples.json
│   └── config.json
└── repos/
    └── owner~repo/      # Ingested source files
```

## Deployment

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

## Development

```bash
npm install
npm run dev          # Start development server
npm run typecheck    # Type checking without compilation
npm run build        # Production build with security checks
npm run build:quick  # Quick build without checks
npm run start        # Run production build
npm test             # Run tests
npm run smoke        # Smoke test after build
npm run docs:generate # Generate API documentation
npm run docs:serve   # Serve documentation with watch mode
```

## FAQ

**Q: Bundle creation is slow**  
A: Use `ifExists: "returnExisting"` to reuse existing bundles. For large repos, consider limiting with `maxFiles`.

**Q: Semantic search not working**  
A: Enable with `embeddingEnabled: true` in config.json and provide embedding API credentials.

**Q: LSP tool not available**  
A: Enable with `PREFLIGHT_LSP_ENABLED=true` in environment variables. Ensure language servers are installed (`pyright`, `gopls`, `rust-analyzer`, `typescript-language-server`).

**Q: LSP timeouts**  
A: Increase `PREFLIGHT_LSP_TIMEOUT_MS`. Ensure language servers are installed (`pyright`, `gopls`, `rust-analyzer`, `typescript-language-server`).

**Q: Web crawl fails**  
A: For JavaScript-heavy sites (React/Vue SPA), add `useSpa: true` and `skipLlmsTxt: true`. Note: SPA mode is slower.

**Q: PDF extraction quality**  
A: Enable VLM for better formula/table extraction. Configure `vlmEnabled: true` with a vision model.

**Q: ArXiv search returns too many results**  
A: Use `brief: true` for title-only listings, or filter with `daysBack` parameter. Use `cursor` pagination for large result sets.

**Q: ArXiv translation fails**  
A: Ensure verifier LLM is configured in config.json with `verifierLlmApiBase`, `verifierLlmApiKey`, and `verifierLlmModel`.

**Q: Memory tool not available**  
A: Enable with `memory.enabled: true` in config.json or `PREFLIGHT_MEMORY_ENABLED=true`. Ensure ChromaDB is running.

**Q: Memory garbage collection not working**  
A: Use `dryRun: true` first to preview what will be deleted. Adjust `maxAgeDays` and `minAccessCount` filters as needed.

## License

AGPL-3.0
