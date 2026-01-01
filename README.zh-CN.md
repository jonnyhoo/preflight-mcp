# preflight-mcp

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://opensource.org/licenses/AGPL-3.0)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io/)
[![npm version](https://img.shields.io/npm/v/preflight-mcp)](https://www.npmjs.com/package/preflight-mcp)

> [English](./README.md) | **中文**

**让你的 AI 助手秒懂任何代码仓库。**

Preflight-MCP 为 GitHub 仓库创建可搜索的知识库，让 Claude/GPT/Cursor 理解你的项目结构、快速定位代码、追踪依赖关系 —— 无需复制粘贴，不受 token 限制。

## 为什么需要 Preflight？

| 痛点 | Preflight 解决方案 |
|------|--------------------|
| 🤯 AI 记不住你的代码库 | 持久化、可搜索的知识包 |
| 📋 反复复制粘贴代码 | 一句话：「索引这个仓库」 |
| 🔍 AI 找不到相关文件 | 全文搜索 + 依赖图 |
| 🧩 大项目里迷失方向 | 自动生成 `START_HERE.md` 和 `OVERVIEW.md` |
| 🔗 不知道哪些测试覆盖哪些代码 | 追溯链接：代码↔测试↔文档 |

|| 📄 不能读取 PDF/Word 文档 | **新** 文档解析与多模态提取 |
|| 🖼️ 图片/表格被忽略 | **新** 多模态内容搜索 |

## v0.7.2 新特性

### 🔗 函数级调用图分析
构建和查询调用图，深入理解代码：
- **多语言支持** — TypeScript、Python、Go、Rust
- **调用层级** — 谁调用了这个函数？它调用了什么？
- **代码提取** — 提取函数及其所有依赖
- **接口摘要** — 自动生成 API 文档

### 📄 文档解析
解析复杂文档并提取结构化内容：
- **PDF** — 文本、图片、表格、公式（支持 OCR）
- **Word (.docx)** — 完整内容提取，保留格式
- **Excel (.xlsx)** — 工作表数据转结构化表格
- **PowerPoint (.pptx)** — 幻灯片内容和嵌入媒体
- **HTML** — 干净的文本提取，保留结构

### 🖼️ 多模态内容处理
从文档中提取和索引视觉内容：
- **图片** — 描述、alt 文本、提取文字（OCR）
- **表格** — 结构化数据，含表头和单元格
- **公式** — LaTeX/MathML 提取
- **图表** — 流程图、架构图

### 🧠 智能工具路由
对 LLM 友好的工具选择器，支持中英文关键词：
- 根据任务描述自动推荐工具
- 复杂任务的工作流建议
- 中文/英文关键词支持

## 效果演示

```
你：「为 facebook/react 创建 bundle」

Preflight：✅ 已克隆，索引了 2,847 个文件，生成概览完成

你：「搜索 useState 的实现」

Preflight：📍 找到 23 处匹配：
  → packages/react/src/ReactHooks.js:24
  → packages/react-reconciler/src/ReactFiberHooks.js:1042
  ...

你：「哪些测试覆盖了 useState」

Preflight：🔗 追溯链接：
  → ReactHooks.js tested_by ReactHooksTest.js
  ...
```

## 核心功能

- 🚀 **一句话索引** — 「索引 owner/repo」即可创建完整知识包
- 🔍 **全文搜索** — SQLite FTS5 搜索全部代码和文档
- 🧠 **语义搜索** *（可选）* — 基于向量的相似度搜索，支持 Ollama（本地）或 OpenAI
- 🗺️ **依赖图** — 可视化 import 关系和文件依赖
- 🔗 **追溯链接** — 追踪代码↔测试↔文档关系
- 📖 **自动生成指南** — `START_HERE.md`、`AGENTS.md`、`OVERVIEW.md`
- ☁️ **云端同步** — 多路径镜像备份
- ⚡ **25 个 MCP 工具 + 6 个 prompts** — 完整的代码探索工具集
- 🔗 **调用图分析** — 函数级依赖追踪（v0.7.2）

<details>
<summary><b>全部功能（点击展开）</b></summary>

- **进度追踪**：长时间操作的实时进度显示
- **Bundle 完整性检查**：防止对不完整 bundle 进行操作
- **去重机制**：即使超时也能防止重复创建
- **可靠的 GitHub 抓取**：git clone 超时 + archive 兜底
- **离线修复**：无需重新抓取即可重建派生文件
- **静态事实提取**：`analysis/FACTS.json`（非 LLM）
- **Resources**：通过 `preflight://...` URI 读取文件
- **原子操作**：崩溃安全，零孤儿目录
- **快速删除**：100-300 倍性能提升
- **自动清理**：启动时自动清理孤儿 bundle

</details>

## 目录

- [为什么需要 Preflight](#为什么需要-preflight)
- [v0.7.2 新特性](#v072-新特性)
- [效果演示](#效果演示)
- [核心功能](#核心功能)
- [快速开始](#quick-start)
- [工具](#tools-25-active)
- [Prompts](#prompts-6-total)
- [调用图分析](#调用图分析)
- [环境变量](#environment-variables)
- [贡献指南](#contributing)

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

在你的 MCP 配置文件中加入：

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

或（本地开发）直接指向构建产物：

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

对你的 AI 助手说：

```
"为仓库 octocat/Hello-World 创建 bundle"
```

它会：
- 克隆仓库
- 索引所有文档与代码
- 生成可搜索的 SQLite FTS5 索引
- 生成 `START_HERE.md`、`AGENTS.md`、`OVERVIEW.md`

### 3. Search the Bundle

```
"在 bundle 里搜索 'GitHub'"
```

### 4. Test Locally (Optional)

运行端到端 smoke 测试：

```bash
npm run smoke
```

这会测试 bundle 创建、搜索、更新等核心操作。

## Architecture

### 🚀 原子创建（Crash-safe）
- 在 `tmpDir/bundles-wip/` 下构建，校验通过后原子重命名到最终目录
- 失败会自动清理临时目录，避免产生孤儿目录
- 跨文件系统自动回退到 copy+delete

### ⚡ 后台删除（Fast Delete）
- 先将目录重命名为 `.deleting.{timestamp}`，响应<100ms
- 真正的删除在后台完成；启动时会清理残留的 `.deleting` 目录

### 🧹 启动自动清理（Auto-Cleanup）
- 启动时后台扫描并清理无效 bundle（无有效 manifest.json）
- 仅清理超过 1 小时的目录（安全阈值），非阻塞执行

### 🔍 UUID 严格校验
- 列表与清理逻辑只接受 UUID v4 作为 bundleId
- 会自动过滤 `#recycle`、`tmp`、`.deleting` 等非 bundle 目录

## Tools (25 active)

### 调用图工具 (v0.7.2 新增)

#### `preflight_build_call_graph`
为多语言项目构建函数级调用图。
- **语言支持**：TypeScript、JavaScript、Python、Go、Rust
- 自动检测项目语言
- 触发词：「build call graph」「构建调用图」

#### `preflight_query_call_graph`
查询特定函数或方法的调用关系。
- **方向**：callers（调用者）、callees（被调用）、both（双向）
- 找出谁调用了这个函数，以及它调用了什么
- 触发词：「who calls」「查询调用关系」「谁调用了」

#### `preflight_extract_code`
提取函数及其依赖，生成自包含代码。
- **格式**：minimal（仅签名）、full（完整代码）、markdown（带文档）
- 包含传递依赖
- 触发词：「extract function」「提取代码」「提取函数」

#### `preflight_interface_summary`
为文件或项目生成接口摘要。
- 列出所有导出的函数/类
- 包含签名和文档
- 触发词：「interface summary」「接口文档」「API 文档」

### `preflight_list_bundles`
列出所有 bundle。
- 触发词：「show bundles」「查看bundle」「有哪些bundle」「列出仓库」

### `preflight_create_bundle`
从一个或多个输入创建新 bundle。
- 触发词：「index this repo」「学习这个项目」「创建bundle」

关键语义：
- **默认去重**：如果相同规范化输入的 bundle 已存在，默认拒绝创建
- 使用 `ifExists` 控制行为：
  - `error`（默认）：拒绝重复
  - `returnExisting`：返回已存在的 bundle，不抓取（可替代原 `preflight_find_bundle`）
  - `updateExisting`：更新已存在的 bundle 后返回
  - `createNew`：绕过去重
- GitHub 抓取使用**浅克隆**；如果 `git clone` 失败，会回退到 **GitHub archive (zipball)**
- 支持 `repos.kind: "local"` 从本地目录（如解压后的 zip）抓取

输入示例：
- `repos`: `[{ kind: "github", repo: "owner/repo" }, { kind: "local", repo: "owner/repo", path: "/path/to/dir" }]`
- `libraries`: `["nextjs", "react"]`（Context7；可选）
- `topics`: `["routing", "api"]`（Context7 主题过滤；可选）
- `ifExists`: `"error" | "returnExisting" | "updateExisting" | "createNew"`

**💡 提示**：对于代码仓库，创建 bundle 后可进一步使用 `preflight_dependency_graph` 获取依赖图，或使用 `preflight_trace_upsert` 记录代码←→需求/测试的追溯链接。

### `preflight_read_file`
从 bundle 读取文件。多种模式：
- **批量模式**（省略 `file`）：返回所有关键文件（OVERVIEW.md、START_HERE.md、AGENTS.md、manifest.json 等）
- **单文件模式**（提供 `file`）：返回指定文件
- **证据引用**：使用 `withLineNumbers: true` 获取 `N|行` 格式；使用 `ranges: ["20-80"]` 读取指定行
- 触发词：「查看概览」「项目概览」「bundle详情」「读取依赖图」

**v0.5.3 新增 - 符号大纲与按符号读取：**
- `outline: true`：返回文件的符号结构（function/class/method/interface/type/enum），附带行号范围
  - 支持：`.ts`、`.tsx`、`.js`、`.jsx`、`.py`、`.go`、`.rs`
  - 理解文件结构可节省 90%+ token
- `symbol: "name"`：按名称读取特定符号
  - 格式：`"functionName"` 或 `"ClassName.methodName"`
  - 自动包含上下文行并返回带行号的内容

**示例 - 大纲模式：**
```
[src/server.ts] Outline (15 top-level symbols, typescript):
├── ⚡function startServer(): Promise<void> :174-200
├── ⚡class McpServer :205-400
│   ├── method registerTool :210-250
│   └── method start :380-400
└── ⚡interface Config :45-71
```
（`⚡` = 已导出）

### `preflight_repo_tree`
获取仓库结构概览，避免浪费 token 搜索。
- 返回：ASCII 目录树、按扩展名/目录统计文件数、入口点候选
- 默认深度：6（v0.3.1+，原为 4）— 可看到 norm/ 下 2-3 层子目录
- 在深入分析前使用，了解项目布局
- 触发词：「项目结构」「文件分布」「show tree」

### `preflight_delete_bundle`
永久删除/移除一个 bundle。
- 触发词：「删除bundle」「移除仓库」

### `preflight_update_bundle`
用最新仓库变更刷新/同步 bundle。
- 触发词：「更新bundle」「同步仓库」「刷新索引」

可选参数：
- `checkOnly`：如为 true，仅检查是否有更新，不实际应用
- `force`：如为 true，即使未检测到变更也强制重建

### `preflight_repair_bundle`
离线修复 bundle（无需抓取）：重建缺失/为空的派生物。
- 重建 `indexes/search.sqlite3`、`START_HERE.md`、`AGENTS.md`、`OVERVIEW.md`（当缺失/为空时）
- 适用场景：搜索因索引损坏失败、bundle 文件被部分删除等

### `preflight_search_by_tags`
跨多个 bundle 按标签过滤搜索（基于行的 SQLite FTS5）。
- 触发词：「search in MCP bundles」「search in all bundles」「在MCP项目中搜索」「搜索所有agent」

说明：
- 此工具是只读的，**不会自动修复**
- 如果某些 bundle 搜索失败（如索引缺失/损坏），会在 `warnings` 中报告

可选参数：
- `tags`：按标签过滤 bundle（如 `["mcp", "agents"]`）
- `scope`：搜索范围（`docs`、`code` 或 `all`）
- `limit`：跨所有 bundle 的最大命中数

### `preflight_trace_upsert`
写入/更新 bundle 级 traceability links（commit↔ticket、symbol↔test、code↔doc 等）。

### `preflight_trace_query`
查询 traceability links。
- 无匹配边时返回 `reason` 和 `nextSteps`（帮助 LLM 决定下一步）
- 提供 `bundleId` 时更快；省略时可跨 bundle 扫描

### `preflight_cleanup_orphans`
删除不完整或损坏的 bundle（缺少有效 manifest.json）。
- 触发词：「清理孤儿bundle」「删除坏目录」
- 参数：
  - `dryRun`（默认 true）：仅报告不删除
  - `minAgeHours`（默认 1）：只清理超过 N 小时的目录
- 输出：`totalFound`, `totalCleaned`, `details`
- 说明：服务启动时也会自动执行后台清理（非阻塞）

### `preflight_get_task_status`
检查 bundle 创建/更新任务的状态（进度追踪）。
- 触发词：「查看进度」「任务状态」「下载进度」
- 通过 `taskId`、`fingerprint` 或 `repos` 查询
- 显示：阶段、进度百分比、消息、已用时间

### 文档与多模态工具

#### `preflight_parse_document`
解析 PDF、Word、Excel、PowerPoint 或 HTML 文档。
- 提取文本、图片、表格、公式
- 支持扫描文档 OCR
- 输出格式：markdown、json、text
- 触发词：「解析文档」「parse document」「read PDF」

#### `preflight_search_modal`
搜索 bundle 中的多模态内容（图片、表格、公式）。
- 全文搜索描述
- 按内容类型过滤
- 基于关键词过滤
- 触发词：「search images」「找图片」「search tables」

#### `preflight_analyze_modal`
分析和处理 bundle 中的多模态内容。
- 图片描述和 OCR
- 表格结构提取
- 公式解析
- 触发词：「analyze images」「分析表格」

### 核心 Bundle 工具

#### `preflight_get_overview`
⭐ **从这里开始** - 一次调用获取项目概览。
- 返回：OVERVIEW.md + START_HERE.md + AGENTS.md
- 探索任何 bundle 的最简入口
- 触发词：「了解项目」「项目概览」「what is this project」

#### `preflight_dependency_graph`
获取或生成 bundle 的依赖图。
- 如未缓存则自动生成，如有缓存则返回缓存版本
- 触发词：「show dependencies」「看依赖图」「import graph」

#### `preflight_search_and_read`
搜索 + 读取合一 - **主要搜索工具**。
- RFC v2 统一响应格式：`ok`, `meta`, `data`, `evidence[]`
- 触发词：「search and show code」「搜索并读取」

#### `preflight_deep_analyze_bundle`
一次调用的深度分析，带测试检测。
- 返回统一证据包
- 自动生成声明及证据
- 触发词：「deep analyze」「深度分析」

#### `preflight_validate_report`
验证声明和证据链的可审计性。

## Prompts（6 个）

MCP prompts 提供交互式引导。调用这些 prompt 获取使用说明和示例。

### `preflight_router` (v0.7.0 新增)
智能工具选择器。
- 根据任务描述自动推荐工具
- 工作流建议
- 触发词：「用哪个工具」「which tool should I use」「推荐工具」

### `preflight_menu`
主菜单，显示所有 Preflight 功能。
- 触发词：「preflight有什么功能」「有什么工具」「what can preflight do」

### `preflight_analyze_guide`
深入分析指南，包含分步流程和可复制的 prompt。
- 显示：Bundle 文件结构、推荐分析流程、示例 prompt
- 参数：`projectPath`（可选）

### `preflight_search_guide`
搜索功能指南。
- 显示：单 bundle 搜索、跨 bundle 按标签搜索、FTS5 语法提示
- 参数：`bundleId`（可选）

### `preflight_manage_guide`
Bundle 管理操作指南。
- 显示：列出、查看、更新、修复、删除 bundle 操作

### `preflight_trace_guide`
追溯链接指南。
- 显示：查询和创建代码↔测试、代码↔文档关系
- 参数：`bundleId`（可选）

## 调用图分析

### 支持的语言

| 语言 | 适配器 | 特性 |
|------|--------|------|
| TypeScript/JS | TS Language Service | 完整类型信息、引用查找、定义跳转 |
| Python | tree-sitter | 函数、类、装饰器、docstring |
| Go | tree-sitter | 函数、接口、方法、Go doc |
| Rust | tree-sitter | fn、impl、trait、struct、enum、宏调用 |

### 使用示例

```
"为 /path/to/project 构建调用图"
"谁调用了 processData 函数？"
"提取 handleRequest 函数及其所有依赖"
"为 src/api/ 生成接口文档"
```

### 输出格式

- **查询结果**：调用者/被调用者关系，带文件位置
- **代码提取**：自包含代码，带依赖
- **接口摘要**：Markdown 格式的 API 文档

## Resources

### `preflight://bundles`
静态 JSON，列出所有 bundle 及其主入口文件。

### `preflight://bundle/{bundleId}/file/{encodedPath}`
读取 bundle 内的特定文件。

示例：
- `preflight://bundle/<id>/file/START_HERE.md`
- `preflight://bundle/<id>/file/repos%2Fowner%2Frepo%2Fnorm%2FREADME.md`

## Error semantics (stable, UI-friendly)

大多数工具错误会包装为稳定、可机器解析的前缀：
- `[preflight_error kind=<kind>] <message>`

常见 kinds：
- `bundle_not_found`
- `file_not_found`
- `invalid_path`（不安全的路径遍历尝试）
- `permission_denied`
- `index_missing_or_corrupt`
- `deprecated_parameter`
- `unknown`

这样设计是为了让 UI/agent 能可靠地决定是否：
- 调用 `preflight_update_bundle`
- 调用 `preflight_repair_bundle`
- 提示用户提供不同的 bundleId/path

## Environment variables

### Storage
- `PREFLIGHT_STORAGE_DIR`：bundle 存储目录（默认：`~/.preflight-mcp/bundles`）
- `PREFLIGHT_STORAGE_DIRS`：**多路径镜像备份**（分号分隔，如 `D:\cloud1\preflight;E:\cloud2\preflight`）
- `PREFLIGHT_TMP_DIR`：临时检出目录（默认：OS temp `preflight-mcp/`）
- `PREFLIGHT_MAX_FILE_BYTES`：单文件最大字节（默认：512 KiB）
- `PREFLIGHT_MAX_TOTAL_BYTES`：单仓库抓取最大字节（默认：50 MiB）

### Analysis & evidence
- `PREFLIGHT_ANALYSIS_MODE`：静态分析模式 - `none` | `quick` | `full`（默认：`full`）。控制 `analysis/FACTS.json` 生成。
- `PREFLIGHT_AST_ENGINE`：部分证据工具使用的 AST 引擎 - `wasm`（默认）或 `native`。

### Built-in HTTP API
- `PREFLIGHT_HTTP_ENABLED`：启用/禁用 REST API（默认：true）
- `PREFLIGHT_HTTP_HOST`：REST 监听主机（默认：127.0.0.1）
- `PREFLIGHT_HTTP_PORT`：REST 监听端口（默认：37123）

### GitHub & Context7
- `GITHUB_TOKEN`：可选；用于 GitHub API/auth 模式和 GitHub archive 兑底（公开仓库通常不需要）
- `PREFLIGHT_GIT_CLONE_TIMEOUT_MS`：可选；`git clone` 最大等待时间，超时后切换到 archive（默认：5 分钟）
- `CONTEXT7_API_KEY`：可选；启用更高的 Context7 限制（无 key 也能运行但可能被限流）
- `CONTEXT7_MCP_URL`：可选；默认为 Context7 MCP 端点

### 语义搜索（可选功能）
语义搜索提供基于向量的相似度搜索。**默认禁用**，保持零依赖设计。

- `PREFLIGHT_SEMANTIC_SEARCH`：启用语义搜索（默认：`false`）
- `PREFLIGHT_EMBEDDING_PROVIDER`：`ollama`（本地，默认）或 `openai`（云服务）
- `PREFLIGHT_OLLAMA_HOST`：Ollama 服务器（默认：`http://localhost:11434`）
- `PREFLIGHT_OLLAMA_MODEL`：embedding 模型（默认：`nomic-embed-text`）
- `OPENAI_API_KEY`：使用 OpenAI 时必填
- `PREFLIGHT_OPENAI_MODEL`：OpenAI 模型（默认：`text-embedding-3-small`）

**快速开始（本地，零云依赖）：**
```bash
# 1. 安装 Ollama 并拉取 embedding 模型
ollama pull nomic-embed-text

# 2. 启用语义搜索
export PREFLIGHT_SEMANTIC_SEARCH=true
```

> **TODO:** 集成 `sqlite-vec` 实现 ANN（近似最近邻）索引，提升大型代码库的搜索性能。

## Bundle layout (on disk)

bundle 目录内部：
- `manifest.json`（含 `fingerprint`、`displayName`、`tags`，以及每个 repo 的 `source`）
- `START_HERE.md`
- `AGENTS.md`
- `OVERVIEW.md`
- `indexes/search.sqlite3`
- `indexes/semantic.sqlite3`（可选，启用语义搜索时生成）
- **`analysis/FACTS.json`**（静态分析）
- **`deps/dependency-graph.json`**（全局依赖图；按需生成）
- `trace/trace.sqlite3`（traceability links；按需创建）
- `trace/trace.json`（自动导出的 JSON，便于 LLM 直接读取）
- `repos/<owner>/<repo>/raw/...`
- `repos/<owner>/<repo>/norm/...`（GitHub/local 快照）
- `libraries/context7/<...>/meta.json`
- `libraries/context7/<...>/docs-page-1.md`（或 `topic-<topic>-page-1.md`）

## Multi-device sync & mirror backup

如果你在多台电脑上工作或需要冗余云备份：

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
写入所有路径，从第一个可用路径读取：
```powershell
# Windows - 分号分隔
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
- **Auto-failover**：如果主路径不可用，自动使用第一个可用备份
- **Mirror sync**：所有写入会镜像到可用备份路径
- **Mount recovery**：路径恢复后，下次写入时自动同步
- **Non-blocking**：不可用路径会被跳过，不报错

### Important notes
- **避免并发访问**：同一时间只在一台机器上使用（SQLite 冲突）
- **等待同步**：更新后，切换机器前等待云同步完成

## Contributing

欢迎贡献！请查看 [Contributing Guide](./CONTRIBUTING.md) 了解：
- 开发环境搭建
- 代码风格
- 测试要求
- PR 流程

在贡献之前，也请阅读 [Code of Conduct](./CODE_OF_CONDUCT.md)。

## Support

如果你遇到问题或有疑问：

- **Issues**: [GitHub Issues](https://github.com/jonnyhoo/preflight-mcp/issues)
- **Discussions**: [GitHub Discussions](https://github.com/jonnyhoo/preflight-mcp/discussions)

## License

本项目基于 AGPL-3.0 License 发布，详见 [LICENSE](./LICENSE)。

## Acknowledgments

- Built on the [Model Context Protocol](https://modelcontextprotocol.io/)
- Uses SQLite FTS5 for efficient full-text search
- Inspired by the need for evidence-based AI assistance

---

Made with ❤️ for the AI developer community
