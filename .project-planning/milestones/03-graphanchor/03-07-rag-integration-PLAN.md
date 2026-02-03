---
stage: 4
depends_on: [03-06-iterative-retriever]
files_modified: [src/rag/query.ts, src/rag/types.ts, src/server/tools/ragTools.ts]
autonomous: true
---

# Plan: RAG Engine Integration

## Goal
Integrate GraphAnchor iterative retrieval into existing RAGEngine.query().

## Tasks

<task id="1" name="Add GraphAnchor options to QueryOptions">
Extend `src/rag/types.ts` with graph retrieval options.

```typescript
interface QueryOptions {
  // ... existing options
  
  // GraphAnchor options (Phase 3)
  enableGraphRetrieval?: boolean;  // default false
  graphOptions?: {
    maxIterations?: number;        // default 3
    sufficiencyThreshold?: number; // default 0.8
    maxEntitiesInPrompt?: number;  // default 50
    maxTriplesInPrompt?: number;   // default 80
  };
}
```

<verify>
- QueryOptions extended with enableGraphRetrieval
- graphOptions nested object defined
- Default values documented
</verify>
</task>

<task id="2" name="Add graph stats to QueryResult" depends_on="1">
Extend QueryResult with graph statistics.

```typescript
interface QueryResult {
  // ... existing fields
  stats: {
    // ... existing stats
    graphStats?: {
      iterations: number;
      entitiesExtracted: number;
      triplesExtracted: number;
      subQueriesGenerated: string[];
      durationMs: number;
    };
  };
}
```

<verify>
- graphStats added to stats object
- All graph metrics included
- Optional field (undefined when graph disabled)
</verify>
</task>

<task id="3" name="Integrate into RAGEngine.query" depends_on="2">
Modify `src/rag/query.ts` to use IterativeRetriever.

Logic:
```typescript
async query(question: string, options?: QueryOptions): Promise<QueryResult> {
  // ... existing setup
  
  if (options?.enableGraphRetrieval) {
    // Use IterativeRetriever
    const iterativeRetriever = new IterativeRetriever(
      this.retriever,
      new GraphUpdater(new EntityExtractor(this.llm), new EntityLinker(this.embedding)),
      this.llm
    );
    
    const result = await iterativeRetriever.retrieve(question, {
      maxIterations: options.graphOptions?.maxIterations ?? 3,
      // ... other options
    });
    
    return {
      answer: result.answer,
      sources: buildSources(result.allDocuments),
      stats: {
        // ... existing stats
        graphStats: {
          iterations: result.iterations,
          entitiesExtracted: result.graph.entities.size,
          triplesExtracted: result.graph.triples.length,
          subQueriesGenerated: result.reasoning,
          durationMs: Date.now() - startTime,
        },
      },
    };
  }
  
  // ... existing non-graph path
}
```

<verify>
- enableGraphRetrieval triggers iterative path
- Falls back to existing path when disabled
- Stats correctly populated
- Backward compatible
</verify>
</task>

<task id="4" name="Update MCP tool interface" depends_on="3">
Expose graph options in `src/server/tools/ragTools.ts`.

Add to preflight_rag tool schema:
```typescript
enableGraphRetrieval: z.boolean().optional(),
graphOptions: z.object({
  maxIterations: z.number().optional(),
  sufficiencyThreshold: z.number().optional(),
  maxEntitiesInPrompt: z.number().optional(),
  maxTriplesInPrompt: z.number().optional(),
}).optional(),
```

<verify>
- MCP tool accepts enableGraphRetrieval
- graphOptions passed to RAGEngine
- Tool description updated
</verify>
</task>

## acceptance_criteria

Goal: GraphAnchor integrated into RAG query pipeline

- [ ] QueryOptions extended with graph options
- [ ] QueryResult includes graph statistics
- [ ] RAGEngine.query uses IterativeRetriever when enabled
- [ ] MCP tool exposes graph options
- [ ] Backward compatible (default: graph disabled)
- [ ] Integration test passes
