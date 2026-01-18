# Analyzer 模块设计规范

本文档定义 `src/bundle/analyzers/` 目录下分析器模块的统一设计规范。所有分析器实现必须遵循本规范。

## 1. Analyzer 统一接口定义

### 1.1 基础接口

```typescript path=null start=null
/**
 * 分析器输入配置
 */
export type AnalyzerInput = {
  bundleRoot: string;           // Bundle 根目录绝对路径
  files: IngestedFile[];        // 已摄取的文件列表
  manifest: BundleManifest;     // Bundle 清单
  facts?: BundleFacts;          // 可选的已提取 facts
};

/**
 * 分析器输出结果
 */
export type AnalyzerOutput<T = unknown> = {
  success: boolean;             // 分析是否成功
  data?: T;                     // 分析结果数据
  errors?: AnalyzerError[];     // 错误列表（非致命错误可继续）
  metadata: {
    analyzerName: string;       // 分析器名称
    version: string;            // 分析器版本
    durationMs: number;         // 执行耗时（毫秒）
    filesAnalyzed: number;      // 分析的文件数
  };
};

/**
 * 分析器错误
 */
export type AnalyzerError = {
  code: string;                 // 错误码 (如 'PARSE_ERROR', 'FILE_NOT_FOUND')
  message: string;              // 错误描述
  file?: string;                // 关联文件路径
  line?: number;                // 关联行号
  recoverable: boolean;         // 是否可恢复（继续分析其他文件）
};

/**
 * 分析器配置选项
 */
export type AnalyzerOptions = {
  enabled?: boolean;            // 是否启用（默认 true）
  timeout?: number;             // 超时时间（毫秒，默认 30000）
  maxFiles?: number;            // 最大分析文件数（0 = 无限制）
  includePatterns?: string[];   // 文件包含模式（glob）
  excludePatterns?: string[];   // 文件排除模式（glob）
};
```

### 1.2 Analyzer 抽象基类

```typescript path=null start=null
/**
 * 所有分析器必须继承此基类
 */
export abstract class BaseAnalyzer<TOutput = unknown, TOptions extends AnalyzerOptions = AnalyzerOptions> {
  /** 分析器唯一名称 */
  abstract readonly name: string;
  
  /** 分析器版本（遵循 semver） */
  abstract readonly version: string;
  
  /** 分析器描述 */
  abstract readonly description: string;
  
  protected readonly options: Required<TOptions>;
  protected readonly logger: ILogger;
  
  constructor(options?: Partial<TOptions>) {
    this.options = this.mergeOptions(options);
    this.logger = createModuleLogger(`analyzer:${this.name}`);
  }
  
  /** 执行分析 */
  abstract analyze(input: AnalyzerInput): Promise<AnalyzerOutput<TOutput>>;
  
  /** 验证输入是否有效 */
  protected validateInput(input: AnalyzerInput): AnalyzerError[] {
    // 默认实现，子类可覆盖
  }
  
  /** 合并默认选项与用户选项 */
  protected abstract mergeOptions(options?: Partial<TOptions>): Required<TOptions>;
  
  /** 过滤要分析的文件 */
  protected filterFiles(files: IngestedFile[]): IngestedFile[] {
    // 根据 includePatterns 和 excludePatterns 过滤
  }
}
```

### 1.3 工厂函数模式

每个分析器必须提供工厂函数：

```typescript path=null start=null
// 导出工厂函数（推荐使用方式）
export function createMyAnalyzer(options?: Partial<MyAnalyzerOptions>): MyAnalyzer {
  return new MyAnalyzer(options);
}

// 同时导出类（供类型引用和继承）
export class MyAnalyzer extends BaseAnalyzer<MyOutput, MyAnalyzerOptions> {
  // ...
}
```

## 2. 模块结构规范

### 2.1 目录结构

```
src/bundle/analyzers/
├── DESIGN.md              # 本设计规范文档
├── index.ts               # 公共导出入口
├── types.ts               # 共享类型定义
├── base-analyzer.ts       # 基类实现
├── utils.ts               # 共享工具函数
├── <analyzer-name>/       # 分析器子目录（复杂分析器）
│   ├── index.ts           # 分析器入口
│   ├── types.ts           # 分析器专用类型
│   └── helpers.ts         # 内部辅助函数
└── <simple-analyzer>.ts   # 简单分析器单文件
```

### 2.2 文件命名

- 文件名使用 **kebab-case**：`my-analyzer.ts`, `code-quality.ts`
- 测试文件后缀 `.test.ts`：`my-analyzer.test.ts`
- 类型定义文件：`types.ts`

### 2.3 导出规范

`index.ts` 统一导出：

```typescript path=null start=null
// src/bundle/analyzers/index.ts

// 基础设施
export { BaseAnalyzer } from './base-analyzer.js';
export type * from './types.js';

// 各分析器工厂函数
export { createCodeQualityAnalyzer } from './code-quality.js';
export { createSecurityAnalyzer } from './security/index.js';
export { createDependencyAnalyzer } from './dependency.js';

// 类型导出（供继承使用）
export type { CodeQualityAnalyzer } from './code-quality.js';
export type { SecurityAnalyzer } from './security/index.js';
```

## 3. 命名规范

### 3.1 类型命名

| 类别 | 格式 | 示例 |
|------|------|------|
| 类型别名 | PascalCase | `AnalyzerOutput`, `FileMetrics` |
| 接口 | PascalCase + I前缀（仅限抽象契约） | `IAnalyzer` |
| 枚举 | PascalCase | `AnalysisLevel` |
| 泛型参数 | 单字母大写或短PascalCase | `T`, `TOutput`, `TOptions` |

### 3.2 变量命名

| 类别 | 格式 | 示例 |
|------|------|------|
| 局部变量 | camelCase | `fileCount`, `analysisResult` |
| 函数名 | camelCase | `analyzeFile`, `computeMetrics` |
| 类名 | PascalCase | `CodeQualityAnalyzer` |
| 常量 | UPPER_SNAKE_CASE | `DEFAULT_TIMEOUT_MS`, `MAX_FILES` |
| 私有成员 | 无下划线前缀 | `private logger`, `private options` |

### 3.3 文件命名

| 类别 | 格式 | 示例 |
|------|------|------|
| 模块文件 | kebab-case | `code-quality.ts` |
| 测试文件 | kebab-case + .test | `code-quality.test.ts` |
| 类型文件 | types.ts | `types.ts` |

## 4. 错误处理规范

### 4.1 错误类定义

继承项目标准错误类：

```typescript path=null start=null
import { PreflightError } from '../../errors.js';

/**
 * 分析器基础错误
 */
export class AnalyzerError extends PreflightError {
  constructor(
    message: string,
    code: string,
    options?: {
      context?: Record<string, unknown>;
      cause?: Error;
      recoverable?: boolean;
    }
  ) {
    super(message, `ANALYZER_${code}`, options);
    this.name = 'AnalyzerError';
  }
}

/**
 * 分析超时错误
 */
export class AnalyzerTimeoutError extends AnalyzerError {
  constructor(analyzerName: string, timeoutMs: number) {
    super(
      `Analyzer "${analyzerName}" timed out after ${timeoutMs}ms`,
      'TIMEOUT',
      { context: { analyzerName, timeoutMs }, recoverable: false }
    );
    this.name = 'AnalyzerTimeoutError';
  }
}

/**
 * 文件分析错误（可恢复）
 */
export class FileAnalysisError extends AnalyzerError {
  constructor(filePath: string, reason: string, cause?: Error) {
    super(
      `Failed to analyze file "${filePath}": ${reason}`,
      'FILE_ANALYSIS_ERROR',
      { context: { filePath }, cause, recoverable: true }
    );
    this.name = 'FileAnalysisError';
  }
}
```

### 4.2 错误处理模式

```typescript path=null start=null
async analyze(input: AnalyzerInput): Promise<AnalyzerOutput<MyOutput>> {
  const startTime = Date.now();
  const errors: AnalyzerError[] = [];
  let filesAnalyzed = 0;
  
  try {
    const files = this.filterFiles(input.files);
    const results: FileResult[] = [];
    
    for (const file of files) {
      try {
        const result = await this.analyzeFile(file);
        results.push(result);
        filesAnalyzed++;
      } catch (err) {
        // 可恢复错误：记录并继续
        const error = err instanceof AnalyzerError 
          ? err 
          : new FileAnalysisError(file.repoRelativePath, String(err), err as Error);
        
        if (error.context?.recoverable !== false) {
          errors.push({
            code: error.code,
            message: error.message,
            file: file.repoRelativePath,
            recoverable: true,
          });
          this.logger.warn(`File analysis failed, skipping`, { file: file.repoRelativePath, error: error.message });
          continue;
        }
        
        // 不可恢复错误：抛出
        throw error;
      }
    }
    
    return {
      success: true,
      data: this.aggregateResults(results),
      errors: errors.length > 0 ? errors : undefined,
      metadata: {
        analyzerName: this.name,
        version: this.version,
        durationMs: Date.now() - startTime,
        filesAnalyzed,
      },
    };
  } catch (err) {
    this.logger.error(`Analysis failed`, err as Error);
    return {
      success: false,
      errors: [{
        code: err instanceof AnalyzerError ? err.code : 'UNKNOWN_ERROR',
        message: String(err),
        recoverable: false,
      }],
      metadata: {
        analyzerName: this.name,
        version: this.version,
        durationMs: Date.now() - startTime,
        filesAnalyzed,
      },
    };
  }
}
```

## 5. 日志规范

### 5.1 日志级别使用

| 级别 | 用途 |
|------|------|
| `debug` | 详细调试信息（文件级处理、中间状态） |
| `info` | 重要操作节点（分析开始/结束、汇总信息） |
| `warn` | 可恢复问题（文件跳过、降级处理） |
| `error` | 分析失败（不可恢复错误） |

### 5.2 日志格式

```typescript path=null start=null
import { createModuleLogger } from '../../logging/logger.js';

export class MyAnalyzer extends BaseAnalyzer<MyOutput> {
  private readonly logger = createModuleLogger('analyzer:my-analyzer');
  
  async analyze(input: AnalyzerInput): Promise<AnalyzerOutput<MyOutput>> {
    this.logger.info('Starting analysis', { 
      bundleRoot: input.bundleRoot,
      fileCount: input.files.length,
    });
    
    // 处理过程
    this.logger.debug('Processing file', { file: 'src/index.ts' });
    
    // 警告（可恢复）
    this.logger.warn('File skipped due to encoding issue', { 
      file: 'data/binary.dat',
      reason: 'unsupported encoding',
    });
    
    // 错误（记录但可能继续）
    this.logger.error('File analysis failed', new Error('Parse error'), {
      file: 'src/broken.ts',
    });
    
    this.logger.info('Analysis complete', {
      filesAnalyzed: 100,
      durationMs: 1234,
    });
  }
}
```

## 6. 测试规范

### 6.1 测试文件结构

```typescript path=null start=null
// tests/bundle/analyzers/my-analyzer.test.ts

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createMyAnalyzer } from '../../../src/bundle/analyzers/index.js';
import type { AnalyzerInput, IngestedFile } from '../../../src/bundle/analyzers/types.js';

// ESM 兼容
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('MyAnalyzer', () => {
  let tmpDir: string;
  
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(tmpdir(), 'preflight-test-'));
  });
  
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  
  describe('analyze', () => {
    it('should return success for valid input', async () => {
      const analyzer = createMyAnalyzer();
      const input = createMockInput(tmpDir);
      
      const result = await analyzer.analyze(input);
      
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.metadata.analyzerName).toBe('my-analyzer');
    });
    
    it('should handle empty file list', async () => {
      const analyzer = createMyAnalyzer();
      const input = createMockInput(tmpDir, []);
      
      const result = await analyzer.analyze(input);
      
      expect(result.success).toBe(true);
      expect(result.metadata.filesAnalyzed).toBe(0);
    });
    
    it('should collect recoverable errors without failing', async () => {
      const analyzer = createMyAnalyzer();
      const input = createMockInputWithBadFile(tmpDir);
      
      const result = await analyzer.analyze(input);
      
      expect(result.success).toBe(true);
      expect(result.errors).toBeDefined();
      expect(result.errors?.some(e => e.recoverable)).toBe(true);
    });
  });
  
  describe('options', () => {
    it('should respect maxFiles option', async () => {
      const analyzer = createMyAnalyzer({ maxFiles: 5 });
      const input = createMockInput(tmpDir, generateFiles(10));
      
      const result = await analyzer.analyze(input);
      
      expect(result.metadata.filesAnalyzed).toBeLessThanOrEqual(5);
    });
  });
});

// 测试辅助函数
function createMockInput(bundleRoot: string, files?: IngestedFile[]): AnalyzerInput {
  return {
    bundleRoot,
    files: files ?? [createMockFile('src/index.ts')],
    manifest: createMockManifest(),
  };
}

function createMockFile(relativePath: string): IngestedFile {
  return {
    repoRelativePath: relativePath,
    bundleNormRelativePath: `repos/test/norm/${relativePath}`,
    bundleNormAbsPath: `/tmp/bundle/repos/test/norm/${relativePath}`,
    kind: 'code',
    repoId: 'test/repo',
  };
}
```

### 6.2 测试命名规范

- 使用 `describe` 分组：外层为类/模块名，内层为方法名
- 使用 `it` 描述具体行为，格式：`should <expected behavior> [when <condition>]`
- 优先测试公共 API，避免测试私有实现细节

### 6.3 测试覆盖要求

- 正常流程（happy path）
- 边界条件（空输入、最大值等）
- 错误处理（可恢复/不可恢复错误）
- 配置选项生效验证

## 7. 代码风格

### 7.1 导入顺序

```typescript path=null start=null
// 1. Node.js 内置模块
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// 2. 外部依赖（按字母排序）
import { SomeType } from 'external-package';

// 3. 项目内部模块（按相对路径深度排序）
import { PreflightError } from '../../errors.js';
import { createModuleLogger } from '../../logging/logger.js';
import type { IngestedFile } from '../ingest.js';

// 4. 同目录模块
import { BaseAnalyzer } from './base-analyzer.js';
import type { AnalyzerInput, AnalyzerOutput } from './types.js';
```

### 7.2 类型导入

优先使用 `import type` 导入纯类型：

```typescript path=null start=null
import type { IngestedFile, BundleManifest } from '../ingest.js';
import { createBundleFacts, type BundleFacts } from '../facts.js';
```

### 7.3 异步处理

- 始终使用 `async/await`，避免裸 Promise 链
- 并行处理使用 `Promise.all` 或 `Promise.allSettled`
- 需要限流时使用 `core/concurrency-limiter.js`

```typescript path=null start=null
// 并行分析文件（带限流）
import { ConcurrencyLimiter } from '../../core/concurrency-limiter.js';

const limiter = new ConcurrencyLimiter(10); // 最多 10 并发
const results = await Promise.all(
  files.map(file => limiter.run(() => this.analyzeFile(file)))
);
```

### 7.4 注释规范

- 公共 API 必须有 JSDoc 注释
- 复杂逻辑添加行内注释解释"为什么"
- 避免显而易见的注释

```typescript path=null start=null
/**
 * 分析代码质量指标
 * 
 * @param input - 分析器输入配置
 * @returns 分析结果，包含各项质量指标
 * 
 * @example
 * ```ts
 * const analyzer = createCodeQualityAnalyzer();
 * const result = await analyzer.analyze({ bundleRoot, files, manifest });
 * console.log(result.data.averageComplexity);
 * ```
 */
async analyze(input: AnalyzerInput): Promise<AnalyzerOutput<CodeQualityMetrics>> {
  // 排除测试文件以获得更准确的生产代码指标
  const productionFiles = files.filter(f => !f.repoRelativePath.includes('.test.'));
  
  // ...
}
```

## 8. 版本兼容性

### 8.1 分析器版本

每个分析器必须声明版本号（遵循 semver）：

- **MAJOR**: 输出格式不兼容变更
- **MINOR**: 新增分析能力，输出向后兼容
- **PATCH**: Bug 修复，行为不变

### 8.2 输出格式稳定性

分析器输出存储在 bundle 中，升级时需考虑：

- 新增字段使用可选类型 `field?: Type`
- 移除字段前先标记废弃，保留至少一个版本
- 类型变更需要版本号 MAJOR 升级
