---
stage: 4
depends_on: [03-07-rag-integration]
files_modified: [src/graph/__tests__/]
autonomous: true
---

# Plan: Unit Tests and Integration Tests

## Goal
Comprehensive testing for GraphAnchor implementation.

## Tasks

<task id="1" name="Unit tests for KnowledgeGraph">
Create `src/graph/__tests__/knowledge-graph.test.ts`.

Test cases:
- addEntity: new entity, duplicate entity merge
- addTriple: valid triple, invalid entity id
- getNeighbors: connected entities, isolated entity
- linearize: format correctness, truncation

<verify>
- All KnowledgeGraph methods tested
- Edge cases covered
- Tests pass
</verify>
</task>

<task id="2" name="Unit tests for EntityLinker" depends_on="1">
Create `src/graph/__tests__/entity-linker.test.ts`.

Test cases:
- normalizeEntityName: various inputs
- linkEntity: exact match, embedding match, no match
- linkEntities: batch linking

Mock embedding provider for deterministic tests.

<verify>
- Name normalization tested
- Linking strategies tested
- Mocking works correctly
</verify>
</task>

<task id="3" name="Unit tests for EntityExtractor" depends_on="1">
Create `src/graph/__tests__/entity-extractor.test.ts`.

Test cases:
- extractTriples: valid JSON response
- extractTriples: malformed JSON handling
- extractFromChunks: batch extraction

Mock LLM for deterministic tests.

<verify>
- Valid extraction tested
- Error handling tested
- Batch processing tested
</verify>
</task>

<task id="4" name="Integration test for IterativeRetriever" depends_on="3">
Create `src/graph/__tests__/iterative-retriever.test.ts`.

Test scenario:
1. Multi-hop question requiring 2+ iterations
2. Verify graph grows across iterations
3. Verify sufficiency judgment terminates loop
4. Verify final answer uses graph context

Use mock LLM with scripted responses.

<verify>
- Multi-iteration scenario works
- Graph accumulates correctly
- Loop terminates appropriately
</verify>
</task>

<task id="5" name="E2E test with real LLM" depends_on="4">
Create `src/graph/__tests__/graphanchor-e2e.test.ts`.

Test with real LLM (skip if no API key):
1. Index 2 related PDF bundles
2. Ask multi-hop question
3. Verify answer references both sources
4. Verify graph contains cross-document entities

<verify>
- E2E test passes with real LLM
- Skips gracefully without API key
- Performance within acceptable range
</verify>
</task>

## acceptance_criteria

Goal: Comprehensive test coverage for GraphAnchor

- [ ] KnowledgeGraph unit tests pass
- [ ] EntityLinker unit tests pass
- [ ] EntityExtractor unit tests pass
- [ ] IterativeRetriever integration test passes
- [ ] E2E test with real LLM passes (when available)
- [ ] Test coverage > 80% for graph module
