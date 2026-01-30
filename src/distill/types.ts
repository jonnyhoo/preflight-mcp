/**
 * Types for Repo Card Distillation.
 * @module distill/types
 */

// ============================================================================
// Types
// ============================================================================

export interface FieldEvidence {
  field: string;
  sources: Array<{ path: string; lineRange?: string }>;
}

export interface GenerationMeta {
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  parseMethod: 'json' | 'regex' | 'fallback';
  durationMs: number;
}

export type CardWarning =
  | 'missing_readme'
  | 'facts_incomplete'
  | 'llm_disabled'
  | 'llm_failed'
  | 'parse_failed'
  | 'context_truncated'
  | 'low_confidence';

// ============================================================================
// RepoCard
// ============================================================================

/** Knowledge card for a code repository. */
export interface RepoCard {
  schemaVersion: 1;
  cardId: string;          // sha256(bundleId+repoId)
  bundleId: string;
  repoId: string;          // owner/repo format (use toSafeRepoId for paths)
  version: number;
  generatedAt: string;
  generatedBy: 'llm' | 'fallback' | 'manual';
  generationMeta?: GenerationMeta;
  sourceFingerprint?: string;

  // Basic info
  name: string;
  language: string;
  frameworks: string[];

  // Core descriptions (LLM generated)
  oneLiner: string;
  problemSolved: string;
  useCases: string[];
  designHighlights: string[];
  limitations: string[];
  quickStart: string;
  keyAPIs: string[];

  // Personal (manual only)
  whyIChoseIt?: string;
  personalNotes?: string;
  rating?: 1 | 2 | 3 | 4 | 5;

  // Tags
  tags: string[];
  relatedBundles?: string[];

  // Universal metadata (rule-extracted)
  arxivId?: string;
  doi?: string;
  githubUrl?: string;
  license?: string;
  authors?: string[];

  // Quality
  confidence: number;
  evidence: FieldEvidence[];
  needsReview: string[];
  lockedFields: string[];
  warnings: CardWarning[];
  lastUpdatedBy?: 'llm' | 'manual' | 'fallback';
  lastUpdatedAt?: string;
}

// ============================================================================
// BundleContext
// ============================================================================

export interface BundleContext {
  bundleId: string;
  repoId: string;
  name: string;
  language: string;
  frameworks: string[];
  overview: string;
  architectureSummary?: string;
  designPatterns?: string[];
  entryPoints?: string[];
  coreTypes?: string[];
  publicAPIs?: string[];
  features?: Array<{ name: string; desc?: string }>; // Extracted from skills/, commands/, plugins/ directories
  tags?: string[];
  readme?: string;
}

// ============================================================================
// Utilities
// ============================================================================

export function toSafeRepoId(repoId: string): string {
  return repoId.replace(/\//g, '~');
}

export function fromSafeRepoId(safeRepoId: string): string {
  return safeRepoId.replace(/~/g, '/');
}

// ============================================================================
// LLM & Results
// ============================================================================

export interface LLMCardResponse {
  oneLiner?: string;
  problemSolved?: string;
  useCases?: string[];
  designHighlights?: string[];
  limitations?: string[];
  quickStart?: string;
  keyAPIs?: string[];
}

export interface CardExport {
  json: RepoCard;
  markdown: string;
  text: string;
}

export interface GenerateCardResult {
  card: RepoCard;
  llmUsed: boolean;
  warnings: CardWarning[];
  saved: boolean;
}
