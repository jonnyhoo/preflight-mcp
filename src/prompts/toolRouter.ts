/**
 * Intelligent Tool Router for Preflight MCP.
 *
 * Provides LLM-friendly tool selection guidance based on user intent.
 * This module helps LLMs choose the most appropriate tool for any task.
 *
 * IMPORTANT FOR LLMs:
 * - After creating a bundle, ALWAYS proceed with analysis tools
 * - Use call graph tools for function-level understanding
 * - Follow the standard workflows defined below
 *
 * @module prompts/toolRouter
 */

// ============================================================================
// Tool Categories
// ============================================================================

export interface ToolInfo {
  name: string;
  category: ToolCategory;
  description: string;
  keywords: string[];
  chineseKeywords: string[];
  requires: 'bundleId' | 'path' | 'none';
  mutating: boolean;
  /** When should this tool be used? Clear guidance for LLMs */
  whenToUse: string;
  /** What to do after using this tool? */
  nextSteps?: string[];
}

export type ToolCategory =
  | 'document'      // Document parsing and analysis
  | 'search'        // Search functionality
  | 'bundle'        // Bundle management
  | 'analysis'      // Code analysis and dependency graphs
  | 'callgraph'     // Function-level call graph analysis
  | 'quality'       // Code quality checks (duplicates, deadcode, complexity, etc.)
  | 'trace'         // Trace links
  | 'modal'         // Multimodal content
  | 'navigation'    // Navigation and discovery
  | 'distill';      // Knowledge distillation (card generation)

// ============================================================================
// Tool Registry
// ============================================================================

export const TOOL_REGISTRY: ToolInfo[] = [
  // === Bundle Management (START HERE) ===
  {
    name: 'preflight_list_bundles',
    category: 'bundle',
    description: 'List all available bundles. START HERE if you need a bundleId.',
    keywords: ['list', 'bundles', 'show', 'available', 'repos'],
    chineseKeywords: ['列出', '查看', 'bundle', '仓库', '项目', '有哪些'],
    requires: 'none',
    mutating: false,
    whenToUse: 'FIRST STEP: Use this when you need to find an existing bundle or check if a project is already indexed.',
    nextSteps: ['If bundle exists: use preflight_get_overview', 'If not exists: use preflight_create_bundle'],
  },
  {
    name: 'preflight_create_bundle',
    category: 'bundle',
    description: 'Create a new bundle from GitHub repos, local directories, or web documentation sites. This is the entry point for analyzing any project or crawling documentation.',
    keywords: ['create', 'bundle', 'index', 'ingest', 'new', 'add', 'analyze', 'learn', 'crawl', 'web', 'docs', 'documentation', 'website', 'site'],
    chineseKeywords: ['创建', '新建', '索引', '添加', '导入', '分析', '学习', '了解', '爬取', '爬虫', '文档', '网站', '网页'],
    requires: 'none',
    mutating: true,
    whenToUse: 'Use when user wants to: (1) analyze a project (local/GitHub), (2) crawl web documentation site, (3) learn about any codebase or docs. Supports llms.txt fast path for optimized doc sites.',
    nextSteps: [
      'IMMEDIATELY after: use preflight_get_overview to understand the project',
      'For deep code analysis: use preflight_build_call_graph',
      'For architecture: use preflight_dependency_graph',
    ],
  },
  {
    name: 'preflight_get_overview',
    category: 'navigation',
    description: '⭐ Get project overview (OVERVIEW.md + START_HERE.md + AGENTS.md). Best starting point after creating a bundle.',
    keywords: ['overview', 'start', 'understand', 'summary', 'intro'],
    chineseKeywords: ['概览', '了解', '理解', '入门', '开始'],
    requires: 'bundleId',
    mutating: false,
    whenToUse: 'Use immediately after preflight_create_bundle to get a quick understanding of the project structure and purpose.',
    nextSteps: [
      'To understand function calls: use preflight_build_call_graph',
      'To search for specific code: use preflight_search_and_read',
    ],
  },
  {
    name: 'preflight_update_bundle',
    category: 'bundle',
    description: 'Update an existing bundle with latest changes from source.',
    keywords: ['update', 'refresh', 'sync', 'latest'],
    chineseKeywords: ['更新', '刷新', '同步', '最新'],
    requires: 'bundleId',
    mutating: true,
    whenToUse: 'Use when source code has changed and bundle needs refresh.',
  },
  {
    name: 'preflight_repair_bundle',
    category: 'bundle',
    description: 'Repair a corrupted or incomplete bundle.',
    keywords: ['repair', 'fix', 'rebuild', 'restore'],
    chineseKeywords: ['修复', '重建', '恢复'],
    requires: 'bundleId',
    mutating: true,
    whenToUse: 'Use when bundle is corrupted or search index is broken.',
  },
  {
    name: 'preflight_delete_bundle',
    category: 'bundle',
    description: 'Delete a bundle permanently.',
    keywords: ['delete', 'remove', 'destroy'],
    chineseKeywords: ['删除', '移除'],
    requires: 'bundleId',
    mutating: true,
    whenToUse: 'Use only when user explicitly wants to remove a bundle.',
  },

  // === Call Graph Tools (DEEP CODE ANALYSIS) ===
  {
    name: 'preflight_build_call_graph',
    category: 'callgraph',
    description: 'Build function-level call graph. Supports TypeScript, Python, Go, Rust. Essential for understanding code flow.',
    keywords: ['call', 'graph', 'function', 'method', 'flow', 'analyze'],
    chineseKeywords: ['调用图', '函数', '方法', '流程', '分析', '调用关系'],
    requires: 'path',
    mutating: false,
    whenToUse: 'Use after creating bundle when user wants to deeply understand code. Required before using query/extract tools.',
    nextSteps: [
      'To find who calls a function: use preflight_query_call_graph with direction="callers"',
      'To find what a function calls: use preflight_query_call_graph with direction="callees"',
      'To extract function with deps: use preflight_extract_code',
    ],
  },
  {
    name: 'preflight_query_call_graph',
    category: 'callgraph',
    description: 'Query call relationships: who calls this function? what does it call? Essential for impact analysis.',
    keywords: ['query', 'call', 'who', 'calls', 'callers', 'callees', 'depends'],
    chineseKeywords: ['查询', '调用', '谁调用', '被调用', '依赖', '影响'],
    requires: 'path',
    mutating: false,
    whenToUse: 'Use when user asks "who calls X?", "what calls X?", "what does X call?", "what depends on X?".',
  },
  {
    name: 'preflight_extract_code',
    category: 'callgraph',
    description: 'Extract a function and ALL its dependencies as self-contained code. Perfect for understanding or refactoring.',
    keywords: ['extract', 'function', 'code', 'dependencies', 'self-contained'],
    chineseKeywords: ['提取', '函数', '代码', '依赖', '独立'],
    requires: 'path',
    mutating: false,
    whenToUse: 'Use when user wants to understand a specific function completely, or needs to extract code for refactoring.',
  },
  {
    name: 'preflight_interface_summary',
    category: 'callgraph',
    description: 'Generate API documentation for all exported functions/classes in a file or directory.',
    keywords: ['interface', 'api', 'summary', 'documentation', 'exports'],
    chineseKeywords: ['接口', 'API', '文档', '导出', '摘要'],
    requires: 'path',
    mutating: false,
    whenToUse: 'Use when user wants API documentation or needs to understand module boundaries.',
  },

  // === Analysis Tools ===
  {
    name: 'preflight_dependency_graph',
    category: 'analysis',
    description: 'Generate module-level dependency graph showing import relationships.',
    keywords: ['dependency', 'graph', 'import', 'module', 'architecture'],
    chineseKeywords: ['依赖', '图', '架构', '模块', '关系', 'import'],
    requires: 'bundleId',
    mutating: false,
    whenToUse: 'Use for understanding project architecture and module relationships. Different from call graph (which is function-level).',
  },
  {
    name: 'preflight_deep_analyze_bundle',
    category: 'analysis',
    description: 'Comprehensive project analysis including structure, test detection, and dependencies.',
    keywords: ['analyze', 'deep', 'comprehensive', 'structure', 'overview', 'test'],
    chineseKeywords: ['深度分析', '全面', '结构', '概览', '测试'],
    requires: 'bundleId',
    mutating: false,
    whenToUse: 'Use for comprehensive project analysis including test detection.',
  },

  // === Search Tools ===
  {
    name: 'preflight_search_and_read',
    category: 'search',
    description: 'Search code/docs and automatically show matching content. PRIMARY search tool.',
    keywords: ['search', 'find', 'read', 'code', 'content'],
    chineseKeywords: ['搜索', '查找', '找', '代码', '内容'],
    requires: 'bundleId',
    mutating: false,
    whenToUse: 'Use when user wants to find specific code, function, or text in the project.',
  },
  {
    name: 'preflight_search_by_tags',
    category: 'search',
    description: 'Search across multiple bundles filtered by tags.',
    keywords: ['search', 'tags', 'cross-bundle', 'multi', 'filter'],
    chineseKeywords: ['跨bundle搜索', '标签', '多仓库', '过滤'],
    requires: 'none',
    mutating: false,
    whenToUse: 'Use when searching across multiple projects/bundles.',
  },

  // === Navigation Tools ===
  {
    name: 'preflight_read_file',
    category: 'navigation',
    description: 'Read specific file(s) from a bundle. Supports symbol outline for large files.',
    keywords: ['read', 'file', 'content', 'view', 'open'],
    chineseKeywords: ['读取', '文件', '查看', '打开', '内容'],
    requires: 'bundleId',
    mutating: false,
    whenToUse: 'Use when you know exactly which file to read.',
  },
  {
    name: 'preflight_repo_tree',
    category: 'navigation',
    description: 'Get directory tree structure of a repository.',
    keywords: ['tree', 'directory', 'structure', 'files', 'folders'],
    chineseKeywords: ['目录', '树', '结构', '文件夹'],
    requires: 'bundleId',
    mutating: false,
    whenToUse: 'Use to explore project structure before diving into specific files.',
  },

  // === Document Tools ===
  {
    name: 'preflight_parse_document',
    category: 'document',
    description: 'Parse PDF, Word, Excel, PowerPoint, HTML documents and extract content.',
    keywords: ['parse', 'document', 'pdf', 'word', 'excel', 'extract', 'read'],
    chineseKeywords: ['解析', '文档', '读取', '提取', 'PDF', 'Word', 'Excel'],
    requires: 'path',
    mutating: false,
    whenToUse: 'Use when user has a document file (PDF, Word, Excel, etc.) to analyze.',
  },

  // === Multimodal Tools ===
  {
    name: 'preflight_search_modal',
    category: 'modal',
    description: 'Search for images, tables, equations, and diagrams in bundle.',
    keywords: ['search', 'image', 'table', 'equation', 'diagram', 'modal', 'visual'],
    chineseKeywords: ['搜索图片', '搜索表格', '搜索公式', '图表', '多模态'],
    requires: 'bundleId',
    mutating: false,
    whenToUse: 'Use when searching for visual content (images, tables, diagrams).',
  },
  {
    name: 'preflight_analyze_modal',
    category: 'modal',
    description: 'Analyze images, tables, and equations with AI-powered descriptions.',
    keywords: ['analyze', 'image', 'table', 'equation', 'modal', 'ocr', 'visual'],
    chineseKeywords: ['分析图片', '分析表格', '分析公式', 'OCR', '视觉'],
    requires: 'bundleId',
    mutating: false,
    whenToUse: 'Use when you need AI analysis of visual content.',
  },

  // === Code Quality Tools ===
  {
    name: 'preflight_check',
    category: 'quality',
    description: 'Run code quality checks: duplicates, doccheck, deadcode, circular dependencies, complexity hotspots.',
    keywords: ['check', 'quality', 'duplicates', 'deadcode', 'dead', 'unused', 'circular', 'complexity', 'lint'],
    chineseKeywords: ['检查', '质量', '重复', '死代码', '未使用', '循环依赖', '复杂度', '代码检查'],
    requires: 'path',
    mutating: false,
    whenToUse: 'Use when user wants to check code quality: find duplicates, dead code, circular dependencies, or complexity hotspots.',
    nextSteps: ['Review and fix reported issues', 'Run specific checks only if needed'],
  },

  // === Trace Tools ===
  {
    name: 'preflight_trace_query',
    category: 'trace',
    description: 'Query trace links between code, tests, and docs.',
    keywords: ['trace', 'query', 'link', 'test', 'coverage'],
    chineseKeywords: ['追溯', '查询', '链接', '测试', '覆盖'],
    requires: 'bundleId',
    mutating: false,
    whenToUse: 'Use to find relationships between code and tests.',
  },
  {
    name: 'preflight_trace_upsert',
    category: 'trace',
    description: 'Create or update trace links.',
    keywords: ['trace', 'create', 'link', 'connect'],
    chineseKeywords: ['创建追溯', '链接', '关联'],
    requires: 'bundleId',
    mutating: true,
    whenToUse: 'Use to create new trace links between code and tests/docs.',
  },

  // === Knowledge Distillation Tools ===
  {
    name: 'preflight_generate_card',
    category: 'distill',
    description: 'Generate knowledge card from bundle. Extracts "what is this project" and "why is it valuable" for RAG retrieval.',
    keywords: ['card', 'distill', 'knowledge', 'extract', 'summary', 'rag', 'save', 'curate'],
    chineseKeywords: ['卡片', '蒸馏', '知识', '提取', '摘要', '收藏', '精选', '保存'],
    requires: 'bundleId',
    mutating: true,
    whenToUse: 'Use when user wants to save/curate a project for later reference, or extract knowledge summary for RAG.',
    nextSteps: [
      'Card saved in <bundle>/cards/<repoId>/CARD.json',
      'Read card with preflight_read_file',
      'Use format="markdown" for human-readable output',
    ],
  },
];

// ============================================================================
// Routing Logic
// ============================================================================

/**
 * Find the best matching tools for a given query.
 */
export function routeQuery(query: string, maxResults = 3): ToolInfo[] {
  const lowerQuery = query.toLowerCase();
  const scores: Array<{ tool: ToolInfo; score: number }> = [];

  for (const tool of TOOL_REGISTRY) {
    let score = 0;

    // Check English keywords
    for (const keyword of tool.keywords) {
      if (lowerQuery.includes(keyword)) {
        score += 10;
      }
    }

    // Check Chinese keywords
    for (const keyword of tool.chineseKeywords) {
      if (query.includes(keyword)) {
        score += 10;
      }
    }

    // Check description match
    const descWords = tool.description.toLowerCase().split(/\s+/);
    for (const word of descWords) {
      if (word.length > 3 && lowerQuery.includes(word)) {
        score += 2;
      }
    }

    // Check tool name
    if (lowerQuery.includes(tool.name.replace('preflight_', ''))) {
      score += 20;
    }

    // Check whenToUse match
    if (tool.whenToUse) {
      const whenWords = tool.whenToUse.toLowerCase().split(/\s+/);
      for (const word of whenWords) {
        if (word.length > 3 && lowerQuery.includes(word)) {
          score += 5;
        }
      }
    }

    if (score > 0) {
      scores.push({ tool, score });
    }
  }

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);

  return scores.slice(0, maxResults).map(s => s.tool);
}

/**
 * Generate a routing prompt for LLM consumption.
 * This is the main guidance document for LLMs to understand how to use Preflight tools.
 */
export function generateRoutingPrompt(categories?: ToolCategory[]): string {
  const lines: string[] = [];
  
  // Header with clear purpose
  lines.push('# Preflight Tool Router - LLM Guide');
  lines.push('');
  lines.push('## 🎯 Standard Workflows (FOLLOW THESE)');
  lines.push('');
  
  // Workflow 1: New Project Analysis
  lines.push('### Workflow 1: Analyze a New Project ("分析项目", "understand code", "学习代码")');
  lines.push('```');
  lines.push('Step 1: preflight_create_bundle     → Index the project');
  lines.push('Step 2: preflight_get_overview      → Read OVERVIEW.md, START_HERE.md');
  lines.push('Step 3: preflight_build_call_graph  → Build function call relationships');
  lines.push('Step 4: preflight_query_call_graph  → Query specific functions');
  lines.push('```');
  lines.push('');
  
  // Workflow 2: Deep Function Understanding
  lines.push('### Workflow 2: Understand a Specific Function ("谁调用了X", "what calls X")');
  lines.push('```');
  lines.push('Step 1: preflight_build_call_graph            → Build call graph (if not cached)');
  lines.push('Step 2: preflight_query_call_graph            → direction="callers" or "callees"');
  lines.push('Step 3: preflight_extract_code (optional)     → Get function + all dependencies');
  lines.push('```');
  lines.push('');
  
  // Workflow 3: Search
  lines.push('### Workflow 3: Search for Code ("搜索", "find", "查找")');
  lines.push('```');
  lines.push('Step 1: preflight_list_bundles        → Find the bundleId');
  lines.push('Step 2: preflight_search_and_read     → Search and show results');
  lines.push('```');
  lines.push('');
  
  // Workflow 4: Document Parsing
  lines.push('### Workflow 4: Parse Document (PDF/Word/Excel)');
  lines.push('```');
  lines.push('Step 1: preflight_parse_document      → Extract content from file');
  lines.push('```');
  lines.push('');

  // Workflow 5: Web Documentation Crawling
  lines.push('### Workflow 5: Crawl Web Documentation ("爬取文档", "crawl docs", "index website")');
  lines.push('```');
  lines.push('Step 1: preflight_create_bundle       → kind="web", url="https://docs.example.com"');
  lines.push('        Optional: config.includePatterns=["/api/"] to filter URLs');
  lines.push('        Optional: config.maxPages=100 to limit crawl scope');
  lines.push('Step 2: preflight_get_overview        → Read crawled documentation');
  lines.push('Step 3: preflight_search_and_read     → Search within crawled docs');
  lines.push('```');
  lines.push('Note: Supports llms.txt standard for optimized crawling.');
  lines.push('');
  
  // Decision Tree
  lines.push('## 🧠 Quick Decision Tree');
  lines.push('');
  lines.push('**Q: Do you have a bundleId?**');
  lines.push('- NO → `preflight_list_bundles` or `preflight_create_bundle`');
  lines.push('- YES → Continue below');
  lines.push('');
  lines.push('**Q: What do you want to do?**');
  lines.push('- Understand project overview → `preflight_get_overview`');
  lines.push('- Analyze function calls → `preflight_build_call_graph` then `preflight_query_call_graph`');
  lines.push('- Search for code/text → `preflight_search_and_read`');
  lines.push('- See module dependencies → `preflight_dependency_graph`');
  lines.push('- Read specific file → `preflight_read_file`');
  lines.push('- Parse document file → `preflight_parse_document`');
  lines.push('- Crawl web documentation → `preflight_create_bundle` with kind="web"');
  lines.push('- Save/curate project knowledge → `preflight_generate_card`');
  lines.push('');
  
  // Tool Reference
  lines.push('## 🛠️ Tool Reference');
  lines.push('');
  
  const categoryLabels: Record<ToolCategory, string> = {
    bundle: '📦 Bundle Management (Start Here)',
    callgraph: '🔗 Call Graph Analysis (Deep Code Understanding)',
    analysis: '📊 Module Analysis',
    quality: '🔍 Code Quality Checks',
    search: '🔎 Search',
    navigation: '📂 Navigation',
    document: '📄 Document Processing',
    modal: '🖼️ Multimodal Content',
    trace: '🔗 Trace Links',
    distill: '💎 Knowledge Distillation',
  };
  
  const categoryOrder: ToolCategory[] = ['bundle', 'callgraph', 'analysis', 'quality', 'search', 'navigation', 'document', 'modal', 'trace', 'distill'];
  
  const filteredTools = categories
    ? TOOL_REGISTRY.filter(t => categories.includes(t.category))
    : TOOL_REGISTRY;

  const byCategory = new Map<ToolCategory, ToolInfo[]>();
  for (const tool of filteredTools) {
    const list = byCategory.get(tool.category) ?? [];
    list.push(tool);
    byCategory.set(tool.category, list);
  }

  for (const category of categoryOrder) {
    const tools = byCategory.get(category);
    if (!tools || tools.length === 0) continue;
    
    lines.push(`### ${categoryLabels[category]}`);
    lines.push('');
    for (const tool of tools) {
      const requires = tool.requires === 'bundleId' ? '[needs bundleId]' :
                       tool.requires === 'path' ? '[needs path]' : '';
      lines.push(`**${tool.name}** ${requires}`);
      lines.push(`- ${tool.description}`);
      lines.push(`- When: ${tool.whenToUse}`);
      if (tool.nextSteps && tool.nextSteps.length > 0) {
        lines.push(`- Next: ${tool.nextSteps[0]}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Get workflow suggestions based on a task description.
 * Returns a structured workflow that LLMs should follow.
 */
export function suggestWorkflow(task: string): string[] {
  const lower = task.toLowerCase();
  const steps: string[] = [];

  // === Priority 1: Project Analysis (most common use case) ===
  if (lower.includes('分析') || lower.includes('学习') || lower.includes('了解') || lower.includes('理解') ||
      lower.includes('analyze') || lower.includes('understand') || lower.includes('learn') ||
      lower.includes('create bundle') || lower.includes('创建')) {
    steps.push('1. `preflight_create_bundle` - Index the project (local path or GitHub)');
    steps.push('2. `preflight_get_overview` - Read project overview (OVERVIEW.md, START_HERE.md)');
    steps.push('3. `preflight_build_call_graph` - Build function-level call relationships');
    steps.push('4. `preflight_query_call_graph` - Query specific function relationships');
    steps.push('');
    steps.push('💡 This is the standard "deep analysis" workflow.');
    return steps;
  }

  // === Priority 2: Function/Call Analysis ===
  if (lower.includes('调用') || lower.includes('函数') || lower.includes('谁调用') || lower.includes('被调用') ||
      lower.includes('call') || lower.includes('function') || lower.includes('who calls') || lower.includes('what calls')) {
    steps.push('1. `preflight_build_call_graph` - Build call graph for the project');
    steps.push('2. `preflight_query_call_graph` - Query with symbol name');
    steps.push('   - direction="callers" to find who calls this function');
    steps.push('   - direction="callees" to find what this function calls');
    steps.push('3. `preflight_extract_code` - (Optional) Extract function with all dependencies');
    return steps;
  }

  // === Priority 3: Code Extraction ===
  if (lower.includes('提取') || lower.includes('extract') || lower.includes('依赖')) {
    steps.push('1. `preflight_build_call_graph` - Build call graph first');
    steps.push('2. `preflight_extract_code` - Extract function with dependencies');
    steps.push('   - format="markdown" for documented output');
    steps.push('   - format="full" for complete source code');
    return steps;
  }

  // === Priority 4: Web Documentation Crawling ===
  if (lower.includes('crawl') || lower.includes('爬取') || lower.includes('爬虫') || lower.includes('website') ||
      lower.includes('网站') || lower.includes('网页') || lower.includes('docs site') || lower.includes('documentation site')) {
    steps.push('1. `preflight_create_bundle` - Crawl the documentation site');
    steps.push('   - kind: "web"');
    steps.push('   - url: "https://docs.example.com"');
    steps.push('   - Optional config.includePatterns: ["/api/", "/guide/"]');
    steps.push('   - Optional config.maxPages: 100');
    steps.push('2. `preflight_get_overview` - Read crawled documentation');
    steps.push('3. `preflight_search_and_read` - Search within crawled docs');
    steps.push('');
    steps.push('💡 Supports llms.txt standard for faster crawling of compatible sites.');
    return steps;
  }

  // === Priority 5: Document Parsing ===
  if (lower.includes('pdf') || lower.includes('document') || lower.includes('word') || lower.includes('excel') ||
      lower.includes('文档') || lower.includes('解析')) {
    steps.push('1. `preflight_parse_document` - Parse the document file');
    steps.push('   - Supports: PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), HTML');
    steps.push('   - Extracts: text, images, tables, equations');
    return steps;
  }

  // === Priority 6: Search ===
  if (lower.includes('search') || lower.includes('find') || lower.includes('查找') || lower.includes('搜索') || lower.includes('找')) {
    steps.push('1. `preflight_list_bundles` - Find the bundleId');
    steps.push('2. `preflight_search_and_read` - Search and read matching content');
    return steps;
  }

  // === Priority 7: Architecture/Dependencies ===
  if (lower.includes('architecture') || lower.includes('架构') || lower.includes('dependency') || lower.includes('依赖图') ||
      lower.includes('import') || lower.includes('module')) {
    steps.push('1. `preflight_list_bundles` - Find the bundleId');
    steps.push('2. `preflight_dependency_graph` - Generate module dependency graph');
    steps.push('');
    steps.push('💡 For function-level analysis, use `preflight_build_call_graph` instead.');
    return steps;
  }

  // === Priority 8: Knowledge Distillation / Curation ===
  if (lower.includes('card') || lower.includes('卡片') || lower.includes('distill') || lower.includes('蒸馏') ||
      lower.includes('curate') || lower.includes('收藏') || lower.includes('save project') || lower.includes('保存项目') ||
      lower.includes('knowledge') || lower.includes('知识') || lower.includes('rag')) {
    steps.push('1. `preflight_list_bundles` - Find the bundleId');
    steps.push('2. `preflight_generate_card` - Generate knowledge card');
    steps.push('   - regenerate: true to force refresh');
    steps.push('   - format: "markdown" for human-readable output');
    steps.push('');
    steps.push('💡 Cards capture "what this project is" and "why it\'s valuable" for later retrieval.');
    return steps;
  }

  // === Default: Start from basics ===
  steps.push('1. `preflight_list_bundles` - Check existing bundles');
  steps.push('2. If project not indexed: `preflight_create_bundle`');
  steps.push('3. Then: `preflight_get_overview` to understand the project');
  steps.push('');
  steps.push('💡 Describe your task more specifically for better guidance.');
  
  return steps;
}
