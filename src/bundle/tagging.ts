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

      if (lowerFw.includes('jest') || lowerFw.includes('vitest') || lowerFw.includes('pytest')) {
        tags.add('testing');
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

    if (allDeps.some((d) => d.includes('axios') || d.includes('fetch') || d.includes('request'))) {
      tags.add('http-client');
    }

    if (allDeps.some((d) => d.includes('cheerio') || d.includes('beautifulsoup') || d.includes('jsdom'))) {
      tags.add('html-parsing');
      tags.add('web-scraping');
    }
  }

  // 3. Detect by file patterns
  const fileNames = params.files.map((f) => f.repoRelativePath.toLowerCase());

  if (fileNames.some((f) => f.includes('dockerfile') || f.includes('docker-compose'))) {
    tags.add('docker');
    tags.add('devops');
  }

  if (fileNames.some((f) => f.includes('kubernetes') || f.includes('k8s'))) {
    tags.add('kubernetes');
    tags.add('devops');
  }

  if (fileNames.some((f) => f.includes('ci') || f.includes('github/workflows'))) {
    tags.add('ci-cd');
    tags.add('devops');
  }

  if (fileNames.some((f) => f.includes('readme') || f.includes('docs/'))) {
    tags.add('documented');
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

  // Special categories
  if (params.tags.includes('mcp')) {
    parts.push('(MCP Server)');
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
