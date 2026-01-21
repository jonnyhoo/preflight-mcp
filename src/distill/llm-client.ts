/**
 * LLM Client for Repo Card Generation.
 * @module distill/llm-client
 */

import { getConfig } from '../config.js';
import { createModuleLogger } from '../logging/logger.js';
import { robustJsonParse, type ParseResult } from '../modal/utils/json-parser.js';

const logger = createModuleLogger('llm-client');

// ============================================================================
// Types
// ============================================================================

export interface LLMConfig {
  apiBase: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  enabled: boolean;
}

export interface LLMResponse {
  content: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
}

export interface LLMCallResult<T> {
  data: T | null;
  parseMethod: string;
  response?: LLMResponse;
  error?: string;
}

// ============================================================================
// Config & API
// ============================================================================

export function getLLMConfig(): LLMConfig {
  const cfg = getConfig();
  return {
    apiBase: cfg.llmApiBase || 'https://api.openai.com/v1',
    apiKey: cfg.llmApiKey || '',
    model: cfg.llmModel || 'gpt-4o-mini',
    maxTokens: 2000,
    enabled: cfg.llmEnabled,
  };
}

export async function callLLM(prompt: string, systemPrompt?: string): Promise<LLMResponse> {
  const config = getLLMConfig();
  if (!config.enabled || !config.apiKey) {
    throw new Error('LLM not enabled or API key not configured');
  }

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const url = `${config.apiBase.replace(/\/$/, '')}/chat/completions`;
  logger.debug(`Calling LLM: ${config.model}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      max_tokens: config.maxTokens,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error(`LLM API error: ${res.status} ${text}`);
    throw new Error(`LLM API error: ${res.status}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    model: string;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    content: data.choices?.[0]?.message?.content ?? '',
    model: data.model,
    promptTokens: data.usage?.prompt_tokens,
    completionTokens: data.usage?.completion_tokens,
  };
}

export async function callLLMWithJSON<T>(prompt: string, systemPrompt?: string): Promise<LLMCallResult<T>> {
  try {
    const response = await callLLM(prompt, systemPrompt);
    const parseResult: ParseResult<T> = robustJsonParse<T>(response.content);
    return { data: parseResult.data, parseMethod: parseResult.method, response };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`LLM call failed: ${msg}`);
    return { data: null, parseMethod: 'none', error: msg };
  }
}

// ============================================================================
// Prompts
// ============================================================================

export const CARD_GENERATION_SYSTEM_PROMPT = `You are a technical analyst. Output ONLY valid JSON.

RULES:
1. Be concise but accurate
2. If uncertain, write "Unknown"
3. NEVER include source code or secrets
4. Focus on "what" and "why", not "how"
5. keyAPIs: Extract core features, skills, commands, or API names that users would search for
6. Look for supported platforms/tools in README (e.g., "works with X", "plugin for Y")

Output format:
{"oneLiner":"...","problemSolved":"...","useCases":[],"designHighlights":[],"limitations":[],"quickStart":"...","keyAPIs":[]}`;

export function buildCardGenerationPrompt(ctx: {
  name: string;
  language: string;
  frameworks: string[];
  overview: string;
  architectureSummary?: string;
  designPatterns?: string[];
  readme?: string;
}): string {
  const parts = [
    `Project: ${ctx.name}`,
    `Language: ${ctx.language}`,
  ];
  if (ctx.frameworks.length) parts.push(`Frameworks: ${ctx.frameworks.join(', ')}`);
  parts.push('\n--- OVERVIEW ---', ctx.overview);
  if (ctx.architectureSummary) parts.push('\n--- ARCHITECTURE ---', ctx.architectureSummary);
  if (ctx.designPatterns?.length) parts.push('\n--- PATTERNS ---', ctx.designPatterns.join(', '));
  if (ctx.readme) parts.push('\n--- README ---', ctx.readme);
  parts.push('\nGenerate a knowledge card. For keyAPIs, list the main features/skills/commands users would search for (e.g., skill names, CLI commands, core functions).');
  return parts.join('\n');
}

// ============================================================================
// Context Truncation
// ============================================================================

const LIMITS = { overview: 2000, readme: 1500, arch: 1000, total: 8000 };

export function truncateContext(ctx: {
  overview: string;
  readme?: string;
  architectureSummary?: string;
}): { overview: string; readme?: string; architectureSummary?: string; truncated: boolean } {
  let truncated = false;
  const cut = (s: string, max: number) => {
    if (s.length <= max) return s;
    truncated = true;
    return s.slice(0, max) + '...';
  };

  const overview = cut(ctx.overview, LIMITS.overview);
  let readme = ctx.readme ? cut(ctx.readme, LIMITS.readme) : undefined;
  const architectureSummary = ctx.architectureSummary ? cut(ctx.architectureSummary, LIMITS.arch) : undefined;

  // Drop readme if over total limit
  const total = overview.length + (readme?.length || 0) + (architectureSummary?.length || 0);
  if (total > LIMITS.total && readme) {
    readme = undefined;
    truncated = true;
  }

  return { overview, readme, architectureSummary, truncated };
}
