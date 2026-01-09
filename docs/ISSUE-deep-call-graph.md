# Issue: 深层调用图支持（Deep Call Graph）

## 背景 / Why

当前 Preflight 的 `dependency_graph` 提供：
- **Import 级别**：文件 A 导入文件 B（准确，基于 AST）
- **Call 级别**：函数 A 调用函数 B（启发式，基于 FTS + 名称匹配，置信度 0.6）

**问题**：
1. Import 图无法回答"函数 X 被谁调用"
2. 启发式 call 检测误报多、漏检多
3. 无法支持"安全提取可复用代码"场景

## 目标 / Goals

1. 提供**符号级别**的调用图（function/method/class 级别）
2. 支持主流语言：TypeScript/JavaScript、Python、Go
3. 保持 Preflight 的"证据化"特性（每条边有 sources/confidence）
4. 性能可接受（大型项目 < 60s）

## 非目标 / Non-Goals

- 不做运行时调用分析（动态语言的动态调用无法静态分析）
- 不做跨仓库调用分析
- 不要求 100% 覆盖（复杂反射/动态调用可标记为 "unknown"）

---

## 技术方案

### 方案 A：Tree-sitter + 符号表（推荐）

**原理**：
1. 用 Tree-sitter 解析 AST，提取所有符号定义（函数、类、方法）
2. 构建符号表：`{ symbolName → { file, range, kind } }`
3. 遍历 AST 中的调用表达式，解析到符号表
4. 输出调用边：`{ caller: Symbol, callee: Symbol, callSite: SourceRef }`

**优点**：
- Tree-sitter 已集成（WASM）
- 跨语言统一架构
- 不需要类型系统

**缺点**：
- 无法解析动态类型（`obj.method()` 中 `obj` 的类型）
- 重载方法无法区分

**实现步骤**：
1. 扩展 `ast/treeSitter.ts`：新增 `extractSymbols()` 和 `extractCalls()`
2. 两遍扫描：Pass 1 收集符号 → Pass 2 解析调用
3. 输出新的 edge 类型：`calls_symbol`

### 方案 B：LSP 集成（更精确但更复杂）

**原理**：
- 启动语言服务器（tsserver、pylsp、gopls）
- 使用 `textDocument/references` 和 `callHierarchy` 请求

**优点**：
- 类型精确
- 处理重载、泛型、动态类型

**缺点**：
- 需要项目可编译（依赖安装）
- 启动慢，资源消耗大
- 每种语言需要单独配置

**结论**：作为 Phase 2 考虑，Phase 1 先用 Tree-sitter

---

## 数据模型

### 新增符号节点类型

```typescript
type SymbolNode = {
  id: string;           // "symbol:functionName@file#line"
  kind: 'function' | 'method' | 'class' | 'variable';
  name: string;
  file: string;         // bundle-relative path
  range: SourceRange;
  parent?: string;      // 所属类/模块的 id
  signature?: string;   // 函数签名（可选）
  exported: boolean;
};
```

### 新增调用边类型

```typescript
type CallEdge = {
  evidenceId: string;
  kind: 'edge';
  type: 'calls_symbol';
  from: string;         // caller symbol id
  to: string;           // callee symbol id
  callSite: SourceRef;  // 调用发生的位置
  method: 'exact' | 'heuristic';
  confidence: number;   // exact: 0.95, heuristic: 0.7
  notes: string[];
};
```

---

## 语言支持计划

### Phase 1：TypeScript/JavaScript

**解析要点**：
- 函数声明：`function foo()`, `const foo = () =>`, `class.method()`
- 调用表达式：`foo()`, `obj.foo()`, `new Foo()`
- 导出分析：`export function`, `module.exports`

**Tree-sitter 查询示例**：
```scheme
; 函数定义
(function_declaration name: (identifier) @func_name)
(arrow_function) @arrow_func
(method_definition name: (property_identifier) @method_name)

; 调用表达式
(call_expression function: (identifier) @callee)
(call_expression function: (member_expression property: (property_identifier) @callee))
```

### Phase 2：Python

**解析要点**：
- 函数/方法：`def foo():`, `class Foo: def bar():`
- 调用：`foo()`, `self.foo()`, `Foo()`
- 装饰器处理

### Phase 3：Go

**解析要点**：
- 函数：`func foo()`, `func (r Receiver) foo()`
- 方法调用：`obj.Foo()`, `pkg.Foo()`
- 接口方法

---

## API 设计

### 扩展 dependency_graph 选项

```typescript
options: {
  // ...existing options...
  
  /** 是否包含符号级调用图 */
  includeCallGraph: boolean = false,
  
  /** 调用图深度限制（防止爆炸） */
  callGraphDepth: number = 3,
  
  /** 只分析指定符号的调用链 */
  callGraphRoots?: string[],  // e.g., ["parseConfig", "main"]
}
```

### 新增返回结构

```typescript
type DependencyGraphResult = {
  // ...existing fields...
  
  callGraph?: {
    symbols: SymbolNode[];
    calls: CallEdge[];
    stats: {
      totalSymbols: number;
      totalCalls: number;
      perLanguage: Record<string, { symbols: number; calls: number }>;
    };
  };
};
```

---

## 性能考量

| 项目规模 | 文件数 | 预计符号数 | 预计耗时 |
|---------|--------|-----------|---------|
| 小型 | <100 | <1000 | <5s |
| 中型 | 100-500 | 1000-10000 | 5-30s |
| 大型 | 500-2000 | 10000-50000 | 30-60s |

**优化策略**：
1. 增量分析：缓存符号表，只重新分析变更文件
2. 并行解析：多线程处理不同文件
3. 懒加载：先返回 import 图，call 图异步生成
4. 范围限制：`callGraphRoots` 只分析指定入口的调用链

---

## 验收标准

- [ ] TypeScript/JavaScript 调用图，准确率 >90%
- [ ] Python 调用图（Phase 2）
- [ ] Go 调用图（Phase 3）
- [ ] 性能：1000 文件项目 < 30s
- [ ] 每条 call 边有 `callSite` 证据
- [ ] LLM 可用：`preflight_trace_query` 支持查询 "谁调用了函数 X"

---

## 里程碑

| 阶段 | 内容 | 预计工时 |
|------|------|---------|
| M1 | TypeScript 符号提取 + 调用解析 | 3-5 天 |
| M2 | 集成到 dependency_graph | 1-2 天 |
| M3 | Python 支持 | 2-3 天 |
| M4 | Go 支持 | 2-3 天 |
| M5 | 性能优化 + 缓存 | 2-3 天 |

**总计**：约 10-16 天

---

## 参考

- [Tree-sitter 查询语法](https://tree-sitter.github.io/tree-sitter/using-parsers#pattern-matching-with-queries)
- [LSP Call Hierarchy](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_prepareCallHierarchy)
- 类似工具：Sourcegraph、GitHub Code Navigation、Kythe
