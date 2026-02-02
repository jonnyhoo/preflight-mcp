---
stage: 1
depends_on: []
files_modified:
  - src/graph/types.ts
  - src/graph/index.ts
autonomous: true
---

# Plan: GraphAnchor Types and Interfaces

## Goal
Define core type definitions for Entity, Triple, KnowledgeGraph, and IterativeRetrieval options that will be used across all graph modules.

## Tasks

<task id="1" name="Create graph module directory and types file">
Create `src/graph/types.ts` with all core interfaces.

```typescript
// src/graph/types.ts

/**
 * GraphAnchor Types - Knowledge Graph for RAG enhancement.
 * Based on GraphAnchor paper iterative retrieval approach.
 * @module graph/types
 */

// ============================================================================
// Entity Types
// ============================================================================

/**
 * Entity in the knowledge graph.
 * Represents a concept, term, or named entity extracted from documents.
 */
export interface Entity {
  /** Unique identifier (UUID) */
  id: string;
  /** Original entity name as extracted */
  name: string;
  /** Normalized name for matching (lowercase + punctuation removed) */
  normalizedName: string;
  /** Entity type/category (e.g., 'CONCEPT', 'METHOD', 'METRIC', 'PERSON') */
  entityType?: string;
  /** Descriptive attributes extracted from context */
  attributes: string[];
  /** Optional embedding vector for similarity matching */
  embedding?: number[];
  /** Source chunk IDs where this entity was mentioned */
  sourceChunkIds: string[];
  /** Confidence score from extraction (0-1) */
  confidence?: number;
  /** Creation timestamp */
  createdAt?: number;
}

// ============================================================================
// Triple Types
// ============================================================================

/**
 * Relation type between entities.
 */
export type RelationType = 
  | 'is_a'           // Taxonomy: X is a type of Y
  | 'part_of'        // Composition: X is part of Y
  | 'has_property'   // Attribute: X has property Y
  | 'uses'           // Usage: X uses Y
  | 'produces'       // Output: X produces Y
  | 'related_to'     // General relation
  | 'compared_to'    // Comparison: X compared to Y
  | 'improves'       // Enhancement: X improves Y
  | 'extends'        // Extension: X extends Y
  | 'implements'     // Implementati X implements Y
  | string;          // Custom relations

/**
 * Triple representing a relation between two entities.
 * Format: (head, relation, tail)
 */
export interface Triple {
  /** Head entity ID */
  head: string;
  /** Relation type */
  relation: RelationType;
  /** Tail entity ID */
  tail: string;
  /** Source chunk ID where this relation was extracted */
  sourceChunkId: string;
  /** Confidence score from extraction (0-1) */
  confidence?: number;
  /** Optional context snippet supporting this triple */
  evidence?: string;
}

// ============================================================================
// Knowledge Graph Interface
// ============================================================================

/**
 * Knowledge Graph for storing and querying entities and relations.
 */
export interface KnowledgeGraph {
  /** Entity storage by ID */
  entities: Map<string, Entity>;
  /** All triples in the graph */
  triples: Triple[];
  
  /**
   * Add an entity to the graph.
   * @returns Entity ID (existing or new)
   */
  addEntity(entity: Omit<Entity, 'id'>): string;
  
  /**
   * Add a triple to the graph.
   */
  addTriple(triple: Triple): void;
  
  /**
   * Link a mention to an existing entity or create new.
   * Uses name normalization and optional embedding similarity.
   * @param name - Entity name to link
   * @param embedding - Optional embedding for similarity matching
   * @returns Linked or new entity
   */
  linkEntity(name: string, embedding?: number[]): Entity;
  
  /**
   * Get neighboring entities (1-hop).
   * @param entityId - Center entity ID
   * @returns Array of neighboring entities
   */
  getNeighbors(entityId: string): Entity[];
  
  /**
   * Get entities within N hops.
   * @param entityId - Center entity ID
   * @param maxHops - Maximum hop distance (default: 2)
   * @returns Array of reachable entities with hop distance
   */
  getNeighborsWithinHops(entityId: string, maxHops?: number): Array<Entity & { hopDistance: number }>;
  
  /**
   * Linearize graph to text for LLM consumption.
   * @param maxEntities - Max entities to include
   * @param maxTriples - Max triples to include
   * @returns Formatted text representation
   */
  linearize(maxEntities?: number, maxTriples?: number): string;
  
  /**
   * Get entity by ID.
   */
  getEntity(id: string): Entity | undefined;
  
  /**
   * Get entity by normalized name.
   */
  getEntityByName(name: string): Entity | undefined;
  
  /**
   * Get all triples involving an entity.
   */
  getTriplesForEntity(entityId: string): Triple[];
  
  /**
   * Get graph statistics.
   */
  getStats(): GraphStats;
}

/**
 * Graph statistics.
 */
export interface GraphStats {
  e number;
  tripleCount: number;
  avgDegree: number;
  connectedComponents: number;
}

// ============================================================================
// Iterative Retrieval Types
// ============================================================================

/**
 * Options for iterative graph-enhanced retrieval.
 */
export interface IterativeRetrievalOptions {
  /** Maximum iterations (default: 3) */
  maxIterations: number;
  /** Sufficiency threshold to stop early (default: 0.8) */
  sufficiencyThreshold: number;
  /** Enable graph-based retrieval (default: true) */
  enableGraph: boolean;
  /** Max entities to include in LLM prompt (default: 50) */
  maxEntitiesInPrompt: number;
  /** Max triples to include in LLM prompt (default: 80) */
  maxTriplesInPrompt: number;
  /** Enable sub-query generation (default: true) */
  enableSubQueries: boolean;
  /** Max sub-queries per iteration (default: 3) */
  maxSubQueries: number;
}

/**
 * Default iterative retrieval options.
 */
export const DEFAULT_ITERATIVE_OPTIONS: IterativeRetrievalOptions = {
  maxIterations: 3,
  sufficiencyThreshold: 0.8,
  enableGraph: true,
  maxEntitiesInPrompt: 50,
  maxTriplesInPrompt: 80,
  enableSubQueries: true,
  maxSubQueries: 3,
};

// ============================================================================
// Extraction Types
// ============================================================================

/**
 * Result of entity/triple extraction from a chunk.
 */
export interface ExtractionResult {
  /** Extracted entities */
  entities: Array<Omit<Entity, 'id'>>;
  /** Extracted triples (using entity names, not IDs) */
  triples: Array<{
    headName: string;
    relation: RelationType;
    tailName: string;
    confidence?: number;
    evidence?: string;
  }>;
  /** Source chunk ID */
  sourceChunkId: string;
}

/**
 * Options for entity extraction.
 */
export interface ExtractionOptions {
  /** Max entities to extract per chunk (default: 10) */
  maxEntitiesPerChunk?: number;
  /** Max triples to extract per chunk (default: 15) */
  maxTriplesPerChunk?: number;
  /** Minimum confidence threshold (default: 0.5) */
  minConfidence?: number;
  /** Entity types to focus on (optional filter) */
  entityTypes?: string[];
}

/**
 * Default extraction options.
 */
export const DEFAULT_EXTRACTION_OPTIONS: Required<ExtractionOptions> = {
  maxEntitiesPerChunk: 10,
  maxTriplesPerChunk: 15,
  minConfidence: 0.5,
  entityTypes: [],
};

// ============================================================================
// Reasoning Types
// ============================================================================

/**
 * Result of LLM reasoning step.
 */
export interface ReasoningResult {
  /** Current reasoning/analysis */
  reasoning: string;
  /** Generated sub-query for next iteration (if needed) */
  subQuery?: string;
  /** Whether current context is sufficient to answer */
  isSufficient: boolean;
  /** Confidence in sufficiency assessment (0-1) */
  sufficiencyScore: number;
  /** Key entities identified as relevant */
  relevantEntities: string[];
}

// ============================================================================
// Graph Update Types
// ============================================================================

/**
 * Result of graph update operation.
 */
export interface GraphUpdateResult {
  /** Number of new entities added */
  entitiesAdded: number;
  /** Number of entities merged (linked to existing) */
  entitiesMerged: number;
  /** Number of new triples added */
  triplesAdded: number;
  /** Number of duplicate triples skipped */
  triplesSkipped: number;
  /** Processing duration in ms */
  durationMs: number;
}

// ============================================================================
// Serialization Types
// ============================================================================

/**
 * Serialized graph format for persistence.
 */
export interface SerializedGraph {
  version: string;
  entities: Entity[];
  triples: Triple[];
  metadata: {
    createdAt: number;
    updatedAt: number;
    sourceBundle?: string;
  };
}
```

<verify>
- File exists at src/graph/types.ts
- All interfaces compile without TypeScript errors
- Entity, Triple, KnowledgeGraph interfaces match roadmap spec
- IterativeRetrievalOptions has all required fields with defaults
</verify>
</task>

<task id="2" name="Create graph module index file" depends_on="1">
Create `src/graph/index.ts` to export all types and future implementations.

```typescript
// src/graph/index.ts

/**
 * GraphAnchor - Knowledge Graph for RAG enhancement.
 * @module graph
 */

// Types
export type {
  Entity,
  Triple,
  RelationType,
  KnowledgeGraph,
  GraphStats,
  IterativeRetrievalOptions,
  ExtractionResult,
  ExtractionOptions,
  ReasoningResult,
  GraphUpdateResult,
  SerializedGraph,
} from './types.js';

export {
  DEFAULT_ITERATIVE_OPTIONS,
  DEFAULT_EXTRACTION_OPTIONS,
} from './types.js';

// Implementations will be added in subsequent plans:
// - KnowledgeGraphImpl from './knowledge-graph.js'
// - EntityExtractor from './entity-extractor.js'
// - GraphUpdater from './graph-updater.js'
// - IterativeRetriever from './iterative-retriever.js'
// - GraphSerializer from './graph-serializer.js'
```

<verify>
- File exists at src/graph/index.ts
- All exports resolve correctly
- No circular dependency issues
</verify>
</task>

<task id="3" name="Add utility functions for entity normalization" depends_on="1">
Add entity name normalization utilities to types.ts.

```typescript
// Add to src/graph/types.ts

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Normalize entity name for matching.
 * - Convert to lowercase
 * - Remove punctuation
 * - Collapse whitespace
 * 
 * @param name - Original entity name
 * @returns Normalized name
 */
export function normalizeEntityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ')    // Collapse whitespace
    .trim();
}

/**
 * Generate a unique entity ID.
 * Uses crypto.randomUUID if available, fallback to timestamp-based.
 */
export function generateEntityId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return `entity-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Calculate cosine similarity between two vectors.
 * Used for entity linking via embedding similarity.
 * 
 * @param a - First vector
 * @param b - Second vector
 * @returns Cosine similarity (0-1)
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Entity linking similarity threshold.
 * Entities with embedding similarity >= this threshold are considered the same.
 */
export const ENTITY_LINK_THRESHOLD = 0.88;
```

<verify>
- normalizeEntityName('Hello, World!') returns 'hello world'
- normalizeEntityName('GPT-4') returns 'gpt4'
- cosineSimilarity([1,0], [1,0]) returns 1
- cosineSimilarity([1,0], [0,1]) returns 0
- ENTITY_LINK_THRESHOLD equals 0.88
</verify>
</task>

## Acceptance Criteria

Goal: Define all type interfaces for GraphAnchor knowledge graph system

- [ ] Entity interface has: id, name, normalizedName, attributes, embedding?, sourceChunkIds
- [ ] Triple interface has: head, relation, tail, sourceChunkId
- [ ] KnowledgeGraph interface has all required methods: addEntity, addTriple, linkEntity, getNeighbors, linearize
- [ ] IterativeRetrievalOptions has: maxIterations (default 3), sufficiencyThreshold (default 0.8), enableGraph (default true), maxEntitiesInPrompt (default 50), maxTriplesInPrompt (default 80)
- [ ] normalizeEntityName utility correctly normalizes names
- [ ] ENTITY_LINK_THRESHOLD is 0.88
- [ ] All types compile without errors
- [ ] Module exports are properly configured
