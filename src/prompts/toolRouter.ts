/**
 * Prompt helpers for MCP clients that still rely on prompts/* endpoints.
 *
 * The same guidance is also exposed through MCP `instructions`, but these
 * helpers preserve backwards-compatible prompt discovery for older clients.
 */

export interface ToolInfo {
  name: string;
  category: ToolCategory;
  description: string;
  keywords: string[];
  chineseKeywords: string[];
  requires: 'bundleId' | 'path' | 'none';
  mutating: boolean;
  whenToUse: string;
  nextSteps?: string[];
}

export type ToolCategory =
  | 'search'
  | 'bundle'
  | 'quality'
  | 'navigation'
  | 'distill'
  | 'rag'
  | 'memory';

export const TOOL_REGISTRY: ToolInfo[] = [
  {
    name: 'preflight_list_bundles',
    category: 'bundle',
    description: 'List available bundles and find a bundleId.',
    keywords: ['list', 'bundles', 'available', 'repos', 'show'],
    chineseKeywords: ['列出', '查看', '仓库', '项目', 'bundle', '有哪些'],
    requires: 'none',
    mutating: false,
    whenToUse: 'Use first when you need to discover an existing bundle.',
    nextSteps: ['If found, call preflight_get_overview or preflight_search_and_read.'],
  },
  {
    name: 'preflight_create_bundle',
    category: 'bundle',
    description: 'Create a bundle from GitHub, local paths, PDFs, markdown, or web docs.',
    keywords: ['create', 'bundle', 'index', 'ingest', 'analyze', 'crawl', 'docs', 'web'],
    chineseKeywords: ['创建', '新建', '索引', '导入', '分析', '爬取', '文档', '网站'],
    requires: 'none',
    mutating: true,
    whenToUse: 'Use when the project or documentation is not indexed yet.',
    nextSteps: ['Always call preflight_get_overview after creating a bundle.'],
  },
  {
    name: 'preflight_get_overview',
    category: 'navigation',
    description: 'Read OVERVIEW.md, START_HERE.md, and AGENTS.md for a bundle.',
    keywords: ['overview', 'summary', 'understand', 'start', 'intro'],
    chineseKeywords: ['概览', '总结', '理解', '开始', '入门'],
    requires: 'bundleId',
    mutating: false,
    whenToUse: 'Use immediately after preflight_create_bundle.',
    nextSteps: ['Then use search, tree, lsp, or check depending on the task.'],
  },
  {
    name: 'preflight_delete_bundle',
    category: 'bundle',
    description: 'Delete a bundle.',
    keywords: ['delete', 'remove', 'destroy'],
    chineseKeywords: ['删除', '移除'],
    requires: 'bundleId',
    mutating: true,
    whenToUse: 'Use only when the user explicitly wants a bundle removed.',
  },
  {
    name: 'preflight_search_and_read',
    category: 'search',
    description: 'Primary full-text search tool for code and docs.',
    keywords: ['search', 'find', 'read', 'grep', 'lookup'],
    chineseKeywords: ['搜索', '查找', '找', '读取'],
    requires: 'bundleId',
    mutating: false,
    whenToUse: 'Use for keyword search inside a bundle.',
  },
  {
    name: 'preflight_read_file',
    category: 'navigation',
    description: 'Read specific file content from a bundle.',
    keywords: ['read', 'file', 'open', 'view'],
    chineseKeywords: ['读取', '文件', '打开', '查看'],
    requires: 'bundleId',
    mutating: false,
    whenToUse: 'Use when you already know which file you want.',
  },
  {
    name: 'preflight_repo_tree',
    category: 'navigation',
    description: 'Inspect bundle directory structure.',
    keywords: ['tree', 'structure', 'folders', 'files'],
    chineseKeywords: ['目录', '结构', '树', '文件夹'],
    requires: 'bundleId',
    mutating: false,
    whenToUse: 'Use before deep file reads when you need structure.',
  },
  {
    name: 'preflight_check',
    category: 'quality',
    description: 'Run duplicates, deadcode, circular dependency, and complexity checks.',
    keywords: ['check', 'quality', 'duplicates', 'deadcode', 'circular', 'complexity'],
    chineseKeywords: ['检查', '质量', '重复', '死代码', '循环依赖', '复杂度'],
    requires: 'path',
    mutating: false,
    whenToUse: 'Use for code quality review on a local path.',
  },
  {
    name: 'preflight_lsp',
    category: 'navigation',
    description: 'Find definition, references, symbols, and diagnostics.',
    keywords: ['lsp', 'definition', 'references', 'symbols', 'diagnostics', 'hover'],
    chineseKeywords: ['定义', '引用', '符号', '诊断', '跳转'],
    requires: 'bundleId',
    mutating: false,
    whenToUse: 'Use for precise code navigation after overview/search.',
  },
  {
    name: 'preflight_generate_card',
    category: 'distill',
    description: 'Generate a CARD summary for later retrieval.',
    keywords: ['card', 'distill', 'summary', 'curate', 'knowledge'],
    chineseKeywords: ['卡片', '蒸馏', '摘要', '知识'],
    requires: 'bundleId',
    mutating: true,
    whenToUse: 'Use to preserve a concise summary of a bundle.',
  },
  {
    name: 'preflight_rag',
    category: 'rag',
    description: 'Index/query semantic search content.',
    keywords: ['rag', 'semantic', 'vector', 'embedding', 'query'],
    chineseKeywords: ['RAG', '语义搜索', '向量', '检索'],
    requires: 'none',
    mutating: false,
    whenToUse: 'Use for semantic retrieval rather than exact keyword search.',
  },
  {
    name: 'preflight_memory',
    category: 'memory',
    description: 'Persist and recall long-term memory items.',
    keywords: ['memory', 'remember', 'recall', 'preferences', 'facts'],
    chineseKeywords: ['记忆', '记住', '回忆', '偏好', '事实'],
    requires: 'none',
    mutating: true,
    whenToUse: 'Use when you need persistent user or project context.',
  },
];

export function routeQuery(query: string, maxResults = 3): ToolInfo[] {
  const lowerQuery = query.toLowerCase();
  const scores: Array<{ tool: ToolInfo; score: number }> = [];

  for (const tool of TOOL_REGISTRY) {
    let score = 0;

    for (const keyword of tool.keywords) {
      if (lowerQuery.includes(keyword)) score += 10;
    }
    for (const keyword of tool.chineseKeywords) {
      if (query.includes(keyword)) score += 10;
    }
    if (lowerQuery.includes(tool.name.replace('preflight_', ''))) {
      score += 20;
    }
    for (const word of tool.description.toLowerCase().split(/\s+/)) {
      if (word.length > 3 && lowerQuery.includes(word)) score += 2;
    }
    for (const word of tool.whenToUse.toLowerCase().split(/\s+/)) {
      if (word.length > 3 && lowerQuery.includes(word)) score += 5;
    }

    if (score > 0) {
      scores.push({ tool, score });
    }
  }

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, maxResults).map((entry) => entry.tool);
}

export function generateRoutingPrompt(categories?: ToolCategory[]): string {
  const tools = categories
    ? TOOL_REGISTRY.filter((tool) => categories.includes(tool.category))
    : TOOL_REGISTRY;

  const lines: string[] = [
    '# Preflight Tool Router',
    '',
    'Standard workflow for a new project:',
    '1. preflight_create_bundle',
    '2. preflight_get_overview',
    '3. preflight_search_and_read',
    '4. preflight_check',
    '5. preflight_lsp',
    '',
    'Quick decisions:',
    '- Need bundleId: preflight_list_bundles',
    '- New repo/docs site: preflight_create_bundle',
    '- Search code/docs: preflight_search_and_read',
    '- Read known file: preflight_read_file',
    '- Structure: preflight_repo_tree',
    '- Definitions/references: preflight_lsp',
    '- Quality checks: preflight_check',
    '- Semantic retrieval: preflight_rag',
    '',
    'Tool reference:',
  ];

  for (const tool of tools) {
    const requires =
      tool.requires === 'bundleId' ? ' [needs bundleId]' :
      tool.requires === 'path' ? ' [needs path]' :
      '';
    lines.push(`- ${tool.name}${requires}: ${tool.description}`);
    lines.push(`  When: ${tool.whenToUse}`);
    if (tool.nextSteps?.length) {
      lines.push(`  Next: ${tool.nextSteps[0]}`);
    }
  }

  return lines.join('\n');
}

export function suggestWorkflow(task: string): string[] {
  const lower = task.toLowerCase();

  if (
    lower.includes('分析') ||
    lower.includes('学习') ||
    lower.includes('了解') ||
    lower.includes('理解') ||
    lower.includes('analyze') ||
    lower.includes('understand') ||
    lower.includes('learn') ||
    lower.includes('创建')
  ) {
    return [
      '1. `preflight_create_bundle` - index the project',
      '2. `preflight_get_overview` - read overview files',
      '3. `preflight_search_and_read` - find relevant code',
      '4. `preflight_check` - run code quality checks',
      '5. `preflight_lsp` - navigate definitions and references',
    ];
  }

  if (
    lower.includes('定义') ||
    lower.includes('引用') ||
    lower.includes('谁调用') ||
    lower.includes('definition') ||
    lower.includes('references') ||
    lower.includes('who calls')
  ) {
    return [
      '1. `preflight_list_bundles` - find the bundleId',
      '2. `preflight_lsp` - use definition/references actions',
    ];
  }

  if (
    lower.includes('crawl') ||
    lower.includes('爬取') ||
    lower.includes('网站') ||
    lower.includes('网页') ||
    lower.includes('docs site')
  ) {
    return [
      '1. `preflight_create_bundle` - create a web bundle with kind="web"',
      '2. `preflight_get_overview` - read the crawled overview',
      '3. `preflight_search_and_read` - search within the docs',
    ];
  }

  if (
    lower.includes('search') ||
    lower.includes('find') ||
    lower.includes('搜索') ||
    lower.includes('查找')
  ) {
    return [
      '1. `preflight_list_bundles` - find the bundleId',
      '2. `preflight_search_and_read` - search and inspect matches',
    ];
  }

  if (
    lower.includes('quality') ||
    lower.includes('check') ||
    lower.includes('检查') ||
    lower.includes('重复') ||
    lower.includes('deadcode')
  ) {
    return [
      '1. `preflight_list_bundles` - find the bundleId if needed',
      '2. `preflight_check` - run quality checks on the local path',
    ];
  }

  return [
    '1. `preflight_list_bundles` - inspect existing bundles',
    '2. `preflight_create_bundle` - create one if needed',
    '3. `preflight_get_overview` - start from the overview',
  ];
}
