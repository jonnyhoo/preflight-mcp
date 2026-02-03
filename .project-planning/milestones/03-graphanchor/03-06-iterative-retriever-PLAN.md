---
stage: 3
depends_on: [03-05-graph-updater]
files_modified: [src/graph/iterative-retriever.ts]
autonomous: true
---

# Plan: Iterative Retrieval Loop

## Goal
Implement iterative retrieval with sufficiency judgment and sub-query generation.

## Tasks

<task id="1" name="Create IterativeRetriever class">
Create `src/graph/iterative-retriever.ts` for multi-hop retrieval.

Constructor:
- retriever: RAGRetriever (existing)
- graphUpdater: GraphUpdater
- llm: LLM client

<verify>
- File exists at src/graph/iterative-retriever.ts
- Class accepts retriever, graphUpdater, llm
- Exports IterativeRetriever class
</verify>
</task>

<task id="2" name="Implement sufficiency judgment" depends_on="1">
LLM-based judgment if current context is sufficient.

```typescript
async judgeSufficiency(
  query: string,
  documents: ChunkWithScore[],
  graph: KnowledgeGraph
): Promise<{ sufficient: boolean; reasoning: string; nextQuery?: string }>
```

Prompt structure (per paper Figure 13):
```
Query: {query}
Retrieved documents: {documents}
Knowledge graph: {graph.linearize()}

Determine:
1. Is the information sufficient to answer the query?
2. If not, what additional information is needed?

Output JSON:
{
  "sufficient": true/false,
  "reasoning": "explanation",
  "nextQuery": "sub-query if not sufficient"
}
```

<verify>
- Returns sufficient boolean
- Provides reasoning
- Generates nextQuery when not sufficient
</verify>
</task>

<task id="3" name="Implement retrieval loop" depends_on="2">
Main iterative retrieval algorithm.

```typescript
async retrieve(
  query: string,
  options: IterativeRetrievalOptions
): Promise<IterativeRetrievalResult>
```

Algorithm (per paper):
```
G_0 = empty graph
D_0 = Retriever(q_0)
for t = 1 to maxIterations:
  (entities, triples) = Extract(D_t, q_0, R_{t-1})
  G_t = UpdateGraph(G_{t-1}, entities, triples)
  (R_t, q_t, sufficient) = JudgeSufficiency(q_0, D_t, G_t)
  if sufficient: break
  D_{t+1} = Retriever(q_t)
return { answer, iterations, graph, allDocuments, reasoning }
```

<verify>
- Loop terminates on sufficient or maxIterations
- Graph updated each iteration
- All documents accumulated
- Reasoning history tracked
</verify>
</task>

<task id="4" name="Implement answer generation" depends_on="3">
Generate final answer using accumulated context.

```typescript
async generateAnswer(
  query: string,
  documents: ChunkWithScore[],
  graph: KnowledgeGraph
): Promise<string>
```

Prompt includes:
- Original query
- All retrieved documents
- Linearized knowledge graph

<verify>
- Uses all accumulated documents
- Includes graph context
- Returns coherent answer
</verify>
</task>

## acceptance_criteria

Goal: Multi-hop iterative retrieval with knowledge graph

- [ ] IterativeRetriever class created
- [ ] Sufficiency judgment with LLM
- [ ] Retrieval loop follows paper algorithm
- [ ] Sub-query generation for insufficient context
- [ ] Answer generation with graph context
- [ ] Iteration count and reasoning tracked
