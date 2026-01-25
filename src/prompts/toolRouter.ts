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
  | 'search'        // Search functionality
  | 'bundle'        // Bundle management
  | 'quality'       // Code quality checks (duplicates, deadcode, complexity, etc.)
  | 'navigation'    // Navigation and discovery
  | 'distill'       // Knowledge distillation (card generation)
  | 'rag';          // RAG (Retrieval Augmented Generation)

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
      'Then use preflight_search_and_read to find specific code',
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
      'To search for specific code: use preflight_search_and_read',
      'To check code quality: use preflight_check',
    ],
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

  // === LSP Tools ===
  {
    name: 'preflight_lsp',
    category: 'navigation',
    description: 'Language Server Protocol actions: go to definition, find references, hover info. Precise code navigation.',
    keywords: ['lsp', 'definition', 'references', 'hover', 'goto', 'navigate'],
    chineseKeywords: ['定义', '引用', '跳转', '导航', 'LSP'],
    requires: 'bundleId',
    mutating: false,
    whenToUse: 'Use for precise code navigation: find where a symbol is defined, find all references to a symbol.',
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

  // === RAG Tools ===
  {
    name: 'preflight_rag',
    category: 'rag',
    description: 'RAG operations: index bundle for semantic search, query indexed content.',
    keywords: ['rag', 'semantic', 'vector', 'embedding', 'index', 'query'],
    chineseKeywords: ['RAG', '语义搜索', '向量', '索引', '查询'],
    requires: 'bundleId',
    mutating: false,
    whenToUse: 'Use for semantic search over bundle content. Requires embedding configuration.',
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
  lines.push('Step 3: preflight_search_and_read   → Search for specific code');
  lines.push('Step 4: preflight_check             → Check code quality');
  lines.push('```');
  lines.push('');
  
  // Workflow 2: Search
  lines.push('### Workflow 2: Search for Code ("搜索", "find", "查找")');
  lines.push('```');
  lines.push('Step 1: preflight_list_bundles        → Find the bundleId');
  lines.push('Step 2: preflight_search_and_read     → Search and show results');
  lines.push('```');
  lines.push('');

  // Workflow 3: Web Documentation Crawling
  lines.push('### Workflow 3: Crawl Web Documentation ("爬取文档", "crawl docs", "index website")');
  lines.push('```');
  lines.push('Step 1: preflight_create_bundle       → kind="web", url="https://docs.example.com"');
  lines.push('        Optional: config.includePatterns=["/api/"] to filter URLs');
  lines.push('        Optional: config.maxPages=100 to limit crawl scope');
  lines.push('Step 2: preflight_get_overview        → Read crawled documentation');
  lines.push('Step 3: preflight_search_and_read     → Search within crawled docs');
  lines.push('```');
  lines.push('Note: Supports llms.txt standard for optimized crawling.');
  lines.push('');

  // Workflow 4: Code Navigation with LSP
  lines.push('### Workflow 4: Precise Code Navigation ("定义", "引用", "definition", "references")');
  lines.push('```');
  lines.push('Step 1: preflight_list_bundles        → Find the bundleId');
  lines.push('Step 2: preflight_lsp                 → action="definition" or "references"');
  lines.push('```');
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
  lines.push('- Search for code/text → `preflight_search_and_read`');
  lines.push('- Read specific file → `preflight_read_file`');
  lines.push('- Find definition/references → `preflight_lsp`');
  lines.push('- Check code quality → `preflight_check`');
  lines.push('- Crawl web documentation → `preflight_create_bundle` with kind="web"');
  lines.push('- Save/curate project knowledge → `preflight_generate_card`');
  lines.push('- Semantic search (RAG) → `preflight_rag`');
  lines.push('');
  
  // Tool Reference
  lines.push('## 🛠️ Tool Reference');
  lines.push('');
  
  const categoryLabels: Record<ToolCategory, string> = {
    bundle: '📦 Bundle Management (Start Here)',
    quality: '🔍 Code Quality Checks',
    search: '🔎 Search',
    navigation: '📂 Navigation',
    distill: '💎 Knowledge Distillation',
    rag: '🔮 RAG (Semantic Search)',
  };
  
  const categoryOrder: ToolCategory[] = ['bundle', 'search', 'navigation', 'quality', 'distill', 'rag'];
  
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
    steps.push('3. `preflight_search_and_read` - Search for specific code');
    steps.push('4. `preflight_check` - Check code quality');
    steps.push('');
    steps.push('💡 This is the standard "deep analysis" workflow.');
    return steps;
  }

  // === Priority 2: Code Navigation (definition/references) ===
  if (lower.includes('调用') || lower.includes('函数') || lower.includes('谁调用') || lower.includes('被调用') ||
      lower.includes('call') || lower.includes('function') || lower.includes('who calls') || lower.includes('what calls') ||
      lower.includes('定义') || lower.includes('引用') || lower.includes('definition') || lower.includes('references')) {
    steps.push('1. `preflight_list_bundles` - Find the bundleId');
    steps.push('2. `preflight_lsp` - Use LSP for precise navigation');
    steps.push('   - action="definition" to find where a symbol is defined');
    steps.push('   - action="references" to find all usages');
    return steps;
  }

  // === Priority 3: Web Documentation Crawling ===
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

  // === Priority 4: Search ===
  if (lower.includes('search') || lower.includes('find') || lower.includes('查找') || lower.includes('搜索') || lower.includes('找')) {
    steps.push('1. `preflight_list_bundles` - Find the bundleId');
    steps.push('2. `preflight_search_and_read` - Search and read matching content');
    return steps;
  }

  // === Priority 5: Code Quality ===
  if (lower.includes('quality') || lower.includes('质量') || lower.includes('check') || lower.includes('检查') ||
      lower.includes('duplicate') || lower.includes('重复') || lower.includes('deadcode') || lower.includes('死代码')) {
    steps.push('1. `preflight_list_bundles` - Find the bundleId');
    steps.push('2. `preflight_check` - Run code quality checks');
    steps.push('   - Detects: duplicates, deadcode, circular dependencies, complexity');
    return steps;
  }

  // === Priority 6: Knowledge Distillation / Curation ===
  if (lower.includes('card') || lower.includes('卡片') || lower.includes('distill') || lower.includes('蒸馏') ||
      lower.includes('curate') || lower.includes('收藏') || lower.includes('save project') || lower.includes('保存项目') ||
      lower.includes('knowledge') || lower.includes('知识')) {
    steps.push('1. `preflight_list_bundles` - Find the bundleId');
    steps.push('2. `preflight_generate_card` - Generate knowledge card');
    steps.push('   - regenerate: true to force refresh');
    steps.push('   - format: "markdown" for human-readable output');
    steps.push('');
    steps.push('💡 Cards capture "what this project is" and "why it\'s valuable" for later retrieval.');
    return steps;
  }

  // === Priority 7: RAG / Semantic Search ===
  if (lower.includes('rag') || lower.includes('semantic') || lower.includes('语义') || lower.includes('vector') || lower.includes('向量')) {
    steps.push('1. `preflight_list_bundles` - Find the bundleId');
    steps.push('2. `preflight_rag` - Run semantic search');
    steps.push('   - action="index" to build semantic index');
    steps.push('   - action="query" to search semantically');
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
