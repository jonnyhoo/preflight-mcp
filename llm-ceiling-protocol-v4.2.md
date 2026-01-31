# LLM 穷尽式分析天花板协议 v4.2（融合版）

> **目标**：让 LLM 对任何内容（代码项目/文档/方案）进行穷尽式分析，直到达到经验性天花板（或触发显式预算终止）。
> **特点**：引导式配置、自适应、防提前停止、支持代码/文档两种模式、可重入阶段三验证、可压缩状态输出。
>
> **说明（v4.2）**：本版本由 `llm-ceiling-protocol-v4.1.md` 与 `llm-ceiling-protocol-v4.1x.md` 融合生成；文中保留 `v4.1+ / v4.1++ / v4.1+++` 标注作为历史来源提示，但执行时以本文档为准。

---

## 核心概念

### 什么是“天花板”（Ceiling）

在固定的输入快照 **S**、固定的分析目标 **G**、固定的工具/检索规则 **T**、固定的维度集合 **Dims**、固定的指纹/去重/证据规则 **R** 下：

当阶段二出现连续 **K** 轮 `new_count = 0`，并触发阶段三对当时所有**未穷尽维度**完成验证后，仍产生 **0 个新的、有证据支持的发现**，则分析达到了 (S,G,T,Dims,R) 条件下的**经验性天花板**。

**关键性质**：
- **条件固定**：否则天花板不可比较。
- **证据支持**：每条发现必须能指向快照中的具体位置，否则不计入“新发现”。
- **多维度验证**：阶段三必须覆盖“当前未穷尽维度”；阶段三可重入（多次触发），直到所有维度被标记为已穷尽或触发预算终止。
- **显式停止**：唯一合法停止：
  - ✅ 达到天花板结论（阶段三验证后无新发现）；
  - ✅ 预算终止（Round 0 显式配置预算，并在结论中标注“未达到天花板”）；
  - ✅ 用户明确输入“提前终止”。

### 术语表

| 术语 | 定义 |
|------|------|
| 天花板 (Ceiling) | 在固定 (S,G,T,Dims,R) 下，阶段二连续K轮无新增后进入阶段三验证，验证仍无新增，则认为达到经验性天花板 |
| 维度 (Dimension) | 分析类别/关注领域（选择后固定），如正确性、完整性、安全性等 |
| 未穷尽维度 | 尚未被阶段三标记为“已穷尽”的维度；阶段三后阶段二只允许从未穷尽维度中选择 |
| 已穷尽维度 | 阶段三验证中“该维度无新发现”则标记为已穷尽（终态），后续不再在阶段二/三尝试（除非走增量分析流程） |
| 指纹 (Fingerprint) | 唯一标识一个发现的规范化字符串：`{PROBLEM_TYPE}::{subject}::{location}` |
| 轮次 (Round) | 一次完整迭代。Round 0 为初始化轮（不计入K） |
| K值 | 连续零新发现的轮数阈值（由内容规模决定） |
| K计数器 | 记录阶段二中连续 `new_count=0` 的轮数计数器；阶段三期间冻结 |
| 证据 (Evidence) | 支持发现的位置引用：文档用 `L行号`；代码用 `path:L行号`；全局问题用 `global` |
| 指纹输出模式 | `inline_full`（每轮输出全量JSON数组）/ `inline_compact`（每轮仅输出增量+计数）/ `external_store`（可落盘时将全量存入文件，仅输出路径+增量） |
| 预算终止 | Round 0 配置了预算（最大轮次/时间/token等）且达到预算上限时停止，必须标注“未达到天花板” |

---

## 快速使用

**使用方法**：复制本协议全文 + 待分析内容，一起发送给 LLM。

**Prompt 模板**（将 `<OUTPUT_DIR>` 替换为你的输出目录；同名不覆盖/落盘规则见 Round 0「输出落盘规则」）：

```
请对以下内容进行穷尽式分析，直到达到可复核的经验性天花板（按本协议定义）（或触发预算终止），并形成最终分析报告以 md 格式落盘到 <OUTPUT_DIR>（同名文件新建不覆盖）：
（若用户未显式提供 dims / 指纹输出模式 / 预算 / K / round_reflection / selection_authority / selection_confirm / variance_gate_threshold / weight_source / prune_mode / high_sev_guard / stage3_verify_mode / sorting_rule，则按「Round 0 默认自动配置（Auto Round 0）」补全，并在 Round 0 输出中声明配置来源）
（若环境不支持落盘：在对话中输出完整报告正文，并在结论中标注“未落盘原因”。）

[在此粘贴待分析内容]
═══════════════════════════════════════════════════════════════════════
[此处粘贴本协议全文，从「阶段一：Round 0 自适应初始化」开始]
═══════════════════════════════════════════════════════════════════════
```

## 使用说明（v4.2，必读）

本章节回答：
1) 怎么把本协议当作 prompt 使用（复制范围、粘贴顺序）；
2) 协议的核心算法（四阶段、K计数器、指纹与证据）；
3) v4.2 增补/集成的算法模块（标注论文/代码来源）；
4) 可配置参数与含义（name / value / 作用）；
5) 常见场景建议与排错。

### 1) 怎么使用 Prompt（复制范围 + 拼接顺序）

#### 1.1 单窗口使用（推荐）
1. 准备“待分析内容快照”（建议带行号，见 Doc Evidence Rule；否则本协议会按换行生成 L1..Ln）。
2. 在同一个对话窗口，按以下顺序粘贴：
   - A. 你的任务说明（可选）+ 待分析内容快照
   - B. 分隔线
   - C. 本协议（按下方“复制范围”复制）
3. 要求模型从 Round 0 开始执行，并在输出中持续维护：K计数器、未穷尽维度、历史指纹状态等。

#### 1.2 复制范围（推荐按标题定位，避免行号漂移）
- 方案A（最稳，首次使用推荐）：复制全文（从本文件标题 `# LLM 穷尽式分析天花板协议...` 到文件末尾）。
- 方案B（更省 token，日常推荐）：复制从 `## 阶段一：Round 0 自适应初始化` 到文件末尾。

#### 1.3 最小拼接模板（可直接用）
```
[你的任务说明]
[待分析内容快照]
═══════════════════════════════════════════════════════════════════════
[粘贴协议：按上面的复制范围]
═══════════════════════════════════════════════════════════════════════
```

### 2) 核心算法（四阶段 + K + 指纹）

#### 2.1 核心不变原则
- Snapshot：内容在单次会话期间不可变。
- Evidence：任何计入新发现的条目必须能定位到具体位置（L行号 / path:L行号）。
- Fingerprint：每条新发现必须生成唯一指纹 `{PROBLEM_TYPE}::{subject}::{location}` 并按去重规则比对历史。

#### 2.2 四阶段流程（协议主干）
- 阶段一（Round 0 初始化）：选择 Doc/Code 模式、规模→K、维度 dims、指纹与证据规则、预算与输出模式等。
- 阶段二（Round 1+ 迭代分析）：
  - 每轮至少覆盖 `min(3, D_avail)` 个维度；
  - 记录所有“有证据的新发现”，去重后得到 `new_count`；
  - 若 `new_count=0` 则 K计数器+1；否则 K计数器归零。
- 阶段三（多维度验证，可重入）：当阶段二 K计数器达到K时触发；只验证未穷尽维度；若验证无新发现则把维度标记为已穷尽。
- 阶段四（结论）：
  - 天花板结论：阶段三验证后无新发现；
  - 预算终止结论：触发显式预算上限（必须标注“未达到天花板”）。

### 3) 增补/集成的算法模块（v4.2，含来源标注）

说明：以下模块属于“协议级增强”，目的是让“遵照协议”在输出质量上稳定优于普通问法；这些模块不会改变四阶段主框架。

1) Auto Round 0 默认配置（协议内部补充）
- 作用：当用户未显式指定 dims/预算/输出模式/反思模式时，由协议自动补全并声明来源，避免用户裁量导致的不可复现。

2) 输出质量闸门（协议内部补充）
- 作用：用硬约束（证据/建议绑定/可验收/严重度/去重/结论闸门）抑制空泛、不可执行、不可复核的输出。

3) Round 内反思/自选：sample3_select（多候选→自选合并）
- 来源：论文与代码启发（多候选 + 自选/合并范式）
  - 论文：Vision-Language Models Can Self-Improve Reasoning via Reflection（arXiv:2411.00855；https://arxiv.org/abs/2411.00855）
  - 代码：
    - GitHub：`https://github.com/njucckevin/MM-Self-Improve`
    - 本地镜像（若有）：`C:\Users\Administrator\Desktop\sicko\MM-Self-Improve-master\MM-Self-Improve-master`
- 迁移点：3 候选 → 选择/合并（相当于 Test@3 + Select 的“自选”思想）。
- 作用：提高覆盖率，降低一次生成的偶然遗漏；并通过“仅出现1/3候选需复核，否则降级”为疑点，降低噪声。

4) Round 内反思/自选：rpc_select（内部概率 × 自洽性，v4.1+）
- 来源：论文与代码（Perplexity Consistency + Reasoning Pruning）
  - 论文：A Theoretical Study on Bridging Internal Probability and Self-Consistency for LLM Reasoning（arXiv:2510.15444v1；https://arxiv.org/abs/2510.15444）
    - 本地PDF（若有）：`C:\Users\Administrator\Desktop\sicko\2510.15444v1.pdf`
  - 代码：
    - GitHub：`https://github.com/WNJXYK/RPC`
    - 本地镜像（若有）：`C:\Users\Administrator\Desktop\sicko\RPC-main\RPC-main`（RPC-main；若 repo README 链接版本不同，以本地PDF为准）
- 迁移点：
  - Perplexity Consistency：将“内部概率/置信度”融入“自洽聚合”，以提升有限采样下的收敛与可靠性。
  - Reasoning Pruning：避免低概率路径导致的退化与噪声；在本协议中体现为“降级为疑点/待确认（默认不删除）+ 证据复核”。
- 协议内实现（prompt 可执行的近似版）：
  - A/B/C 候选为每条发现附加 `weight`（来自 logprobs 或 verbalized_confidence）；
  - 合并后计算 `support_count` 与 `confidence`；
  - 通过闸门与可选降级规则，让主建议更可靠、更可解释。

5) Round 内反思/自选：bbon_select（事实叙事 × 比较式选择，v4.1+）
- 来源：论文与代码（Behavior Best-of-N / behavior narratives + comparative selection）
  - 论文：The Unreasonable Effectiveness of Scaling Agents for Computer Use（arXiv:2510.02250v1；https://arxiv.org/abs/2510.02250v1）
    - 本地PDF（若有）：`C:\Users\Administrator\Desktop\sicko\2510.02250v1.pdf`
  - 代码：
    - GitHub：`https://github.com/simular-ai/Agent-S`（bBoN: BehaviorNarrator + ComparativeJudge）
    - 本地镜像（若有）：`C:\Users\Administrator\Desktop\sicko\Agent-S-main\Agent-S-main`
- 迁移点：
  - Behavior Narratives：将“候选输出”先压缩成可比的事实叙事（facts），每条 fact 必须附带证据位置并避免推断。
  - Comparative Selection（MCQ）：对多个候选进行同上下文比较式裁决，要求引用 facts/证据而非“叙事更丰富”。
- 协议内实现（prompt 可执行的近似版）：
  - 仍生成 A/B/C 候选，但不做并集合并；改为生成每个候选的 `candidate_facts`（事实叙事）与 `candidate_findings`（发现表），再做比较式选择输出单一最优候选（默认 `selection_authority=auto`，并在输出中给出可复核的选择理由；用户可显式覆盖）。

### 4) 可配置参数（用户可显式覆写）

说明：本协议没有真正的“参数解析器”，因此建议在 Prompt 顶部用固定格式给出覆写项；模型需在 Round 0 中声明“配置来源”。

#### 4.1 推荐覆写块格式（可直接复制）
```
【配置覆盖（可选）】
analysis_mode: Doc Mode | Code Mode
content_type: 技术方案 | 产品文档 | 商业计划 | 流程规范 | 学术论文 | 代码项目 | 其他
analysis_goal: 一句话说明你想要的输出/决策
K: auto | 2 | 3 | 4
stage3_verify_mode: auto | A | B

dims: [正确性, 完整性, 一致性, ...]

fingerprint_output_mode: inline_compact | inline_full | external_store
budget: N/A | max_rounds=__ | max_time_minutes=__ | max_tokens=__

round_reflection: off | sample3_select | rpc_select | bbon_select
selection_authority: auto | user
selection_confirm: auto | on | off
variance_gate_threshold: off | auto | 0.05 | 0.10 | 0.20

weight_source: auto | logprobs | verbalized_confidence | none
prune_mode: off | demote_low_support | demote_low_mass
high_sev_guard: on | off
sorting_rule: support_count→conf→严重度（默认）| 严重度优先 | 其他（用户指定）
```

#### 4.2 参数解释（name / value / 作用）

| 参数名 | 可选值 | 默认（Auto Round 0） | 主要作用 |
|------|--------|----------------------|----------|
| analysis_mode | Doc Mode / Code Mode | 自动识别 | 决定输出物与检查维度（文档模式/代码模式不同）。 |
| content_type | 技术方案/产品文档/商业计划/流程规范/学术论文/代码项目/其他 | 由用户或模型推断 | 影响 dims 选择、风险信号判断、产出物表述风格。 |
| analysis_goal | 任意文本 | 由用户或模型推断 | 约束“什么算有价值的发现/建议”；影响阶段四行动清单。 |
| dims | 5–10个维度列表 | Doc/Code 默认 dims（见 Auto Round 0） | 约束分析“穷尽范围”；阶段三只验证未穷尽维度。 |
| K | 2 / 3 / 4 | 按规模自动设定 | 连续 0 新发现触发阶段三的阈值；越大越“保守/更难停”。 |
| fingerprint_output_mode | inline_full / inline_compact / external_store | inline_compact（论文PDF/长文优先 external_store） | 控制指纹状态输出体积与可重入性；对论文PDF/长文档优先 external_store，避免上下文膨胀。 |
| budget | N/A 或 max_rounds/max_time_minutes/max_tokens | N/A | 显式预算终止；触发时必须输出“未达到天花板”。 |
| stage3_verify_mode | auto / A / B | auto | 阶段三验证方式：A逐个维度；B批量分组。 |
| round_reflection | off / sample3_select / rpc_select / bbon_select | 预算=N/A 时默认 rpc_select；严格预算时默认 sample3_select | 控制每轮是否做“多候选→自选合并”或“事实叙事×比较式选择”，以及是否引入权重/置信度。 |
| selection_authority（bbon_select） | auto / user | auto | bbon_select 的最终裁决权归属：auto 由模型做比较式选择；user 仅在输出中给出推荐选项并请求用户确认/覆盖。 |
| selection_confirm（bbon_select） | auto / on / off | auto | bbon_select 下是否显式请求用户确认：auto 默认给出推荐选项并允许用户覆盖但不中断；on 每轮都提示可覆盖；off 不提示。 |
| variance_gate_threshold（bbon_select） | off / auto / 0.05 / 0.10 / 0.20 | auto（按K自适应） | bbon_select 下“分歧很小时简化裁决流程”的阈值；off 禁用 variance_gate；auto：K=2→0.05，K=3→0.10，K=4→0.20。 |
| weight_source | auto / logprobs / verbalized_confidence / none | auto | rpc_select 下的权重来源；auto 会按可用性降级。 |
| prune_mode | off / demote_low_support / demote_low_mass | off | rpc_select 下的“降噪/降级”方式（默认不删，只降级疑点）。 |
| high_sev_guard | on / off | on | rpc_select 下对高严重度条目的反剪枝保护（避免误杀关键问题）。 |
| sorting_rule（rpc_select） | 默认：support_count→conf→严重度 | 默认 | 控制阶段四行动清单排序；若用户覆盖需在 Round 0 声明来源。 |

#### 4.3 字段映射（覆写块 → Round 0 输出，避免两套命名并存引发歧义）

说明：覆写块使用 `snake_case` 只是为了便于复制与稳定对齐；Round 0 输出仍以协议主干的中文字段为准。模型必须把覆写块中的键映射到 Round 0 对应字段，并在“配置来源”中如实标注来源（用户指定/Auto/混合）。

- `analysis_mode` → Round 0「分析模式」
- `content_type` → Round 0「内容类型」
- `analysis_goal` → Round 0「分析目的」
- `dims` → Round 0「选中维度（5-10个）」
- `K` → Round 0「内容规模 → K=___」（若用户显式指定 K=2/3/4，则以用户为准，并在 Round 0 标注来源）
- `fingerprint_output_mode` → Round 0「指纹输出模式」
- `budget` → Round 0「预算」
- `round_reflection` → Round 0「Round内反思/自选」
- `weight_source / prune_mode / high_sev_guard` → Round 0「rpc_select配置」
- `selection_authority / selection_confirm / variance_gate_threshold` → Round 0「bbon_select配置」
- `stage3_verify_mode` → Round 0「stage3_verify_mode」
- `sorting_rule` → Round 0「sorting_rule（rpc_select）」

补充规则：
- 若用户显式提供 `content_type` / `analysis_goal`：Round 0 必须直接复述用户文本，不得再“改写成另一句”。
- 若用户未提供上述项：模型可推断，但必须在 Round 0 明确写出“推断依据”（例如引用快照中的关键术语/章节）。

### 5) 常见场景建议（你可能没想到但很常用）

1) 我只要质量，不在乎 token（推荐）
- budget=N/A
- round_reflection=rpc_select
- weight_source=auto
- prune_mode=off（先不降级，保证穷尽；若噪声太多再改为 demote_low_support）
- high_sev_guard=on

2) 我想省 token / 快速收敛（推荐）
- budget=max_rounds=2 或 3
- round_reflection=sample3_select
- 指纹输出模式建议 inline_compact

3) 高风险领域（安全/合规/财务）
- round_reflection=rpc_select
- high_sev_guard=on（必须）
- 阶段三验证方式强制 A

4) 文档不带行号且很长
- 建议先转成带行号快照再分析；否则“证据闸门”会导致大量条目无法计入新发现。

---

## 阶段一：Round 0 自适应初始化

在开始分析前，先完成以下设置（本轮不计入K计数）：

### 1) 识别内容类型和分析模式

□ **代码模式（Code Mode）**：分析代码仓库/项目
- 产出：`architecture.json` + `README_RUNBOOK.md` + `refactor_backlog.yaml` + 天花板结论
- 指纹类型：结构化指纹 + 代码专用指纹
- 典型目的（v4.1+++ 补充）：抽取可复用/可迁移的架构、概念、算法与工程实践，并可选产出对目标项目/方案的修改提案（需满足“代码修改提案闸门”）。

□ **文档模式（Doc Mode）**：分析文档/方案/论文/流程规范等
- 产出：`finding_report.md`（深度评估报告）+ 天花板结论
- 指纹类型：结构化指纹

### 2) 识别内容属性

- 内容类型：[代码项目/技术方案/产品文档/商业计划/学术论文/流程规范/其他]
- 内容规模（代码按行数，文档按字符数）：
  - 小：≤999 → K=2
  - 中：1000–9999 → K=3
  - 大：≥10000 → K=4
  - 若无法精确统计字符数/行数：允许用“估算值”，但必须在 Round 0 输出中注明口径（例如：字符数≈__，或用行数代替）。
- 目标受众：[谁会使用这个内容？]
- 分析目的：[要回答什么问题？解决什么问题？]

**重要约束 — 内容不可变性（Snapshot）**：
在单次分析会话期间，被分析的内容必须保持静态。证据（行号/路径行号）必须基于初始快照。若需修改内容，请在达成结论后进行，或使用【高级场景】中的增量分析流程。

**文档模式行号快照规则（Doc Evidence Rule）**：
- 若输入内容已带行号（推荐格式：`L123|...` 或 `123|...`），则采用该行号体系，并在输出中统一规范化为 `L123` 形式（即：`123|` 视为 `L123|`）。
- 否则默认：将输入按换行符分割，第一行记为 `L1`，依次递增。
- 若文档很长且你无法可靠计数行号：建议用户提供“带行号快照”或文件方式输入；无法保证证据准确时，不允许记录为“新发现”。

### 2.4) 论文 PDF 场景输入规范（Doc Mode，v4.1+++ 补充）

适用：用户提供论文 PDF，希望识别其中可复用/可迁移的概念、算法、架构或代码线索（而非仅做摘要）。

**关键约束（防上下文爆炸 & 防空泛）**

A. 先做规模测量（必须）
- 先将 PDF 全文提取为纯文本 `paper_text`，再统计 `paper_text_chars` 与 `paper_text_lines`（以提取文本为准，不以文件大小为准）。
- Round 0 的「内容规模 → K」必须基于 `paper_text_chars` 的总量判断（以全文总量为准，不以单片大小为准）。
- 若 `paper_text_chars > 50,000`：必须按协议分片策略分片（每片 ≤ 25,000 chars），并确保证据行号可追溯。
- 必须生成“全局行号快照”：把全文按换行编号为 `L1..Ln`；分片时必须保留全局 L 行号（不允许每片从 L1 重新计数导致证据失真）。

B. 协议执行方式（必须）
- Round 0：若用户未提供 dims/K/budget/round_reflection 等配置，按协议 Auto Round 0 补全，并在 Round 0 明确“配置来源=Auto/混合/用户指定”。
- 指纹输出模式：优先 `external_store`（能落盘就写到文件），否则用 `inline_compact`；禁止 `inline_full`（会爆上下文）。
- 若无法可靠提取 PDF 文本（例如仅有扫描件/OCR质量差/工具不可用）：必须请求用户提供可复制的纯文本快照（带行号或可生成行号），否则不得声称“有证据的新发现”。

C. 混合任务：论文PDF + 配套代码 + 修改提案（同一窗口，推荐流程）
- 目标：用协议严谨提取论文中的可迁移点（概念/算法/架构/伪代码/关键假设），并把这些点落地为对指定代码库/文件的“修改提案”（代码侧不要求走协议四阶段与指纹/K流程）。
- 输入建议：
  - 论文侧：按本节 A/B 生成带全局行号的纯文本快照（可外部存储）。
  - 代码侧：只提供“仓库路径/commit/目标文件列表/约束”，需要时再逐段提供关键文件片段；避免整仓库贴进同一窗口。
- 执行顺序（防混淆）：
  1) 先按协议阶段一～阶段三完成“论文侧可迁移点”的证据化提取与去重收敛（论文侧条目才计入 `new_count` / K 计数）。
  2) 在阶段四（或预算终止结论）追加输出一个“代码修改提案包（可选）”，把论文证据 → 代码落地点明确映射。
- 代码修改提案硬约束（防空泛/防臆测）：
  - 每个提案必须同时引用：
    - 论文证据：`L行号/L范围`（说明“这个提案从论文里复用的是什么”）；
    - 代码证据：`path:L行号`（说明“改动目标在哪里/为何需要改”）。
  - 若缺少代码上下文（未提供目标文件/关键片段）：只能输出“接口级/模块级提案 + 需要用户补充的代码证据清单”，不得硬写细节 diff。
  - 提案粒度与拆分（必须）：
    - 单个提案应尽量“小步可验收”，建议：改动 ≤3 个文件、diff 总行数 ≤200 行（含上下文）；超出则拆分为多个提案，或先输出分步 plan 再逐步给 diff。
    - diff 必须使用最小上下文（建议 ±3–5 行），避免粘贴大段无关代码导致上下文爆炸。
  - 可测试性（必须）：
    - `acceptance` 必须给出至少 1 条可执行的验证方式（优先：仓库现有测试命令；否则：最小手工验收步骤 + 需要用户补充的测试命令/CI入口）。
  - 风险与回滚（必须）：
    - 必须写出最可能的失败模式/兼容性风险，并给出最小回滚路径（例如：撤销单个文件改动/回退提交/关闭开关）。
  - 输出位置（必须）：
    - “代码修改提案包”应放在产出物的「迁移/修改提案」章节中，不应混入“新发现/指纹清单”；若进入阶段四主建议清单，仍需绑定 ≥1 个论文侧指纹/证据。

### 2.5) 默认自动配置（Auto Round 0，v4.1+ 补充，推荐）

当用户未显式提供 dims / 指纹输出模式 / 预算 / K / round_reflection / selection_authority / selection_confirm / variance_gate_threshold / weight_source / prune_mode / high_sev_guard / stage3_verify_mode / sorting_rule 等配置时，模型必须按本节默认值自动补全，并在 Round 0 输出中明确写出“默认来源”，以保证可复核、可重入与可比较（便于验证“遵照协议”优于“普通问法”）。

1) 默认维度（Doc Mode）
- 若分析模式=文档模式且用户未指定维度：默认 dims（顺序固定）：
  1. 正确性
  2. 完整性
  3. 一致性
  4. 清晰性
  5. 结构性
  6. 可操作性
  7. 可验证性
- 若文本出现高风险信号（示例：账号/权限/密钥/token/隐私/PII/加密/注入/越权/审计/风控/支付/资金/合同/合规/法规/许可证/数据跨境等），且总维度数未超过10：追加「安全性」「合规性」（若已存在则不重复）。

2) 默认维度（Code Mode，迁移复用导向，v4.1+++ 补充）
- 若分析模式=代码模式且用户未指定维度：默认 dims（顺序固定）：
  1. 正确性
  2. 架构合理性
  3. 核心机制/算法
  4. 接口契约
  5. 可扩展性
  6. 可迁移性
  7. 依赖与版本策略
  8. 配置管理
- 追加规则（总维度数≤10，按优先级补齐；若超过10必须在 Round 0 明确说明取舍）：
  - 高风险信号（安全/权限/密钥/PII/合规）→ 追加「安全性」「合规性」（优先级最高）
  - 性能/成本信号（性能指标/压测/成本优化）→ 追加「性能」
  - 工程可落地信号（需要可复现运行/需要提交patch/需要CI验证）→ 优先追加「可测试性」「构建部署」「复现性」
  - 代码可诊断/可运营信号（日志/metrics/tracing/线上排障）→ 追加「可观测性」

- （可选）替代默认维度（Code Mode，工程落地导向，继承 v4.1）：
  - 当目标更偏“快速审计/运行/维护”而非“迁移复用”：可用以下默认 dims（顺序固定）：
    1. 正确性
    2. 完整性
    3. 一致性
    4. 架构合理性
    5. 可维护性
    6. 配置管理
    7. 构建部署
    8. 可观测性
  - 同样遵循“总维度数≤10”的追加规则（安全/合规/性能等）。

3) 默认指纹输出模式
- 默认：`inline_compact`
- 若输入为论文PDF或接近/超过分片阈值的长文档：优先 `external_store`（能落盘就写到文件），否则用 `inline_compact`；禁止 `inline_full`（会爆上下文）。

4) 默认预算策略（防“偷停”）
- 默认：N/A（不设置预算）
- 仅当用户明确要求“限制轮次/限时/省 token”时，才允许设置预算项（max_rounds / max_time_minutes / max_tokens）。
- 一旦触发预算终止：必须输出“预算终止结论（未达到天花板）”，并列出未穷尽维度与残留风险来源。

5) 短文档阅读策略（未达到分片阈值）
- 每轮阶段二至少快速通读一次快照；任何“新发现”必须回到原文定位证据行号后才计入。
- 允许“只精读一次全文”用于建立上下文，但不允许后续轮次完全不回看原文、只凭记忆生成发现。

6) Round 内反思/自选（Reflection/Select，v4.1+ 补充，用于提质）
- 目的：在不改变四阶段框架的前提下，通过“多候选 → 自选合并”或“事实叙事 × 比较式选择”提升覆盖率/可靠性，降低空泛、低质量与高方差输出。
- 参数（协议级可自动补全，避免用户裁量）：
  - `round_reflection = off | sample3_select | rpc_select | bbon_select`
  - `selection_authority = auto | user`（仅 bbon_select）
  - `selection_confirm = auto | on | off`（仅 bbon_select）
  - `variance_gate_threshold = off | auto | 0.05 | 0.10 | 0.20`（仅 bbon_select；auto 按 K 自适应：K=2→0.05，K=3→0.10，K=4→0.20）
  - `weight_source = auto | logprobs | verbalized_confidence | none`
  - `prune_mode = off | demote_low_support | demote_low_mass`
  - `high_sev_guard = on | off`
  - `stage3_verify_mode = auto | A | B`（默认 auto；高风险领域强制 A）
  - `sorting_rule（rpc_select） = support_count→conf→严重度 | 严重度优先 | 用户指定`（默认 support_count→conf→严重度）
- 默认策略：
  - 若预算=N/A（未显式限轮/限时/限token）：默认 `rpc_select`（推荐）。
    - 同时默认：`weight_source=auto`, `prune_mode=off`, `high_sev_guard=on`
  - 若显式设置了严格预算：默认 `sample3_select`（更省 token），除非用户明确要求 `rpc_select`。
  - 若用户明确表示“不知道如何选择/不想人工选择”，且更强调“择优稳定”而非“并集穷尽”：可显式设置 `round_reflection=bbon_select`（默认 `selection_authority=auto`, `selection_confirm=auto`, `variance_gate_threshold=auto`；其中 auto 按 K 自适应：K=2→0.05，K=3→0.10，K=4→0.20）。
- 解释：
  - `sample3_select`：3候选 → 指纹合并（均匀权重），用于提升覆盖率。
  - `rpc_select`：3候选 → “加权一致性聚合 +（可选）低支持度降级”，用于提升建议可靠性与输出可解释性。
  - `bbon_select`：3候选 → 为每个候选生成可比的事实叙事（candidate_facts）→ 比较式选择输出单一最优候选；默认 `selection_authority=auto`，并在输出中给出可复核的选择理由；用户可显式覆盖但不要求理解细节。
  - `weight_source=auto`：
    - 若环境可直接取得 token 级 logprobs（或等价内部概率）→ 使用 `logprobs`（最接近论文设定）。
    - 否则使用 `verbalized_confidence`（要求输出 0–1 概率并保持保守标定）。
    - 若以上都不可用 → 使用 `none`（权重恒为1，退化为仅用一致性信号）。

### 3) 选择分析维度（5–10个）

**选择指导**：
- 必选：与内容类型直接相关的维度（如代码必选“正确性”，安全系统必选“安全性”）。
- 优先：基础类中至少包含「正确性」；若目标包含“审计/修复/对照实现”，再补全「完整性」「一致性」。
- 若目标是“复用/迁移/产出修改提案”：建议至少包含「可迁移性」「接口契约」「核心机制/算法」「依赖与版本策略」「可扩展性」，以保证“复用点→落地路径”可复核。
- 上限：超过10个维度需说明必要性。

**【通用维度】**

| 类别 | 维度 | 审视焦点 |
|------|------|----------|
| 基础类 | 正确性 | 逻辑矛盾、事实错误、计算错误、引用错误 |
| 基础类 | 完整性 | 缺失步骤、未定义术语、遗漏边界、缺少示例 |
| 基础类 | 一致性 | 术语不统一、格式不一致、规则冲突 |
| 质量类 | 清晰性 | 歧义表述、定义不明、缺少示例 |
| 质量类 | 结构性 | 组织混乱、层次不清、冗余重复 |
| 质量类 | 可操作性 | 无法执行、条件冲突、步骤缺失 |
| 质量类 | 可验证性 | 无法度量、无法测试、缺少验收标准 |
| 风险类 | 安全性 | 信息泄露、权限漏洞、注入风险 |
| 风险类 | 合规性 | 标准违规、法规冲突、许可证问题 |
| 价值类 | 实用性 | 无实际价值、需求不匹配、成本过高 |
| 迁移类 | 可迁移性 | 复用价值、适配成本、耦合/依赖约束、落地路径是否清晰 |
| 迁移类 | 复现性 | 是否可在新环境复现（依赖锁定、随机性、数据/模型获取、运行脚本） |
| 演进类 | 可维护性 | 修改困难、耦合过紧、文档缺失 |

**【代码专用维度】**（仅代码模式）

| 维度 | 审视焦点 |
|------|----------|
| 架构合理性 | 模块边界不清、分层混乱、循环依赖 |
| 核心机制/算法 | 关键数据流/控制流、核心算法点、复杂度、关键假设与边界条件 |
| 接口契约 | 对外API/内部接口、数据模型、不变量、错误语义、版本兼容策略 |
| 可扩展性 | 插件/钩子/策略模式、可配置开关、扩展点稳定性与隔离性 |
| 依赖与版本策略 | 依赖锁定、可替换性、许可证、平台兼容、构建环境要求 |
| 可测试性 | 单测/集成/E2E、golden tests、基准测试、CI入口与最小复现脚本 |
| 性能 | 算法复杂度、内存泄漏、慢查询 |
| 可观测性 | 日志缺失、监控盲区、追踪不全 |
| 配置管理 | 配置散乱、优先级不清、默认值缺失 |
| 构建部署 | 构建失败、部署复杂、测试缺失 |
| 技术债务 | 代码冗余、TODO积压、测试覆盖低 |

### 4) 定义指纹格式

**结构化指纹格式**：`{PROBLEM_TYPE}::{subject}::{location}`

**PROBLEM_TYPE 枚举**（16个，必须从中选择）：

| 类型 | 含义 | 判定标准 |
|------|------|----------|
| UNDEFINED | 未定义 | 概念/术语首次出现但无定义 |
| INCOMPLETE | 定义/规则不完整 | 只说了A情况，没说B情况 |
| CONFLICT | 多处冲突/矛盾 | 位置X说A，位置Y说非A |
| INCONSISTENT | 术语/格式不统一 | 同一概念用了不同名称 |
| AMBIGUOUS | 歧义/可多种解读 | 存在2种以上合理理解 |
| MISSING_STEP | 缺少步骤 | 流程从A跳到C，没有B |
| MISSING_EXAMPLE | 缺少示例 | 有规则/公式但无计算示例 |
| MISSING_BOUNDARY | 边界条件缺失 | 没说边界值怎么处理 |
| OUTDATED | 引用/值过时 | 引用的行号/版本已失效 |
| REDUNDANT | 冗余/重复 | 同一内容出现两处 |
| LOGIC_ERROR | 逻辑错误 | 推理过程有错 |
| UNREACHABLE | 死代码/不可达 | 某分支永远不会执行 |
| CIRCULAR | 循环依赖/定义 | A依赖B，B依赖A |
| TYPO | 拼写/格式错误 | 明显的笔误 |
| UNVERIFIABLE | 无法验证 | 声称X但无法检查 |
| OTHER | 其他 | 以上都不适用 |

**subject 规则（v4.1 统一“原词来源”与“规范化”）**：
- subject 必须来自原文中的**原词/短语**（不得换词概括，不得引入原文不存在的新术语）。
- 指纹中的 subject 允许且必须做**可复现的规范化**，以避免大小写/空格/标点导致的重复：
  - 拉丁字母：转为小写；
  - 空白与常见分隔符（空格、`-`、`/`、`:`、`·`、`、`、`，`、`.` 等）：统一替换为下划线 `_`；
  - 连续下划线合并为一个；首尾下划线去除；
  - 中文/数字保持原样。
- 记录发现描述时，建议同时在“问题描述”中附上原文原词（便于人工核对）。

**MISSING_* 类型特殊处理**：subject 应为所属的父级概念、流程名称或紧邻的前驱步骤。

**location 规则**：
- 文档：`L行号` 或 `L起始-L结束`（如 `L252`、`L328-L334`）
- 代码：`相对路径:L行号`（如 `src/main.py:L42`）
- 跨多处：`L位置1+L位置2`（如 `L100+L200`）
- 全局问题：`global`（仅当问题涉及≥5处位置或无法指定具体位置时使用）

**指纹示例**：
- `CONFLICT::schema_version::L500+L649` — 版本号两处说法不一致
- `INCOMPLETE::轮换算法::L252` — 轮换算法边界情况未说明
- `MISSING_STEP::部署流程::L120` — 部署流程缺少必要检查步骤

**严重度判定标准**：

| 严重度 | 判定条件 | 客观检验 |
|--------|----------|----------|
| 高 | 无法继续执行 | 能构造出“执行到X步时无法继续，因为Y”的具体场景 |
| 中 | 需要猜测才能执行 | 存在2种以上合理解读 |
| 低 | 不影响执行 | 当前表述已可唯一确定执行方式，仅优化建议 |

**严重度自检**：标注“高”时必须附带阻断场景描述，否则降级为“中”。

### 5) 设定参数

- K值：默认已在“内容规模”根据字符数/行数确定；若用户在【配置覆盖】中显式指定 `K=2/3/4`，则以用户为准，并在 Round 0 标注配置来源。

- 阶段二每轮最少尝试维度数（v4.1 边界修复）：
  - 设 `D_avail` = 本轮可选维度数。
    - 阶段三未执行前：`D_avail = D`（全部维度可选）
    - 阶段三执行后：`D_avail = 未穷尽维度数`
  - 本轮必须尝试：`min(3, D_avail)` 个维度（若 `D_avail < 3` 则尝试全部可选维度）。

- 轮换算法（v4.2 无歧义定义）：
  - 维度列表固定为数组 `dims[0..D-1]`（**0-based**），并保持顺序不变。
  - 定义 `dims_active`：
    - 阶段三未执行前：`dims_active = dims`
    - 阶段三执行后：`dims_active = 未穷尽维度列表`（按其在 `dims` 中的原始顺序排序）
  - 设 `D_avail = len(dims_active)`。
  - Round N（N≥1）选择维度索引（作用于 `dims_active`）：
    - 若 `D_avail < 3`：每轮选择全部 `dims_active`
    - 否则：`idx_i = ((N-1)*3 + i) mod D_avail`，其中 `i ∈ {0,1,2}`
  - 示例：D=7（阶段三前）
    - Round1：0,1,2
    - Round2：3,4,5
    - Round3：6,0,1

- 指纹去重规则（v4.1 明确算法，避免“精确匹配 vs ±5行”冲突）：
  1. **Exact**：若 fingerprint 字符串完全一致 → 重复
  2. **Fuzzy（仅适用于单行 location）**：
     - 若历史中存在指纹满足 `PROBLEM_TYPE` 与 `subject` 相同，且：
       - 文档 location 为单行 `Lx`（同一文档内）
       - 代码 location 为单行 `path:Lx` 且 **path 相同**
       并且行号差值 `|x - y| ≤ 5` → 视为重复
  3. 对于 `range / 多处 / global`：只应用 Exact，不应用 Fuzzy

- 指纹输出模式（v4.1 新增，默认 `inline_compact`）：
  - `inline_full`：每轮输出全量历史指纹集 JSON 数组（小规模/短会话适用）
  - `inline_compact`：每轮仅输出 `delta_fingerprints`（本轮新增）+ `fingerprints_count`（累计数量）
  - `external_store`：若环境允许落盘，将全量指纹集写入 `<OUTPUT_DIR>/fingerprints.json`（若同名冲突，按“输出落盘规则”重命名），每轮只输出 `store_path` + 增量

- 输出落盘规则（同名不覆盖，v4.2）：
  - 对每个要写入的文件（如 `finding_report.md`、`fingerprints.json` 等），目标路径为 `<OUTPUT_DIR>/<filename>`。
  - 若目标文件已存在：在扩展名前追加后缀 `_YYYYMMDD_HHMMSS`（默认；可由用户覆盖），并在 Round 0/每轮输出中记录实际路径。
  - 若环境不支持落盘：在对话中输出完整内容，并在结论中标注“未落盘原因”。

- 预算（v4.1 新增，可选）：
  - `max_rounds`：最大 Round 数（不含 Round 0）
  - `max_time_minutes`：最大分析用时
  - `max_tokens`：最大 token 预算（若环境可计量）
  - 若触发预算终止：必须输出“预算终止结论（未达到天花板）”并说明残留未穷尽维度与风险。

- Round 内反思/自选（v4.1+ 补充，可选）：
  - `round_reflection = off | sample3_select | rpc_select | bbon_select`
  - `sample3_select`：每轮生成3份候选发现→按指纹自选合并；只在 1/3 候选中出现的指纹需回到证据位置复核，否则降级为“疑点/待确认”（不计入 `new_count`）。
  - `rpc_select`：在 `sample3_select` 基础上，引入“内部概率/置信度”的加权一致性聚合（Perplexity Consistency 思想）与可选降级规则（Reasoning Pruning 思想）：
    - `weight_source = auto | logprobs | verbalized_confidence | none`
    - `prune_mode = off | demote_low_support | demote_low_mass`
    - `high_sev_guard = on | off`
  - `bbon_select`：在不取并集的前提下，生成候选→生成“事实叙事（candidate_facts）”→比较式选择输出单一最优候选（默认 `selection_authority=auto`，适用于用户不懂如何挑选、且更追求稳定择优的场景）：
    - `selection_authority = auto | user`
    - `selection_confirm = auto | on | off`

- 阶段三验证方式（v4.1+ 可覆写）：
  - `stage3_verify_mode = auto | A | B`（高风险领域强制 A；否则 auto 依规则选）

- 排序与优先级（rpc_select，v4.1+ 可选）：
  - `sorting_rule = support_count→conf→严重度（默认） | 严重度优先 | 用户指定`

### 6) 大规模内容处理

若内容超过分片阈值（>100k行代码 或 >50k字符文档）：
- 分片策略：按章节/模块/包分割，每片≤25k字符
- 每片独立达到片内天花板
- 最后分析跨片问题（接口、一致性、依赖）
- **证据要求（v4.1 补充）**：分片仍必须保留可追溯位置。推荐使用“全局行号快照”（每行前缀 `Lxxxx|`）以确保跨片合并时 location 不失真。

### 7) Round 0 输出格式

```
## Round 0：初始化完成
- 分析模式：[代码模式 / 文档模式]
- 内容类型：___
- 内容规模：___  → K=___（并注明口径：字符数/行数/估算）
- 目标受众：___
- 分析目的：___
- 输出目录：<OUTPUT_DIR>（不支持落盘则写 N/A）
- 输出落盘规则：同名不覆盖；冲突后缀 `_YYYYMMDD_HHMMSS`（默认；可由用户覆盖）
- 指纹输出模式：inline_full / inline_compact / external_store
- 预算：max_rounds=___, max_time_minutes=___, max_tokens=___（未设置则写 N/A）
- Doc行号快照：输入自带行号 / 模型按换行生成 L1..Ln（并统一规范化为 `L123` 形式）
- 配置来源：用户显式指定 / Auto Round 0 默认 / 混合（若未写，默认 Auto Round 0）
- Round内反思/自选：off / sample3_select / rpc_select / bbon_select（若未写，按 Auto Round 0 默认）
- rpc_select配置：weight_source=auto/logprobs/verbalized_confidence/none, prune_mode=off/demote_low_support/demote_low_mass, high_sev_guard=on/off（未启用则写 N/A）
- bbon_select配置：selection_authority=auto/user, selection_confirm=auto/on/off, variance_gate_threshold=off/auto/0.05/0.10/0.20（未启用则写 N/A）
- stage3_verify_mode：auto / A / B（若未写，默认 auto）
- sorting_rule（rpc_select）：support_count→conf→严重度（默认） / 严重度优先 / 用户指定（若未写，默认）

选中维度（5-10个）：
1. [维度] → 审视焦点：___
2. [维度] → 审视焦点：___
...

指纹格式：`{PROBLEM_TYPE}::{subject}::{location}`
```

---

## 阶段二：Round 1+ 迭代分析

**初始状态**：Round 1 开始时，K计数器=0。

**每轮执行**：

1) **选择本轮维度**
- 阶段三前：按轮换算法选择（若D<3则选全部）
- 阶段三后：只能从“未穷尽维度”中选择
- 本轮维度数必须为：`min(3, D_avail)`（若 `D_avail < 3` 则选全部可选维度）

2) **分析内容，记录所有发现**
- 每条发现必须有具体位置引用（证据）
- 生成指纹：`{PROBLEM_TYPE}::{subject}::{location}`
- 按 v4.1 去重算法与历史指纹集比对，仅记录新增

2.5) **Round 内反思/自选（可选，round_reflection=sample3_select | rpc_select | bbon_select）**
- 共同步骤（sample3_select / rpc_select / bbon_select 都执行）：
  - 先独立生成 3 份候选发现列表（A/B/C），每份都必须遵守证据闸门与指纹规则。
  - （可选，但建议）计算候选分歧度：`coverage@3 = |FP_union|`，`variance_ratio = 1 - |FP_intersection| / |FP_union|`（其中 FP_union 为 A/B/C 指纹并集，FP_intersection 为 A/B/C 指纹交集；边界：若 `|FP_union|=0`，则 `coverage@3=0` 且 `variance_ratio=0`）。
    - 若 `FP_union = FP_intersection`（三份候选完全一致）：可直接采用任一候选作为本轮结果，并跳过后续“合并/选择”步骤（节省 token）。
    - 若 `variance_gate_threshold ≠ off` 且 `variance_ratio ≤ variance_gate_threshold`（分歧很小；阈值可在 Round 0 用 `variance_gate_threshold` 覆写；auto 按 K 自适应：K=2→0.05，K=3→0.10，K=4→0.20）：允许触发 **variance_gate**（仅影响 bbon_select）：
      - 在 `round_reflection=bbon_select` 下：允许将“事实叙事×比较式选择”**简化**为：默认选 A（或证据更强者），并给出**最短可复核理由**（至少引用 1–2 条 `candidate_facts` 及其证据窗口/验收点）；在统计中标记 `variance_gate=on`。

- 若 round_reflection=sample3_select：
  - 合并策略：均匀权重（等价于每条候选 weight=1）；输出时可附 `support_count`（1–3）。
  - `confidence` 可写 N/A，或按 `support_count / Σ support_count` 归一化得到（仅代表一致性强弱，不代表内部概率）。
  - 输出要求：不输出 A/B/C 全文，只输出合并后的最终结果。

- 若 round_reflection=rpc_select（桥接“内部概率 × 自洽性”，参考 RPC/PC 思想）：
  - 目标：在保持一致性聚合优势（降低模型误差）的同时，引入概率/置信度信号提升“选择/排序”的可靠性（降低估计误差影响）。
  - 规则：
    1) 候选输出权重：A/B/C 中每条候选发现都必须附带 `weight ∈ (0,1]`。
       - `weight_source=auto`：若环境可提供 token logprobs 或等价内部概率 → 采用 `logprobs`；否则采用 `verbalized_confidence`；若仍不可用 → 采用 `none`。
       - `weight_source=logprobs`：若环境可提供 token logprobs 或等价内部概率，使用其长度归一化概率作为 weight（推荐）。
       - `weight_source=verbalized_confidence`：输出一个 0–1 概率作为 weight，并保持保守标定；不得在证据薄弱时给出 0.99/1.0。
       - `weight_source=none`：weight 固定为 1（退化为仅用一致性信号）。
    2) 加权一致性聚合（Perplexity Consistency in protocol form）：
       - 对每个指纹 fp 计算：
         - `support_count(fp)` = fp 在 A/B/C 中出现的次数（1–3）
         - `support_mass(fp)` = Σ weight_i（对出现 fp 的候选求和）
       - 计算 `confidence(fp) = support_mass(fp) / 3`（范围 (0,1]；用于跨 Round 比较与排序；若本轮无任何候选条目，则 confidence=N/A）。
       - （可选）若仅需 Round 内归一化分布：可另记 `confidence_norm(fp) = support_mass(fp) / Σ support_mass(·)`（同一 Round 内归一化）。
    3) 可选降级（Reasoning Pruning in protocol form，**不删除，只降级**）：
       - `prune_mode=demote_low_support`：对 `support_count=1` 的条目默认进入“疑点/待确认”，除非复核后仍满足“强证据 + 可验收 + 可执行”。
       - `prune_mode=demote_low_mass`：对 `confidence(fp) < mean(confidence)` 的条目默认进入“疑点/待确认”（仅当本轮可计算 mean(confidence) 且候选条目数≥2 时启用），除非复核通过。
       - `high_sev_guard=on`：严重度=高的条目不得仅凭低支持度/低置信度降级；必须给出阻断场景与证据复核结论后再决定去留。
  - 输出要求：不输出 A/B/C 全文，只输出合并后的最终结果；并在每条“新发现/疑点”后附上 `support_count` 与 `confidence`（可用紧凑格式，如：`support=2/3, conf≈0.37`）。

- 若 round_reflection=bbon_select（事实叙事 × 比较式选择；默认 selection_authority=auto）：
  - 目标：不取并集，而是在候选之间选择 1 个“证据更强、验收更清晰、严重度更诚实”的版本作为本轮输出，降低方差与“拼接式不一致”。
  - 第一步：为每个候选生成 `candidate_facts`（事实叙事；用于可比、可复核的候选理解）：
    - 硬约束：只陈述可核对事实，禁止推断；不得假设“动作/修改一定成功”。不确定就写 `UNVERIFIED` 并说明缺少何种证据。
    - 证据绑定：每条 fact 必须包含证据位置 `evidence`（文档：`L行号`/`L起始-L结束`；代码：`path:L行号`）。
    - 证据窗口（强制场景）：对“高严重度/易误读细节（数字/符号/否定词/单位）”必须附 `evidence_window`（如 `Lx-2..Lx+2`）以便复核。
    - 原子化：一条 fact 只讲一件事；避免“多个发现合并一句”导致不可验证。
    - 推荐 schema（候选内部，不必落盘，仅用于比较）：
      - `F# { claim, evidence, evidence_window?, why_it_matters, verify }`
  - 第二步：比较式选择（MCQ 风格；同上下文并排对比 A/B/C）：
    - 裁决优先级（从高到低）：
      1) 证据闸门优先：无证据/证据对不上 → 直接判为劣势（最多进入“疑点/待确认”）。
      2) 可验收优先：验收标准更清晰、更可操作的候选优先。
      3) 严重度诚实：标高严重度但缺阻断场景者必须降级。
      4) 内部一致性：前后自相矛盾者劣势。
    - 输出契约（必须满足）：
      - `selected_option ∈ {A,B,C}`
      - `decision_rationale`：逐条引用 `candidate_facts` 的编号（如 F3/F7）与证据窗口进行对比说明；禁止用“叙事更丰富/更像/更合理”作为正向证据。
      - 若三者都未满足关键约束：选择“缺证据最少/最诚实标注不确定性”的候选，并把缺口列入“疑点/待确认”（不计入 new_count），以便下一轮补证据而不是硬编。
  - 第三步：落地为本轮结果：
    - 本轮“新发现/疑点”仅采用被选候选的列表；其他候选仅作为比较材料，不计入 `new_count`。
    - `selection_authority=auto`：由模型直接选择并继续输出（不中断）；若 `selection_confirm≠off`，则给出一句“如需改选请回复 A/B/C”，供用户覆盖。
    - `selection_authority=user`：仍需给出 `recommended_option`（推荐选项）+ 可复核理由，且用一句话请求用户确认/覆盖；若用户明确表示“不懂/你决定”，则回退为 auto。
    - `selection_confirm=auto/on/off`：auto/on 时输出“已按推荐选项执行；如需改选请回复 A/B/C”（不中断）；off 不输出提示。

3) **更新产出文件**
- 代码模式：`architecture.json`, `README_RUNBOOK.md`, `refactor_backlog.yaml`
- 文档模式：`finding_report.md`
- 若环境不支持落盘：本步骤跳过落盘，只在对话输出，并在结论中标注原因。

4) **计算统计**
- `new_count = 本轮新指纹数`
- 若 `new_count > 0`：K计数器 ← 0
- 若 `new_count = 0`：K计数器 ← K计数器 + 1

5) **判断状态**
- 若 K计数器 < K：继续下一轮
- 若 K计数器 = K：进入阶段三（对当前未穷尽维度进行验证）

**每轮输出格式**：

```
## Round N
本轮维度：[维度1]、[维度2]、[维度3]
维度选择说明（仅当需要解释“连续轮次维度集合相同”等情况时填写）：___

### 新发现
| # | 指纹 | 问题描述 | 改进建议（含最小验收标准） | 严重度 |
|---|------|----------|--------------------------|--------|
| 1 | PROBLEM_TYPE::subject::L行号 | 描述...（support=__/3, conf≈__ / N/A） | 建议...（验收：...） | 高/中/低 |
（注：support/conf 仅在启用 round_reflection 时填写；未启用写 N/A；sample3_select/bbon_select 的 conf 可写 N/A）

（若无新发现，写“本轮无新发现”）

### 疑点/待确认（不计入 new_count）
- [指纹]（support=__/3, conf≈__ / N/A）：原因（例如：仅出现在1/3候选，复核未通过/证据不足/验收不清晰）
（若无，写“本轮无疑点/待确认”）

### 统计
- new_count: ___
- 累计指纹: ___
- K计数器: ___/K（K值=___）
- 本轮尝试维度: [列表]
- 未穷尽维度: [列表]（阶段三前等于全量维度列表）
- 已穷尽维度: [列表]（阶段三执行前为空）
- 阶段三执行次数: ___
- Round内反思/自选: off / sample3_select / rpc_select / bbon_select（若启用，则 candidates=3）
- rpc_select配置: weight_source=auto/logprobs/verbalized_confidence/none, prune_mode=off/demote_low_support/demote_low_mass, high_sev_guard=on/off（未启用则写 N/A）
- bbon_select配置: selection_authority=auto/user, selection_confirm=auto/on/off, variance_gate_threshold=off/auto/0.05/0.10/0.20, selected_option=A/B/C（未启用则写 N/A）
- 候选分歧摘要（若启用 round_reflection 且生成了候选）：coverage@3=___, variance_ratio=___, variance_gate=on/off（未启用则写 N/A）
- 指纹输出模式: inline_full / inline_compact / external_store
- 历史指纹集:
  - inline_full: [JSON数组]
  - inline_compact: delta_fingerprints=[...], fingerprints_count=___
  - external_store: store_path=<OUTPUT_DIR>/fingerprints.json, delta_fingerprints=[...], fingerprints_count=___
```

---

## 阶段三：多维度验证（v4.1 可重入）

**触发条件**：阶段二中 K计数器首次或再次达到 K 时触发。

**验证目标**：只针对“当前未穷尽维度”，刻意寻找此前可能遗漏的问题。

**验证方式选择**：
- 可覆写参数：`stage3_verify_mode = auto | A | B`
  - 若为高风险领域（安全/合规/财务/法律）：强制 A（不可被覆写）
    - 高风险领域判定（从高到低优先级，满足任一即视为高风险）：
      1. 用户在配置或目标中显式声明属于安全/合规/财务/法律
      2. 选中维度包含「安全性」或「合规性」
      3. 文本出现高风险信号（见 Auto Round 0 的示例列表）
  - 否则若用户显式指定 A/B：使用该方式
  - 否则（auto）：按以下规则自动选择
- 未穷尽维度数 ≤ 6 → 方式A（逐个验证）
- 未穷尽维度数 > 6 → 方式B（批量验证）

### 方式A（逐个验证）
对每个未穷尽维度依次执行“验证步骤”。

### 方式B（批量验证，v4.1 补全）
- 将未穷尽维度按每组 ≤ 3 个分组（例如：每组3个，最后一组可能1–2个）。
- 以“组”为单位阅读与检查，但**记录结果必须按维度分别输出**（禁止只给组结论）。
- 在同一段落/同一位置可同时触发多个维度的发现，但每条发现的指纹仍是唯一的。

### 验证步骤（A/B通用）
对每个维度：
1. **仅关注该维度审视焦点**，忽略其他维度。
2. **假设之前遗漏了该维度的问题**，刻意寻找。
3. 仅当发现满足“证据可定位 + 指纹可生成 + 去重后确为新增”时，才计入阶段三新发现。
4. 若该维度新发现数=0：标记该维度为“✅ 已穷尽”（终态）。
5. 若该维度新发现数>0：保持“✗ 未穷尽”。

### 阶段三结束后处理
- 若阶段三新增指纹 > 0：
  - K计数器 ← 0
  - 阶段三执行次数 +1
  - 返回阶段二继续 Round N+1（仅从未穷尽维度中选维度）
- 若阶段三新增指纹 = 0：
  - 阶段三执行次数 +1
  - 进入阶段四输出天花板结论（此时所有维度均已穷尽）

**阶段三输出格式**：

```
## 阶段三：多维度验证结果

验证方式：[方式A/方式B]
本次验证维度范围：当前未穷尽维度（数量=___）

### 维度验证状态
| 维度 | 新发现数 | 穷尽标记 |
|------|----------|----------|
| 正确性 | 0 | ✅ 已穷尽 |
| 完整性 | 2 | ✗ 未穷尽 |
...

### 阶段三新发现（若有）
| # | 指纹 | 维度 | 描述 | 严重度 |
|---|------|------|------|--------|
| 1 | ... | ... | ... | ... |

### 统计
- 阶段三新增指纹: ___
- 累计总指纹: ___
- K计数器状态: ___（阶段三期间冻结）
- 后续处理: [返回阶段二 / 进入阶段四]
```

---

## 阶段四：结论

### rpc_select：默认排序与优先级规则（v4.1+）
当 round_reflection=rpc_select 时，输出中的“建议后续行动/主建议清单”默认按以下规则排序（除非用户明确覆盖）：
1. 每条行动项必须绑定一个 **primary_fp（主指纹）**，即该行动主要解决的指纹。
2. 默认排序键（从高到低）：
   - `support_count(primary_fp)`：3/3 > 2/3 > 1/3
   - `confidence(primary_fp)`：数值越大越优先（0–1）
   - `严重度(primary_fp)`：高 > 中 > 低
3. 若 `support_count(primary_fp)=1/3` 仍进入主建议：必须在行动项里写出“证据复核通过”的要点（含证据位置）。
4. 若用户显式指定其他排序（例如“严重度优先”）：必须在 Round 0 明确声明“排序规则来源：用户指定”。

阶段四有三类合法结论：
1) **天花板结论**（达到经验性天花板）
2) **预算终止结论**（未达到天花板）
3) **用户提前终止结论**（未达到天花板）

### A) 天花板结论
**进入条件**：最近一次触发 K 后，阶段三验证完成且无新发现。

**输出格式**：

```
═══════════════════════════════════════════════════════════════════════
                         天花板结论
═══════════════════════════════════════════════════════════════════════

### 分析条件
- 分析模式: [代码模式 / 文档模式]
- 内容类型: ___
- 内容规模: ___
- K值: ___
- 分析总轮次: ___
- 阶段三执行次数: ___
- 指纹输出模式: ___

### 已穷尽维度
1. [维度] - 阶段三穷尽
...

### 统计摘要
- 总指纹数: ___
- 按严重度: 高=___ 中=___ 低=___
- 按PROBLEM_TYPE: INCOMPLETE=___ CONFLICT=___ ...

### 完整发现清单（按严重度排序）

**高严重度：**
| # | 指纹 | 问题 | 建议 |
|---|------|------|------|
...

**中严重度：**
...

**低严重度：**
...

### 诚实局限声明
- [领域知识限制]
- [信息不足]
- [模型能力边界]

### 建议后续行动
1. [最高优先级]（若 round_reflection=rpc_select：优先绑定 `support≥2/3`；若 `support=1/3` 也要进入主建议，必须附带“证据复核通过”说明；默认排序：support_count→conf→严重度）
2. [次优先级]
...

═══════════════════════════════════════════════════════════════════════
```

### B) 预算终止结论（未达到天花板）
**进入条件**：Round 0 配置了预算，且在达到天花板前触发预算上限。

**输出格式**：

```
═══════════════════════════════════════════════════════════════════════
                    预算终止结论（未达到天花板）
═══════════════════════════════════════════════════════════════════════

### 预算信息
- 触发的预算项: [max_rounds / max_time_minutes / max_tokens]
- 配置值: ___
- 实际消耗: ___

### 当前分析状态
- 分析模式: ___
- 内容类型: ___
- 内容规模: ___
- K值: ___
- 已完成总轮次: ___
- K计数器: ___/K
- 阶段三执行次数: ___

### 已穷尽维度
...

### 未穷尽维度（残留风险来源）
...

### 当前累计发现摘要
- 总指纹数: ___
- Top风险领域/维度: ___

### 建议后续行动
1. [如果继续，应优先覆盖哪些未穷尽维度]（若 round_reflection=rpc_select：优先覆盖“低支持度/低置信度但潜在高风险”的指纹与维度；默认排序：support_count→conf→严重度）
2. [如何降低预算下的风险]

═══════════════════════════════════════════════════════════════════════
```

### C) 用户提前终止结论（未达到天花板）
**进入条件**：用户明确输入“提前终止”。

**输出格式**：

```
═══════════════════════════════════════════════════════════════════════
                    用户提前终止结论（未达到天花板）
═══════════════════════════════════════════════════════════════════════

### 当前分析状态
- 分析模式: ___
- 内容类型: ___
- 内容规模: ___
- K值: ___
- 已完成总轮次: ___
- K计数器: ___/K
- 阶段三执行次数: ___

### 已穷尽维度
...

### 未穷尽维度（残留风险来源）
...

### 当前累计发现摘要
- 总指纹数: ___
- Top风险领域/维度: ___

### 建议后续行动
1. [如果继续，应优先覆盖哪些未穷尽维度]
2. [如何在预算/时间限制下复跑]

═══════════════════════════════════════════════════════════════════════
```

---

## 防止提前停止机制（v4.1）

⚠️ **严格执行**：

1) **禁止主观停止**
- ❌ “感觉差不多了”
- ❌ “主要问题都找到了”
- ✅ 合法停止只有三类：天花板结论 / 预算终止（显式） / 用户提前终止

2) **每轮必须尝试足够维度**
- 阶段二每轮至少尝试 `min(3, D_avail)` 个维度（`D_avail<3` 时尝试全部可选维度）
- 连续2轮完全相同维度：必须解释原因（写在本轮输出的“维度选择说明”字段）；但若 `D≤3` 或因边界条件导致集合必然相同，可仅标注“边界触发，无需解释”。

3) **自我检查（每轮结束）**
- □ 维度数是否满足 `min(3, D_avail)`？如未满足，是否触发并记录了边界条件？
- □ 指纹格式是否规范？（PROBLEM_TYPE枚举正确？subject规范化可复现？location用L行号/路径行号？）
- □ 去重规则是否按 v4.1 算法执行？
- □ K计数器更新是否合理？
- □ 是否诚实记录了所有“有证据支持”的发现？

## 输出质量闸门（v4.1+ 补充）

⚠️ **硬约束**：不满足以下闸门，不允许进入阶段四输出“最终结论/主建议清单”（只能继续迭代，或走预算终止/用户提前终止）。

1) **证据闸门（新发现必须可定位）**
- 任何计入 `new_count` 的发现必须带证据位置（文档：`L行号`/`L起始-L结束`；代码：`path:L行号`）。
- 无法给出证据 → 不得生成指纹、不计入新发现（最多记录为“疑点/待确认”，不进入指纹集）。

2) **建议绑定闸门（防空泛）**
- 每条“修改/优化建议”必须绑定 ≥1 条指纹（或说明为何为 `global`）。
- 未绑定指纹的内容只能作为“可选想法/背景说明”，不得进入主建议清单。

3) **可验收闸门（防不可执行）**
- 主建议必须包含最小验收标准（Acceptance），说明“做完后如何客观判断有效”。
- 无验收标准 → 建议降级为备注，不计入主建议。

4) **严重度闸门（防随意标高）**
- 标注“高严重度”必须附带阻断场景描述（执行到X步无法继续，因为Y），否则严重度降级为“中”。

5) **去重与格式闸门（防重复堆叠，保证可重入）**
- 指纹必须严格符合 `{PROBLEM_TYPE}::{subject}::{location}`，且 `subject` 必须来自原文原词并按 v4.1 规则规范化。
- 去重必须按 v4.1 Exact +（仅单行 location）Fuzzy±5 行执行。
- 重复项不得计入 `new_count`。

6) **结论闸门（防提前停止）**
- 合法停止仅三类：天花板结论 / 预算终止（显式） / 用户提前终止。

7) **自洽/置信度闸门（仅当 round_reflection=rpc_select）**
- Round 0 必须声明 `weight_source` 与 `prune_mode`（auto/logprobs/verbalized_confidence/none；off/demote_low_support/demote_low_mass）。
- 阶段四“主建议清单/后续行动”中出现的建议，必须绑定到：
  - `support_count ≥ 2/3` 的指纹，或
  - `support_count = 1/3` 但已在本轮证据复核中明确“仍成立”的指纹（写出复核要点与证据位置）。
- 对 `support_count = 1/3` 的指纹：除非给出复核结论，否则只能进入“次要建议/疑点/待确认”，不得进入主建议清单。

8) **叙事/选择闸门（仅当 round_reflection=bbon_select）**
- 本轮若发生 bbon_select 选择：必须给出 `selected_option` 与可复核理由（只允许引用 `candidate_facts`/证据窗口/验收标准），不得以“叙事更丰富/步骤更多/看起来更合理”作为正向证据。
- 若 `selection_authority=user`：必须同时给出 `recommended_option`（推荐选项）与理由，让用户可直接同意/覆盖；不得要求用户理解细节后才能继续。

9) **格式修复重试闸门（v4.1++ 补充）**
- 若本轮输出违反任何“硬格式要求”（例如：缺少证据位置/指纹不合规/Markdown diff 不成对/缺少必需字段），必须在**同一轮**立即自修复（最多重试 3 次），而不是带病进入下一轮或进入阶段四。
- 自修复方式（协议内提示词范式，供模型执行）：
  - 先输出一个“格式反馈块”逐条列出需修复点；然后给出“完全替换版”的新输出。
  - 替换版不得提及“格式反馈块”本身（避免污染最终产出）。
- 若连续 3 次仍无法修复：必须输出“格式错误未修复 → 本轮作废”，并继续下一轮；该作废轮不更新指纹集、不更新 K 计数器（视为 LLM 异常处理而非有效分析轮）。

10) **代码修改提案闸门（混合任务，v4.1+++ 补充）**
- 若用户要求输出“代码修改提案/patch/diff”（且代码侧不走K流程）：
  - 每个提案必须包含：
    - `source_in_paper`：论文证据（`L行号/L范围`）
    - `target_in_code`：代码证据（`path:L行号`）
    - `change_diff`：可应用的 Markdown diff（或明确说明为何只能给 plan）
    - `acceptance`：最小验收标准（必须包含如何测试）
    - `risk_and_rollback`：风险与回滚路径
  - 禁止编造仓库结构/文件路径/函数名；若缺少上下文，必须输出“需补充的代码证据清单”，不得硬写细节 diff。
  - 若单个提案规模过大（建议：≥4个文件或 diff>200 行）：必须拆分为多个提案，或先给分步 plan 再逐步给 diff（不可一次性给大改）。

---

## 产出物 Schema

### 文档模式：finding_report.md

```markdown
# [文档标题] 深度评估报告

## 1. 评估概览
- **评估时间**: YYYY-MM-DD
- **协议版本**: v4.2（以实际使用的协议文本为准）
- **快照说明**: [输入自带行号/模型按换行生成L1..Ln]
- **K值设置**: ___ (基于规模: ___)
- **总轮次**: ___
- **阶段三执行次数**: ___
- **指纹输出模式**: ___
- **Round内反思/自选**: ___
- **rpc_select 配置**: weight_source=___, prune_mode=___, high_sev_guard=___（未启用则写 N/A）
- **bbon_select 配置**: selection_authority=___, selection_confirm=___, variance_gate_threshold=___（未启用则写 N/A）
- **总体结论**: [达到天花板/预算终止/用户提前终止]

## 2. 统计摘要
- **总发现数**: ___
- **严重度分布**: 高(__) / 中(__) / 低(__)
- **主要问题类型**: [列出Top3 PROBLEM_TYPE]
- **候选分歧摘要（若启用 round_reflection 且生成了候选）**: coverage@3=__, variance_ratio=__, variance_gate=__
- **一致性/置信度摘要（若启用 rpc_select）**: support_count_hist={1:__,2:__,3:__}, ECE_proxy=__（若阶段三复核已发生）

## 3. 完整发现清单（按严重度分组）

### 高严重度 (数量: __)
| # | 指纹 | 问题描述 | 改进建议（含最小验收标准） |
|---|------|----------|--------------------------|
| 1 | ... | ... | ...（验收：...） |

### 中严重度 (数量: __)
...

### 低严重度 (数量: __)
...

## 4. 维度覆盖状态
| 维度 | 状态 | 发现数 |
|------|------|--------|
| 正确性 | ✅ 已穷尽 | ___ |
...

## 5. 局限性声明
...

## 6. 迁移/修改提案（可选，按需输出）

适用：用户要求“从论文中抽取可迁移点，并对某个文件/项目代码提交修改提案”。

### 6.1 可迁移点清单（论文侧，有证据）
- 每项包含：名称/一句话用途/关键约束或前提/证据位置（L行号或范围）/可迁移风险。

### 6.2 代码修改提案包（代码侧，不走四阶段K流程，但必须可复核）
- 每个提案包含：
  - `proposal_id`：唯一编号
  - `scope`：file / module / project（默认 file）
  - `source_in_paper`：引用论文证据（L行号/范围），说明复用点
  - `target_in_code`：目标文件与证据位置（`path:L行号`）
  - `change_diff`：Markdown diff（小步；建议≤3文件且≤200行；超出则拆分或先给 plan）
  - `acceptance`：最小验收标准（必须包含如何测试：测试命令或最小手工步骤）
  - `risk_and_rollback`：风险与回滚方案（若适用）
  - `dependencies`（可选）：新增/变更依赖、配置项、迁移步骤

## 7. 历史指纹集（用于中断恢复）
- 若为 inline_full：直接附全量JSON数组
- 若为 inline_compact：附 fingerprints_count + 所有轮次 delta_fingerprints 的串联结果（或提供外部存储）

```json
["fingerprint1", "fingerprint2", ...]
```
```

### 代码模式：三产出物

**1) architecture.json**
```json
{
  "schema_version": "4.2",
  "snapshot": {"id": "<commit>", "date": "<ISO-8601>"},
  "entrypoints": [...],
  "components": [...],
  "interfaces": [...],
  "dependencies": [...],
  "runtime": {...},
  "quality_risks": [...],
  "open_questions": [...]
}
```

**2) README_RUNBOOK.md**
- 所有事实陈述必须有证据引用
- 目标 `evidence_ratio ≥ 80%`
- evidence_ratio 计算口径（v4.1 最小可操作定义）：
  - 以 README 中每个“分条项（以换行分隔的 bullet）或以句号结尾的陈述句”为统计单元
  - 单元内包含 `L...` 或 `path:L...` 的证据引用 → 计为“有证据”

**3) refactor_backlog.yaml**
- 字段：id, title, kind, impact, effort, risk, evidence, plan, acceptance, dependencies
- kind 建议枚举：bugfix | refactor | docs | test | chore | perf | security
- impact/effort/risk 建议枚举：high | medium | low
- 示例：

```yaml
- id: RB-001
  title: 修复/重构某个高优先级问题
  kind: refactor
  impact: medium
  effort: low
  risk: low
  evidence: ["src/main.py:L42"]
  plan:
    - "明确问题根因与改动范围"
    - "拆分为可验收的小步骤"
  acceptance:
    - "相关测试通过"
    - "关键路径无回归"
  dependencies: []
```

---

## 异常处理

1) **用户提前终止**：用户输入“提前终止”，在结论中标注“用户请求提前终止，未达到天花板”。

2) **预算终止（v4.1 新增）**：
- 若触发预算：输出“预算终止结论（未达到天花板）”，并列出未穷尽维度与残留风险。

3) **分析中断恢复**：
- 每轮输出包含恢复所需状态：K计数器、阶段三执行次数、已穷尽维度列表、未穷尽维度列表、指纹输出模式与指纹状态（全量或增量）。
- 恢复时提供：最后一轮输出 +（全量指纹集 或 外部存储路径 或 从Round1起的所有delta串联）

4) **LLM异常处理**：
- 上下文溢出 → 触发分片流程
- 幻觉生成 → 要求提供证据位置，无法提供则不记录
- 格式错误 → 立即修正

---

## 高级场景

### 1) 大规模内容分片

触发条件：>100k行代码 或 >50k字符文档

步骤：
1. 按模块/章节分割，每片≤25k字符
2. 每片独立执行完整流程达到片内天花板
3. 合并阶段：合并指纹集（去重）+ 跨片分析轮
4. 整体K值 = max(各片K值) + 1

**v4.1 建议**：尽量使用“全局行号快照”避免合并后证据失真。

### 2) 增量分析（内容变更后）

1. 计算 diff，识别变更区域
2. 失效变更区域相关的指纹（`global` 指纹不失效，除非问题已被明确修复并能定位）
3. 仅对变更区域重新分析
4. 合并新旧指纹集，K计数器归零
5. 维度“已穷尽”状态可按需重置：若变更影响某维度的结论，应将该维度从“已穷尽”移回“未穷尽”

### 3) R次独立重跑验证

推荐用于高风险场景：
1. 独立重跑R次（建议R=3）
2. 计算收敛率 = 稳定指纹数 / 指纹并集数
3. 目标：整体≥80%，高严重度≥90%

---

## 版本历史

### v4.2 (2025-12-23)
**融合版**：融合 `llm-ceiling-protocol-v4.1.md` 与 `llm-ceiling-protocol-v4.1x.md`，统一规则表述并修复已知矛盾点。

**主要变化**：
- **落盘规则统一**：补齐“输出落盘规则（同名不覆盖）”，并在 Round 0 输出中增加输出目录与落盘规则字段。
- **Stage 4 结论补齐**：补齐“用户提前终止结论（未达到天花板）”模板，使之与合法停止条件一致。
- **rpc_select 置信度定义修复**：将 `confidence(fp)` 统一为 `support_mass(fp) / 3`（0–1，可跨轮比较），并对 `demote_low_mass` 增加可计算条件。
- **Stage 3 高风险判定细化**：补齐高风险领域判定规则（安全/合规/财务/法律）。
- **合并工程细节**：补齐输出模板可复制性（Markdown 表格修复）、refactor_backlog.yaml 示例与枚举、本地/在线来源引用并存等。

### v4.1 (2025-12)
**一致性与可执行性修订版**：在 v4.0 基础上补齐可执行细节并修复边界冲突。

**主要变化**：
- **阶段三可重入**：K再次达到K时可再次进入阶段三（仅验证未穷尽维度），保证“天花板定义”与“停止条件”一致
- **补全方式B**：给出批量验证的可执行流程与输出要求
- **修复最少尝试维度数边界**：使用 `min(3, D_avail)` 规则，避免仅剩1个未穷尽维度时流程不可满足
- **轮换算法无歧义**：明确 0-based 与公式
- **去重规则算法化**：明确 Exact/Fuzzy 适用范围
- **subject 规则统一**：明确“原词来源 + 可复现规范化”
- **指纹输出模式**：新增 compact/store 以降低输出膨胀
- **新增预算终止**：允许显式预算上限下停止并标注“未达到天花板”

### v4.1+ (2025-12-22)
**输出质量强化补丁（不改变主流程）**：在 v4.1 框架下补齐“开箱即用默认配置”和“输出质量闸门”，用于提升单窗口 prompt 的稳定性与可复现性。
- **Auto Round 0 默认配置**：当用户未指定 dims/预算/输出模式时，模型必须按默认规则补全并在 Round 0 明确声明
- **输出质量闸门**：证据闸门/建议绑定/可验收/严重度闸门/格式去重闸门，降低空泛与不可执行建议
- **Round 内反思/自选（sample3_select）**：每轮先生成3份候选发现，再按指纹自选合并，用于提升覆盖率与可执行性（可关闭以节省token）
- **rpc_select（内部概率 × 自洽性）**：引入“加权一致性聚合 +（可选）降级”，并增加主建议的自洽/置信度闸门，提升建议可靠性与可解释性
- **使用说明章节**：新增“如何复制使用/核心算法来源/参数速查/场景建议”等说明，降低使用门槛
- **rpc_select 默认排序规则**：阶段四行动清单默认按 `support_count→conf→严重度` 排序（可由用户覆盖但需声明来源）

### v4.1++ (2025-12-22)
**基于 Agent-S3 / bBoN 的可比性与自修复补丁（不改变四阶段主流程）**：补强 bbon_select 的事实叙事与比较式裁决契约，并新增 variance_gate_threshold（并在统计中标记 variance_gate）与格式修复重试闸门，提升稳定性与成本可控性。
- **bbon_select：candidate_facts 事实化 schema**：明确原子化、证据绑定、禁止推断、证据窗口/验收字段。
- **bbon_select：比较式选择契约强化**：明确裁决优先级（证据→验收→严重度诚实→一致性），要求引用 facts 进行可复核比较。
- **variance_gate_threshold（bbon_select，可覆写）**：新增可覆写阈值（off/auto/0.05/0.10/0.20）；其中 auto 按 K 自适应：K=2→0.05，K=3→0.10，K=4→0.20；当 `variance_gate_threshold ≠ off` 且 `variance_ratio ≤ variance_gate_threshold` 时允许简化 bbon_select 的比较流程并标记 variance_gate=on，以节省 token。
- **格式修复重试闸门**：格式错误最多重试3次，要求“替换输出”且不得提及反馈块，避免带病进入下一轮/阶段四。

### v4.1+++ (2025-12-22)
**论文 PDF 场景补丁（Doc Mode，不改变四阶段主流程）**：补齐论文 PDF 作为输入时的预处理与防上下文爆炸约束，确保证据可追溯、分片可合并；并补齐“论文→代码提案”的同窗口混合交付规范。
- **PDF→纯文本→规模测量**：先提取全文纯文本，再统计 chars/lines；K 值以全文 chars 判定。
- **全局行号快照强制**：全文按换行编号 L1..Ln；分片保留全局行号，避免证据失真。
- **指纹输出模式防爆**：优先 external_store，其次 inline_compact；在论文PDF/长文档场景禁用 inline_full。
- **混合任务规范（论文PDF + 配套代码 + 修改提案）**：明确“论文侧走协议、代码侧不走K流程”的执行顺序与提案证据要求（paper L行号 + code path:L行号）。
- **代码提案闸门与小步交付**：提案必须可复核（paper+code 双证据），并限制单提案规模（建议≤3文件且≤200行）且必须给出测试/验收与回滚路径。
- **Code Mode 迁移复用维度扩展**：新增/强化与“复用前沿代码/框架/算法”相关的维度（核心机制/算法、接口契约、可扩展性、可迁移性、依赖与版本策略、可测试性、复现性等），并更新 Auto Round 0 的 Code Mode 默认维度。

### v4.0 (2024-12)
合并优化版：结合 v3.9 核心定义 + 结构优化

### v3.9 (2024-12)
结构化指纹格式，16个PROBLEM_TYPE枚举

### v3.0–v3.8
迭代优化版本，详见历史文档
