# preflight-mcp

Preflight MCP 是一个 MCP Server：把 **代码项目 + 论文/文档** 变成可持久化、可搜索的知识 bundle，供 LLM/Agent 进行“证据驱动”的检索与分析。

这个仓库专门为了 **LLM-first** 做了强化：
- **极简工具集模式**：只暴露 *一个* 工具（`preflight_assistant`），避免模型在工具菜单里乱试、浪费 token。
- **论文 + 配套代码联动**：一次检索同时命中文档与代码，并返回可引用证据。
- **语义索引增量更新**（可选）：按文件级 diff 更新 embedding，不再每次全量重建。

> 传统的 bundle 管理 / 全文搜索 / 调用图 / 文档解析 等完整工具集仍然在 **full** 模式下可用。

## 两种模式

- **minimal（推荐）**：`PREFLIGHT_TOOLSET=minimal`
  - 只暴露：`preflight_assistant`
  - 不注册 prompts/菜单
- **full（管理/开发）**：`PREFLIGHT_TOOLSET=full`
  - 暴露：所有旧工具 +（可选）语义工具 + `preflight_assistant`

## 快速开始

### 1）在 MCP Host 里启动

minimal 模式配置示例：

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

full 模式配置示例：

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

### 2）只用一个工具：`preflight_assistant`

`preflight_assistant` 是唯一自然语言入口，会自动编排：
-（可选）repo ingest：创建/复用 bundle
-（可选）docPaths ingest：把论文/文档解析为缓存“docs bundle”
-（必要时）bundle repair / update（尽量自动）
- 检索：FTS（可选再叠加 semantic）
- 返回：紧凑的、可引用的 **evidence 证据包**

#### A）分析项目（代码）

```json
{
  "question": "深度理解这个项目，并提出可以复用到 B 项目的设计/算法点",
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
    "description": "B 项目：（描述你的目标系统与约束）"
  },
  "fresh": "auto"
}
```

#### B）分析论文（只给文档）

```json
{
  "question": "总结论文核心贡献/创新点，并映射到 B 项目",
  "intent": "paper",
  "sources": {
    "docPaths": ["C:\\papers\\my-paper.pdf"]
  }
}
```

#### C）论文 + 配套代码（联动检索）

```json
{
  "question": "这篇论文的方法如何落到代码里？给出实现入口点，并同时引用论文与代码证据",
  "intent": "pair",
  "sources": {
    "bundleIds": ["<existingBundleId>"],
    "docPaths": ["C:\\papers\\my-paper.pdf"]
  }
}
```

## 输出说明

assistant 返回 JSON，其中：
- `evidence[]`：每条包含 `bundleId/path/行号范围/uri/带行号 excerpt`，便于引用。
- `resolved`：本次实际使用了哪些 bundle（例如 `repoBundleId` / `docsBundleId` / `targetBundleId`）。
- `operations`：修复/更新/文档缓存/语义索引动作摘要，以及“可复用候选文件”的启发式列表。

## 可选：语义搜索（向量）

开启语义搜索：
- `PREFLIGHT_SEMANTIC_SEARCH=true`
- `PREFLIGHT_EMBEDDING_PROVIDER=ollama|openai`

Ollama（本地）：
- `PREFLIGHT_OLLAMA_HOST`（默认：`http://localhost:11434`）
- `PREFLIGHT_OLLAMA_MODEL`（默认：`nomic-embed-text`）

OpenAI-compatible / Azure：
- `PREFLIGHT_OPENAI_API_KEY`（或 `OPENAI_API_KEY`）
- `PREFLIGHT_OPENAI_MODEL`（默认：`text-embedding-3-small`）
- `PREFLIGHT_OPENAI_BASE_URL`（可选）
- `PREFLIGHT_OPENAI_EMBEDDINGS_URL`（可选，全量 embeddings endpoint）
- `PREFLIGHT_OPENAI_AUTH_MODE=auto|bearer|api-key`

注意：
- 在 minimal 模式下，语义“工具”不会暴露出来，但 `preflight_assistant` 仍可在内部使用语义检索（如果开启）。
- 语义索引是**增量更新**：只重算变更文件。

## 存储

- `PREFLIGHT_STORAGE_DIR`：主 storage
- `PREFLIGHT_STORAGE_DIRS`：镜像备份（用 `;` 分隔）
- `PREFLIGHT_MAX_FILE_BYTES`, `PREFLIGHT_MAX_TOTAL_BYTES`：摄取上限

## 本地开发

```bash
npm install
npm run typecheck
npm run build
npm run smoke
```

额外 smoke：
- `node scripts/smoke-minimal.mjs`
- `node scripts/smoke-assistant.mjs`

## License

AGPL-3.0（见 `LICENSE`）。
