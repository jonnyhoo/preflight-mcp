---
stage: 2
depends_on:
  - 03-01-types-and-interfaces-PLAN.md
  - 03-02-knowledge-graph-impl-PLAN.md
  - 03-03-entity-extractor-PLAN.md
files_modified:
  - src/graph/graph-updater.ts
autonomous: true
---

# Plan: Graph Updater Implementation

## Goal
Implement incremental graph update logic that merges extraction results into the knowledge graph, handling entity linking and deduplication.

## Tasks

<task id="1" name="Create GraphUpdater class">
Create `src/graph/graph-updater.ts` with incremental update logic.

```typescript
// src/graph/graph-updater.ts

/**
 * Graph Updater - Incremental knowledge graph updates.
 * Merges extraction results into existing graph with entity linking.
 * @module graph/graph-updater
 */

import {
  type KnowledgeGraph,
  type Entity,
  type Triple,
  type ExtractionResult,
  type GraphUpdateResult,
  normalizeEntityName,
  cosineSimilarity,
  ENTITY_LINK_THRESHOLD,
} from './types.js';
import type { RAGConfig } from '../rag/types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('graph-updater');

// ============================================================================
// Update Options
// ============================================================================

/**
 * Options for graph updates.
 */
export interface GraphUpdateOptions {
  /** Enable embedding-based entity linking (default: true) */
  enableEmbeddingLink?: boolean;
  /** Similarity threshold for entity linking (default: 0.88) */
  linkThreshold?: number;
  /** Merge attributes from new entities into existing (default: true) */
  mergeAttributes?: boolean;
  /** Update confidence scores (use max of existing and new) (default: true) */
  updateConfidence?: boolean;
}

const DEFAULT_UPDATE_OPTIONS: Required<GraphUpdateOptions> = {
  enableEmbeddingLink: true,
  linkThreshold: ENTITY_LINK_THRESHOLD,
  mergeAttributes: true,
  updateConfidence: true,
};

// ============================================================================
// GraphUpdater Class
// ============================================================================

/**
 * Incremental graph updater.
 * Handles entity linking and deduplication when adding new extractions.
 */
export class GraphUpdater {
  private graph: KnowledgeGraph;
  private embedding?: RAGConfig['embedding'];
  private options: Required<GraphUpdateOptions>;
  
  /** Cache: entity name -> embedding for linking */
  private embeddingCache: Map<string, number[]> = new Map();

  constructor(
    graph: KnowledgeGraph,
    embedding?: RAGConfig['embedding'],
    options?: GraphUpdateOptions
  ) {
    this.graph = graph;
    this.embedding = embedding;
    this.options = { ...DEFAULT_UPDATE_OPTIONS, ...options };
  }

  // --------------------------------------------------------------------------
  // Main Update Method
  // --------------------------------------------------------------------------

  /**
   * Update graph with extraction results.
   * Performs entity linking and adds new entities/triples.
   * 
   * @param extraction - Extraction result from EntityExtractor
   * @returns Update statistics
   */
  async update(extraction: ExtractionResult): Promise<GraphUpdateResult> {
    const startTime = Date.now();
    let entitiesAdded = 0;
    let entitiesMerged = 0;
    let triplesAdded = 0;
    let triplesSkipped = 0;

    // Map: extracted entity name -> graph entity ID
    const entityIdMap = new Map<string, string>();

    // Step 1: Process entities (link or add)
    for (const entityData of extraction.entities) {
      const result = await this.processEntity(entityData);
      entityIdMap.set(entityData.name, result.entityId);
      
      if (result.isNew) {
        entitiesAdded++;
      } else {
        entitiesMerged++;
      }
    }

    // Step 2: Process triples
    for (const tripleData of extraction.triples) {
      const headId = entityIdMap.get(tripleData.headName) || 
                     this.findEntityId(tta.headName);
      const tailId = entityIdMap.get(tripleData.tailName) ||
                     this.findEntityId(tripleData.tailName);

      if (!headId || !tailId) {
        logger.debug(
          `Skipping triple: missing entity (head: ${tripleData.headName}, tail: ${tripleData.tailName})`
        );
        triplesSkipped++;
        continue;
      }

      // Check for duplicate triple
      const existingTriples = this.graph.getTriplesForEntity(headId);
      const isDuplicate = existingTriples.some(
        t => t.head === headId && 
             t.relation === tripleData.relation && 
             t.tail === tailId
      );

      if (isDuplicate) {
        triplesSkipped++;
        continue;
      }

      // Add triple
      const triple: Triple = {
        head: headId,
        relation: tripleData.relation,
        tail: tailId,
        sourceChunkId: extraction.sourceChunkId,
        confidence: tripleData.confidence,
        evidence: tripleData.evidence,
      };

      this.graph.addTriple(triple);
      triplesAdded++;
    }

    const durationMs = Date.now() - startTime;
    
    logger.info(
      `Graph update: +${entitiesAdded} entities, ~${entitiesMerged} merged, ` +
      `+${triplesAdded} triples, ${triplesSkipped} skipped (${durationMs}ms)`
    );

    return {
      entitiesAdded,
      entitiesMerged,
      triplesAdded,
      triplesSkipped,
      durationMs,
    };
  }

  /**
   * Update graph with multiple extraction results.
   * 
   * @param extractions - Array of extraction results
   * @returns Aggregated update statistics
   */
  async updateBatch(extractions: ExtractionResult[]): Promise<GraphUpdateResult> {
    const startTime = Date.now();
    let totalEntitiesAdded = 0;
    let totalEntitiesMerged = 0;
    let totalTriplesAdded = 0;
    let totalTriplesSkipped = 0;

    for (const extraction of extractions) {
      const result = await this.update(extraction);
      totalEntitiesAdded += result.entitiesAdded;
      totalEntitiesMerged += result.entitiesMerged;
      totalTriplesAdded += result.triplesAdded;
      totalTriplesSkipped += result.triplesSkipped;
    }

    return {
      entitiesAdded: totalEntitiesAdded,
      entitiesMerged: totalEntitiesMerged,
      triplesAdded: totalTriplesAdded,
      triplesSkipped: totalTriplesSkipped,
      durationMs: Date.now() - startTime,
    };
  }

  // --------------------------------------------------------------------------
  // Entity Processing
  // --------------------------------------------------------------------------

  private async processEntity(
    entityData: Omit<Entity, 'id'>
  ): Promise<{ entityId: string; isNew: boolean }> {
    const normalizedName = normalizeEntityName(entityData.name);

    // 1. Try exact name match
    const existingByName = this.graph.getEntityByName(entityData.name);
    if (existingByName) {
      this.mergeEntityData(existingByName, entityData);
      return { entityId: existingByName.id, isNew: false };
    }

    // 2. Try embedding-based linking
    if (this.options.enableEmbeddingLink && this.embedding) {
      const linkedEntity = await this.tryEmbeddingLink(entityData);
      if (linkedEntity) {
        this.mergeEntityData(linkedEntity, entityData);
        return { entityId: linkedEntity.id, isNew: false };
      }
    }

    // 3. Create new entity
    const entityId = this.graph.addEntity(entityData);
    
    // Cache embedding for future linking
    if (entityData.embedding) {
      this.embeddingCache.set(normalizedName, entityData.embedding);
    }

    return { entityId, isNew: true };
  }

  private async tryEmbeddingLink(
    entityData: Omit<Entity, 'id'>
  ): Promise<Entity | null> {
    // Get or compute embedding for new entity
    let newEmbedding = entityData.embedding;
    
    if (!newEmbedding && this.embedding) {
      try {
        const result = await this.embedding.embed(entityData.name);
        newEmbedding = result.vector;
        // Store in entity data for later use
        (entityData as any).embedding = newEmbedding;
      } catch (err) {
        logger.warn(`Failed to embed entity "${entityData.name}": ${err}`);
        return null;
      }
    }

    if (!newEmbedding) return null;

    // Find best matching entity by embedding similarity
    let bestMatch: Entity | null = null;
    let bestSimilarity = 0;

    for (const entity of this.graph.entities.values()) {
      if (!entity.embedding) continue;
      
      const similarity = cosineSimilarity(newEmbedding, entity.embedding);
      if (similarity >= this.options.linkThreshold && similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = entity;
      }
    }

    if (bestMatch) {
      logger.debug(
        `Linked "${entityData.name}" to "${bestMatch.name}" (similarity: ${bestSimilarity.toFixed(3)})`
      );
    }

    return bestMatch;
  }

  private mergeEntityData(
    existing: Entity,
    newData: Omit<Entity, 'id'>
  ): void {
    // Merge source chunk IDs
    for (const chunkId of newData.sourceChunkIds) {
      if (!existing.sourceChunkIds.includes(chunkId)) {
        existing.sourceChunkIds.push(chunkId);
      }
    }

    // Merge attributes
    if (this.options.mergeAttributes) {
      for (const attr of newData.attributes) {
        if (!existing.attributes.includes(attr)) {
          existing.attributes.push(attr);
        }
      }
    }

    // Update confidence (use max)
    if (this.options.updateConfidence && newData.confidence !== undefined) {
      existing.confidence = Math.max(
        existing.confidence ?? 0,
        newData.confidence
      );
    }

    // Update embedding if new one is provided and existing doesn't have one
    if (newData.embedding && !existing.embedding) {
      existing.embedding = newData.embedding;
    }
  }

  // --------------------------------------------------------------------------
  // Helper Methods
  // --------------------------------------------------------------------------

  private findEntityId(name: string): string | undefined {
    const entity = this.graph.getEntityByName(name);
    return entity?.id;
  }

  /**
   * Clear embedding cache.
   */
  clearCache(): void {
    this.embeddingCache.clear();
  }

  /**
   * Get current graph reference.
   */
  getGraph(): KnowledgeGraph {
    return this.graph;
  }

  /**
   * Update options.
   */
  setOptions(options: Partial<GraphUpdateOptions>): void {
    this.options = { ...this.options, ...options };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a GraphUpdater instance.
 */
export function createGraphUpdater(
  graph: KnowledgeGraph,
  embedding?: RAGConfig['embedding'],
  options?: GraphUpdateOptions
): GraphUpdater {
  return new GraphUpdater(graph, embedding, options);
}
```

<verify>
- GraphUpdater class compiles without errors
- update() processes entities and triples from ExtractionResult
- Entity linking by name works correctly
- Entity linking by embedding similarity works with threshold
- Duplicate triples are skipped
- Attributes and source chunks are merged correctly
- updateBatch() aggregates statistics from multiple extractions
- createGraphUpdater factory function works
</verify>
</task>

<task id="2" name="Add updater to module exports" depends_on="1">
Update `src/graph/index.ts` to export GraphUpdater.

```typescript
// Add to src/graph/index.ts

export type { GraphUpdateOptions } from './graph-updater.js';

export {
  GraphUpdater,
  createGraphUpdater,
} from './graph-updater.js';
```

<verify>
- GraphUpdater is exported from src/graph/index.ts
- GraphUpdateOptions type is exported
- createGraphUpdater factory function is exported
</verify>
</task>

<task id="3" name="Add graph update integration test" depends_on="1">
Create integration test scenario for graph updates.

Test scenario:
1. Create empty graph
2. Extract entities from chunk 1
3. Update graph with extraction 1
4. Extract entities from chunk 2 (with overlapping entities)
5. Update graph with extraction 2
6. Verify entity merging occurred
7. Verify triples are connected correctly

```typescript
// Test pseudocode

const graph = createKnowledgeGraph();
const updater = createGraphUpdater(graph, embedding);

// Extraction 1: "BERT uses attention mechanism"
const extraction1: ExtractionResult = {
  entities: [
    { name: 'BERT', normalizedName: 'bert', attributes: ['language model'], sourceChunkIds: ['c1'] },
    { name: 'attention mechanism', normalizedName: 'attention mechanism', attributes: [], sourceChunkIds: ['c1'] },
  ],
  triples: [
    { headName: 'BERT', relation: 'uses', tailName: 'attention mechanism' },
  ],
  sourceChunkId: 'c1',
};

const result1 = await updater.update(extraction1);
assert(result1.entitiesAdded === 2);
assert(result1.triplesAdded === 1);

// Extraction 2: "BERT achieves 95% accuracy" (BERT should merge)
const extraction2: ExtractionResult = {
  entities: [
    { name: 'BERT', normalizedName: 'bert', attributes: ['accuracy: 95%'], sourceChunkIds: ['c2'] },
  ],
  triples: [],
  sourceChunkId: 'c2',
};

const result2 = await updater.update(extraction2);
assert(result2.entitiesAdded === 0);  // BERT merged
assert(result2.entitiesMerged === 1);

// Verify merged entity
const bert = graph.getEntityByName('BERT');
assert(bert?.sourceChunkIds.length === 2);  // c1 and c2
assert(bert?.attributes.includes('language model'));
assert(bert?.attributes.includes('accuracy: 95%'));
```

<verify>
- Entity merging works correctly
- Source chunk IDs are accumulated
- Attributes are merged
- Triple connections are maintained after merge
</verify>
</task>

## Acceptance Criteria

Goal: Implement incremental graph update with entity linking and deduplication

- [ ] GraphUpdater.update() processes ExtractionResult and returns GraphUpdateResult
- [ ] Entity linking by exact normalized name works
- [ ] Entity linking by embedding similarity (threshold 0.88) works when embedding provided
- [ ] Duplicate entities are merged (same normalized name)
- [ ] Duplicate triples are skipped
- [ ] Source chunk IDs are accumulated on merge
- [ ] Attributes are merged from new entities into existing
- [ ] Confidence scores are updated (max of existing and new)
- [ ] updateBatch() processes multiple extractions and aggregates stats
- [ ] GraphUpdateResult contains: entitiesAdded, entitiesMerged, triplesAdded, triplesSkipped, durationMs
- [ ] createGraphUpdater factory function works
