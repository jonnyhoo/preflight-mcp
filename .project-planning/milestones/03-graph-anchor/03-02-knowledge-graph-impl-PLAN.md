---
stage: 1
depends_on: []
files_modified:
  - src/graph/knowledge-graph.ts
autonomous: true
---

# Plan: KnowledgeGraph Implementation

## Goal
Implement the core KnowledgeGraph class for storing entities and relations, with entity linking and graph traversal capabilities.

## Tasks

<task id="1" name="Create KnowledgeGraphImpl class">
Create `src/graph/knowledge-graph.ts` with the main implementation.

```typescript
// src/graph/knowledge-graph.ts

/**
 * Knowledge Graph Implementation.
 * Stores entities and triples with entity linking support.
 * @module graph/knowledge-graph
 */

import {
  type Entity,
  type Triple,
  type KnowledgeGraph,
  type GraphStats,
  normalizeEntityName,
  generateEntityId,
  cosineSimilarity,
  ENTITY_LINK_THRESHOLD,
} from './types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('knowledge-graph');

/**
 * In-memory Knowledge Graph implementation.
 */
export class KnowledgeGraphImpl implements KnowledgeGraph {
  entities: Map<string, Entity> = new Map();
  triples: Triple[] = [];
  
  /** Index: normalized name -> entity ID for fast lookup */
  private nameIndex: Map<string, string> = new Map();
  
  /** Index: entity ID -> connected entity IDs (adjacency list) */
  private adjacencyIndex: Map<string, Set<string>> = new Map();

  constructor() {
    logger.debug('KnowledgeGraph initialized');
  }

  // --------------------------------------------------------------------------
  // Entity Operations
  // --------------------------------------------------------------------------

  addEntity(entityData: Omit<Entity, 'id'>): string {
    const normalizedName = normalizeEntityName(entityData.name);
    
    // Check if entity with same normalized name exists
    const existingId = this.nameIndex.get(normalizedName);
    if (existingId) {
      // Merge: add new source chunks to existing entity
      const existing = this.entities.get(existingId)!;
      const newChunks = entityData.sourceChunkIds.filter(
        id => !existing.sourceChunkIds.includes(id)
      );
      existing.sourceChunkIds.push(...newChunks);
      
      // Merge attributes
      for (const attr of entityData.attributes) {
        if (!existing.attributes.includes(attr)) {
          existing.attributes.push(attr);
        }
      }
      
      logger.debug(`Merged entity "${entityData.name}" into existing "${existing.name}"`);
      return existingId;
    }
    
    // Create new entity
    const id = generateEntityId();
    const entity: Entity = {
      id,
      name: entityData.name,
      normalizedName,
      entityType: entityData.entityType,
      attributes: [...entityData.attributes],
      embedding: entityData.embedding,
      sourceChunkIds: [...entityData.sourceChunkIds],
      confidence: entityData.confidence,
      createdAt: Date.now(),
    };
    
    this.entities.set(id, entity);
    this.nameIndex.set(normalizedName, id);
    this.adjacencyIndex.set(id, new Set());
    
    logger.debug(`Added entity: ${entity.name} (${id})`);
    return id;
  }

  getEntity(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  getEntityByName(name: string): Entity | undefined {
    const normalizedName = normalizeEntityName(name);
    const id = this.nameIndex.get(normalizedName);
    return id ? this.entities.get(id) : undefined;
  }

  // --------------------------------------------------------------------------
  // Entity Linking
  // --------------------------------------------------------------------------

  linkEntity(name: string, embedding?: number[]): Entity {
    const normalizedName = normalizeEntityName(name);
    
    // 1. Exact name match
    const exactMatchId = this.nameIndex.get(normalizedName);
    if (exactMatchId) {
      return this.entities.get(exactMatchId)!;
    }
    
    // 2. Embedding similarity match (if embedding provided)
    if (embedding && embedding.length > 0) {
      let bestMatch: Entity | null = null;
      let bestSimilarity = 0;
      
      for (const entity of this.entities.values()) {
        if (entity.embedding && entity.embedding.length === embedding.length) {
          const similarity = cosineSimilarity(embedding, entity.embedding);
          if (similarity >= ENTITY_LINK_THRESHOLD && similarity > bestSimilarity) {
            bestSimilarity = similarity;
            bestMatch = entity;
          }
        }
      }
      
      if (bestMatch) {
        logger.debug(`Linked "${name}" to "${bestMatch.name}" (similarity: ${bestSimilarity.toFixed(3)})`);
        return bestMatch;
      }
    }
    
    // 3. No match found - create new entity
    const id = this.addEntity({
      name,
      normalizedName,
      attributes: [],
      embedding,
      sourceChunkIds: [],
    });
    
    return this.entities.get(id)!;
  }

  // --------------------------------------------------------------------------
  // Triple Operations
  // --------------------------------------------------------------------------

  addTriple(triple: Triple): void {
    // Validate entities exist
    if (!this.entities.has(triple.head)) {
      logger.warn(`Triple head entity not found: ${triple.head}`);
      return;
    }
    if (!this.entities.has(triple.tail)) {
      logger.warn(`Triple tail entity not found: ${triple.tail}`);
      return;
    }
    
    // Check for duplicate
    const isDuplicate = this.triples.some(
      t => t.head === triple.head && 
           t.relation === triple.relation && 
           t.tail === triple.tail
    );
    
    if (isDuplicate) {
      logger.debug(`Skipping duplicate triple: (${triple.head}, ${triple.relation}, ${triple.tail})`);
      return;
    }
    
    this.triples.push(triple);
    
    // Update adjacency index (bidirectional)
    this.adjacencyIndex.get(triple.head)?.add(triple.tail);
    this.adjacencyIndex.get(triple.tail)?.add(triple.head);
    
    logger.debug(`Added triple: (${triple.head}, ${triple.relation}, ${triple.tail})`);
  }

  getTriplesForEntity(entityId: string): Triple[] {
    return this.triples.filter(
      t => t.head === entityId || t.tail === entityId
    );
  }

  // --------------------------------------------------------------------------
  // Graph Traversal
  // --------------------------------------------------------------------------

  getNeighbors(entityId: string): Entity[] {
    const neighborIds = this.adjacencyIndex.get(entityId);
    if (!neighborIds) return [];
    
    return [...neighborIds]
      .map(id => this.entities.get(id))
      .filter((e): e is Entity => e !== undefined);
  }

  getNeighborsWithinHops(
    entityId: string, 
    maxHops: number = 2
  ): Array<Entity & { hopDistance: number }> {
    const result: Array<Entity & { hopDistance: number }> = [];
    const visited = new Set<string>([entityId]);
    const queue: Array<{ id: string; distance: number }> = [{ id: entityId, distance: 0 }];
    
    while (queue.length > 0) {
      const { id, distance } = queue.shift()!;
      
      if (distance > 0) {
        const entity = this.entities.get(id);
        if (entity) {
          result.push({ ...entity, hopDistance: distance });
        }
      }
      
      if (distance < maxHops) {
        const neighbors = this.adjacencyIndex.get(id) || new Set();
        for (const neighborId of neighbors) {
          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            queue.push({ id: neighborId, distance: distance + 1 });
          }
        }
      }
    }
    
    return result;
  }

  // --------------------------------------------------------------------------
  // Linearization
  // --------------------------------------------------------------------------

  linearize(maxEntities: number = 50, maxTriples: number = 80): string {
    // Sort entities by number of connections (most connected first)
    const sortedEntities = [...this.entities.values()]
      .map(e => ({
        entity: e,
        degree: this.adjacencyIndex.get(e.id)?.size || 0,
      }))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, maxEntities)
      .map(({ entity }) => entity);
    
    // Get entity IDs for filtering triples
    const includedEntityIds = new Set(sortedEntities.map(e => e.id));
    
    // Filter triples to only include those between included entities
    const filteredTriples = this.triples
      .filter(t => includedEntityIds.has(t.head) && includedEntityIds.has(t.tail))
      .slice(0, maxTriples);
    
    // Build linearized format
    const entityNames = sortedEntities
      .map(e => e.name)
      .join(', ');
    
    const tripleStrings = filteredTriples
      .map(t => {
        const head = this.entities.get(t.head)?.name || t.head;
        const tail = this.entities.get(t.tail)?.name || t.tail;
        return `(${head}, ${t.relation}, ${tail})`;
      })
      .join(', ');
    
    return `<graph>
Entities: ${entityNames}
Relations: ${tripleStrings}
</graph>`;
  }

  // --------------------------------------------------------------------------
  // Statistics
  // --------------------------------------------------------------------------

  getStats(): GraphStats {
    const entityCount = this.entities.size;
    const tripleCount = this.triples.length;
    
    // Calculate average degree
    let totalDegree = 0;
    for (const neighbors of this.adjacencyIndex.values()) {
      totalDegree += neighbors.size;
    }
    const avgDegree = entityCount > 0 ? totalDegree / entityCount : 0;
    
    // Count connected components using Union-Find
    const connectedComponents = this.countConnectedComponents();
    
    return {
      entityCount,
      tripleCount,
      avgDegree,
      connectedComponents,
    };
  }

  private countConnectedComponents(): number {
    const visited = new Set<string>();
    let components = 0;
    
    for (const entityId of this.entities.keys()) {
      if (!visited.has(entityId)) {
        components++;
        // BFS to mark all connected entities
        const queue = [entityId];
        while (queue.length > 0) {
          const current = queue.shift()!;
          if (visited.has(current)) continue;
          visited.add(current);
          
          const neighbors = this.adjacencyIndex.get(current) || new Set();
          for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
              queue.push(neighbor);
            }
          }
        }
      }
    }
    
    return components;
  }

  // --------------------------------------------------------------------------
  // Utility Methods
  // --------------------------------------------------------------------------

  /**
   * Clear all data from the graph.
   */
  clear(): void {
    this.entities.clear();
    this.triples = [];
    this.nameIndex.clear();
    this.adjacencyIndex.clear();
    logger.debug('KnowledgeGraph cleared');
  }

  /**
   * Get all entities as array.
   */
  getAllEntities(): Entity[] {
    return [...this.entities.values()];
  }

  /**
   * Get all triples.
   */
  getAllTriples(): Triple[] {
    return [...this.triples];
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new KnowledgeGraph instance.
 */
export function createKnowledgeGraph(): KnowledgeGraph {
  return new KnowledgeGraphImpl();
}
```

<verify>
- KnowledgeGraphImpl class compiles without errors
- addEntity returns existing ID for duplicate normalized names
- linkEntity uses embedding similarity with threshold 0.88
- getNeighbors returns 1-hop neighbors
- getNeighborsWithinHops returns entities within N hops with distance
- linearize produces correct format: `<graph>\nEntities: ...\nRelations: ...\n</graph>`
- getStats returns correct counts
</verify>
</task>

<task id="2" name="Add graph to module exports" depends_on="1">
Update `src/graph/index.ts` to export KnowledgeGraphImpl.

```typescript
// Add to src/graph/index.ts

export {
  KnowledgeGraphImpl,
  createKnowledgeGraph,
} from './knowledge-graph.js';
```

<verify>
- KnowledgeGraphImpl is exported from src/graph/index.ts
- createKnowledgeGraph factory function is exported
</verify>
</task>

<task id="3" name="Write unit tests for KnowledgeGraph" depends_on="1">
Create basic test cases to verify KnowledgeGraph functionality.

Test scenarios:
1. Add entity and retrieve by ID
2. Add entity with same normalized name -> merge
3. Link entity by exact name match
4. Link entity by embedding similarity
5. Add triple and verify adjacency
6. Get neighbors (1-hop)
7. Get neighbors within 2 hops
8. Linearize graph to text format
9. Get graph statistics

```typescript
// Test pseudocode (for manual verification)

const graph = createKnowledgeGraph();

// Test 1: Add entity
const id1 = graph.addEntity({
  name: 'Machine Learning',
  normalizedName: 'machine learning',
  attributes: ['AI technique'],
  sourceChunkIds: ['chunk-1'],
});
assert(graph.getEntity(id1)?.name === 'Machine Learning');

// Test 2: Merge duplicate
const id2 = graph.addEntity({
  name: 'machine learning',  // Same normalized
  normalizedName: 'machine learning',
  attributes: ['ML'],
  sourceChunkIds: ['chunk-2'],
});
assert(id1 === id2);  // Should return same ID
assert(graph.getEntity(id1)?.sourceChunkIds.length === 2);

// Test 3: Add related entity and triple
const id3 = graph.addEntity({
  name: 'Neural Networks',
  normalizedName: 'neural networks',
  attributes: [],
  sourceChunkIds: ['chunk-1'],
});
graph.addTriple({
  head: id1,
  relation: 'uses',
  tail: id3,
  sourceChunkId: 'chunk-1',
});

// Test 4: Get neighbors
const neighbors = graph.getNeighbors(id1);
assert(neighbors.length === 1);
assert(neighbors[0].name === 'Neural Networks');

// Test 5: Linearize
const text = graph.linearize();
assert(text.includes('<graph>'));
assert(text.includes('Machine Learning'));
assert(text.includes('Neural Networks'));
assert(text.includes('uses'));
```

<verify>
- All test scenarios pass
- Entity merging works correctly
- Graph traversal returns correct results
- Linearization format matches spec
</verify>
</task>

## Acceptance Criteria

Goal: Implement KnowledgeGraph class with entity storage, linking, and traversal

- [ ] KnowledgeGraphImpl implements KnowledgeGraph interface
- [ ] addEntity merges entities with same normalized name
- [ ] linkEntity matches by exact name first, then embedding similarity (threshold 0.88)
- [ ] addTriple validates entity existence and prevents duplicates
- [ ] getNeighbors returns 1-hop connected entities
- [ ] getNeighborsWithinHops returns entities within N hops with distance
- [ ] linearize produces format: `<graph>\nEntities: X, Y, Z\nRelations: (X, rel, Y), ...\n</graph>`
- [ ] getStats returns entityCount, tripleCount, avgDegree, connectedComponents
- [ ] Adjacency index is maintained for efficient traversal
- [ ] createKnowledgeGraph factory function works
