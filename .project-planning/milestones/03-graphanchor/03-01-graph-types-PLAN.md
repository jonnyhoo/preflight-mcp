---
stage: 1
depends_on: []
files_modified: [src/graph/types.ts]
autonomous: true
---

# Plan: GraphAnchor Type Definitions

## Goal
Define core data structures for knowledge graph: Entity, Triple, KnowledgeGraph interfaces.

## Tasks

<task id="1" name="Create graph types module">
Create `src/graph/types.ts` with core interfaces.

```typescript
interface Entity {
  id: string;
  name: string;
  normalizedName: string;  // lowercase + punctuation removed
  attributes: string[];
  embedding?: number[];
  sourceChunkIds: string[];
}

interface Triple {
  head: string;      // entity id
  relation: string;
  tail: string;      // entity id
  sourceChunkId: string;
}

interface KnowledgeGraph {
  entities: Map<string, Entity>;
  triples: Triple[];
}
```

<verify>
- File exists at src/graph/types.ts
- Entity interface has: id, name, normalizedName, attributes, embedding?, sourceChunkIds
- Triple interface has: head, relation, tail, sourceChunkId
- KnowledgeGraph interface has: entities Map, triples array
- TypeScript compiles without errors
</verify>
</task>

<task id="2" name="Add graph operation interfaces" depends_on="1">
Add method signatures for graph operations.

```typescript
interface KnowledgeGraphOps {
  addEntity(entity: Entity): string;
  addTriple(triple: Triple): void;
  linkEntity(name: string, embedding?: number[]): Entity;
  getNeighbors(entityId: string): Entity[];
  linearize(maxEntities?: number, maxTriples?: number): string;
}
```

<verify>
- KnowledgeGraphOps interface defined
- All 5 methods have correct signatures
- Export statements present
</verify>
</task>

<task id="3" name="Add iterative retrieval types" depends_on="1">
Add types for iterative retrieval loop.

```typescript
interface IterativeRetrievalOptions {
  maxIterations: number;       // default 3
  sufficiencyThreshold: number; // default 0.8
  enableGraph: boolean;        // default true
  maxEntitiesInPrompt: number; // default 50
  maxTriplesInPrompt: number;  // default 80
}

interface IterativeRetrievalResult {
  answer: string;
  iterations: number;
  graph: KnowledgeGraph;
  allDocuments: ChunkWithScore[];
  reasoning: string[];
}
```

<verify>
- IterativeRetrievalOptions interface defined with all 5 fields
- IterativeRetrievalResult interface defined with all 5 fields
- Default values documented in JSDoc comments
</verify>
</task>

## acceptance_criteria

Goal: Core type definitions for GraphAnchor knowledge graph

- [ ] src/graph/types.ts created with all interfaces
- [ ] Entity, Triple, KnowledgeGraph interfaces complete
- [ ] KnowledgeGraphOps interface with method signatures
- [ ] IterativeRetrievalOptions and Result interfaces
- [ ] TypeScript compilation passes
- [ ] Exports available for other modules
