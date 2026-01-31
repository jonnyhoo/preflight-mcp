/**
 * Memory Module for 3-Layer LTM (Long-Term Memory) System.
 * 
 * Provides long-term memory storage with:
 * - L1: Episodic Memory (conversation fragments, events, summaries)
 * - L2: Semantic Memory (facts, entities, relations)
 * - L3: Procedural Memory (user preferences, habits, patterns)
 * 
 * Based on AgeMem (arXiv:2601.01885) research.
 * 
 * @module memory
 */

// ============================================================================
// Type Exports
// ============================================================================

export {
  // Constants
  SCHEMA_VERSION,
  MEMORY_COLLECTION_PREFIX,
  SIMILARITY_THRESHOLDS,
  CONFIDENCE_THRESHOLDS,
  PII_PATTERNS,
  MEMORY_LAYERS,

  // Layer types
  type MemoryLayer,
  type EpisodicType,
  type SemanticType,
  type ProceduralType,
  type MemoryStatus,
  type AbstractionLevel,

  // Memory interfaces
  type BaseMemory,
  type EpisodicMemory,
  type SemanticMemory,
  type ProceduralMemory,
  type Memory,

  // Metadata interfaces
  type EpisodicMetadata,
  type SemanticMetadata,
  type ProceduralMetadata,
  type MemoryMetadata,

  // Input types
  type AddEpisodicInput,
  type AddSemanticInput,
  type AddProceduralInput,
  type AddMemoryInput,

  // Search types
  type ScoreBreakdown,
  type MemorySearchResult,
  type SearchResult,
  type SearchFilters,
  type SearchOptions,

  // Stats types
  type HealthCheck,
  type EmbeddingInfo,
  type StatsResult,

  // List types
  type ListSortBy,
  type ListOrder,
  type ListOptions,
  type ListResult,

  // GC types
  type GCOptions,
  type GCResult,

  // Health meta types
  type MemoryHealthMeta,

  // Access buffer types
  type AccessDelta,

  // ChromaDB types
  type ChromaQueryResponse,
  type ChromaGetResponse,
  type ChromaCollection,

  // Utility functions
  normalize,
  generateMemoryId,
  joinArray,
  splitJoined,
  containsPII,
  calculateRecencyWeight,
  calculateFrequencyBoost,
  calculateFinalScore,
  getCollectionName,
} from './types.js';

// ============================================================================
// Store Exports
// ============================================================================

export {
  MemoryStore,
  type MemoryStoreConfig,
} from './memory-store.js';
