# 问题根因分析与解决方案

## 问题1：delete通讯阻塞

### 根本原因
1. **Windows文件系统特性**：在Windows上删除大目录时，`fs.rm(path, {recursive: true})` 可能需要很长时间
2. **同步阻塞**：`clearBundleMulti()` 在循环中串行删除，每个storageDirs都会等待前一个完成
3. **没有超时机制**：MCP客户端有默认超时（通常10秒），但服务端删除操作没有超时控制

### 代码位置
```typescript
// src/bundle/service.ts:1784-1803
export async function clearBundleMulti(storageDirs: string[], bundleId: string): Promise<boolean> {
  let deleted = false;
  for (const dir of storageDirs) {  // 串行循环
    try {
      const paths = getBundlePaths(dir, bundleId);
      await fs.stat(paths.rootDir);
      await clearBundle(dir, bundleId);  // 阻塞点：可能很慢
      deleted = true;
    } catch {
      // Skip unavailable paths
    }
  }
  return deleted;
}
```

### 解决方案
**方案A：并行删除 + 快速响应**
```typescript
export async function clearBundleMulti(storageDirs: string[], bundleId: string): Promise<boolean> {
  let deleted = false;
  
  // 并行删除所有存储目录
  const deletePromises = storageDirs.map(async (dir) => {
    try {
      const paths = getBundlePaths(dir, bundleId);
      await fs.stat(paths.rootDir);
      await clearBundle(dir, bundleId);
      return true;
    } catch {
      return false;
    }
  });
  
  const results = await Promise.allSettled(deletePromises);
  deleted = results.some(r => r.status === 'fulfilled' && r.value === true);
  
  return deleted;
}
```

**方案B：后台删除（推荐）**
```typescript
export async function clearBundleMulti(storageDirs: string[], bundleId: string): Promise<boolean> {
  let deleted = false;
  
  for (const dir of storageDirs) {
    try {
      const paths = getBundlePaths(dir, bundleId);
      const exists = await fs.stat(paths.rootDir).then(() => true).catch(() => false);
      
      if (exists) {
        // 标记为删除（重命名为.deleting后缀）
        const deletingPath = `${paths.rootDir}.deleting`;
        try {
          await fs.rename(paths.rootDir, deletingPath);
          deleted = true;
          
          // 后台异步删除（不等待）
          clearBundle(dir, `${bundleId}.deleting`).catch(err => {
            logger.error(`Background delete failed for ${bundleId}`, err);
          });
        } catch {
          // Rename failed, skip
        }
      }
    } catch {
      // Skip unavailable paths
    }
  }
  
  return deleted;
}
```

---

## 问题2：为什么会有空目录

### 根本原因
**bundle创建流程存在间隙窗口**：

```typescript
// src/bundle/service.ts:930-1165
async function createBundleInternal(...) {
  const bundleId = crypto.randomUUID();        // 952行：生成ID
  const paths = getBundlePaths(..., bundleId); // 959行
  await ensureDir(paths.rootDir);              // 960行：创建目录 ⚠️
  
  let bundleCreated = false;
  
  try {
    bundleCreated = true;  // 968行：设置标志 ⚠️ 间隙！
    
    // 970-1139行：大量耗时操作
    // - 克隆GitHub仓库
    // - 生成索引
    // - 写入manifest
    // - 验证完整性
    
  } catch (err) {
    if (bundleCreated) {  // 1156行：只有设置标志后才清理
      await cleanupFailedBundle(cfg, bundleId);
    }
    throw new Error(`Failed to create bundle: ${errorMsg}`);
  }
}
```

### 产生空目录的场景
1. **间隙窗口**：在960行（创建目录）和968行（设置标志）之间如果失败，不会清理
2. **进程被杀**：用户Ctrl+C或系统崩溃时，cleanup永远不会执行
3. **验证失败**：在1133-1139行验证失败后，虽然会清理，但如果cleanup本身失败，目录残留
4. **网络中断**：克隆GitHub时网络断开，创建了部分内容但没有manifest

### 具体代码问题
```typescript
// 960行：目录已创建
await ensureDir(paths.rootDir);

let bundleCreated = false;  // 但标志还是false

// 965-967行：如果这里抛异常，不会清理！
const allIngestedFiles: IngestedFile[] = [];
const reposSummary: BundleSummary['repos'] = [];

try {
  bundleCreated = true;  // 968行：太晚了
```

---

## 问题3：如何从源头杜绝

### 解决方案1：原子性创建（推荐）
使用临时目录 + 原子rename模式：

```typescript
async function createBundleInternal(...) {
  const bundleId = crypto.randomUUID();
  
  // 1. 在临时目录创建
  const tmpBundlePath = path.join(cfg.tmpDir, 'bundles', bundleId);
  await ensureDir(tmpBundlePath);
  
  try {
    // 2. 所有操作都在临时目录完成
    const tmpPaths = getBundlePaths(cfg.tmpDir + '/bundles', bundleId);
    
    // ... 克隆、索引、生成manifest等 ...
    
    // 3. 验证完整性
    const validation = await validateBundleCompleteness(tmpPaths.rootDir);
    if (!validation.isValid) {
      throw new Error(`Bundle incomplete: ${validation.missingComponents.join(', ')}`);
    }
    
    // 4. 原子性移动到最终位置（只有完全成功才可见）
    const finalPath = path.join(effectiveStorageDir, bundleId);
    await fs.rename(tmpBundlePath, finalPath);
    
    // 5. 镜像到备份目录
    if (cfg.storageDirs.length > 1) {
      await mirrorBundleToBackups(effectiveStorageDir, cfg.storageDirs, bundleId);
    }
    
    return summary;
    
  } catch (err) {
    // 6. 失败清理：只需删除临时目录
    await rmIfExists(tmpBundlePath);
    throw err;
  } finally {
    // 7. 确保临时目录被清理（双保险）
    await rmIfExists(tmpBundlePath).catch(() => {});
  }
}
```

**优点**：
- ✅ 原子性：要么完全成功，要么完全不可见
- ✅ 进程崩溃安全：临时目录在/tmp下，系统重启会自动清理
- ✅ 不会产生不健康的bundle

### 解决方案2：后台清理守护进程
定期清理孤儿bundle：

```typescript
// src/bundle/janitor.ts
import cron from 'node-cron';

export function startBundleJanitor(cfg: PreflightConfig) {
  // 每小时运行一次清理
  cron.schedule('0 * * * *', async () => {
    logger.info('Running bundle janitor...');
    await cleanupOrphanBundles(cfg);
  });
}

async function cleanupOrphanBundles(cfg: PreflightConfig) {
  for (const storageDir of cfg.storageDirs) {
    const entries = await fs.readdir(storageDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!isValidBundleId(entry.name)) continue;
      
      const bundlePath = path.join(storageDir, entry.name);
      const manifestPath = path.join(bundlePath, 'manifest.json');
      
      try {
        // 检查manifest是否存在且有效
        const manifest = await fs.readFile(manifestPath, 'utf8');
        JSON.parse(manifest);
      } catch {
        // manifest缺失或无效
        const stats = await fs.stat(bundlePath);
        const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
        
        // 超过1小时的孤儿bundle，删除
        if (ageHours > 1) {
          logger.warn(`Cleaning up orphan bundle: ${entry.name} (age: ${ageHours.toFixed(1)}h)`);
          await rmIfExists(bundlePath);
        }
      }
    }
  }
}
```

### 解决方案3：健康检查API
添加主动健康检查工具：

```typescript
// 在server.ts中注册新工具
server.registerTool(
  'preflight_cleanup_orphans',
  {
    title: 'Cleanup orphan bundles',
    description: 'Remove incomplete or corrupted bundles automatically.',
    inputSchema: {
      dryRun: z.boolean().default(true).describe('If true, only report without deleting.'),
      olderThanHours: z.number().default(1).describe('Only clean bundles older than N hours.'),
    },
  },
  async (args) => {
    const orphans = [];
    
    for (const storageDir of cfg.storageDirs) {
      const ids = await listBundles(storageDir);
      
      for (const id of ids) {
        const paths = getBundlePathsForId(storageDir, id);
        const validation = await validateBundleCompleteness(paths.rootDir);
        
        if (!validation.isValid) {
          const stats = await fs.stat(paths.rootDir);
          const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
          
          if (ageHours >= args.olderThanHours) {
            orphans.push({ bundleId: id, ageHours, missing: validation.missingComponents });
            
            if (!args.dryRun) {
              await clearBundle(storageDir, id);
            }
          }
        }
      }
    }
    
    return {
      content: [{ type: 'text', text: JSON.stringify(orphans, null, 2) }],
      structuredContent: { orphans, cleaned: !args.dryRun },
    };
  }
);
```

---

## 实施建议

### 优先级1（立即实施）
1. ✅ **已完成**：list方法过滤非UUID目录
2. ✅ **已完成**：delete方法支持删除无manifest的bundle
3. **待实施**：delete方法改为后台删除（解决超时）

### 优先级2（本周内）
1. **原子性创建**：使用临时目录模式重构createBundle
2. **后台清理**：启动janitor定期清理孤儿bundle

### 优先级3（可选）
1. 添加 `preflight_cleanup_orphans` 工具
2. 添加bundle创建进度通知
3. 添加bundle锁机制防止并发冲突

---

## 测试验证

### 测试场景
1. ✅ 正常创建bundle
2. ✅ 创建过程中Ctrl+C（应该不产生孤儿）
3. ✅ 网络中断时创建bundle（应该回滚）
4. ✅ 删除大bundle（应该快速响应）
5. ✅ list不显示非UUID目录
6. ✅ 定期清理能发现并删除孤儿bundle
