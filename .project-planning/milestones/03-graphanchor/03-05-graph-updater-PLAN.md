---
stage: 3
depends_on: [03-03-entity-extractor, 03-04-entity-linker]
files_modified: [src/graph/graph-updater.ts]
autonomous: true
---

# Plan: Graph Incremental Update

## Goal
Implement incremental graph update logic per GraphAnchor paper Eq.7-8.

## Tasks

<task id="1" name="Create GraphUpdater class">
Create `src/graph/graph-updater.ts` for incremental updates.

Constructor:
- extractor: EntityExtractor
- linker: EntityLinker

<verify>
- File exists at src/graph/graph-updater.ts
- Class accepts extractor and linker
- Exports GraphUpdater class
</verify>
</task>

<task id="2" name="Implement updateGraph method" depends_on="1">
Core update logic per paper formula:
```
G_t = M(q0, D_t, {G_{t-1}, R_{t-1}, q_{t-1}})
```

```typescript
async updateGraph(
  graph: KnowledgeGraph,
  documents: ChunkWithScore[],
  query: string,
  prevReasoning?: string
): Promise<KnowledgeGraph>
```

Logic:
1. Extract entities/triples from documents
2. Link entities to existing graph
3. Update triple head/tail with linked ids
4. Add new entities and triples to graph
5. Return updated graph

<verify>
- Extracts from new documents
- Links to existing entities
- Preserves existing graph data
- Returns updated graph
</verify>
</task>

<task id="3" name="Implement delta tracking" depends_on="2">
Track changes for debugging/logging.

```typescript
interface GraphDelta {
  newEntities: Entity[];
  linkedEntities: Array<{ original: string; linked: string }>;
  newTriples: Triple[];
}
```

<verify>
- Delta captures new entities
- Delta captures linked entities
- Delta captures new triples
- Useful for debugging
</verify>
</task>

<task id="4" name="Add merge strategies" depends_on="2">
Handle entity attribute merging.

When linking entities:
- Merge attributes arrays (deduplicate)
- Merge sourceChunkIds arrays
- Keep original entity id

<verify>
- Attributes merged without duplicates
- sourceChunkIds accumulated
- Entity id preserved
</verify>
</task>

## acceptance_criteria

Goal: Incremental graph update following GraphAnchor algorithm

- [ ] GraphUpdater class created
- [ ] updateGraph implements paper formula
- [ ] Entity linking integrated
- [ ] Delta tracking for debugging
- [ ] Attribute merging works correctly
- [ ] Graph grows incrementally across iterations
