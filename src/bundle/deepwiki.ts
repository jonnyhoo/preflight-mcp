import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type IngestedFile } from './ingest.js';
import { type BundlePaths } from './paths.js';
import { type PreflightConfig } from '../config.js';

export type DeepWikiSummary = {
  kind: 'deepwiki';
  url: string;
  repoId: string;
  fetchedAt: string;
  notes?: string[];
  files?: string[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

/**
 * Parse DeepWiki URL to extract owner/repo.
 * Supports formats like:
 * - https://deepwiki.com/owner/repo
 * - https://deepwiki.com/owner/repo/path/to/doc
 */
function parseDeepWikiUrl(url: string): { owner: string; repo: string } | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('deepwiki.com')) return null;
    
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    
    return { owner: parts[0]!, repo: parts[1]! };
  } catch {
    return null;
  }
}

/**
 * Fetch a DeepWiki page and extract its content.
 * Returns the page content as Markdown.
 */
async function fetchDeepWikiPage(url: string, timeoutMs = 30000): Promise<{ content: string; title?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'preflight-mcp/0.1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const html = await res.text();
    
    // Extract main content - DeepWiki typically renders docs in a main content area.
    // This is a best-effort extraction; real implementation would need more sophisticated parsing.
    const content = extractMarkdownFromHtml(html);
    const title = extractTitle(html);

    return { content, title };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Simple HTML to Markdown-ish text extraction.
 * This is a best-effort converter for documentation pages.
 */
function extractMarkdownFromHtml(html: string): string {
  // Remove script and style tags
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  
  // Convert common HTML elements to Markdown-ish format
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n');
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n');
  
  // Code blocks
  text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n');
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  
  // Lists
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  text = text.replace(/<ul[^>]*>/gi, '\n');
  text = text.replace(/<\/ul>/gi, '\n');
  text = text.replace(/<ol[^>]*>/gi, '\n');
  text = text.replace(/<\/ol>/gi, '\n');
  
  // Paragraphs and line breaks
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<hr\s*\/?>/gi, '\n---\n');
  
  // Bold and italic
  text = text.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  text = text.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  text = text.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  text = text.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');
  
  // Links
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  
  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');
  
  // Decode HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  
  // Clean up whitespace
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();
  
  return text;
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (match?.[1]) {
    return match[1].replace(/\s*[-|]\s*DeepWiki.*$/i, '').trim();
  }
  return undefined;
}

function clipUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const normalized = text.replace(/\r\n/g, '\n');
  const buf = Buffer.from(normalized, 'utf8');
  if (buf.length <= maxBytes) return { text: normalized, truncated: false };
  const clipped = buf.subarray(0, maxBytes).toString('utf8');
  return { text: `${clipped}\n\n[TRUNCATED]\n`, truncated: true };
}

export async function ingestDeepWikiRepo(params: {
  cfg: PreflightConfig;
  bundlePaths: BundlePaths;
  url: string;
}): Promise<{ files: IngestedFile[]; summary: DeepWikiSummary }> {
  const parsed = parseDeepWikiUrl(params.url);
  if (!parsed) {
    return {
      files: [],
      summary: {
        kind: 'deepwiki',
        url: params.url,
        repoId: params.url,
        fetchedAt: nowIso(),
        notes: ['Invalid DeepWiki URL format'],
      },
    };
  }

  const repoId = `${parsed.owner}/${parsed.repo}`;
  const fetchedAt = nowIso();
  const notes: string[] = [];
  const files: IngestedFile[] = [];
  const fileRelPaths: string[] = [];

  // Create deepwiki directory structure
  const deepwikiDir = path.join(params.bundlePaths.rootDir, 'deepwiki', parsed.owner, parsed.repo);
  const normDir = path.join(deepwikiDir, 'norm');
  await ensureDir(normDir);

  try {
    const { content, title } = await fetchDeepWikiPage(params.url);
    
    if (!content.trim()) {
      notes.push('DeepWiki page returned empty content');
    } else {
      const clipped = clipUtf8(content, params.cfg.maxFileBytes);
      if (clipped.truncated) {
        notes.push(`Content truncated to maxFileBytes=${params.cfg.maxFileBytes}`);
      }

      // Add header with source info
      const header = `# ${title || repoId} (DeepWiki)\n\nSource: ${params.url}\nFetched: ${fetchedAt}\n\n---\n\n`;
      const finalContent = header + clipped.text;

      const fileName = 'index.md';
      const absDocPath = path.join(normDir, fileName);
      await fs.writeFile(absDocPath, finalContent, 'utf8');

      const bundleRelPosix = toPosix(path.relative(params.bundlePaths.rootDir, absDocPath));
      fileRelPaths.push(bundleRelPosix);

      files.push({
        repoId: `deepwiki:${repoId}`,
        kind: 'doc',
        repoRelativePath: fileName,
        bundleNormRelativePath: bundleRelPosix,
        bundleNormAbsPath: absDocPath,
        sha256: sha256Hex(finalContent),
        bytes: Buffer.byteLength(finalContent, 'utf8'),
      });
    }
  } catch (err) {
    notes.push(`Failed to fetch DeepWiki page: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Write meta.json
  const metaPath = path.join(deepwikiDir, 'meta.json');
  await fs.writeFile(
    metaPath,
    JSON.stringify(
      {
        kind: 'deepwiki',
        url: params.url,
        repoId,
        fetchedAt,
        files: fileRelPaths,
        notes: notes.length > 0 ? notes : undefined,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  return {
    files,
    summary: {
      kind: 'deepwiki',
      url: params.url,
      repoId,
      fetchedAt,
      files: fileRelPaths.length > 0 ? fileRelPaths : undefined,
      notes: notes.length > 0 ? notes : undefined,
    },
  };
}
