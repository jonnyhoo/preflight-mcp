---
stage: 2
depends_on: [03-01-graph-types, 03-02-knowledge-graph]
files_modified: [src/graph/entity-extractor.ts]
autonomous: true
---

# Plan: LLM Entity/Triple Extraction

## Goal
Extract entities and RDF triples from document chunks using LLM.

## Tasks

<task id="1" name="Create EntityExtractor class">
Create `src/graph/entity-extractor.ts` with LLM-based extraction.

Constructor:
- llm: LLM client for completion
- embedding: Embedding provider (optional, for entity linking)

<verify>
- File exists at src/graph/entity-extractor.ts
- Class accepts llm and embedding in constructor
- Exports EntityExtractor class
</verify>
</task>

<task id="2" name="Design extraction prompt" depends_on="1">
Create prompt template based on GraphAnchor paper.

Prompt structure:
```
Given the following document and query, extract entities and relations.

Query: {query}
Document: {document}
Previous reasoning: {prev_reasoning}

Output JSON format:
{
  "entities": [
    {"name": "EntityName", "attributes": ["attr1", "attr2"]}
  ],
  "triples": [
    {"head": "Entity1", "relation": "relates_to", "tail": "Entity2"}
  ]
}
```

<verify>
- Prompt includes query context
- Prompt includes previous reasoning for iterative updates
- Output format is valid JSON
- Handles empty extraction gracefully
</verify>
</task>

<task id="3" name="Implement extractTriples method" depends_on="2">
Main extraction method.

```typescript
async extractTriples(
  document: string,
  query: string,
  prevReasoning?: string
): Promise<{ entities: Entity[], triples: Triple[] }>
```

Logic:
1. Build prompt with document, query, prevReasoning
2. Call LLM with JSON output format
3. Parse JSON response
4. Validate entity/triple structure
5. Return extracted data

Error handling:
- JSON parse errors: return empty result
- Invalid structure: filter out malformed items

<verify>
- Returns valid entities and triples
- Handles LLM errors gracefully
- Logs extraction statistics
</verify>
</task>

<task id="4" name="Implement batch extraction" depends_on="3">
Extract from multiple chunks efficiently.

```typescript
async extractFromChunks(
  chunks: ChunkWithScore[],
  query: string,
  prevReasoning?: string
): Promise<{ entities: Entity[], triples: Triple[] }>
```

Logic:
1. Process chunks in parallel (concurrency limit: 3)
2. Merge results, deduplicating entities by name
3. Track sourceChunkId for each entity/triple

<verify>
- Parallel processing with concurrency limit
- Entity deduplication across chunks
- sourceChunkId correctly tracked
</verify>
</task>

## acceptance_criteria

Goal: LLM-based entity and triple extraction from documents

- [ ] EntityExtractor class created
- [ ] Extraction prompt follows GraphAnchor paper format
- [ ] extractTriples handles single document
- [ ] extractFromChunks handles batch with deduplication
- [ ] Error handling for LLM failures
- [ ] sourceChunkId tracking for provenance
