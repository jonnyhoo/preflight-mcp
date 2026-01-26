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
    enabled: cfg.llmEnabled,
  };
}

/**
 * Get verifier LLM config for cross-validation.
 * Falls back to main LLM config if verifier-specific config not set.
 */
export function getVerifierLLMConfig(): LLMConfig {
  const cfg = getConfig();
  const mainConfig = getLLMConfig();
  
  // If verifier LLM is explicitly configured, use it
  if (cfg.verifierLlmEnabled) {
    return {
      apiBase: cfg.verifierLlmApiBase || mainConfig.apiBase,
      apiKey: cfg.verifierLlmApiKey || mainConfig.apiKey,
      model: cfg.verifierLlmModel || mainConfig.model,
      enabled: true,
    };
  }
  
  // Otherwise fall back to main LLM (cross-validation still works, just same model)
  return mainConfig;
}

export async function callLLM(prompt: string, systemPrompt?: string, configOverride?: LLMConfig): Promise<LLMResponse> {
  const config = configOverride ?? getLLMConfig();
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
  entryPoints?: string[];
  coreTypes?: string[];
  publicAPIs?: string[];
  features?: Array<{ name: string; desc?: string }>;
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

  // Include structured extraction results for better keyAPIs generation
  if (ctx.entryPoints?.length) parts.push('\n--- ENTRY POINTS ---', ctx.entryPoints.join(', '));
  if (ctx.coreTypes?.length) parts.push('\n--- CORE TYPES ---', ctx.coreTypes.join(', '));
  if (ctx.publicAPIs?.length) parts.push('\n--- PUBLIC APIs ---', ctx.publicAPIs.join(', '));
  if (ctx.features?.length) {
    const featureList = ctx.features.map(f => f.desc ? `${f.name}: ${f.desc}` : f.name);
    parts.push('\n--- FEATURES/SKILLS ---', featureList.join('\n'));
  }

  if (ctx.readme) parts.push('\n--- README ---', ctx.readme);
  parts.push('\nGenerate a knowledge card. For keyAPIs, list the main features/skills/commands users would search for (e.g., skill names, CLI commands, core functions).');
  return parts.join('\n');
}

// ============================================================================
// Context Truncation (pass-through, no limits)
// ============================================================================

export function truncateContext(ctx: {
  overview: string;
  readme?: string;
  architectureSummary?: string;
}): { overview: string; readme?: string; architectureSummary?: string; truncated: boolean } {
  // No truncation - modern LLMs have large context windows (128k+)
  // Card generation is low-frequency, cost is negligible
  // LLM will extract key points itself
  return {
    overview: ctx.overview,
    readme: ctx.readme,
    architectureSummary: ctx.architectureSummary,
    truncated: false,
  };
}
