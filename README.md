# preflight-mcp

Preflight MCP is an MCP server that turns **codebases + papers** into persistent, searchable “bundles” for LLM agents.

This repo is tuned for **LLM-first usage**:
- **Minimal toolset mode**: expose *one* tool (`preflight_assistant`) to avoid tool-sprawl and token-wasting menus.
- **Paper + companion code pairing**: search and cite evidence from both sides together.
- **Incremental semantic indexing** (optional): update embeddings per-file, not full rebuilds.

> Upstream features like bundle creation, full-text search (FTS5), call graph analysis, document parsing, etc. are still available in **full** mode.

## Modes

- **Minimal (recommended)**: `PREFLIGHT_TOOLSET=minimal`
  - Tools exposed: **only** `preflight_assistant`
  - Prompts/menus are disabled
- **Full (admin/developer)**: `PREFLIGHT_TOOLSET=full`
  - Tools exposed: all legacy tools **+** semantic tools (if enabled) **+** `preflight_assistant`

## Quick start

### 1) Run via MCP host

Minimal mode example config:

```json
{
  "mcpServers": {
    "preflight": {
      "command": "npx",
      "args": ["preflight-mcp"],
      "env": {
        "PREFLIGHT_TOOLSET": "minimal",
        "PREFLIGHT_STORAGE_DIR": "~/.preflight-mcp/bundles",
        "PREFLIGHT_ASSISTANT_DIR": "~/.preflight-mcp/assistant",
        "PREFLIGHT_SEMANTIC_SEARCH": "false"
      }
    }
  }
}
```

Full mode example:

```json
{
  "mcpServers": {
    "preflight": {
      "command": "npx",
      "args": ["preflight-mcp"],
      "env": {
        "PREFLIGHT_TOOLSET": "full"
      }
    }
  }
}
```

### 2) Use the one tool: `preflight_assistant`

`preflight_assistant` is the single natural-language entry point. It orchestrates:
- repo ingest (optional) → create/reuse bundle
- doc ingest (optional) → cached “docs bundle”
- bundle repair/update (best-effort)
- retrieval via **FTS** (and optional **semantic** search)
- returns a compact, citation-ready **evidence pack**

#### Project (code) analysis

```json
{
  "question": "Deeply analyze this project and propose reusable designs for my B project",
  "intent": "project",
  "sources": {
    "repos": [
      {
        "kind": "local",
        "repo": "owner/projectA",
        "path": "C:\\path\\to\\projectA"
      }
    ]
  },
  "target": {
    "description": "B project: (describe your target system + constraints)"
  },
  "fresh": "auto"
}
```

#### Paper analysis

```json
{
  "question": "Summarize the core contribution + innovation and map it to my B project",
  "intent": "paper",
  "sources": {
    "docPaths": ["C:\\papers\\my-paper.pdf"]
  }
}
```

#### Paper + companion code (paired retrieval)

```json
{
  "question": "Find how the paper's method can be implemented in this codebase; cite evidence from both",
  "intent": "pair",
  "sources": {
    "bundleIds": ["<existingBundleId>"],
    "docPaths": ["C:\\papers\\my-paper.pdf"]
  }
}
```

## Output format

The assistant returns a JSON object with:
- `evidence[]`: each item includes `bundleId`, `path`, `excerptRange`, `uri`, and a line-numbered `excerpt` for citations.
- `resolved`: which bundles were used (e.g. `repoBundleId`, `docsBundleId`, `targetBundleId`).
- `operations`: repair/update actions, doc ingestion cache summary, semantic index actions, and heuristic reuse candidates.

## Optional: semantic search (vector)

Enable semantic search:
- `PREFLIGHT_SEMANTIC_SEARCH=true`
- `PREFLIGHT_EMBEDDING_PROVIDER=ollama|openai`

Ollama (local):
- `PREFLIGHT_OLLAMA_HOST` (default: `http://localhost:11434`)
- `PREFLIGHT_OLLAMA_MODEL` (default: `nomic-embed-text`)

OpenAI-compatible / Azure:
- `PREFLIGHT_OPENAI_API_KEY` (or `OPENAI_API_KEY`)
- `PREFLIGHT_OPENAI_MODEL` (default: `text-embedding-3-small`)
- `PREFLIGHT_OPENAI_BASE_URL` (optional)
- `PREFLIGHT_OPENAI_EMBEDDINGS_URL` (optional, full embeddings endpoint)
- `PREFLIGHT_OPENAI_AUTH_MODE=auto|bearer|api-key`

Notes:
- In **minimal toolset** mode, semantic *tools* are hidden, but `preflight_assistant` will still use semantic retrieval if enabled.
- Semantic indexing is **incremental**: changed files are re-embedded, unchanged files are skipped.

## Storage

- `PREFLIGHT_STORAGE_DIR`: primary bundle storage (default: `~/.preflight-mcp/bundles`)
- `PREFLIGHT_STORAGE_DIRS`: mirrored storage paths (semicolon-separated)
- `PREFLIGHT_MAX_FILE_BYTES`, `PREFLIGHT_MAX_TOTAL_BYTES`: ingestion limits

## Development

```bash
npm install
npm run typecheck
npm run build
npm run smoke
```

Extra smoke tests:
- `node scripts/smoke-minimal.mjs`
- `node scripts/smoke-assistant.mjs`

## License

AGPL-3.0 (see `LICENSE`).
