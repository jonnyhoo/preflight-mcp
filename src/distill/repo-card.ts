/**
 * Repo Card Generation - extracts knowledge cards from bundles.
 * @module distill/repo-card
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { getConfig } from '../config.js';
import { createModuleLogger } from '../logging/logger.js';
import { getBundlePaths, type BundlePaths } from '../bundle/paths.js';
import { readManifest } from '../bundle/manifest.js';
import { getEffectiveStorageDir } from '../bundle/storage.js';
import { findBundleStorageDir } from '../bundle/list.js';
import { readUtf8OrNull } from '../bundle/utils.js';

import {
  type RepoCard, type BundleContext, type CardWarning,
  type LLMCardResponse, type CardExport, type GenerateCardResult,
  type FieldEvidence, toSafeRepoId,
} from './types.js';
import type { BundleFacts } from '../bundle/facts.js';
import type { ArchitectureSummary } from '../analysis/architecture-summary.js';
import {
  getLLMConfig, callLLMWithJSON,
  CARD_GENERATION_SYSTEM_PROMPT, buildCardGenerationPrompt, truncateContext,
} from './llm-client.js';

const logger = createModuleLogger('repo-card');

// ============================================================================
// Helpers
// ============================================================================

const generateCardId = (bundleId: string, repoId: string) =>
  crypto.createHash('sha256').update(`${bundleId}:${repoId}`).digest('hex').slice(0, 16);

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');

async function computeFingerprint(paths: BundlePaths): Promise<string> {
  const parts: string[] = [];
  const facts = await readUtf8OrNull(path.join(paths.rootDir, 'analysis', 'FACTS.json'));
  if (facts) parts.push(md5(facts));
  const overview = await readUtf8OrNull(paths.overviewPath);
  if (overview) parts.push(md5(overview));
  return parts.join('-');
}

function getCardPath(paths: BundlePaths, repoId: string): string {
  return path.join(paths.rootDir, 'cards', toSafeRepoId(repoId), 'CARD.json');
}

async function getBundlePaths2(bundleId: string) {
  const cfg = getConfig();
  const dir = (await findBundleStorageDir(cfg.storageDirs, bundleId)) ?? (await getEffectiveStorageDir(cfg));
  return getBundlePaths(dir, bundleId);
}

// ============================================================================
// Context Extraction
// ============================================================================

export async function extractBundleContext(
  bundleId: string,
  repoId?: string
): Promise<{ context: BundleContext; warnings: CardWarning[]; evidence: FieldEvidence[] }> {
  const paths = await getBundlePaths2(bundleId);
  const warnings: CardWarning[] = [];
  const evidence: FieldEvidence[] = [];

  const manifest = await readManifest(paths.manifestPath);
  const effectiveRepoId = repoId || manifest.repos[0]?.id;
  if (!effectiveRepoId) throw new Error('No repos found in bundle');

  // Read OVERVIEW.md
  const overview = await readUtf8OrNull(paths.overviewPath) || '';
  if (overview) evidence.push({ field: 'overview', sources: [{ path: 'OVERVIEW.md' }] });
  else warnings.push('facts_incomplete');

  // Read FACTS.json (contains architectureSummary in Phase 4)
  const factsStr = await readUtf8OrNull(path.join(paths.rootDir, 'analysis', 'FACTS.json'));
  let facts: Partial<BundleFacts> = {};
  if (factsStr) {
    try { facts = JSON.parse(factsStr); evidence.push({ field: 'facts', sources: [{ path: 'analysis/FACTS.json' }] }); }
    catch { warnings.push('facts_incomplete'); }
  } else warnings.push('facts_incomplete');

  // Extract architectureSummary from FACTS.json (not separate file)
  const arch = facts.architectureSummary as ArchitectureSummary | undefined;

  // README (track actual filename for evidence)
  const parts = effectiveRepoId.includes('/') ? effectiveRepoId.split('/') : ['', effectiveRepoId];
  const owner = parts[0] ?? '';
  const repo = parts[1] ?? effectiveRepoId;
  let readme = await readUtf8OrNull(path.join(paths.reposDir, owner, repo, 'norm', 'README.md'));
  let readmeFile = 'README.md';
  if (!readme) {
    readme = await readUtf8OrNull(path.join(paths.reposDir, owner, repo, 'norm', 'readme.md'));
    readmeFile = 'readme.md';
  }
  if (readme) evidence.push({ field: 'readme', sources: [{ path: `repos/${effectiveRepoId}/norm/${readmeFile}` }] });
  else warnings.push('missing_readme');

  // Serialize architectureSummary stats for LLM context (not the full object)
  const archSummaryStr = arch?.stats
    ? `Modules: ${arch.stats.totalModules}, Interfaces: ${arch.stats.totalInterfaces}, Core types: ${arch.stats.totalCoreTypes}, Public APIs: ${arch.stats.totalPublicAPIs}`
    : undefined;

  const truncated = truncateContext({
    overview,
    readme: readme || undefined,
    architectureSummary: archSummaryStr,
  });
  if (truncated.truncated) warnings.push('context_truncated');

  // Map entryPoints (objects) to file strings
  const entryPointFiles = facts.entryPoints?.map(ep => ep.file) || [];
  // Map coreTypes/publicAPI to name strings
  const coreTypeNames = arch?.coreTypes?.map(ct => ct.name) || [];
  const publicAPINames = arch?.publicAPI?.map(api => api.name) || [];

  return {
    context: {
      bundleId,
      repoId: effectiveRepoId,
      name: manifest.displayName || effectiveRepoId,
      language: facts.languages?.[0]?.language || manifest.primaryLanguage || 'Unknown',
      frameworks: facts.frameworks || [],
      overview: truncated.overview,
      architectureSummary: truncated.architectureSummary,
      designPatterns: facts.patterns,
      entryPoints: entryPointFiles.length > 0 ? entryPointFiles : undefined,
      coreTypes: coreTypeNames.length > 0 ? coreTypeNames : undefined,
      publicAPIs: publicAPINames.length > 0 ? publicAPINames : undefined,
      features: facts.features,
      tags: manifest.tags,
      readme: truncated.readme,
    },
    warnings,
    evidence,
  };
}

// ============================================================================
// Card Generation
// ============================================================================

const AUTO_FIELDS = ['oneLiner', 'problemSolved', 'useCases', 'designHighlights', 'limitations', 'quickStart', 'keyAPIs'] as const;

/** Map robustJsonParse method to GenerationMeta parseMethod */
function mapParseMethod(method: string): 'json' | 'regex' | 'fallback' {
  if (method === 'direct' || method === 'cleanup' || method === 'quote_fix') return 'json';
  if (method === 'regex_fallback') return 'regex';
  return 'fallback';
}

export async function generateCardWithLLM(
  ctx: BundleContext,
  existing?: RepoCard
): Promise<{ card: Partial<RepoCard>; parseMethod: string }> {
  const prompt = buildCardGenerationPrompt(ctx);
  const result = await callLLMWithJSON<LLMCardResponse>(prompt, CARD_GENERATION_SYSTEM_PROMPT);
  if (!result.data) throw new Error(result.error || 'LLM returned no data');

  const locked = new Set(existing?.lockedFields || []);
  const d = result.data;
  const card: Partial<RepoCard> = {};

  if (!locked.has('oneLiner')) card.oneLiner = d.oneLiner || 'Unknown';
  if (!locked.has('problemSolved')) card.problemSolved = d.problemSolved || 'Unknown';
  if (!locked.has('useCases')) card.useCases = d.useCases || [];
  if (!locked.has('designHighlights')) card.designHighlights = d.designHighlights || [];
  if (!locked.has('limitations')) card.limitations = d.limitations || [];
  if (!locked.has('quickStart')) card.quickStart = d.quickStart || 'See README';
  if (!locked.has('keyAPIs')) card.keyAPIs = d.keyAPIs || [];

  return { card, parseMethod: result.parseMethod };
}

export function generateCardFallback(ctx: BundleContext): { card: Partial<RepoCard>; needsReview: string[] } {
  const needsReview: string[] = ['useCases', 'limitations'];
  const lines = ctx.overview.split('\n').filter(l => l.trim() && !l.startsWith('#'));

  const oneLiner = lines.find(l => l.length > 20)?.slice(0, 200) || 'Unknown';
  const problemLine = lines.find(l => /solves?|resolves?|addresses?/i.test(l));
  const problemSolved = problemLine?.slice(0, 300) || 'Unknown';
  if (!problemLine) needsReview.push('problemSolved');

  const designHighlights = ctx.designPatterns?.slice(0, 5) || [];
  if (!designHighlights.length) needsReview.push('designHighlights');

  const keyAPIs = ctx.publicAPIs?.slice(0, 10) || [];
  if (!keyAPIs.length) needsReview.push('keyAPIs');

  return {
    card: {
      oneLiner,
      problemSolved,
      useCases: [],
      designHighlights,
      limitations: [],
      quickStart: ctx.readme?.includes('npm install') ? 'npm install && npm start' : 'See README',
      keyAPIs,
    },
    needsReview,
  };
}

// ============================================================================
// Storage
// ============================================================================

export async function saveRepoCard(bundleId: string, repoId: string, card: RepoCard): Promise<void> {
  const paths = await getBundlePaths2(bundleId);
  const cardPath = getCardPath(paths, repoId);
  await fs.mkdir(path.dirname(cardPath), { recursive: true });
  await fs.writeFile(cardPath, JSON.stringify(card, null, 2), 'utf8');
  logger.info(`Saved card: ${repoId}`);
}

export async function loadRepoCard(bundleId: string, repoId: string): Promise<RepoCard | null> {
  const paths = await getBundlePaths2(bundleId);
  try {
    return JSON.parse(await fs.readFile(getCardPath(paths, repoId), 'utf8')) as RepoCard;
  } catch {
    return null;
  }
}

/**
 * Merge LLM-generated keyAPIs with extracted features from directories.
 * LLM keyAPIs come first (preserving importance order), then additional features.
 */
function mergeKeyAPIsWithFeatures(keyAPIs: string[], features?: string[]): string[] {
  if (!features || features.length === 0) return keyAPIs;

  // Combine and deduplicate (case-insensitive), preserving LLM order for existing items
  const seen = new Set(keyAPIs.map((k) => k.toLowerCase()));
  const merged = [...keyAPIs];

  // Add features not already in keyAPIs (sorted for consistency)
  const additionalFeatures = features
    .filter((f) => !seen.has(f.toLowerCase()))
    .sort();

  return [...merged, ...additionalFeatures];
}

export function mergeCardUpdates(existing: RepoCard, updates: Partial<RepoCard>): RepoCard {
  const merged = { ...existing };
  const locked = new Set(existing.lockedFields || []);
  let hasChanges = false;

  for (const f of AUTO_FIELDS) {
    if (!locked.has(f) && updates[f] !== undefined) {
      const oldVal = JSON.stringify((existing as any)[f]);
      const newVal = JSON.stringify(updates[f]);
      if (oldVal !== newVal) {
        (merged as any)[f] = updates[f];
        hasChanges = true;
      }
    }
  }
  if (updates.whyIChoseIt !== undefined && updates.whyIChoseIt !== existing.whyIChoseIt) {
    merged.whyIChoseIt = updates.whyIChoseIt;
    hasChanges = true;
  }
  if (updates.personalNotes !== undefined && updates.personalNotes !== existing.personalNotes) {
    merged.personalNotes = updates.personalNotes;
    hasChanges = true;
  }
  if (updates.rating !== undefined && updates.rating !== existing.rating) {
    merged.rating = updates.rating;
    hasChanges = true;
  }

  if (hasChanges) {
    merged.version = existing.version + 1;
    merged.lastUpdatedAt = new Date().toISOString();
  }
  return merged;
}

// ============================================================================
// Export for RAG
// ============================================================================

export function exportCardForRAG(card: RepoCard): CardExport {
  const md = `# ${card.name}
${card.oneLiner}

## 解决的问题
${card.problemSolved}

## 使用场景
${card.useCases.map(u => `- ${u}`).join('\n') || '- 待补充'}

## 设计亮点
${card.designHighlights.map(d => `- ${d}`).join('\n') || '- 待补充'}

## 快速上手
${card.quickStart}

## 核心 API
${card.keyAPIs.map(a => `- ${a}`).join('\n') || '- 待补充'}

## 标签
${card.tags.join(', ')}
${card.whyIChoseIt ? `\n## 我为什么选它\n${card.whyIChoseIt}` : ''}`;

  const text = `${card.name}: ${card.oneLiner}
Problem: ${card.problemSolved}
Use cases: ${card.useCases.join('; ')}
Design: ${card.designHighlights.join('; ')}
Quick start: ${card.quickStart}
APIs: ${card.keyAPIs.join(', ')}
Tags: ${card.tags.join(', ')}`;

  return { json: card, markdown: md, text };
}

// ============================================================================
// Main Entry
// ============================================================================

export async function generateRepoCard(
  bundleId: string,
  repoId?: string,
  opts?: { regenerate?: boolean }
): Promise<GenerateCardResult> {
  const start = Date.now();
  const llmCfg = getLLMConfig();

  const { context, warnings, evidence } = await extractBundleContext(bundleId, repoId);
  const effectiveRepoId = context.repoId;

  // Return existing if not regenerating
  const existing = await loadRepoCard(bundleId, effectiveRepoId);
  if (existing && !opts?.regenerate) {
    const paths = await getBundlePaths2(bundleId);
    const fp = await computeFingerprint(paths);
    const existingWarnings = [...existing.warnings];
    if (existing.sourceFingerprint !== fp) existingWarnings.push('low_confidence');
    return { card: existing, llmUsed: false, warnings: existingWarnings, saved: false };
  }

  // Generate
  let partial: Partial<RepoCard>;
  let parseMethod: 'json' | 'regex' | 'fallback' = 'fallback';
  let needsReview: string[] = [];
  let generatedBy: 'llm' | 'fallback' = 'fallback';

  if (llmCfg.enabled) {
    try {
      const r = await generateCardWithLLM(context, existing || undefined);
      partial = r.card;
      parseMethod = mapParseMethod(r.parseMethod);
      generatedBy = 'llm';
    } catch (e) {
      logger.warn(`LLM failed: ${e instanceof Error ? e.message : e}`);
      warnings.push('llm_failed');
      warnings.push('parse_failed');
      const fb = generateCardFallback(context);
      partial = fb.card;
      needsReview = fb.needsReview;
    }
  } else {
    warnings.push('llm_disabled');
    const fb = generateCardFallback(context);
    partial = fb.card;
    needsReview = fb.needsReview;
  }

  // Build full card
  const base = existing ? mergeCardUpdates(existing, partial) : null;
  const paths = await getBundlePaths2(bundleId);
  const fp = await computeFingerprint(paths);

  const card: RepoCard = {
    schemaVersion: 1,
    cardId: generateCardId(bundleId, effectiveRepoId),
    bundleId,
    repoId: effectiveRepoId,
    version: base?.version ?? 1,
    generatedAt: new Date().toISOString(),
    generatedBy,
    generationMeta: {
      model: generatedBy === 'llm' ? llmCfg.model : undefined,
      parseMethod,
      durationMs: Date.now() - start,
    },
    sourceFingerprint: fp,
    name: context.name,
    language: context.language,
    frameworks: context.frameworks,
    oneLiner: base?.oneLiner ?? partial.oneLiner ?? 'Unknown',
    problemSolved: base?.problemSolved ?? partial.problemSolved ?? 'Unknown',
    useCases: base?.useCases ?? partial.useCases ?? [],
    designHighlights: base?.designHighlights ?? partial.designHighlights ?? [],
    limitations: base?.limitations ?? partial.limitations ?? [],
    quickStart: base?.quickStart ?? partial.quickStart ?? 'See README',
    keyAPIs: mergeKeyAPIsWithFeatures(base?.keyAPIs ?? partial.keyAPIs ?? [], context.features),
    whyIChoseIt: existing?.whyIChoseIt,
    personalNotes: existing?.personalNotes,
    rating: existing?.rating,
    tags: context.tags || [],
    relatedBundles: existing?.relatedBundles,
    confidence: generatedBy === 'llm' ? 0.8 : 0.5,
    evidence,
    needsReview,
    lockedFields: existing?.lockedFields ?? [],
    warnings,
    lastUpdatedBy: generatedBy,
    lastUpdatedAt: new Date().toISOString(),
  };

  await saveRepoCard(bundleId, effectiveRepoId, card);
  return { card, llmUsed: generatedBy === 'llm', warnings, saved: true };
}
