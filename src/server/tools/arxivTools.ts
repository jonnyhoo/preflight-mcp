/**
 * arXiv Search Tools
 *
 * Provides arXiv paper search functionality with:
 * - No artificial result limits (up to 200 per request)
 * - Cursor-based pagination for large result sets
 * - Structured JSON output for easy processing
 *
 * @module server/tools/arxivTools
 */
import * as z from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDependencies } from './types.js';
import { callLLM, getVerifierLLMConfig } from '../../distill/llm-client.js';

// =============================================================================
// Constants
// =============================================================================

const ARXIV_API_BASE = 'https://export.arxiv.org/api/query';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESULTS_PER_REQUEST = 1000; // arXiv API allows up to 2000
const RATE_LIMIT_MS = 3000; // arXiv requires 3s between requests

// Search presets for common research areas
const ARXIV_PRESETS: Record<string, { query: string; description: string }> = {
  'ai_mainstream': {
    query: 'cat:cs.CL OR cat:cs.LG',
    description: 'AI主流研究 (LLM/NLP + 机器学习)',
  },
  'ai_full': {
    query: 'cat:cs.CL OR cat:cs.LG OR cat:cs.CV OR cat:cs.AI',
    description: 'AI全领域 (NLP + ML + CV + AI)',
  },
  'llm': {
    query: 'cat:cs.CL',
    description: 'LLM/NLP研究',
  },
  'ml': {
    query: 'cat:cs.LG',
    description: '机器学习研究',
  },
  'cv': {
    query: 'cat:cs.CV',
    description: '计算机视觉研究',
  },
  'multimodal': {
    query: 'cat:cs.CV OR cat:cs.CL',
    description: '多模态研究 (视觉+语言)',
  },
};

// Track last request time for rate limiting
let lastRequestTime = 0;

// =============================================================================
// Types
// =============================================================================

interface ArxivPaper {
  id: string;
  title: string;
  authors: string[];
  summary: string;
  published: string;
  updated: string;
  primaryCategory: string;
  categories: string[];
  pdfUrl: string | null;
  htmlUrl: string | null;
  abstractUrl: string;
  comment: string | null;
  journalRef: string | null;
  doi: string | null;
}

interface ArxivSearchResult {
  papers: ArxivPaper[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  hasMore: boolean;
  nextCursor: string | null;
}

// =============================================================================
// Input Schema
// =============================================================================

// Flat input schema (MCP standard format - each property is a separate zod schema)
const ArxivSearchInputSchema = {
  preset: z.enum(['ai_mainstream', 'ai_full', 'llm', 'ml', 'cv', 'multimodal'] as const).optional().describe(
    `Search preset (overrides query if provided):
- ai_mainstream: LLM/NLP + ML (推荐，当前AI热点)
- ai_full: NLP + ML + CV + AI (全覆盖)
- llm: 仅LLM/NLP
- ml: 仅机器学习
- cv: 仅计算机视觉
- multimodal: 多模态 (CV + NLP)`
  ),
  query: z.string().optional().describe(
    `Search query using arXiv syntax. Required unless idList is provided.

**Field prefixes (RECOMMENDED for precision):**
- ti:"neural networks" - Search in title only
- abs:"transformer" - Search in abstract only  
- au:"bengio" - Search by author name
- cat:cs.AI - Filter by category

**Operators:**
- AND, OR, ANDNOT - Combine terms
- "exact phrase" - Match exact phrase

**Examples:**
- ti:"large language model" AND cat:cs.CL
- au:hinton AND ti:"deep learning"
- cat:cs.AI AND ti:agent

**Tip:** Without field prefix, arXiv treats spaces as OR (very broad). Always use ti: for precise searches.`
  ),
  maxResults: z.number().int().min(1).max(MAX_RESULTS_PER_REQUEST).default(50).optional().describe(
    `Max results to return (1-${MAX_RESULTS_PER_REQUEST}, default 50). Use cursor for pagination.`
  ),
  sortBy: z.enum(['submittedDate', 'lastUpdatedDate', 'relevance']).default('submittedDate').optional().describe(
    'Sort order: submittedDate (newest first), lastUpdatedDate, or relevance'
  ),
  sortOrder: z.enum(['descending', 'ascending']).default('descending').optional().describe(
    'Sort direction: descending or ascending'
  ),
  cursor: z.string().optional().describe(
    'Pagination cursor from previous response. Pass nextCursor to get next page.'
  ),
  daysBack: z.number().int().min(0).max(30).default(0).optional().describe(
    'Filter papers from last N days. 0 = no filter (default), 1 = today only, 7 = last week. Ignored if fromDate/toDate provided.'
  ),
  fromDate: z.string().optional().describe(
    'Start date for filtering (YYYY-MM-DD format). Example: "2026-01-28"'
  ),
  toDate: z.string().optional().describe(
    'End date for filtering (YYYY-MM-DD format). If same as fromDate, filters single day.'
  ),
  idList: z.array(z.string()).optional().describe(
    `Fetch specific papers by arXiv ID. When provided, query is ignored. Examples: ["2301.07041", "2312.12456v2"]`
  ),
  brief: z.boolean().default(false).optional().describe(
    'Brief mode: only return paper count and titles (saves tokens). Use idList to get full details for specific papers.'
  ),
  translate: z.boolean().default(false).optional().describe(
    'Translate titles and summaries to Chinese using LLM. Requires LLM config in ~/.preflight/config.json'
  ),
  outputFile: z.string().optional().describe(
    'Save results to file (absolute path). Supports .md, .json, .csv formats. Auto-detects format from extension.'
  ),
  format: z.enum(['markdown', 'json', 'csv']).optional().describe(
    'Output format (auto-detected from outputFile extension if not specified). Default: markdown'
  ),
};

// =============================================================================
// Tool Description
// =============================================================================

const arxivSearchDescription =
  'Search arXiv papers by preset, query, or ID.\n' +
  '**Quick start:** `{"preset": "ai_mainstream", "daysBack": 2, "brief": true}`\n' +
  '**Get details:** `{"idList": ["2301.07041"]}`\n' +
  'Tip: Use brief=true for listing (saves tokens), idList for full paper details.\n' +
  'Next: preflight_create_bundle → preflight_rag to index PDF.\n' +
  'Use when: "搜论文", "arXiv", "AI论文", "最新AI研究", "paper search".';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Wait for rate limit if needed.
 */
async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

/**
 * Clean text by normalizing whitespace.
 */
function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Parse arXiv Atom feed response.
 */
function parseAtomFeed(xmlText: string): ArxivSearchResult {
  // Simple XML parsing without external dependencies
  // arXiv returns Atom feed format

  const getTagContent = (xml: string, tag: string): string => {
    const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    return match ? match[1]!.trim() : '';
  };

  const getAllTagContents = (xml: string, tag: string): string[] => {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
    const results: string[] = [];
    let match;
    while ((match = regex.exec(xml)) !== null) {
      results.push(match[1]!.trim());
    }
    return results;
  };

  // Get pagination info from opensearch namespace
  const totalResultsStr = getTagContent(xmlText, 'opensearch:totalResults');
  const startIndexStr = getTagContent(xmlText, 'opensearch:startIndex');
  const itemsPerPageStr = getTagContent(xmlText, 'opensearch:itemsPerPage');

  const totalResults = parseInt(totalResultsStr, 10) || 0;
  const startIndex = parseInt(startIndexStr, 10) || 0;
  const itemsPerPage = parseInt(itemsPerPageStr, 10) || 0;

  // Parse entries
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  const papers: ArxivPaper[] = [];
  let entryMatch;

  while ((entryMatch = entryRegex.exec(xmlText)) !== null) {
    const entry = entryMatch[1]!;

    // Extract ID
    const idFull = getTagContent(entry, 'id');
    const id = idFull.split('/abs/').pop()?.replace(/v\d+$/, '') || idFull;

    // Extract title
    const title = cleanText(getTagContent(entry, 'title'));

    // Extract authors
    const authorMatches = entry.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi) || [];
    const authors = authorMatches.map(a => {
      const nameMatch = a.match(/<name>([\s\S]*?)<\/name>/i);
      return nameMatch ? cleanText(nameMatch[1]!) : '';
    }).filter(Boolean);

    // Extract summary (abstract)
    const summary = cleanText(getTagContent(entry, 'summary'));

    // Extract dates
    const published = getTagContent(entry, 'published');
    const updated = getTagContent(entry, 'updated');

    // Extract categories
    const categoryMatches = entry.match(/<category[^>]*term="([^"]+)"[^>]*\/>/gi) || [];
    const categories = categoryMatches.map(c => {
      const termMatch = c.match(/term="([^"]+)"/i);
      return termMatch ? termMatch[1]! : '';
    }).filter(Boolean);

    // Extract primary category
    const primaryCatMatch = entry.match(/<arxiv:primary_category[^>]*term="([^"]+)"[^>]*\/>/i);
    const primaryCategory = primaryCatMatch ? primaryCatMatch[1]! : (categories[0] || '');

    // Extract links
    let pdfUrl: string | null = null;
    let abstractUrl = '';
    const linkMatches = entry.match(/<link[^>]+>/gi) || [];
    for (const link of linkMatches) {
      const hrefMatch = link.match(/href="([^"]+)"/i);
      const typeMatch = link.match(/type="([^"]+)"/i);
      const titleMatch = link.match(/title="([^"]+)"/i);
      
      if (hrefMatch) {
        const href = hrefMatch[1]!;
        const type = typeMatch ? typeMatch[1] : '';
        const linkTitle = titleMatch ? titleMatch[1] : '';
        
        if (type === 'application/pdf' || linkTitle === 'pdf') {
          pdfUrl = href;
        } else if (type === 'text/html' && !abstractUrl) {
          abstractUrl = href;
        }
      }
    }

    // Construct HTML URL
    const htmlUrl = id ? `https://arxiv.org/html/${id}` : null;
    if (!abstractUrl && id) {
      abstractUrl = `https://arxiv.org/abs/${id}`;
    }

    // Extract optional fields
    const comment = getTagContent(entry, 'arxiv:comment') || null;
    const journalRef = getTagContent(entry, 'arxiv:journal_ref') || null;
    const doi = getTagContent(entry, 'arxiv:doi') || null;

    papers.push({
      id,
      title,
      authors,
      summary,
      published,
      updated,
      primaryCategory,
      categories,
      pdfUrl,
      htmlUrl,
      abstractUrl,
      comment,
      journalRef,
      doi,
    });
  }

  const hasMore = startIndex + papers.length < totalResults;
  const nextCursor = hasMore ? String(startIndex + papers.length) : null;

  return {
    papers,
    totalResults,
    startIndex,
    itemsPerPage: papers.length,
    hasMore,
    nextCursor,
  };
}

/**
 * Get date string in YYYYMMDD format for arXiv date filter.
 */
function getArxivDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Search arXiv API.
 */
async function searchArxiv(
  query: string,
  maxResults: number,
  sortBy: string,
  sortOrder: string,
  startIndex: number,
  daysBack: number = 0,
  idList?: string[],
  fromDateStr?: string,
  toDateStr?: string
): Promise<ArxivSearchResult> {
  await waitForRateLimit();

  // Map sort options to arXiv API values
  const sortByMap: Record<string, string> = {
    submittedDate: 'submittedDate',
    lastUpdatedDate: 'lastUpdatedDate',
    relevance: 'relevance',
  };

  // Build query with optional date filter
  let finalQuery = query;
  if (!idList?.length) {
    // Priority: fromDate/toDate > daysBack
    if (fromDateStr || toDateStr) {
      const fromStr = fromDateStr ? fromDateStr.replace(/-/g, '') : '19910101';
      const toStr = toDateStr ? toDateStr.replace(/-/g, '') : getArxivDateString(new Date());
      finalQuery = `(${query}) AND submittedDate:[${fromStr} TO ${toStr}]`;
    } else if (daysBack > 0) {
      const now = new Date();
      const fromDate = new Date(now);
      fromDate.setDate(fromDate.getDate() - daysBack);
      const fromStr = getArxivDateString(fromDate);
      const toStr = getArxivDateString(now);
      finalQuery = `(${query}) AND submittedDate:[${fromStr} TO ${toStr}]`;
    }
  }

  // Build URL params
  const params = new URLSearchParams();
  
  if (idList && idList.length > 0) {
    // When using id_list, search_query can be empty
    params.set('id_list', idList.join(','));
    params.set('max_results', String(idList.length));
  } else {
    params.set('search_query', finalQuery);
    params.set('start', String(startIndex));
    params.set('max_results', String(maxResults));
    params.set('sortBy', sortByMap[sortBy] || 'submittedDate');
    params.set('sortOrder', sortOrder);
  }

  const url = `${ARXIV_API_BASE}?${params.toString()}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Preflight-MCP/1.0 (arXiv search tool)',
      },
    });

    if (!response.ok) {
      throw new Error(`arXiv API error: ${response.status} ${response.statusText}`);
    }

    const xmlText = await response.text();
    return parseAtomFeed(xmlText);
  } finally {
    clearTimeout(timeoutId);
  }
}

// =============================================================================
// Translation Helper
// =============================================================================

/**
 * Translate paper titles and summaries to Chinese using LLM.
 * Batches papers for efficiency.
 */
async function translatePapers(
  papers: ArxivPaper[],
  batchSize = 10
): Promise<Map<string, { title: string; summary: string }>> {
  // Use verifierLlm for translation (typically has more tokens than RAG llm)
  const llmConfig = getVerifierLLMConfig();
  if (!llmConfig.enabled || !llmConfig.apiKey) {
    throw new Error('Verifier LLM not configured. Add verifierLlmApiBase/verifierLlmApiKey/verifierLlmModel to ~/.preflight/config.json');
  }

  const translations = new Map<string, { title: string; summary: string }>();
  
  // Process in batches
  for (let i = 0; i < papers.length; i += batchSize) {
    const batch = papers.slice(i, i + batchSize);
    
    const prompt = `Translate the following academic paper titles and abstracts to Chinese. Output JSON array with same order.

Input:
${batch.map((p, idx) => `[${idx}] Title: ${p.title}
Abstract: ${p.summary.slice(0, 500)}`).join('\n\n')}

Output format (JSON array, same order):
[{"title": "中文标题", "summary": "一句话中文概述（不超过50字）"}]

IMPORTANT: Output ONLY the JSON array, no markdown code blocks.`;

    try {
      const response = await callLLM(prompt, 'You are a professional academic translator. Translate accurately and concisely.', llmConfig, { temperature: 0.1 });
      
      // Parse JSON from response
      let jsonStr = response.content.trim();
      // Remove markdown code blocks if present
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      
      const parsed = JSON.parse(jsonStr) as Array<{ title: string; summary: string }>;
      
      batch.forEach((paper, idx) => {
        if (parsed[idx]) {
          translations.set(paper.id, parsed[idx]!);
        }
      });
    } catch (err) {
      // On error, use original English for this batch
      console.error(`Translation batch failed: ${err instanceof Error ? err.message : err}`);
      batch.forEach(paper => {
        translations.set(paper.id, { title: paper.title, summary: paper.summary.slice(0, 100) });
      });
    }
    
    // Small delay between batches to avoid rate limits
    if (i + batchSize < papers.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  return translations;
}

/**
 * Format papers for file output.
 */
function formatPapersForOutput(
  papers: ArxivPaper[],
  format: 'markdown' | 'json' | 'csv',
  translations?: Map<string, { title: string; summary: string }>,
  query?: string,
  dateRange?: string
): string {
  if (format === 'json') {
    const data = papers.map(p => {
      const trans = translations?.get(p.id);
      return {
        id: p.id,
        title: p.title,
        titleCn: trans?.title,
        summary: p.summary,
        summaryCn: trans?.summary,
        authors: p.authors,
        published: p.published.split('T')[0],
        category: p.primaryCategory,
        pdfUrl: p.pdfUrl,
      };
    });
    return JSON.stringify(data, null, 2);
  }
  
  if (format === 'csv') {
    const header = 'ID,Title,TitleCN,Summary,Authors,Published,Category,PDF';
    const rows = papers.map(p => {
      const trans = translations?.get(p.id);
      const escape = (s: string) => `"${s.replace(/"/g, '""').replace(/\n/g, ' ')}"`;
      return [
        p.id,
        escape(p.title),
        escape(trans?.title || ''),
        escape(trans?.summary || p.summary.slice(0, 200)),
        escape(p.authors.slice(0, 3).join('; ')),
        p.published.split('T')[0],
        p.primaryCategory,
        p.pdfUrl || '',
      ].join(',');
    });
    return [header, ...rows].join('\n');
  }
  
  // Markdown format (default)
  const lines: string[] = [
    `# arXiv Papers${dateRange ? ` (${dateRange})` : ''}`,
    '',
    `**Query**: ${query || 'N/A'}`,
    `**Total**: ${papers.length} papers`,
    `**Generated**: ${new Date().toISOString().split('T')[0]}`,
    '',
    '---',
    '',
  ];
  
  papers.forEach((p, idx) => {
    const trans = translations?.get(p.id);
    lines.push(`## ${idx + 1}. ${p.title}`);
    if (trans?.title) {
      lines.push(`**${trans.title}**`);
    }
    lines.push('');
    lines.push(`- **ID**: ${p.id} | ${p.primaryCategory}`);
    lines.push(`- **Authors**: ${p.authors.slice(0, 3).join(', ')}${p.authors.length > 3 ? ` +${p.authors.length - 3}` : ''}`);
    lines.push(`- **Date**: ${p.published.split('T')[0]}`);
    lines.push(`- **PDF**: ${p.pdfUrl || 'N/A'}`);
    if (trans?.summary) {
      lines.push(`- **概述**: ${trans.summary}`);
    } else {
      lines.push(`- **Abstract**: ${p.summary.slice(0, 200)}...`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  });
  
  return lines.join('\n');
}

/**
 * Download PDF from arXiv.
 */
async function downloadArxivPdf(paperId: string, outputDir: string): Promise<string> {
  const pdfUrl = `https://arxiv.org/pdf/${paperId}.pdf`;
  const fileName = `${paperId.replace('/', '_')}.pdf`;
  const filePath = path.join(outputDir, fileName);
  
  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });
  
  // Check if already downloaded
  if (fs.existsSync(filePath)) {
    return filePath;
  }
  
  await waitForRateLimit();
  
  const response = await fetch(pdfUrl, {
    headers: { 'User-Agent': 'Preflight-MCP/1.0 (arXiv download tool)' },
  });
  
  if (!response.ok) {
    throw new Error(`Failed to download ${paperId}: ${response.status}`);
  }
  
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, buffer);
  
  return filePath;
}

// =============================================================================
// Tool Registration
// =============================================================================

/**
 * Register arXiv search tools.
 */
export function registerArxivTools({ server }: ToolDependencies): void {
  server.registerTool(
    'preflight_arxiv_search',
    {
      title: 'Search arXiv Papers',
      description: arxivSearchDescription,
      inputSchema: ArxivSearchInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      // Destructure with defaults
      const preset = args.preset as string | undefined;
      let query = args.query as string | undefined;
      const maxResults = (args.maxResults as number | undefined) ?? 50;

      // Apply preset: combine with query if both provided
      if (preset && ARXIV_PRESETS[preset]) {
        const presetQuery = ARXIV_PRESETS[preset].query;
        query = query ? `(${presetQuery}) AND (${query})` : presetQuery;
      }
      const sortBy = (args.sortBy as string | undefined) ?? 'submittedDate';
      const sortOrder = (args.sortOrder as string | undefined) ?? 'descending';
      const cursor = args.cursor as string | undefined;
      const daysBack = (args.daysBack as number | undefined) ?? 0;
      const fromDate = args.fromDate as string | undefined;
      const toDate = args.toDate as string | undefined;
      const idList = args.idList as string[] | undefined;
      const brief = (args.brief as boolean | undefined) ?? false;
      const translate = (args.translate as boolean | undefined) ?? false;
      const outputFile = args.outputFile as string | undefined;
      let format = args.format as 'markdown' | 'json' | 'csv' | undefined;

      // Parse cursor for pagination
      const startIndex = cursor ? parseInt(cursor, 10) : 0;
      if (cursor && isNaN(startIndex)) {
        return {
          content: [{ type: 'text', text: 'Error: Invalid cursor format' }],
          structuredContent: { success: false, error: 'Invalid cursor format' },
        };
      }

      // Validate: need either query or idList
      if (!query && (!idList || idList.length === 0)) {
        return {
          content: [{ type: 'text', text: 'Error: Either query or idList must be provided' }],
          structuredContent: { success: false, error: 'Either query or idList must be provided' },
        };
      }

      // Auto-detect format from file extension
      if (outputFile && !format) {
        const ext = path.extname(outputFile).toLowerCase();
        if (ext === '.json') format = 'json';
        else if (ext === '.csv') format = 'csv';
        else format = 'markdown';
      }

      try {
        const result = await searchArxiv(query ?? '', maxResults, sortBy, sortOrder, startIndex, daysBack, idList, fromDate, toDate);

        // Count papers by date (today, yesterday, etc.)
        const today = new Date().toISOString().split('T')[0];
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        let todayCount = 0;
        let yesterdayCount = 0;
        const dateCounts: Record<string, number> = {};
        
        for (const paper of result.papers) {
          const pubDate = paper.published.split('T')[0] || 'unknown';
          dateCounts[pubDate] = (dateCounts[pubDate] || 0) + 1;
          if (pubDate === today) todayCount++;
          else if (pubDate === yesterday) yesterdayCount++;
        }

        // Format text output
        let text = `📚 arXiv Search Results\n`;
        if (idList && idList.length > 0) {
          text += `Mode: Fetch by ID (${idList.length} requested)\n`;
        } else {
          text += `Query: ${query}\n`;
          if (daysBack > 0) {
            text += `📅 Date filter: last ${daysBack} day(s)\n`;
          }
        }
        text += `Found: ${result.totalResults} total, showing ${result.papers.length} (from ${startIndex + 1})\n`;
        
        // Show date breakdown
        if (result.papers.length > 0) {
          const sortedDates = Object.entries(dateCounts).sort((a, b) => b[0].localeCompare(a[0]));
          const isPaged = result.papers.length < result.totalResults;
          text += isPaged ? `📊 This page by date: ` : `📊 By date: `;
          text += sortedDates.slice(0, 5).map(([date, count]) => {
            const label = date === today ? 'today' : date === yesterday ? 'yesterday' : date;
            return `${label}: ${count}`;
          }).join(', ');
          if (sortedDates.length > 5) text += ` (+${sortedDates.length - 5} more dates)`;
          text += `\n`;
        }
        
        if (result.hasMore) {
          text += `📄 More results available - use cursor: "${result.nextCursor}"\n`;
        }
        text += `\n`;

        // Translate if requested
        let translations: Map<string, { title: string; summary: string }> | undefined;
        if (translate && result.papers.length > 0) {
          text += `🔄 Translating ${result.papers.length} papers to Chinese...\n`;
          try {
            translations = await translatePapers(result.papers);
            text += `✅ Translation complete\n\n`;
          } catch (err) {
            text += `⚠️ Translation failed: ${err instanceof Error ? err.message : err}\n\n`;
          }
        }

        // Save to file if requested
        if (outputFile && result.papers.length > 0) {
          const dateRange = fromDate ? (toDate && toDate !== fromDate ? `${fromDate} ~ ${toDate}` : fromDate) : undefined;
          const fileContent = formatPapersForOutput(result.papers, format || 'markdown', translations, query, dateRange);
          
          // Ensure directory exists
          const dir = path.dirname(outputFile);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(outputFile, fileContent, 'utf8');
          
          text += `📁 Saved to: ${outputFile}\n\n`;
        }

        if (brief) {
          // Brief mode: compact list with titles and PDF links
          for (const paper of result.papers) {
            const trans = translations?.get(paper.id);
            if (trans) {
              text += `- [${paper.id}] ${trans.title} | ${paper.pdfUrl || 'N/A'}\n`;
            } else {
              text += `- [${paper.id}] ${paper.title} | ${paper.pdfUrl || 'N/A'}\n`;
            }
          }
          text += `\nℹ️ Use {"idList": ["ID"]} to get full details (abstract, authors, etc.).\n`;
        } else {
          // Full mode: detailed info
          for (const paper of result.papers) {
            const trans = translations?.get(paper.id);
            text += `---\n`;
            text += `**${paper.title}**\n`;
            if (trans?.title) text += `**${trans.title}**\n`;
            text += `ID: ${paper.id} | ${paper.primaryCategory}\n`;
            text += `Authors: ${paper.authors.slice(0, 3).join(', ')}${paper.authors.length > 3 ? ` +${paper.authors.length - 3} more` : ''}\n`;
            text += `Published: ${paper.published.split('T')[0]}\n`;
            if (trans?.summary) {
              text += `概述: ${trans.summary}\n`;
            }
            text += `Abstract: ${paper.summary.slice(0, 300)}${paper.summary.length > 300 ? '...' : ''}\n`;
            text += `PDF: ${paper.pdfUrl || 'N/A'}\n`;
            text += `\n`;
          }
        }

        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            success: true,
            query,
            totalResults: result.totalResults,
            startIndex: result.startIndex,
            returnedCount: result.papers.length,
            hasMore: result.hasMore,
            nextCursor: result.nextCursor,
            papers: result.papers,
            outputFile,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `❌ arXiv search failed: ${message}` }],
          structuredContent: { success: false, error: message },
        };
      }
    }
  );

  // =========================================================================
  // arxiv_download tool
  // =========================================================================

  const arxivDownloadDescription =
    'Download arXiv papers as PDF files to local directory.\n' +
    '**Usage:** `{"idList": ["2601.20732", "2601.20745"], "outputDir": "D:/papers/"}`\n' +
    'Returns list of downloaded file paths for use with preflight_create_bundle.\n' +
    'Use when: "下载论文", "download papers", "批量下载".';

  server.registerTool(
    'preflight_arxiv_download',
    {
      title: 'Download arXiv Papers',
      description: arxivDownloadDescription,
      inputSchema: {
        idList: z.array(z.string()).min(1).describe(
          'List of arXiv paper IDs to download. Examples: ["2601.20732", "2312.12456"]'
        ),
        outputDir: z.string().describe(
          'Directory to save PDFs. Will be created if not exists.'
        ),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => {
      const idList = args.idList as string[];
      const outputDir = args.outputDir as string;

      const results: Array<{ id: string; path?: string; error?: string }> = [];
      const downloadedPaths: string[] = [];

      for (const paperId of idList) {
        try {
          const filePath = await downloadArxivPdf(paperId, outputDir);
          results.push({ id: paperId, path: filePath });
          downloadedPaths.push(filePath);
        } catch (err) {
          results.push({ id: paperId, error: err instanceof Error ? err.message : String(err) });
        }
      }

      const successCount = results.filter(r => r.path).length;
      const failCount = results.filter(r => r.error).length;

      let text = `📥 arXiv Download Results\n`;
      text += `Downloaded: ${successCount}/${idList.length}`;
      if (failCount > 0) text += ` (${failCount} failed)`;
      text += `\n\n`;

      for (const r of results) {
        if (r.path) {
          text += `✅ ${r.id} → ${r.path}\n`;
        } else {
          text += `❌ ${r.id}: ${r.error}\n`;
        }
      }

      if (downloadedPaths.length > 0) {
        text += `\n📋 Paths for create_bundle:\n`;
        text += JSON.stringify(downloadedPaths, null, 2);
      }

      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          success: failCount === 0,
          downloaded: successCount,
          failed: failCount,
          results,
          paths: downloadedPaths,
        },
      };
    }
  );
}
