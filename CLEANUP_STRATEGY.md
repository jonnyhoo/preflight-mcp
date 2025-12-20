# MCP架构下的Bundle清理策略

## 问题：为什么不能用定期清理？

MCP服务器是**按需启动**的架构：
- ✅ 客户端连接时启动
- ✅ 客户端断开后关闭
- ❌ 不是24/7运行的守护进程

**传统的cron定期清理不适用**，因为：
1. 没有常驻进程
2. 无法保证定期执行
3. 需要额外的后台服务

---

## 解决方案：按需清理架构

### 方案1：启动时清理 ✅ (已实施)

**设计思路**：
- 每次MCP服务器启动时自动清理
- 非阻塞、最佳努力模式
- 失败不影响服务器启动

**实现**：
```typescript
// src/server.ts
export async function startServer(): Promise<void> {
  const cfg = getConfig();
  
  // 启动时清理（后台执行，不阻塞）
  cleanupOnStartup(cfg).catch(() => {
    // 已记录日志，不抛出错误
  });
  
  const server = new McpServer(...);
  // ... 注册工具 ...
}
```

**特点**：
- ⚡ 无孤儿时非常快（只扫描目录）
- 🛡️ 安全边界：只删除>1小时的孤儿bundle
- 📝 自动记录日志
- 🔄 每次客户端连接都会触发

**触发频率**：
- Claude Desktop启动时
- Cursor/Cline连接时
- 任何MCP客户端连接时

---

### 方案2：手动清理工具 ✅ (已实施)

**工具名**：`preflight_cleanup_orphans`

**使用方式**：
```typescript
// 查看孤儿bundle（不删除）
{
  "name": "preflight_cleanup_orphans",
  "arguments": {
    "dryRun": true,
    "minAgeHours": 1
  }
}

// 实际清理
{
  "name": "preflight_cleanup_orphans",
  "arguments": {
    "dryRun": false,
    "minAgeHours": 1
  }
}
```

**参数说明**：
- `dryRun` (默认true): 只报告不删除
- `minAgeHours` (默认1): 只清理超过N小时的孤儿

**输出示例**：
```json
{
  "totalFound": 5,
  "totalCleaned": 3,
  "details": [
    {
      "storageDir": "E:\\coding",
      "found": ["uuid1", "uuid2", "uuid3"],
      "cleaned": ["uuid1", "uuid2"],
      "skipped": [
        {
          "bundleId": "uuid3",
          "reason": "too new (0.5h < 1h)"
        }
      ]
    }
  ]
}
```

---

### 方案3：外部定期清理（可选）

如果真的需要定期清理，可以通过**系统任务计划**调用独立脚本：

#### Windows任务计划
```powershell
# 创建每日清理任务
$action = New-ScheduledTaskAction -Execute "node" -Argument "scripts/cleanup.mjs"
$trigger = New-ScheduledTaskTrigger -Daily -At "3:00AM"
Register-ScheduledTask -TaskName "PreflightCleanup" -Action $action -Trigger $trigger
```

#### Linux/macOS cron
```bash
# 添加到crontab
0 3 * * * cd /path/to/preflight-mcp && node scripts/cleanup.mjs
```

#### 独立清理脚本
```javascript
// scripts/cleanup.mjs
import { getConfig } from '../dist/config.js';
import { cleanupOrphanBundles } from '../dist/bundle/cleanup.js';

const cfg = getConfig();
const result = await cleanupOrphanBundles(cfg, {
  minAgeHours: 24, // 更保守：只清理24小时前的
  dryRun: false,
});

console.log(`Cleaned ${result.totalCleaned} orphan bundles`);
```

---

## 清理逻辑

### 什么是孤儿bundle？

满足以下条件之一：
1. ✅ `manifest.json` 不存在
2. ✅ `manifest.json` 无法解析
3. ✅ `manifest.json` 缺少必需字段（bundleId, schemaVersion）

### 清理流程

```
1. 扫描存储目录
   ├─ 只处理UUID格式的目录名
   └─ 跳过非UUID目录（如#recycle, tmp）

2. 检查manifest
   ├─ 有效 → 跳过（健康bundle）
   └─ 无效 → 标记为孤儿

3. 检查年龄
   ├─ < minAgeHours → 跳过（可能正在创建）
   └─ >= minAgeHours → 删除

4. 删除
   ├─ 成功 → 记录日志
   └─ 失败 → 记录跳过原因
```

### 安全机制

1. **年龄阈值** (默认1小时)
   - 避免删除正在创建的bundle
   - 防止竞态条件

2. **UUID验证**
   - 只处理有效UUID格式的目录
   - 保护用户自定义目录

3. **最佳努力模式**
   - 失败不影响主流程
   - 自动记录日志

4. **dry-run模式**
   - 默认只检查不删除
   - 用户明确确认后才删除

---

## 性能分析

### 启动时清理开销

**无孤儿时**（常见情况）：
- 扫描目录：< 10ms
- 总开销：可忽略不计

**有孤儿时**（罕见）：
- 每个孤儿：检查manifest (1ms) + 删除 (10-100ms)
- 5个孤儿：约0.5秒

**并行处理**：
- 多个存储目录并行扫描
- 不阻塞服务器启动

### 对用户的影响

✅ **几乎零感知**：
- 启动时间增加 < 100ms
- 后台执行不阻塞
- 只记录日志不弹窗

---

## 对比方案

| 方案 | 优点 | 缺点 | 适用性 |
|------|------|------|--------|
| **启动时清理** | 零配置、自动执行 | 依赖客户端连接频率 | ✅ 推荐 |
| **手动清理** | 用户完全控制 | 需要手动触发 | ✅ 推荐 |
| **定期清理守护进程** | 定时执行 | ❌ 需要额外进程 | ❌ 不适用MCP |
| **外部cron** | 独立运行 | 需要系统配置 | ⚠️ 可选 |

---

## 使用建议

### 日常使用
- ✅ 依赖启动时自动清理
- ✅ 定期检查日志确认无异常
- ✅ 不需要手动干预

### 问题排查
```bash
# 1. 检查是否有孤儿（dry-run）
调用 preflight_cleanup_orphans with dryRun=true

# 2. 清理孤儿
调用 preflight_cleanup_orphans with dryRun=false

# 3. 验证
调用 preflight_list_bundles
```

### 大量孤儿（罕见）
如果有很多孤儿bundle（>20个）：
1. 使用 `minAgeHours=0` 立即清理
2. 或直接删除存储目录重新开始

---

## 未来改进

### 可能的优化
1. **增量扫描**：记录上次清理时间，跳过未修改的目录
2. **并发删除**：并行删除多个孤儿bundle
3. **通知机制**：清理完成后通知客户端

### 不推荐的方案
1. ❌ 独立守护进程（违反MCP设计理念）
2. ❌ 定时轮询（浪费资源）
3. ❌ 数据库追踪（过度设计）

---

## 总结

**MCP架构的清理策略**：
- 🎯 **核心**：启动时自动清理
- 🔧 **辅助**：手动清理工具
- 🚫 **不适用**：定期守护进程

**设计原则**：
- 简单 > 复杂
- 按需 > 定期
- 安全 > 激进
- 自动 > 手动

这种设计既解决了孤儿bundle问题，又符合MCP按需启动的架构特点。
