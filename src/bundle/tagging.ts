import { type IngestedFile } from './ingest.js';
import { type BundleFacts } from './facts.js';

/**
 * Auto-detect tags for a bundle based on its content
 */
export function autoDetectTags(params: {
  repoIds: string[];
  facts?: BundleFacts;
  files: IngestedFile[];
}): string[] {
  const tags = new Set<string>();

  // 1. Detect by repo name patterns
  for (const repoId of params.repoIds) {
    const lowerRepo = repoId.toLowerCase();

    // Web source detection
    if (lowerRepo.startsWith('web/') || lowerRepo.startsWith('web:')) {
      tags.add('documentation');
      tags.add('web-source');
    }

    // MCP related
    if (lowerRepo.includes('mcp') || lowerRepo.includes('model-context-protocol')) {
      tags.add('mcp');
      tags.add('ai-tools');
    }

    // Agent frameworks
    if (lowerRepo.includes('agent') || lowerRepo.includes('langchain') || lowerRepo.includes('autogen')) {
      tags.add('agents');
      tags.add('ai');
    }

    // Development tools
    if (lowerRepo.includes('tool') || lowerRepo.includes('cli') || lowerRepo.includes('util')) {
      tags.add('dev-tools');
    }

    // Testing/debugging
    if (lowerRepo.includes('test') || lowerRepo.includes('debug') || lowerRepo.includes('mock')) {
      tags.add('testing');
      tags.add('debugging');
    }

    // Web scraping / crawling
    if (lowerRepo.includes('scraper') || lowerRepo.includes('crawler') || lowerRepo.includes('spider')) {
      tags.add('web-scraping');
    }

    // Anti-detection / bypassing
    if (lowerRepo.includes('bypass') || lowerRepo.includes('anti') || lowerRepo.includes('stealth')) {
      tags.add('anti-detection');
      tags.add('web-scraping');
    }

    // Code analysis
    if (lowerRepo.includes('lint') || lowerRepo.includes('analyzer') || lowerRepo.includes('ast')) {
      tags.add('code-analysis');
      tags.add('dev-tools');
    }

    // Claude Code plugin detection (by repo name)
    if (lowerRepo.includes('claude') && lowerRepo.includes('plugin')) {
      tags.add('claude-code');
      tags.add('plugins');
    }
  }

  // 2. Detect by frameworks (if facts available)
  if (params.facts) {
    for (const framework of params.facts.frameworks) {
      const lowerFw = framework.toLowerCase();

      if (lowerFw.includes('react') || lowerFw.includes('vue') || lowerFw.includes('angular')) {
        tags.add('frontend');
        tags.add('web-framework');
      }

      if (lowerFw.includes('express') || lowerFw.includes('fastify') || lowerFw.includes('nestjs')) {
        tags.add('backend');
        tags.add('web-framework');
      }

      if (lowerFw.includes('next') || lowerFw.includes('nuxt')) {
        tags.add('full-stack');
        tags.add('web-framework');
      }

      if (lowerFw.includes('django') || lowerFw.includes('flask') || lowerFw.includes('fastapi')) {
        tags.add('backend');
        tags.add('python');
      }

      if (lowerFw.includes('starlette') || lowerFw.includes('uvicorn')) {
        tags.add('backend');
        tags.add('python');
      }

      if (lowerFw.includes('jest') || lowerFw.includes('vitest') || lowerFw.includes('pytest')) {
        tags.add('testing');
      }

      // AI/LLM frameworks
      if (lowerFw.includes('anthropic') || lowerFw.includes('openai') || lowerFw.includes('langchain')) {
        tags.add('ai');
        tags.add('llm');
      }

      // MCP framework detection
      if (lowerFw === 'mcp') {
        tags.add('mcp');
        tags.add('ai-tools');
      }

      // Deep Learning frameworks
      if (lowerFw.includes('pytorch') || lowerFw.includes('tensorflow') || lowerFw.includes('jax') || lowerFw.includes('keras')) {
        tags.add('ai');
        tags.add('deep-learning');
      }

      // ML/NLP frameworks (these indicate AI/ML projects)
      if (lowerFw.includes('transformers') || lowerFw.includes('sentence-transformers') || 
          lowerFw.includes('spacy') || lowerFw.includes('nltk') || lowerFw.includes('huggingface')) {
        tags.add('ai');
        tags.add('nlp');
      }

      // Topic modeling / embeddings (indicates ML/NLP)
      if (lowerFw.includes('bertopic') || lowerFw.includes('gensim')) {
        tags.add('ai');
        tags.add('nlp');
        tags.add('embeddings');
      }

      // Vector databases / RAG infrastructure
      if (lowerFw.includes('faiss') || lowerFw.includes('chromadb') || lowerFw.includes('pinecone') ||
          lowerFw.includes('weaviate') || lowerFw.includes('qdrant') || lowerFw.includes('milvus')) {
        tags.add('ai');
        tags.add('vector-search');
        tags.add('embeddings');
      }

      // ML frameworks
      if (lowerFw.includes('scikit-learn') || lowerFw.includes('sklearn') || 
          lowerFw.includes('xgboost') || lowerFw.includes('lightgbm')) {
        tags.add('ai');
        tags.add('machine-learning');
      }

      // Document processing (often part of RAG/AI pipelines)
      if (lowerFw.includes('docling') || lowerFw.includes('unstructured')) {
        tags.add('document-processing');
      }

      // RAG frameworks
      if (lowerFw.includes('llamaindex') || lowerFw.includes('haystack')) {
        tags.add('ai');
        tags.add('rag');
      }

      // CLI frameworks (Python)
      if (lowerFw.includes('click') || lowerFw.includes('typer')) {
        tags.add('cli');
      }

      // CLI frameworks (JS/TS)
      if (lowerFw.includes('commander') || lowerFw.includes('yargs') || lowerFw.includes('inquirer')) {
        tags.add('cli');
      }

      // Terminal UI frameworks
      if (lowerFw === 'ink') {
        tags.add('cli');
        tags.add('terminal-ui');
      }

      // Schema validation
      if (lowerFw === 'zod' || lowerFw === 'pydantic') {
        tags.add('validation');
      }

      // Web scraping frameworks
      if (lowerFw.includes('beautifulsoup') || lowerFw.includes('scrapy')) {
        tags.add('web-scraping');
      }
    }

    // Language tags
    for (const lang of params.facts.languages) {
      const lowerLang = lang.language.toLowerCase();
      if (lowerLang === 'typescript' || lowerLang === 'javascript') {
        tags.add('javascript');
      } else if (lowerLang === 'python') {
        tags.add('python');
      } else if (lowerLang === 'go') {
        tags.add('golang');
      } else if (lowerLang === 'rust') {
        tags.add('rust');
      }
    }

    // Dependency-based detection
    const allDeps = [
      ...params.facts.dependencies.runtime.map((d) => d.name.toLowerCase()),
      ...params.facts.dependencies.dev.map((d) => d.name.toLowerCase()),
    ];

    if (allDeps.some((d) => d.includes('puppeteer') || d.includes('playwright') || d.includes('selenium'))) {
      tags.add('browser-automation');
      tags.add('web-scraping');
    }

    // NOTE: Removed http-client tag - having an HTTP library is too common to be meaningful
    // Previously: if (allDeps.some((d) => d.includes('axios') || d.includes('fetch') || d.includes('request')))

    if (allDeps.some((d) => d.includes('cheerio') || d.includes('beautifulsoup') || d.includes('jsdom'))) {
      tags.add('html-parsing');
      tags.add('web-scraping');
    }
  }

  // 3. Detect by file patterns
  const fileNames = params.files.map((f) => f.repoRelativePath.toLowerCase());

  // Claude Code plugin detection (by file structure)
  // Detects: .claude-plugin/ directory, plugin.json, commands/, agents/, skills/ directories
  const hasClaudePluginDir = fileNames.some((f) => f.includes('.claude-plugin/'));
  const hasPluginJson = fileNames.some((f) => f.endsWith('.claude-plugin/plugin.json'));
  const hasPluginStructure = fileNames.some((f) =>
    f.includes('/commands/') ||
    f.includes('/agents/') ||
    f.includes('/skills/') ||
    f.includes('/hooks/')
  );
  
  if (hasClaudePluginDir || hasPluginJson) {
    tags.add('claude-code');
    tags.add('plugins');
    // If it has multiple plugin directories, it's likely a plugin marketplace/directory
    const pluginDirCount = fileNames.filter((f) => f.endsWith('.claude-plugin/plugin.json')).length;
    if (pluginDirCount > 3) {
      tags.add('marketplace');
    }
  } else if (hasPluginStructure) {
    // Has plugin-like structure but no .claude-plugin/ - might be plugin-related
    tags.add('extensible');
  }

  if (fileNames.some((f) => f.includes('dockerfile') || f.includes('docker-compose'))) {
    tags.add('docker');
    tags.add('devops');
  }

  if (fileNames.some((f) => f.includes('kubernetes') || f.includes('k8s'))) {
    tags.add('kubernetes');
    tags.add('devops');
  }

  // NOTE: CI/CD detection removed from auto-tags
  // Reason: Almost every project has CI/CD, making it noise rather than signal
  // CI/CD is better detected at the project infrastructure level, not as a semantic tag
  // Previously detected: github/workflows, .travis, .gitlab-ci, jenkinsfile, .circleci

  // Web source documentation detection from file paths
  if (fileNames.some((f) => f.startsWith('repos/web/'))) {
    tags.add('documentation');
    tags.add('web-source');
  }

  if (fileNames.some((f) => f.includes('readme') || f.includes('docs/'))) {
    tags.add('documented');
  }

  // MCP detection by file structure (mcp/ directory or server.py/server.ts pattern)
  if (fileNames.some((f) => 
    f.includes('/mcp/') || 
    f.includes('mcp_server') || 
    f.includes('mcp-server') ||
    (f.includes('/mcp') && (f.endsWith('server.py') || f.endsWith('server.ts')))
  )) {
    tags.add('mcp');
    tags.add('ai-tools');
  }

  // CLI detection - only if it's the PRIMARY interface, not just an entry point
  // Having cli.py/cli.ts alone doesn't mean it's a CLI tool - most projects have CLI entry points
  // Only detect CLI if there's a dedicated /cli/ directory structure
  if (fileNames.some((f) => f.includes('/cli/') && !f.endsWith('/cli/'))) {
    tags.add('cli');
  }

  return Array.from(tags).sort();
}

/**
 * Generate a human-readable display name from repo IDs
 */
export function generateDisplayName(repoIds: string[]): string {
  if (repoIds.length === 0) return 'Empty Bundle';
  if (repoIds.length === 1) {
    // Single repo: use repo name
    const parts = repoIds[0]!.split('/');
    return parts[1] || parts[0] || 'Unknown';
  }

  // Multiple repos: combine smartly
  const repoNames = repoIds.map((id) => {
    const parts = id.split('/');
    return parts[1] || parts[0] || 'unknown';
  });

  if (repoNames.length <= 3) {
    return repoNames.join(' + ');
  }

  return `${repoNames[0]} + ${repoNames.length - 1} more`;
}

/**
 * Generate a brief description from facts
 */
export function generateDescription(params: {
  repoIds: string[];
  facts?: BundleFacts;
  tags: string[];
}): string {
  if (!params.facts) {
    return `Bundle containing ${params.repoIds.length} repository(ies)`;
  }

  const parts: string[] = [];

  // Primary language
  if (params.facts.languages.length > 0) {
    const topLang = params.facts.languages[0];
    if (topLang) {
      parts.push(`${topLang.language} project`);
    }
  }

  // Project type
  if (params.facts.frameworks.length > 0) {
    const frameworks = params.facts.frameworks.slice(0, 2).join(', ');
    parts.push(`using ${frameworks}`);
  }

  // Special categories - prioritize more specific categories
  if (params.tags.includes('claude-code')) {
    parts.push('(Claude Code Plugin)');
  } else if (params.tags.includes('mcp')) {
    parts.push('(MCP Server)');
  } else if (params.tags.includes('rag')) {
    parts.push('(RAG Framework)');
  } else if (params.tags.includes('vector-search')) {
    parts.push('(Vector Search / Embeddings)');
  } else if (params.tags.includes('nlp')) {
    parts.push('(NLP/AI)');
  } else if (params.tags.includes('deep-learning')) {
    parts.push('(Deep Learning)');
  } else if (params.tags.includes('machine-learning')) {
    parts.push('(Machine Learning)');
  } else if (params.tags.includes('ai')) {
    parts.push('(AI/LLM)');
  } else if (params.tags.includes('agents')) {
    parts.push('(AI Agent)');
  } else if (params.tags.includes('web-scraping')) {
    parts.push('(Web Scraping)');
  }

  if (parts.length === 0) {
    return `Bundle with ${params.facts.fileStructure.totalFiles} files`;
  }

  return parts.join(' ');
}

/**
 * Get category for a bundle based on tags (for grouping)
 */
export function getCategoryFromTags(tags: string[]): string {
  // Priority order for categorization
  if (tags.includes('claude-code')) return 'claude-code-plugins';
  if (tags.includes('mcp')) return 'mcp-servers';
  if (tags.includes('agents')) return 'ai-agents';
  if (tags.includes('web-scraping')) return 'web-scraping';
  if (tags.includes('code-analysis')) return 'code-analysis';
  if (tags.includes('testing') || tags.includes('debugging')) return 'testing-debugging';
  if (tags.includes('web-framework')) return 'web-frameworks';
  if (tags.includes('dev-tools')) return 'dev-tools';
  if (tags.includes('devops')) return 'devops';

  // Language-based fallback
  if (tags.includes('javascript')) return 'javascript';
  if (tags.includes('python')) return 'python';
  if (tags.includes('golang')) return 'golang';
  if (tags.includes('rust')) return 'rust';

  return 'uncategorized';
}
