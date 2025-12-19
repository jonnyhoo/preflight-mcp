# preflight-mcp

> [English](./README.md) | **中文**

一个 MCP (Model Context Protocol) **stdio** 服务器

## 📦 Bundle 包含内容

每个 bundle 包含：
- 仓库文档 + 代码的本地副本（规范化文本）
- 轻量级**全文搜索索引**（SQLite FTS5）
- 面向 AI Agent 的入口文件：`START_HERE.md`、`AGENTS.md` 和 `OVERVIEW.md`（仅事实，带证据指针）

## ✨ 功能特性

- **12 个工具** - 创建/更新/修复/搜索/验证/读取 bundles
- **去重** - 防止重复索引同一组（规范化后）输入
- **更可靠的 GitHub 获取** - 可配置 git clone 超时 + GitHub archive(zipball) 兜底
- **离线修复** - 索引/导读/指南缺失或为空时可重建（无需重新拉取）
- **静态事实提取** - 生成 `analysis/FACTS.json`（非 LLM）
- **基于证据的校验** - 用证据定位来减少幻觉
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

## 🛠️ 工具列表（共 12 个）

### 1. `preflight_list_bundles`
列出存储中的所有 bundle（稳定、最小化输出）。

### 2. `preflight_find_bundle`
给定输入（repos/libraries/topics），计算指纹并查找是否已有 bundle。
- 用途：UI/Agent 先查再决定是 create 还是 update。

### 3. `preflight_create_bundle`
从一个或多个输入创建新的 bundle。

关键语义（强一致性）：
- 默认 **去重**：相同规范化输入已经存在 bundle 时会拒绝创建。
- 通过 `ifExists` 指定策略：
  - `error`（默认）：拒绝重复创建
  - `returnExisting`：直接返回已有 bundle（不抓取）
  - `updateExisting`：更新已有 bundle（显式写盘行为）后返回
  - `createNew`：绕过去重强制新建
- GitHub 获取：浅克隆；若 `git clone` 失败，会使用 GitHub zipball 兜底。
- 支持 `local`：从本地目录导入（例如你手动下载 zip 解压后的目录）。

**输入示例**:
```json
{
  "repos": [
    { "kind": "github", "repo": "owner/repo" },
    { "kind": "local", "repo": "owner/repo", "path": "/path/to/dir" },
    { "kind": "deepwiki", "url": "https://deepwiki.com/owner/repo" }
  ],
  "libraries": ["nextjs", "react"],
  "topics": ["routing", "api"],
  "ifExists": "error"
}
```

### 4. `preflight_read_file`
从 bundle 读取文件（OVERVIEW.md、START_HERE.md、AGENTS.md 或任意仓库文件）。

### 5. `preflight_bundle_info`
获取 bundle 详情：repos、更新时间、索引信息、资源 URI 等。

### 6. `preflight_repair_bundle`
离线修复（不抓取）：当索引/导读/指南文件缺失或为空时，重建派生物。
- 可重建：`indexes/search.sqlite3`、`OVERVIEW.md`、`START_HERE.md`、`AGENTS.md`

### 7. `preflight_delete_bundle`
永久删除/移除一个 bundle。

### 8. `preflight_update_bundle`
刷新/同步 bundle 与最新的仓库更改。

可选参数：
- `checkOnly`: true 时仅检查是否有更新，不应用
- `force`: true 时强制重建（即使没有检测到更改）

### 9. `preflight_update_all_bundles`
批量更新所有 bundles。

### 10. `preflight_search_bundle`
在已导入的文档/代码中进行全文搜索（基于行的 SQLite FTS5）。

重要说明：**该工具严格只读**。
- `ensureFresh` / `maxAgeHours` 参数已 **废弃**，如果传入会直接报错。
- 如需更新：先调用 `preflight_update_bundle`，再搜索。
- 如需修复：先调用 `preflight_repair_bundle`，再搜索。

### 11. `preflight_search_by_tags`
按标签筛选后跨多个 bundle 搜索（基于行的 SQLite FTS5）。

说明：该工具只读，不会自动 repair/update。
- 如果某些 bundle 因索引缺失/损坏而无法搜索，会在输出的 `warnings` 中列出。

可选参数：
- `tags`: 标签过滤（例如 `["mcp", "agents"]`）
- `scope`: 搜索范围（`docs` / `code` / `all`）
- `limit`: 跨 bundle 的总命中数量上限

输出新增字段：
- `warnings?: [{ bundleId, kind, message }]`（非致命错误列表）
- `warningsTruncated?: true`（warnings 被截断）

### 12. `preflight_verify_claim`
在 bundle 中查找声明/陈述的证据。

重要说明：**该工具严格只读**。
- `ensureFresh` / `maxAgeHours` 参数已 **废弃**，如果传入会直接报错。
- 如需更新：先调用 `preflight_update_bundle`，再验证。
- 如需修复：先调用 `preflight_repair_bundle`，再验证。

---

## 📚 资源

### `preflight://bundles`
bundles 及其主要入口文件的静态 JSON 列表。

### `preflight://bundle/{bundleId}/file/{encodedPath}`
读取 bundle 内的特定文件。

**示例**:
- `preflight://bundle/<id>/file/START_HERE.md`
- `preflight://bundle/<id>/file/repos%2Fowner%2Frepo%2Fnorm%2FREADME.md`

## 🧾 错误语义（稳定、可解析，便于 UI 编排）
大多数工具错误会用稳定前缀包装：
- `[preflight_error kind=<kind>] <message>`

常见 kind：
- `bundle_not_found` / `file_not_found`
- `invalid_path`（路径越界/穿越尝试）
- `permission_denied`
- `index_missing_or_corrupt`
- `deprecated_parameter`
- `unknown`

UI/Agent 推荐按 kind 决策下一步：
- `index_missing_or_corrupt` → 调 `preflight_repair_bundle`
- 需要更新语义 → 调 `preflight_update_bundle`

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
| `PREFLIGHT_ANALYSIS_MODE` | 静态分析模式：`none`、`quick`（生成 `analysis/FACTS.json`） | `quick` |

### GitHub & Context7
| 变量 | 说明 | 默认值 |
|------|------|--------|
| `GITHUB_TOKEN` | GitHub API 令牌（公开仓库通常不需要；用于 GitHub API/zipball 兜底等） | - |
| `PREFLIGHT_GIT_CLONE_TIMEOUT_MS` | git clone 最大允许时间（毫秒），超时后会尝试 zipball 兜底 | 5 分钟 |
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
export PREFLIGHT_STORAGE_DIRS="$HOME/OneDrive/preflight;$HOME/Dropbox/preflight"
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
│   ├── analysis.ts         # 静态分析（FACTS.json）
│   ├── facts.ts            # 事实提取
│   └── ...                 # 其他 bundle 相关模块
├── search/
│   └── sqliteFts.ts        # SQLite FTS5 搜索
└── mcp/
    └── uris.ts             # URI 处理
```

---

## 🧪 测试

项目包含完整的测试套件（会持续增长，以 `npm test` 输出为准）：

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

## 📊 近期变更要点（面向使用者）

这一段只列出会影响工具使用/语义边界的变更（避免“只是代码变了但文档不变”）：

### 1) 工具语义更严格
- `preflight_search_bundle` / `preflight_verify_claim`：严格只读，不再隐式 update/repair（相关参数已废弃）。
- update/repair 必须显式调用对应工具。

### 2) 去重与查找
- 新增输入指纹（fingerprint）与去重策略。
- 新增 `preflight_find_bundle` 便于 UI 先查再决定 create/update。

### 3) 获取可靠性增强
- git clone 超时可配置，失败时 GitHub zipball 兜底。
- 支持 local 目录导入（例如你手动下载 zip 解压后导入）。

### 4) 离线修复与可观测错误
- 新增 `preflight_repair_bundle`：离线重建索引/导读/指南。
- 错误输出采用稳定前缀：`[preflight_error kind=...]`，方便 UI 编排。
- `preflight_search_by_tags` 增加 `warnings`，不再静默吞错。

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
