---
stage: 2
depends_on:
  - 03-01-types-and-interfaces-PLAN.md
  - 03-02-knowledge-graph-impl-PLAN.md
files_modified:
  - src/graph/graph-serializer.ts
autonomous: true
---

# Plan: Graph Serializer Implementation

## Goal
Implement graph serialization for LLM consumption and persistence, with configurable linearization formats.

## Tasks

<task id="1" name="Create GraphSerializer class">
Create `src/graph/graph-serializer.ts` with serialization logic.

```typescript
// src/graph/graph-serializer.ts

/**
 * Graph Serializer - Convert knowledge graph to text and JSON formats.
 * Provides linearization for LLM prompts and persistence.
 * @module graph/graph-serializer
 */

import {
  type KnowledgeGraph,
  type Entity,
  type Triple,
  type SerializedGraph,
} from './types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('graph-serializer');

// ============================================================================
// Linearization Options
// ============================================================================

/**
 * Options for graph linearization.
 */
export interface LinearizeOptions {
  /** Maximum entities to include (default: 50) */
  maxEntities?: number;
  /** Maximum triples to include (default: 80) */
  maxTriples?: number;
  /** Include entity attributes (default: false) */
  includeAttributes?: boolean;
  /** Include confidence scores (default: false) */
  includeConfidence?: boolean;
  /** Sort entities by: 'degree' | 'confidence' | 'name' (default: 'degree') */
  sortBy?: 'degree' | 'confidence' | 'name';
  /** Output format: 'xml' | 'markdown' | 'plain' (default: 'xml') */
  format?: 'xml' | 'markdown' | 'plain';
  /** Focus on entities related to these IDs (prioritize in output) */
  focusEntityIds?: string[];
}

const DEFAULT_LINEARIZE_OPTIONS: Required<Omit<LinearizeOptions, 'focusEntityIds'>> = {
  maxEntities: 50,
  maxTriples: 80,
  includeAttributes: false,
  includeConfidence: false,
  sortBy: 'degree',
  format: 'xml',
};

// ============================================================================
// GraphSerializer Class
// ============================================================================

/**
 * Serializer for knowledge graphs.
 * Converts graphs to text for LLM consumption and JSON for persistence.
 */
export class GraphSerializer {
  private graph: KnowledgeGraph;

  constructor(graph: KnowledgeGraph) {
    this.graph = graph;
  }

  // --------------------------------------------------------------------------
  // Linearization (Graph -> Text)
  // --------------------------------------------------------------------------

  /**
   * Linearize graph to text format for LLM consumption.
   * 
   * @param options - Linearization options
   * @returns Formatted text representation
   */
  linearize(options?: LinearizeOptions): string {
    const opts = { ...DEFAULT_LINEARIZE_OPTIONS, ...options };
    
    // Get and sort entities
    const sortedEntities = this.getSortedEntities(opts);
    const selectedEntities = sortedEntities.slice(0, opts.maxEntities);
    const selectedEntityIds = new Set(selectedEntities.map(e => e.id));

    // Filter triples to only include selected entities
    const filteredTriples = this.graph.getAllTriples()
      .filter(t => selectedEntityIds.has(t.head) && selectedEntityIds.has(t.tail))
      .slice(0, opts.maxTriples);

    // Format based on output type
    switch (opts.format) {
      case 'markdown':
        return this.formatMarkdown(selectedEntities, filteredTriples, opts);
      case 'plain':
        return this.formatPlain(selectedEntities, filteredTriples, opts);
      case 'xml':
      default:
        return this.formatXml(selectedEntities, filteredTriples, opts);
    }
  }

  /**
   * Linearize subgraph around specific entities.
   * Useful for focused context in iterative retrieval.
   * 
   * @param centerEntityIds - Entity IDs to center the subgraph on
   * @param maxHops - Maximum hops from center entities (default: 2)
   * @param options - Linearization options
   * @returns Formatted text representation of subgraph
   */
  linearizeSubgraph(
    centerEntityIds: string[],
    maxHops: number = 2,
    options?: LinearizeOptions
  ): string {
    const opts = { ...DEFAULT_LINEARIZE_OPTIONS, ...options };
    
    // Collect entities within maxHops of center entities
    const includedEntityIds = new Set<string>(centerEntityIds);
    
    for (const centerId of centerEntityIds) {
      const neighbors = this.graph.getNeighborsWithinHops(centerId, maxHops);
      for (const neighbor of neighbors) {
        includedEntityIds.add(neighbor.id);
      }
    }

    // Get entities and limit
    const entities = [...includedEntityIds]
      .map(id => this.graph.getEntity(id))
      .filter((e): e is Entity => e !== undefined)
      .slice(0, opts.maxEntities);

    const entityIdSet = new Set(entities.map(e => e.id));

    // Filter triples
    const triples = this.graph.getAllTriples()
      .filter(t => entityIdSet.has(t.head) && entityIdSet.has(t.tail))
      .slice(0, opts.maxTriples);

    // Format
    switch (opts.format) {
      case 'markdown':
        return this.formatMarkdown(entities, triples, opts);
      case 'plain':
        return this.formatPlain(entities, triples, opts);
      case 'xml':
      default:
        return this.formatXml(entities, triples, opts);
    }
  }

  // --------------------------------------------------------------------------
  // Format Methods
  // --------------------------------------------------------------------------

  private formatXml(
    entities: Entity[],
    triples: Triple[],
    opts: Required<Omit<LinearizeOptions, 'focusEntityIds'>>
  ): string {
    const entityStrings = entities.map(e => {
      let str = e.name;
      if (opts.includeAttributes && e.attributes.length > 0) {
        str += `[${e.attributes.slice(0, 3).join(', ')}]`;
      }
      if (opts.includeConfidence && e.confidence !== undefined) {
        str += `(${(e.confidence * 100).toFixed(0)}%)`;
      }
      return str;
    });

    const tripleStrings = triples.map(t => {
      const head = this.graph.getEntity(t.head)?.name || t.head;
      const tail = this.graph.getEntity(t.tail)?.name || t.tail;
      let str = `(${head}, ${t.relation}, ${tail})`;
      if (opts.includeConfidence && t.confidence !== undefined) {
        str = `(${head}, ${t.relation}, ${tail}, ${(t.confidence * 100).toFixed(0)}%)`;
      }
      return str;
    });

    return `<graph>
Entities: ${entityStrings.join(', ')}
Relations: ${tripleStrings.join(', ')}
</graph>`;
  }

  private formatMarkdown(
    entities: Entity[],
    triples: Triple[],
    opts: Required<Omit<LinearizeOptions, 'focusEntityIds'>>
  ): string {
    const lines: string[] = ['## Knowledge Graph', ''];
    
    // Entities section
    lines.push('### Entities');
    for (const e of entities) {
      let line = `- **${e.name}**`;
      if (e.entityType) {
        line += ` (${e.entityType})`;
      }
      if (opts.includeAttributes && e.attributes.length > 0) {
        line += `: ${e.attributes.slice(0, 3).join(', ')}`;
      }
      lines.push(li);
    }
    
    lines.push('');
    
    // Relations section
    lines.push('### Relations');
    for (const t of triples) {
      const head = this.graph.getEntity(t.head)?.name || t.head;
      const tail = this.graph.getEntity(t.tail)?.name || t.tail;
      lines.push(`- ${head} → *${t.relation}* → ${tail}`);
    }

    return lines.join('\n');
  }

  private formatPlain(
    entities: Entity[],
    triples: Triple[],
    opts: Required<Omit<LinearizeOptions, 'focusEntityIds'>>
  ): string {
    const entityNames = entities.map(e => e.name).join(', ');
    
    const tripleStrings = triples.map(t => {
      const head = this.graph.getEntity(t.head)?.name || t.head;
      const tail = this.graph.getEntity(t.tail)?.name || t.tail;
      return `${head} ${t.relation} ${tail}`;
    }).join('; ');

    return `Entities: ${entityNames}\nRelations: ${tripleStrings}`;
  }

  // --------------------------------------------------------------------------
  // Sorting
  // --------------------------------------------------------------------------

  private getSortedEntities(
    opts: Required<Omit<LinearizeOptions, 'focusEntityIds'>> & { focusEntityIds?: string[] }
  ): Entity[] {
    const allEntities = this.graph.getAllEntities();
    
    // Calculate degree for each entity
    const entityDegrees = new Map<string, number>();
    for (const entity of allEntities) {
      const degree = this.graph.getNeighbors(entity.id).length;
      entityDegrees.set(entity.id, degree);
    }

    // Sort based on option
    let sorted: Entity[];
    
    switch (opts.sortBy) {
      case 'confidence':
        sorted = allEntities.sort((a, b) => 
          (b.confidence ?? 0) - (a.confidence ?? 0)
        );
        break;
      case 'name':
        sorted = allEntities.sort((a, b) => 
          a.name.localeCompare(b.name)
        );
        break;
      case 'degree':
      default:
        sorted = allEntities.sort((a, b) => 
          (entityDegrees.get(b.id) ?? 0) - (entityDegrees.get(a.id) ?? 0)
        );
    }

    // Prioritize focus entities if specified
    if (opts.focusEntityIds && opts.focusEntityIds.length > 0) {
      const focusSet = new Set(opts.focusEntityIds);
      const focusEntities = sorted.filter(e => focusSet.has(e.id));
      const otherEntities = sorted.filter(e => !focusSet.has(e.id));
      sorted = [...focusEntities, ...otherEntities];
    }

    return sorted;
  }

  // --------------------------------------------------------------------------
  // JSON Serialization (Persistence)
  // --------------------------------------------------------------------------

  /**
   * Serialize graph to JSON for persistence.
   * 
   * @param bundleId - Optional bundle ID for metadata
   * @returns Serialized graph object
   */
  toJSON(bundleId?: string): SerializedGraph {
    return {
      version: '1.0.0',
      entities: this.graph.getAllEntities(),
      triples: this.graph.getAllTriples(),
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sourceBundle: bundleId,
      },
    };
  }

  /**
   * Serialize graph to JSON string.
   * 
   * @param bundleId - Optional bundle ID for metadata
   * @param pretty - Pretty print JSON (default: false)
   * @returns JSON string
   */
  toJSONString(bundleId?: string, pretty: boolean = false): string {
    const data = this.toJSON(bundleId);
    return pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  }

  // --------------------------------------------------------------------------
  // Statistics
  // --------------------------------------------------------------------------

  /**
   * Get summary statistics for logging/display.
   */
  getSummary(): string {
    const stats = this.graph.getStats();
    return `Graph: ${stats.entityCount} entities, ${stats.tripleCount} triples, ` +
           `avg degree: ${stats.avgDegree.toFixed(2)}, components: ${stats.connectedComponents}`;
  }
}

// ============================================================================
// Deserialization
// ============================================================================

/**
 * Deserialize graph from JSON.
 * 
 * @param data - Serialized graph data
 * @param graph - Target KnowledgeGraph to populate
 */
export function deserializeGraph(
  data: SerializedGraph,
  graph: KnowledgeGraph
): void {
  // Add entities
  const idMap = new Map<string, string>(); // old ID -> new ID
  
  for (const entity of data.entities) {
    const newId = graph.addEntity({
      name: entity.name,
      normalizedName: entity.normalizedName,
      entityType: entity.entityType,
      attributes: entity.attributes,
      embedding: entity.embedding,
      sourceChunkIds: entity.sourceChunkIds,
      confidence: entity.confidence,
    });
    idMap.set(entity.id, newId);
  }

  // Add triples (with ID mapping)
  for (const triple of data.triples) {
    const newHead = idMap.get(triple.head);
    const newTail = idMap.get(triple.tail);
    
    if (newHead && newTail) {
      graph.addTriple({
        head: newHead,
        relation: triple.relation,
        tail: newTail,
        sourceChunkId: triple.sourceChunkId,
        confidence: triple.confidence,
        evidence: triple.evidence,
      });
    }
  }

  logger.info(`Deserialized graph: ${data.entities.length} entities, ${data.triples.length} triples`);
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a GraphSerializer instance.
 */
export function createGraphSerializer(graph: KnowledgeGraph): GraphSerializer {
  return new GraphSerializer(graph);
}
```

<verify>
- GraphSerializer class compiles without errors
- linearize() produces correct XML format: `<graph>\nEntities: ...\nRelations: ...\n</graph>`
- linearize() with format='markdown' produces markdown output
- linearize() with format='plain' produces plain text output
- linearizeSubgraph() focuses on entities within N hops
- toJSON() returns SerializedGraph with version, entities, triples, metadata
- deserializeGraph() correctly populates a KnowledgeGraph from SerializedGraph
- Entity sorting by degree, confidence, name works correctly
- Focus entities are prioritized in output
</verify>
</task>

<task id="2" name="Add serializer to module exports" depends_on="1">
Update `src/graph/index.ts` to export GraphSerializer.

```typescript
// Add to src/graph/index.ts

export type { LinearizeOptions } from './graph-serializer.js';

export {
  GraphSerializer,
  createGraphSerializer,
  deserializeGraph,
} from './graph-serializer.js';
```

<verify>
- GraphSerializer is exported from src/graph/index.ts
- LinearizeOptions type is exported
- deserializeGraph function is exported
- createGraphSerializer factory function is exported
</verify>
</task>

<task id="3" name="Add file persistence utilities" depends_on="1">
Add utilities for saving/loading graphs to/from files.

```typescript
// Add to src/graph/graph-serializer.ts

import fs from 'node:fs/promises';
import path from 'node:path';

// ============================================================================
// File Persistence
// ============================================================================

/**
 * Save graph to JSON file.
 * 
 * @param graph - KnowledgeGraph to save
 * @param filePath - Output file path
 * @param bundleId - Optional bundle ID for metadata
 */
export async function saveGraphToFile(
  graph: KnowledgeGraph,
  filePath: string,
  bundleId?: string
): Promise<void> {
  const serializer = new GraphSerializer(graph);
  const json = serializer.toJSONString(bundleId, true);
  
  // Ensure directory exists
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  
  await fs.writeFile(filePath, json, 'utf-8');
  logger.info(`Saved graph to ${filePath}`);
}

/**
 * Load graph from JSON file.
 * 
 * @param filePath - Input file path
 * @param graph - Target KnowledgeGraph to populate
 * @returns Loaded metadata
 */
export async function loadGraphFromFile(
  filePath: string,
  graph: KnowledgeGraph
): Promise<SerializedGraph['metadata']> {
  const content = await fs.readFile(filePath, 'utf-8');
  const data = JSON.parse(content) as SerializedGraph;
  
  deserializeGraph(data, graph);
  
  logger.info(`Loaded graph from ${filePath}`);
  return data.metadata;
}
```

<verify>
- saveGraphToFile creates directory if needed
- saveGraphToFile writes pretty-printed JSON
- loadGraphFromFile reads and deserializes graph
- loadGraphFromFile returns metadata
</verify>
</task>

## Acceptance Criteria

Goal: Implement graph serialization for LLM consumption and persistence

- [ ] linearize() produces XML format: `<graph>\nEntities: X(v1), X(v2)\nRelations: X(t1), X(t2)\n</graph>`
- [ ] linearize() respects maxEntities and maxTriples limits
- [ ] linearize() supports format options: 'xml', 'markdown', 'plain'
- [ ] linearize() sorts entities by degree (most connected first) by default
- [ ] linearize() can include attributes and confidence scores
- [ ] linearizeSubgraph() focuses on entities within N hops of center entities
- [ ] toJSON() returns SerializedGraph with version, entities, triples, metadata
- [ ] deserializeGraph() correctly populates KnowledgeGraph from SerializedGraph
- [ ] saveGraphToFile() persists graph to JSON file
- [ ] loadGraphFromFile() loads graph from JSON file
- [ ] createGraphSerializer factory function works
