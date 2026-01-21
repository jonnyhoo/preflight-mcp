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

  // Read sources
  const overview = await readUtf8OrNull(paths.overviewPath) || '';
  if (overview) evidence.push({ field: 'overview', sources: [{ path: 'OVERVIEW.md' }] });
  else warnings.push('facts_incomplete');

  const factsStr = await readUtf8OrNull(path.join(paths.rootDir, 'analysis', 'FACTS.json'));
  let facts: Record<string, unknown> = {};
  if (factsStr) {
    try { facts = JSON.parse(factsStr); evidence.push({ field: 'facts', sources: [{ path: 'analysis/FACTS.json' }] }); }
    catch { warnings.push('facts_incomplete'); }
  } else warnings.push('facts_incomplete');

  const archStr = await readUtf8OrNull(path.join(paths.rootDir, 'analysis', 'architecture-summary.json'));
  let arch: Record<string, unknown> = {};
  if (archStr) try { arch = JSON.parse(archStr); } catch { /* ignore */ }

  // README
  const parts = effectiveRepoId.includes('/') ? effectiveRepoId.split('/') : ['', effectiveRepoId];
  const owner = parts[0] ?? '';
  const repo = parts[1] ?? effectiveRepoId;
  let readme = await readUtf8OrNull(path.join(paths.reposDir, owner, repo, 'norm', 'README.md'));
  if (!readme) readme = await readUtf8OrNull(path.join(paths.reposDir, owner, repo, 'norm', 'readme.md'));
  if (readme) evidence.push({ field: 'readme', sources: [{ path: `repos/${effectiveRepoId}/norm/README.md` }] });
  else warnings.push('missing_readme');

  const truncated = truncateContext({
    overview,
    readme: readme || undefined,
    architectureSummary: arch?.architectureSummary as string | undefined,
  });
  if (truncated.truncated) warnings.push('context_truncated');

  return {
    context: {
      bundleId,
      repoId: effectiveRepoId,
      name: manifest.displayName || effectiveRepoId,
      language: manifest.primaryLanguage || (facts.primaryLanguage as string) || 'Unknown',
      frameworks: (facts.frameworks as string[]) || [],
      overview: truncated.overview,
      architectureSummary: truncated.architectureSummary,
      designPatterns: (facts.patterns as string[]) || (arch?.designPatterns as string[]),
      entryPoints: facts.entryPoints as string[] | undefined,
      coreTypes: arch?.coreTypes as string[] | undefined,
      publicAPIs: arch?.publicAPIs as string[] | undefined,
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

export function mergeCardUpdates(existing: RepoCard, updates: Partial<RepoCard>): RepoCard {
  const merged = { ...existing };
  const locked = new Set(existing.lockedFields || []);

  for (const f of AUTO_FIELDS) {
    if (!locked.has(f) && updates[f] !== undefined) (merged as any)[f] = updates[f];
  }
  if (updates.whyIChoseIt !== undefined) merged.whyIChoseIt = updates.whyIChoseIt;
  if (updates.personalNotes !== undefined) merged.personalNotes = updates.personalNotes;
  if (updates.rating !== undefined) merged.rating = updates.rating;

  merged.version = existing.version + 1;
  merged.lastUpdatedAt = new Date().toISOString();
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
    if (existing.sourceFingerprint !== fp) warnings.push('low_confidence');
    return { card: existing, llmUsed: false, warnings: existing.warnings, saved: false };
  }

  // Generate
  let partial: Partial<RepoCard>;
  let parseMethod = 'fallback';
  let needsReview: string[] = [];
  let generatedBy: 'llm' | 'fallback' = 'fallback';

  if (llmCfg.enabled) {
    try {
      const r = await generateCardWithLLM(context, existing || undefined);
      partial = r.card;
      parseMethod = r.parseMethod;
      generatedBy = 'llm';
    } catch (e) {
      logger.warn(`LLM failed: ${e instanceof Error ? e.message : e}`);
      warnings.push('llm_failed');
      const fb = generateCardFallback(context);
      partial = fb.card;
      needsReview = fb.needsReview;
      warnings.push('llm_disabled');
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
      model: llmCfg.model,
      parseMethod: parseMethod as 'json' | 'regex' | 'fallback',
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
    keyAPIs: base?.keyAPIs ?? partial.keyAPIs ?? [],
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
    lastUpdatedBy: generatedBy === 'llm' ? 'llm' : undefined,
    lastUpdatedAt: new Date().toISOString(),
  };

  await saveRepoCard(bundleId, effectiveRepoId, card);
  return { card, llmUsed: generatedBy === 'llm', warnings, saved: true };
}
