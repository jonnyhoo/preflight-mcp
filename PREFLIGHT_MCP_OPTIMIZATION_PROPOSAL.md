# Preflight MCP Optimization Proposal: "LLM-Native" Experience

## 1. Executive Summary
After a deep dive into the `mcp-deep-think-barl` bundle using the current Preflight MCP toolset, I have identified several opportunities to make the experience significantly more "LLM-friendly." The current tools are robust but sometimes optimized for *human* consumption (stats, strict separation of concerns) rather than *LLM* consumption (dense context, auto-inference, token efficiency).

This proposal focuses on:
1.  **Correctness**: Fixing false negatives in static analysis (e.g., test detection).
2.  **Context Density**: delivering more *meaning* per token in deep analysis.
3.  **Workflow Compression**: Reducing the number of turns required to "load" a codebase into context.

## 2. Critical Findings & Issues

### 2.1 "Deep Analyze" False Negatives
*   **Observation**: `preflight_deep_analyze_bundle` reported **"No tests detected"** and **"Test coverage checked: [ ]"** for `mcp-deep-think-barl`.
*   **Reality**: The repository contains `src/bayesian-state-machine.test.ts`, `src/verifier.test.ts`, etc.
*   **Impact**: An LLM relying on this summary will hallucinate that the project is untested and might propose creating new tests from scratch, duplicating existing work.
*   **Root Cause**: Likely strict directory matching (`test/`, `__tests__/`) instead of pattern matching (`*.test.ts`, `*.spec.ts`).

### 2.2 Token Inefficiency in Search
*   **Observation**: `preflight_search_and_read` returns a flat list of hits. If a file has 5 hits, the full metadata (path, repo, uri, kind) is repeated 5 times.
*   **Impact**: Wastes valuable context window on JSON boilerplate.
*   **Suggestion**: Default to `groupByFile: true` behavior (like `search_bundle`) but for `search_and_read` as well, nesting hits under a single file header.

### 2.3 `deep_analyze_bundle` is "Too Thin"
*   **Observation**: The tool returns file counts, extension stats, and a dependency count.
*   **Impact**: This metadata is "trivia." It helps an LLM *navigate*, but not *understand*. To actually work on the code, I immediately had to follow up with `read_file` or `search_and_read`.
*   **Suggestion**: The "Deep Analyze" should be a "Context Loader." It should include the *outline* (signatures) of the top 3 most-imported files.

## 3. Optimization Proposals

### Proposal A: "Smart Context" Mode for `deep_analyze_bundle`
Transform `deep_analyze_bundle` from a "stats reporter" to a "context primer."

**New Output Format:**
```json
{
  "summary": "TypeScript project with 21 files. Core logic in `bayesian-state-machine.ts`.",
  "structure": "<tree_view>",
  "tests": {
    "status": "detected",
    "patterns": ["*.test.ts"],
    "files": ["src/bayesian-state-machine.test.ts", ...]
  },
  "key_files": [
    {
      "path": "src/types.ts",
      "reason": "Most imported (5 dependents)",
      "content_outline": "interface BayesianFeedback { ... } ..." 
    },
    {
      "path": "src/index.ts",
      "reason": "Entry point",
      "content_summary": "Main server setup using @modelcontextprotocol/sdk."
    }
  ]
}
```
*   **Benefit**: The LLM gets the *shape* of the code immediately, not just the *shape* of the file system.

### Proposal B: Fix Test & Entry Point Heuristics
*   **Action**: Update the internal heuristic for `includeTests` to scan for `*.test.*`, `*.spec.*`, `*_test.*` files, not just directories.
*   **Action**: Improve `entry point` detection to prioritize `index.ts`/`main.ts` in `src/` over config files like `package.json` (which are less useful as "code" entry points).

### Proposal C: Auto-Traceability (Low Hanging Fruit)
*   **Observation**: `trace_query` returned nothing ("not_initialized").
*   **Action**: If no manual traces exist, implementing a simple regex-based "implied trace" would be powerful.
    *   *Rule*: `foo.test.ts` imports `foo.ts` -> Implied `tested_by` link.
*   **Benefit**: Makes `trace_query` useful out-of-the-box without requiring a separate "upsert" workflow.

### Proposal D: "Read Core" Shortcut
*   **New Tool / Option**: `preflight_read_core` (or `mode: "core"` in `read_file`).
*   **Behavior**: Automatically identifies the top 20% of files by centrality (PageRank on dependency graph) and reads them (full content or outline) until `tokenBudget` is hit.
*   **Use Case**: "I want to start coding on this repo. Give me the context." (One shot).

## 4. Conclusion
Preflight MCP is a powerful "file system over wire" tool. To become "LLM Native," it needs to shift from **providing access** (files, searches) to **providing understanding** (patterns, outlines, relationships). The biggest immediate win is fixing the test detection and making `deep_analyze` provide actual code context.
