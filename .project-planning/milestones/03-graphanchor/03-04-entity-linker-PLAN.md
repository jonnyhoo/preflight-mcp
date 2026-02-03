---
stage: 2
depends_on: [03-01-graph-types, 03-02-knowledge-graph]
files_modified: [src/graph/entity-linker.ts]
autonomous: true
---

# Plan: Entity Linking (Cross-Document Alignment)

## Goal
Link entities across documents using name normalization and embedding similarity.

## Tasks

<task id="1" name="Create EntityLinker class">
Create `src/graph/entity-linker.ts` for entity alignment.

Constructor:
- embedding: Embedding provider
- similarityThreshold: default 0.88 (per paper)

<verify>
- File exists at src/graph/entity-linker.ts
- Class accepts embedding provider
- similarityThreshold configurable
</verify>
</task>

<task id="2" name="Implement name normalization" depends_on="1">
Normalize entity names for matching.

```typescript
normalizeEntityName(name: string): string
```

Logic:
1. Convert to lowercase
2. Remove punctuation (keep alphanumeric and spaces)
3. Collapse multiple spaces
4. Trim whitespace

Examples:
- "GPT-4" -> "gpt4"
- "Large Language Model" -> "large language model"
- "BERT (2018)" -> "bert 2018"

<verify>
- Handles various punctuation
- Case insensitive
- Preserves meaningful tokens
</verify>
</task>

<task id="3" name="Implement linkEntity method" depends_on="2">
Link new entity to existing graph.

```typescript
async linkEntity(
  entity: Entity,
  graph: KnowledgeGraph
): Promise<string>  // returns linked entity id
```

Logic:
1. Normalize entity name
2. Check exact match in graph.entityIndex
3. If exact match, return existing entity id
4. If no exact match and embedding available:
   a. Compute entity embedding
   b. Find nearest entity by cosine similarity
   c. If similarity >= threshold, return existing id
5. If no match, add as new entity

<verify>
- Exact name match works
- Embedding similarity fallback works
- New entities added when no match
- Returns correct entity id
</verify>
</task>

<task id="4" name="Implement batch linking" depends_on="3">
Link multiple entities efficiently.

```typescript
async linkEntities(
  entities: Entity[],
  graph: KnowledgeGraph
): Promise<Map<string, string>>  // original id -> linked id
```

Logic:
1. Batch compute embeddings for all entities
2. Link each entity, building id mapping
3. Return mapping for triple head/tail updates

<verify>
- Batch embedding computation
- Returns complete id mapping
- Handles empty input
</verify>
</task>

## acceptance_criteria

Goal: Cross-document entity alignment via name and embedding

- [ ] EntityLinker class created
- [ ] Name normalization handles edge cases
- [ ] Exact name matching works
- [ ] Embedding similarity fallback (threshold 0.88)
- [ ] Batch linking with id mapping
- [ ] Integration with KnowledgeGraph
