/**
 * Memory System Types for 3-Layer LTM (Long-Term Memory).
 * 
 * Based on AgeMem (arXiv:2601.01885) and "From Storage to Experience" research.
 * 
 * @module memory/types
 */

import crypto from 'node:crypto';

// ============================================================================
// Constants
// ============================================================================

/** Current schema version for memory metadata */
export const SCHEMA_VERSION = '1.0.0';

/** Collection name prefix for memory system */
export const MEMORY_COLLECTION_PREFIX = 'preflight_mem';

/** Similarity thresholds per layer */
export const SIMILARITY_THRESHOLDS = {
  episodic: 0.65,
  semantic: 0.70,
  procedural: 0.60,
} as const;

/** Confidence thresholds for write gates */
export const CONFIDENCE_THRESHOLDS = {
  semantic: 0.6,
  procedural: 0.8,
} as const;

/** PII/Secret detection patterns */
export const PII_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9]{32,}/,           // OpenAI API key
  /ghp_[a-zA-Z0-9]{36}/,           // GitHub token
  /-----BEGIN.*PRIVATE KEY-----/,  // Private key
  /[a-zA-Z0-9+/]{40,}={0,2}/,      // Base64 secrets (heuristic)
];

// ============================================================================
// Memory Layer Types
// ============================================================================

/** Memory layer enumeration */
export type MemoryLayer = 'episodic' | 'semantic' | 'procedural';

/** All memory layers */
export const MEMORY_LAYERS: MemoryLayer[] = ['episodic', 'semantic', 'procedural'];

/** Episodic memory types */
export type EpisodicType = 'conversation' | 'event' | 'summary';

/** Semantic memory types */
export type SemanticType = 'fact' | 'relation' | 'entity';

/** Procedural memory types */
export type ProceduralType = 'preference' | 'habit' | 'pattern';

/** Memory status */
export type MemoryStatus = 'active' | 'deprecated' | 'disputed';

/** Abstraction level for procedural memories */
export type AbstractionLevel = 'shallow' | 'intermediate' | 'deep';

// ============================================================================
// Base Memory Interface
// ============================================================================

/** Base memory document */
export interface BaseMemory {
  id: string;
  content: string;
  embedding?: number[];
  layer: MemoryLayer;
  createdAtMs: number;
  lastAccessedAtMs: number;
  accessCount: number;
  schemaVersion: string;
}

// ============================================================================
// L1: Episodic Memory (情景记忆)
// ============================================================================

export interface EpisodicMetadata {
  userId: string;
  sessionId: string;
  type: EpisodicType;
  participantsJoined?: string;  // Comma-separated
  tagsJoined?: string;          // Comma-separated
  embeddingModelId?: string;
}

export interface EpisodicMemory extends BaseMemory {
  layer: 'episodic';
  metadata: EpisodicMetadata;
}

// ============================================================================
// L2: Semantic Memory (语义记忆)
// ============================================================================

export interface SemanticMetadata {
  userId: string;
  type: SemanticType;
  subject?: string;
  predicate?: string;
  object?: string;
  confidence: number;
  sourceEpisodeIdsJoined?: string;  // Comma-separated
  status: MemoryStatus;
  embeddingModelId?: string;
}

export interface SemanticMemory extends BaseMemory {
  layer: 'semantic';
  metadata: SemanticMetadata;
}

// ============================================================================
// L3: Procedural Memory (程序记忆)
// ============================================================================

export interface ProceduralMetadata {
  userId: string;
  type: ProceduralType;
  category: string;
  strength: number;
  occurrenceCount: number;
  lastUpdatedAtMs: number;
  sourceMemoryIdsJoined?: string;  // Comma-separated
  abstractionLevel: AbstractionLevel;
  status: MemoryStatus;
  embeddingModelId?: string;
}

export interface ProceduralMemory extends BaseMemory {
  layer: 'procedural';
  metadata: ProceduralMetadata;
}

// ============================================================================
// Union Types
// ============================================================================

export type Memory = EpisodicMemory | SemanticMemory | ProceduralMemory;

export type MemoryMetadata = EpisodicMetadata | SemanticMetadata | ProceduralMetadata;

// ============================================================================
// Input Types (for add operations)
// ============================================================================

export interface AddEpisodicInput {
  content: string;
  sessionId?: string;
  type?: EpisodicType;
  participants?: string[];
  tags?: string[];
}

export interface AddSemanticInput {
  content: string;
  type: SemanticType;
  subject?: string;
  predicate?: string;
  object?: string;
  confidence: number;
  sourceEpisodeIds?: string[];
}

export interface AddProceduralInput {
  content: string;
  type: ProceduralType;
  category: string;
  strength?: number;
  occurrenceCount?: number;
  sourceMemoryIds?: string[];
  abstractionLevel?: AbstractionLevel;
}

export type AddMemoryInput = AddEpisodicInput | AddSemanticInput | AddProceduralInput;

// ============================================================================
// Search Types
// ============================================================================

export interface ScoreBreakdown {
  similarity: number;
  recency: number;
  frequency: number;
}

export interface MemorySearchResult {
  id: string;
  layer: MemoryLayer;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
  scoreBreakdown: ScoreBreakdown;
}

export interface SearchResult {
  memories: MemorySearchResult[];
  byLayer: {
    procedural: MemorySearchResult[];
    semantic: MemorySearchResult[];
    episodic: MemorySearchResult[];
  };
  totalFound: number;
  coldStart: boolean;
  suggestion?: string;
  _conflictWarning?: string;
  conflictingIds?: string[];
}

export interface SearchFilters {
  type?: string;
  category?: string;
  subject?: string;
  status?: MemoryStatus;
  timeRangeMs?: {
    startMs?: number;
    endMs?: number;
  };
}

export interface SearchOptions {
  query: string;
  layers?: MemoryLayer[];
  topK?: number;
  limit?: number;
  offset?: number;
  filters?: SearchFilters;
}

// ============================================================================
// Stats Types
// ============================================================================

export interface HealthCheck {
  lastReflectAtMs: number | null;
  episodicSinceReflect: number;
  shouldReflect: boolean;
  oldestUnreflectedAtMs: number | null;
}

export interface EmbeddingInfo {
  currentModelId: string;
  mixedModelsWarning?: string;
}

export interface StatsResult {
  effectiveUserId: string;
  episodicCount: number;
  semanticCount: number;
  proceduralCount: number;
  healthCheck: HealthCheck;
  embeddingInfo: EmbeddingInfo;
}

// ============================================================================
// List Types
// ============================================================================

export type ListSortBy = 'createdAt' | 'lastAccessed' | 'accessCount';

export type ListOrder = 'asc' | 'desc';

export interface ListOptions {
  layer?: MemoryLayer;
  limit?: number;
  offset?: number;
  sortBy?: ListSortBy;
  order?: ListOrder;
}

export interface ListResult {
  memories: Memory[];
  total: number;
  hasMore: boolean;
}

// ============================================================================
// GC (Garbage Collection) Types
// ============================================================================

export interface GCOptions {
  layers?: MemoryLayer[];
  maxAgeDays?: number;
  minAccessCount?: number;
  dryRun?: boolean;
}

export interface GCResult {
  deletedCount: number;
  deletedByLayer: Record<MemoryLayer, number>;
  _dangerWarning?: string;
}

// ============================================================================
// Health Meta Types (persisted to file)
// ============================================================================

export interface MemoryHealthMeta {
  lastReflectAtMs: number | null;
  episodicCountAtReflect: number;
  schemaVersion: string;
}

// ============================================================================
// Access Count Buffer Types
// ============================================================================

export interface AccessDelta {
  accessDelta: number;
  lastAccessedAtMs: number;
}

// ============================================================================
// ChromaDB Response Types
// ============================================================================

export interface ChromaQueryResponse {
  ids: string[][];
  embeddings?: number[][][];
  documents?: (string | null)[][];
  metadatas?: (Record<string, unknown> | null)[][];
  distances?: number[][];
}

export interface ChromaGetResponse {
  ids: string[];
  embeddings?: number[][];
  documents?: (string | null)[];
  metadatas?: (Record<string, unknown> | null)[];
}

export interface ChromaCollection {
  name: string;
  id: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Normalize text for ID generation.
 * - Trims whitespace
 * - Converts to lowercase
 * - Collapses whitespace
 * - Keeps only alphanumeric, Chinese characters, and spaces
 */
export function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fa5 ]/g, '');
}

/**
 * Generate memory ID based on layer and content.
 * 
 * ID generation rules:
 * - Episodic: hash(userId + sessionId + createdAtMs + contentHash)
 * - Semantic relation: hash(userId + 'relation' + normalized(subject, predicate, object))
 * - Semantic entity: hash(userId + 'entity' + normalized(subject))
 * - Semantic fact: hash(userId + 'fact' + normalized(content))
 * - Procedural: hash(userId + category + normalized(content))
 */
export function generateMemoryId(
  layer: MemoryLayer,
  userId: string,
  content: string,
  options?: {
    sessionId?: string;
    createdAtMs?: number;
    type?: string;
    subject?: string;
    predicate?: string;
    object?: string;
    category?: string;
  }
): string {
  const prefix = `mem_${layer.slice(0, 3)}_`;
  let hashInput: string;

  switch (layer) {
    case 'episodic': {
      const sessionId = options?.sessionId ?? 'default';
      const createdAtMs = options?.createdAtMs ?? Date.now();
      const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
      hashInput = `${userId}${sessionId}${createdAtMs}${contentHash}`;
      break;
    }
    case 'semantic': {
      const type = options?.type ?? 'fact';
      if (type === 'relation' && options?.subject && options?.predicate && options?.object) {
        hashInput = `${userId}relation${normalize(options.subject)}${normalize(options.predicate)}${normalize(options.object)}`;
      } else if (type === 'entity' && options?.subject) {
        hashInput = `${userId}entity${normalize(options.subject)}`;
      } else {
        hashInput = `${userId}fact${normalize(content)}`;
      }
      break;
    }
    case 'procedural': {
      const category = options?.category ?? 'general';
      hashInput = `${userId}${category}${normalize(content)}`;
      break;
    }
  }

  const hash = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 16);
  return `${prefix}${hash}`;
}

/**
 * Join array to comma-separated string for ChromaDB metadata.
 */
export function joinArray(arr?: string[]): string | undefined {
  if (!arr || arr.length === 0) return undefined;
  return arr.join(',');
}

/**
 * Split comma-separated string back to array.
 */
export function splitJoined(joined?: string): string[] {
  if (!joined) return [];
  return joined.split(',').filter(Boolean);
}

/**
 * Check if content contains PII or secrets.
 */
export function containsPII(content: string): boolean {
  return PII_PATTERNS.some(pattern => pattern.test(content));
}

/**
 * Calculate time decay weight using Ebbinghaus forgetting curve variant.
 * recency_weight = Math.exp(-0.1 * days_since_last_access)
 */
export function calculateRecencyWeight(lastAccessedAtMs: number): number {
  const daysSinceAccess = (Date.now() - lastAccessedAtMs) / (1000 * 60 * 60 * 24);
  return Math.exp(-0.1 * daysSinceAccess);
}

/**
 * Calculate frequency boost.
 * frequency_boost = 1 + Math.log(1 + accessCount) * 0.2
 */
export function calculateFrequencyBoost(accessCount: number): number {
  return 1 + Math.log(1 + accessCount) * 0.2;
}

/**
 * Calculate final score with time decay and frequency boost.
 * score_final = sim_score * recency_weight * frequency_boost
 */
export function calculateFinalScore(
  similarity: number,
  lastAccessedAtMs: number,
  accessCount: number
): { score: number; breakdown: ScoreBreakdown } {
  const recency = calculateRecencyWeight(lastAccessedAtMs);
  const frequency = calculateFrequencyBoost(accessCount);
  const score = similarity * recency * frequency;
  
  return {
    score,
    breakdown: {
      similarity,
      recency,
      frequency,
    },
  };
}

/**
 * Get collection name for a memory layer.
 */
export function getCollectionName(layer: MemoryLayer): string {
  return `${MEMORY_COLLECTION_PREFIX}_${layer}`;
}
