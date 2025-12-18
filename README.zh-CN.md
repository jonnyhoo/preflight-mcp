# preflight-mcp

> [English](./README.md) | **中文**

一个 MCP (Model Context Protocol) **stdio** 服务器

## 📦 Bundle 包含内容

每个 bundle 包含：
- 仓库文档 + 代码的本地副本（规范化文本）
- 轻量级**全文搜索索引**（SQLite FTS5）
- 面向 AI Agent 的入口文件：`START_HERE.md`、`AGENTS.md` 和 `OVERVIEW.md`（仅事实，带证据指针）

## ✨ 功能特性

- **10 个工具** - 创建/更新/搜索/验证/读取/分析 bundles
- **AI 驱动分析** - 静态事实提取和 LLM 摘要
- **基于证据的验证** - 检测幻觉
- **资源访问** - 通过 `preflight://...` URI 读取 bundle 文件
- **多路径镜像备份** - 云存储冗余
- **弹性存储** - 挂载点不可用时自动故障转移
- **任务调度系统** - 自动化的 bundle 更新和存储清理
- **压缩系统** - 支持 Gzip、Brotli、Deflate
- **结构化日志** - 完整的日志记录和监控

---

## 🔧 系统要求

- Node.js >= 18
- `git` 命令可用（在 PATH 中）

---

## 📥 安装

### 本地开发
```bash
npm install
npm run build
```

### 全局安装（发布到 npm 后）
```bash
npm install -g preflight-mcp
```

---

## 🚀 使用方法

### 作为 MCP 服务器运行
此服务器通过 stdin/stdout 通信，通常通过 MCP 主机运行（如 mcp-hub）。

```bash
# 直接运行
preflight-mcp

# 或本地开发
node dist/index.js
```

### 运行测试
```bash
# 运行单元测试
npm test

# 运行 smoke 测试（端到端）
npm run smoke

# 类型检查
npm run typecheck
```

> **注意**: smoke 测试需要从 GitHub 克隆 `octocat/Hello-World`，需要网络访问。

---

## 🛠️ 工具列表（共 10 个）

### 1. `preflight_list_bundles`
列出存储中的所有 bundle ID。

**触发词**: "show bundles"、"查看bundle"、"有哪些bundle"、"列出仓库"

---

### 2. `preflight_create_bundle`
从一个或多个输入创建新的 bundle。

**触发词**: "index this repo"、"学习这个项目"、"创建bundle"、"添加GitHub项目"

**输入示例**:
```json
{
  "repos": [
    { "kind": "github", "repo": "owner/repo" },
    { "kind": "deepwiki", "url": "https://deepwiki.com/owner/repo" }
  ],
  "libraries": ["nextjs", "react"],
  "topics": ["routing", "api"]
}
```

---

### 3. `preflight_read_file`
从 bundle 读取文件（OVERVIEW.md、START_HERE.md、AGENTS.md 或任何仓库文件）。

**触发词**: "查看概览"、"项目概览"、"看README"、"show overview"

---

### 4. `preflight_bundle_info`
获取 bundle 详情：仓库、更新时间、统计信息。

**触发词**: "bundle详情"、"仓库信息"、"bundle info"

---

### 5. `preflight_delete_bundle`
永久删除/移除一个 bundle。

**触发词**: "删除bundle"、"移除仓库"、"delete bundle"

---

### 6. `preflight_update_bundle`
刷新/同步 bundle 与最新的仓库更改。

**触发词**: "更新bundle"、"同步仓库"、"刷新索引"

**可选参数**:
- `checkOnly`: 如果为 true，仅检查更新不应用
- `force`: 如果为 true，即使没有检测到更改也强制重建

---

### 7. `preflight_update_all_bundles`
批量更新所有 bundles。

**触发词**: "批量更新"、"全部刷新"、"更新所有bundle"

---

### 8. `preflight_search_bundle`
在已导入的文档/代码中进行全文搜索（基于行的 SQLite FTS5）。

**触发词**: "搜索bundle"、"在仓库中查找"、"搜代码"、"搜文档"

**可选参数**:
- `ensureFresh`: 如果为 true，搜索前检查 bundle 是否需要更新
- `maxAgeHours`: 触发自动更新前的最大小时数（默认: 24）

---

### 9. `preflight_analyze_bundle`
为 bundle 生成或重新生成 AI 分析。

**触发词**: "analyze this bundle"、"generate analysis"、"分析bundle"、"生成分析报告"

**参数**:
- `bundleId`: 要分析的 Bundle ID
- `mode`: 分析模式 - `quick`（仅静态）或 `deep`（静态 + LLM）
- `regenerate`: 如果为 true，即使已存在也重新生成分析

**生成内容**:
- **FACTS.json**: 静态分析（语言、框架、依赖、入口点）
- **AI_SUMMARY.md**: LLM 生成的摘要，包含架构概览和使用指南（仅 deep 模式）

---

### 10. `preflight_verify_claim`
在 bundle 中查找声明/陈述的证据。

**触发词**: "验证说法"、"找证据"、"这个对吗"、"有没有依据"

**可选参数**:
- `ensureFresh`: 如果为 true，验证前检查 bundle 是否需要更新
- `maxAgeHours`: 触发自动更新前的最大小时数（默认: 24）

---

## 📚 资源

### `preflight://bundles`
bundles 及其主要入口文件的静态 JSON 列表。

### `preflight://bundle/{bundleId}/file/{encodedPath}`
读取 bundle 内的特定文件。

**示例**:
- `preflight://bundle/<id>/file/START_HERE.md`
- `preflight://bundle/<id>/file/repos%2Fowner%2Frepo%2Fnorm%2FREADME.md`

---

## ⚙️ 环境变量

### 存储配置
| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PREFLIGHT_STORAGE_DIR` | bundle 存储目录 | `~/.preflight-mcp/bundles` |
| `PREFLIGHT_STORAGE_DIRS` | 多路径镜像备份（分号分隔） | - |
| `PREFLIGHT_TMP_DIR` | 临时检出目录 | OS temp `preflight-mcp/` |
| `PREFLIGHT_MAX_FILE_BYTES` | 每个文件的最大字节数 | 512 KiB |
| `PREFLIGHT_MAX_TOTAL_BYTES` | 每个仓库导入的最大字节数 | 50 MiB |

### 分析配置
| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PREFLIGHT_ANALYSIS_MODE` | 分析模式：`none`、`quick`、`deep` | `quick` |
| `PREFLIGHT_LLM_PROVIDER` | LLM 提供商：`none`、`openai`、`context7` | `none` |
| `OPENAI_API_KEY` | OpenAI API 密钥（deep 模式需要） | - |
| `OPENAI_MODEL` | OpenAI 模型 | `gpt-4o-mini` |

### GitHub & Context7
| 变量 | 说明 | 默认值 |
|------|------|--------|
| `GITHUB_TOKEN` | GitHub API 令牌（公开仓库不需要） | - |
| `CONTEXT7_API_KEY` | Context7 API 密钥 | - |
| `CONTEXT7_MCP_URL` | Context7 MCP 端点 | 默认端点 |

---

## 📁 Bundle 目录结构

```
bundle-id/
├── manifest.json           # Bundle 元数据
├── START_HERE.md          # 入口指南
├── AGENTS.md              # Agent 指南
├── OVERVIEW.md            # 项目概览
├── indexes/
│   └── search.sqlite3     # FTS5 搜索索引
├── analysis/
│   ├── FACTS.json         # 静态分析结果
│   └── AI_SUMMARY.md      # LLM 分析摘要
├── repos/
│   └── <owner>/<repo>/
│       ├── raw/...        # 原始文件
│       └── norm/...       # 规范化文件
├── deepwiki/
│   └── <owner>/<repo>/
│       ├── norm/index.md
│       └── meta.json
└── libraries/
    └── context7/
        ├── meta.json
        └── docs-page-1.md
```

---

## 🔄 多设备同步与镜像备份

### 单路径（简单）
```powershell
# Windows
$env:PREFLIGHT_STORAGE_DIR = "D:\OneDrive\preflight-bundles"
```

```bash
# macOS/Linux
export PREFLIGHT_STORAGE_DIR="$HOME/Dropbox/preflight-bundles"
```

### 多路径镜像（冗余）
写入所有路径，从第一个可用路径读取：

```powershell
# Windows - 分号分隔
$env:PREFLIGHT_STORAGE_DIRS = "D:\OneDrive\preflight;E:\GoogleDrive\preflight"
```

```bash
# macOS/Linux
export PREFLIGHT_STORAGE_DIRS="$HOME/OneDrive/preflight:$HOME/Dropbox/preflight"
```

### MCP 主机配置（Claude Desktop）
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

### 弹性存储特性
- **自动故障转移**: 主路径不可用时，自动使用第一个可用的备份
- **镜像同步**: 所有写入都镜像到可用的备份路径
- **挂载恢复**: 路径重新上线时，下次写入时自动同步
- **非阻塞**: 不可用的路径会被静默跳过

### 重要说明
- **避免并发访问**: 同一时间只在一台机器上使用（避免 SQLite 冲突）
- **等待同步**: 更新后，在切换机器前等待云同步完成

---

## 🏗️ 项目架构

```
src/
├── index.ts                 # 入口点
├── server.ts               # MCP 服务器主文件
├── config.ts               # 配置管理
├── core/
│   └── scheduler.ts        # 任务调度系统
├── jobs/
│   ├── bundle-auto-update-job.ts   # 自动更新任务
│   ├── health-check-job.ts         # 健康检查任务
│   └── storage-cleanup-job.ts      # 存储清理任务
├── storage/
│   ├── storage-adapter.ts  # 存储抽象层
│   └── compression.ts      # 压缩系统
├── logging/
│   └── logger.ts           # 结构化日志
├── server/
│   └── optimized-server.ts # 优化服务器集成
├── bundle/
│   ├── service.ts          # Bundle 服务
│   ├── analysis.ts         # 静态分析
│   ├── llm-analysis.ts     # LLM 分析
│   ├── facts.ts            # 事实提取
│   └── ...                 # 其他 bundle 相关模块
├── search/
│   └── sqliteFts.ts        # SQLite FTS5 搜索
└── mcp/
    └── uris.ts             # URI 处理
```

---

## 🧪 测试

项目包含完整的测试套件（28 个测试）：

```bash
# 运行所有测试
npm test

# 测试覆盖范围：
# - 调度器系统 (3 tests)
# - Bundle 自动更新任务 (2 tests)
# - 存储清理任务 (2 tests)
# - 健康检查任务 (2 tests)
# - 存储适配器系统 (4 tests)
# - 压缩系统 (5 tests)
# - 日志系统 (3 tests)
# - 优化服务器集成 (4 tests)
# - 性能基准测试 (2 tests)
# - 集成测试 (1 test)
```

---

## 📊 本次更新内容

### 新增功能
1. **任务调度系统** - 基于 node-cron 的自动化任务调度
2. **自动化任务**:
   - Bundle 自动更新（每小时检查）
   - 存储清理（每天凌晨 2 点）
   - 健康检查（每 30 分钟）
3. **存储抽象层** - 支持本地和 S3 存储
4. **压缩系统** - 支持 Gzip、Brotli、Deflate
5. **结构化日志** - 多级别、文件轮转、彩色输出
6. **优化服务器** - 统一管理接口
7. **完整测试套件** - 28 个 Jest 测试

### 修复问题
- ESM 模块兼容性问题
- TypeScript 类型错误
- 存储适配器 require 改为 import
- Logger mtime Promise 处理
- 错误类型转换

### 依赖更新
- 新增: `node-cron`, `@types/node-cron`
- 新增开发依赖: `jest`, `ts-jest`, `@jest/globals`, `@types/jest`

---

## 📝 开发命令

```bash
# 开发模式（热重载）
npm run dev

# 构建
npm run build

# 类型检查
npm run typecheck

# 运行测试
npm test

# Smoke 测试
npm run smoke
```

---

## 📄 许可证

MIT
