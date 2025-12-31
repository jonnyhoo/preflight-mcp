/**
 * Intelligent Tool Router for Preflight MCP.
 *
 * Provides LLM-friendly tool selection guidance based on user intent.
 * This module helps LLMs choose the most appropriate tool for any task.
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
}

export type ToolCategory =
  | 'document'      // Document parsing and analysis
  | 'search'        // Search functionality
  | 'bundle'        // Bundle management
  | 'analysis'      // Code analysis and dependency graphs
  | 'trace'         // Trace links
  | 'modal'         // Multimodal content
  | 'navigation';   // Navigation and discovery

// ============================================================================
// Tool Registry
// ============================================================================

export const TOOL_REGISTRY: ToolInfo[] = [
  // === Document Tools ===
  {
    name: 'preflight_parse_document',
    category: 'document',
    description: 'Parse a single document (PDF, Word, Excel, PowerPoint, HTML) and extract text + multimodal content.',
    keywords: ['parse', 'document', 'pdf', 'word', 'excel', 'extract', 'read'],
    chineseKeywords: ['解析', '文档', '读取', '提取', 'PDF', 'Word', 'Excel'],
    requires: 'path',
    mutating: false,
  },

  // === Search Tools ===
  {
    name: 'preflight_search_bundle',
    category: 'search',
    description: 'Full-text search for code and documentation within a single bundle.',
    keywords: ['search', 'find', 'query', 'code', 'docs', 'text'],
    chineseKeywords: ['搜索', '查找', '查询', '代码', '文档', '全文'],
    requires: 'bundleId',
    mutating: false,
  },
  {
    name: 'preflight_search_by_tags',
    category: 'search',
    description: 'Search across multiple bundles filtered by tags.',
    keywords: ['search', 'tags', 'cross-bundle', 'multi', 'filter'],
    chineseKeywords: ['跨bundle搜索', '标签', '多仓库', '过滤'],
    requires: 'none',
    mutating: false,
  },
  {
    name: 'preflight_search_modal',
    category: 'modal',
    description: 'Search for images, tables, equations, and diagrams in bundle.',
    keywords: ['search', 'image', 'table', 'equation', 'diagram', 'modal', 'visual'],
    chineseKeywords: ['搜索图片', '搜索表格', '搜索公式', '图表', '多模态'],
    requires: 'bundleId',
    mutating: false,
  },
  {
    name: 'preflight_search_and_read',
    category: 'search',
    description: 'Search and automatically read matching files (aggregated results).',
    keywords: ['search', 'read', 'aggregate', 'content', 'combined'],
    chineseKeywords: ['搜索并读取', '聚合', '内容'],
    requires: 'bundleId',
    mutating: false,
  },

  // === Bundle Management ===
  {
    name: 'preflight_list_bundles',
    category: 'bundle',
    description: 'List all available bundles with their metadata.',
    keywords: ['list', 'bundles', 'show', 'available', 'repos'],
    chineseKeywords: ['列出', '查看', 'bundle', '仓库', '项目'],
    requires: 'none',
    mutating: false,
  },
  {
    name: 'preflight_create_bundle',
    category: 'bundle',
    description: 'Create a new bundle from GitHub repos or local directories.',
    keywords: ['create', 'bundle', 'index', 'ingest', 'new', 'add'],
    chineseKeywords: ['创建', '新建', '索引', '添加', '导入'],
    requires: 'none',
    mutating: true,
  },
  {
    name: 'preflight_update_bundle',
    category: 'bundle',
    description: 'Update an existing bundle with latest changes.',
    keywords: ['update', 'refresh', 'sync', 'latest'],
    chineseKeywords: ['更新', '刷新', '同步', '最新'],
    requires: 'bundleId',
    mutating: true,
  },
  {
    name: 'preflight_repair_bundle',
    category: 'bundle',
    description: 'Repair a corrupted or incomplete bundle.',
    keywords: ['repair', 'fix', 'rebuild', 'restore'],
    chineseKeywords: ['修复', '重建', '恢复'],
    requires: 'bundleId',
    mutating: true,
  },
  {
    name: 'preflight_delete_bundle',
    category: 'bundle',
    description: 'Delete a bundle (requires confirmation).',
    keywords: ['delete', 'remove', 'destroy'],
    chineseKeywords: ['删除', '移除'],
    requires: 'bundleId',
    mutating: true,
  },

  // === Analysis Tools ===
  {
    name: 'preflight_evidence_dependency_graph',
    category: 'analysis',
    description: 'Generate dependency graph showing module relationships.',
    keywords: ['dependency', 'graph', 'import', 'module', 'architecture'],
    chineseKeywords: ['依赖', '图', '架构', '模块', '关系'],
    requires: 'bundleId',
    mutating: true,
  },
  {
    name: 'preflight_deep_analysis',
    category: 'analysis',
    description: 'Comprehensive project analysis (structure, tests, deps).',
    keywords: ['analyze', 'deep', 'comprehensive', 'structure', 'overview'],
    chineseKeywords: ['深度分析', '全面', '结构', '概览'],
    requires: 'bundleId',
    mutating: false,
  },
  {
    name: 'preflight_extract_outline',
    category: 'analysis',
    description: 'Extract code outline (functions, classes, symbols) from file.',
    keywords: ['outline', 'symbols', 'functions', 'classes', 'structure'],
    chineseKeywords: ['大纲', '符号', '函数', '类', '结构'],
    requires: 'bundleId',
    mutating: false,
  },

  // === Multimodal Tools ===
  {
    name: 'preflight_analyze_modal',
    category: 'modal',
    description: 'Analyze images, tables, and equations with AI-powered descriptions.',
    keywords: ['analyze', 'image', 'table', 'equation', 'modal', 'ocr', 'visual'],
    chineseKeywords: ['分析图片', '分析表格', '分析公式', 'OCR', '视觉'],
    requires: 'bundleId',
    mutating: false,
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
  },
  {
    name: 'preflight_trace_upsert',
    category: 'trace',
    description: 'Create or update trace links.',
    keywords: ['trace', 'create', 'link', 'connect'],
    chineseKeywords: ['创建追溯', '链接', '关联'],
    requires: 'bundleId',
    mutating: true,
  },

  // === Navigation Tools ===
  {
    name: 'preflight_read_files',
    category: 'navigation',
    description: 'Read one or more files from a bundle.',
    keywords: ['read', 'file', 'content', 'view', 'open'],
    chineseKeywords: ['读取', '文件', '查看', '打开', '内容'],
    requires: 'bundleId',
    mutating: false,
  },
  {
    name: 'preflight_repo_tree',
    category: 'navigation',
    description: 'Get directory tree structure of a repository.',
    keywords: ['tree', 'directory', 'structure', 'files', 'folders'],
    chineseKeywords: ['目录', '树', '结构', '文件夹'],
    requires: 'bundleId',
    mutating: false,
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
 */
export function generateRoutingPrompt(categories?: ToolCategory[]): string {
  const filteredTools = categories
    ? TOOL_REGISTRY.filter(t => categories.includes(t.category))
    : TOOL_REGISTRY;

  const byCategory = new Map<ToolCategory, ToolInfo[]>();
  for (const tool of filteredTools) {
    const list = byCategory.get(tool.category) ?? [];
    list.push(tool);
    byCategory.set(tool.category, list);
  }

  const lines: string[] = [];
  lines.push('# Preflight Tool Router');
  lines.push('');
  lines.push('Select the appropriate tool based on your task:');
  lines.push('');

  const categoryLabels: Record<ToolCategory, string> = {
    document: '📄 Document Processing',
    search: '🔍 Search',
    bundle: '📦 Bundle Management',
    analysis: '📊 Code Analysis',
    trace: '🔗 Trace Links',
    modal: '🖼️ Multimodal Content',
    navigation: '📂 File Navigation',
  };

  for (const [category, tools] of byCategory) {
    lines.push(`## ${categoryLabels[category]}`);
    lines.push('');
    for (const tool of tools) {
      const requires = tool.requires === 'bundleId' ? '(needs bundleId)' :
                       tool.requires === 'path' ? '(needs file path)' : '';
      const mutating = tool.mutating ? '[WRITES]' : '[READ-ONLY]';
      lines.push(`- **${tool.name}** ${mutating} ${requires}`);
      lines.push(`  ${tool.description}`);
      lines.push(`  Keywords: ${tool.keywords.slice(0, 5).join(', ')}`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('**Quick Decision Tree:**');
  lines.push('1. Need to parse a document file? → `preflight_parse_document`');
  lines.push('2. Need to search code/docs? → `preflight_search_bundle` or `preflight_search_and_read`');
  lines.push('3. Need to find images/tables/equations? → `preflight_search_modal`');
  lines.push('4. Need project architecture? → `preflight_evidence_dependency_graph`');
  lines.push('5. Need to create/manage bundle? → `preflight_create_bundle`, `preflight_list_bundles`');
  lines.push('6. Don\'t have a bundleId yet? → Run `preflight_list_bundles` first');

  return lines.join('\n');
}

/**
 * Get workflow suggestions based on a task description.
 */
export function suggestWorkflow(task: string): string[] {
  const lower = task.toLowerCase();
  const steps: string[] = [];

  // Document analysis workflow
  if (lower.includes('pdf') || lower.includes('document') || lower.includes('word') || lower.includes('excel')) {
    steps.push('1. Use `preflight_parse_document` to extract content from the document');
    steps.push('2. Review extracted text and multimodal content (images, tables)');
    steps.push('3. If you want to index it for search, use `preflight_create_bundle`');
  }
  // Project analysis workflow
  else if (lower.includes('analyze') || lower.includes('understand') || lower.includes('architecture')) {
    steps.push('1. Check if bundle exists: `preflight_list_bundles`');
    steps.push('2. If not, create one: `preflight_create_bundle`');
    steps.push('3. Generate dependency graph: `preflight_evidence_dependency_graph`');
    steps.push('4. Read overview: `preflight_read_files` with path="OVERVIEW.md"');
  }
  // Search workflow
  else if (lower.includes('search') || lower.includes('find') || lower.includes('查找') || lower.includes('搜索')) {
    steps.push('1. Ensure bundle exists: `preflight_list_bundles`');
    steps.push('2. Search: `preflight_search_bundle` or `preflight_search_and_read`');
    steps.push('3. For visual content: `preflight_search_modal`');
  }
  // Default workflow
  else {
    steps.push('1. List available bundles: `preflight_list_bundles`');
    steps.push('2. Choose appropriate tool based on task');
  }

  return steps;
}
