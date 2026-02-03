---
stage: 1
depends_on: []
files_modified: [src/graph/knowledge-graph.ts]
autonomous: true
---

# Plan: Knowledge Graph Storage

## Goal
Implement in-memory knowledge graph storage with entity/triple management.

## Tasks

<task id="1" name="Create KnowledgeGraph class">
Create `src/graph/knowledge-graph.ts` implementing graph storage.

Core structure:
- entities: Map<string, Entity>
- triples: Triple[]
- entityIndex: Map<normalizedName, entityId> for fast lookup

<verify>
- File exists at src/graph/knowledge-graph.ts
- Class has entities Map and triples array
- entityIndex for normalized name lookup
</verify>
</task>

<task id="2" name="Implement addEntity" depends_on="1">
Add entity to graph with deduplication.

Logic:
1. Generate UUID if id not provided
2. Normalize name (lowercase, remove punctuation)
3. Check entityIndex for existing entity
4. If exists, merge sourceChunkIds
5. If new, add to entities Map and entityIndex

<verify>
- addEntity returns entity id
- Duplicate names merge sourceChunkIds
- entityIndex updated correctly
</verify>
</task>

<task id="3" name="Implement addTriple" depends_on="2">
Add triple to graph.

Logic:
1. Validate head and tail entity ids exist
2. Check for duplicate triple (same head, relation, tail)
3. Add to triples array if not duplicate

<verify>
- addTriple validates entity existence
- Duplicate triples not added
- sourceChunkId preserved
</verify>
</task>

<task id="4" name="Implement getNeighbors" depends_on="3">
Get neighboring entities via triples.

Logic:
1. Find all triples where entityId is head or tail
2. Collect unique neighbor entity ids
3. Return Entity objects

<verify>
- Returns entities connected by any relation
- Handles both head and tail positions
- Returns empty array for isolated entities
</verify>
</task>

<task id="5" name="Implement linearize" depends_on="4">
Convert graph to text format for LLM prompt.

Format (per GraphAnchor paper):
```
<graph>
Entities: Entity1, Entity2, ...
Relations: (Entity1, relation, Entity2), ...
</graph>
```

Parameters:
- maxEntities: default 50
- maxTriples: default 80

<verify>
- Output matches paper format
- Respects maxEntities/maxTriples limits
- Entities sorted by relevance (sourceChunkIds count)
</verify>
</task>

## acceptance_criteria

Goal: In-memory knowledge graph with CRUD operations

- [ ] KnowledgeGraph class created
- [ ] addEntity with deduplication works
- [ ] addTriple with validation works
- [ ] getNeighbors returns connected entities
- [ ] linearize produces paper-format output
- [ ] Unit tests pass for all operations
