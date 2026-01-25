/**
 * Multi-hop Context Completer - Automatically complete incomplete retrieval results.
 * 
 * @module rag/context-completer
 * 
 * Based on MiRAGE paper (arXiv 2601.15487) context.py
 * 
 * ## Problem
 * Retrieved chunks may have dangling references:
 * - "as mentioned above..."
 * - "see below..."
 * - "the following table shows..." (but table not in current chunk)
 * 
 * ## Solution
 * Automatically detect incomplete chunks and retrieve missing content.
 * 
 * ## Cost
 * - 1-3 extra LLM calls per query (depends on maxDepth)
 * - N extra vector searches (N = missingReferences.length)
 * 
 * ## Usage
 * options.enableContextCompletion = true (default: true)
 * options.maxHops = 2 (default: max 2 hops)
 */

import type { SemanticChunk } from '../bridge/types.js';
import type { ChromaVectorDB } from '../vectordb/chroma-client.js';
import type { QueryFilter } from '../vectordb/types.js';
import type { RAGConfig } from './types.js';
import { callLLM, callLLMWithJSON, getLLMConfig } from '../distill/llm-client.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('context-completer');

// ============================================================================
// Types
// ============================================================================

export interface ContextCompletionResult {
  /** Final context chunks */
  chunks: SemanticChunk[];
  /** Number of hops performed */
  hopCount: number;
  /** Search queries used */
  searchHistory: string[];
  /** Whether context is complete */
  isComplete: boolean;
}

export interface CompletionOptions {
  /** Max depth for multi-hop (default: 2) */
  maxDepth?: number;
  /** Max breadth per hop (default: 5) */
  maxBreadth?: number;
}

export interface ContextCompleterDeps {
  /** ChromaDB for retrieval */
  chromaDB: ChromaVectorDB;
  /** Embedding function */
  embedding: RAGConfig['embedding'];
  /** Optional filter for retrieval (bundleId, repoId) */
  filter?: QueryFilter;
}

interface CompletenessVerification {
  isComplete: boolean;
  missingReferences: string[];
}

type ChunkRelevance = 'EXPLANATORY' | 'RELATED' | 'IRRELEVANT';

// ============================================================================
// Context Completer Class
// ============================================================================

/**
 * Multi-hop Context Completer.
 * Uses LLM to detect dangling references and retrieves additional chunks.
 */
export class ContextCompleter {
  private chromaDB: ChromaVectorDB;
  private embedding: RAGConfig['embedding'];
  private filter?: QueryFilter;

  constructor(deps: ContextCompleterDeps) {
    this.chromaDB = deps.chromaDB;
    this.embedding = deps.embedding;
    this.filter = deps.filter;
  }

  /**
   * Update the filter for retrieval.
   */
  setFilter(filter?: QueryFilter): void {
    this.filter = filter;
  }

  /**
   * Complete context by detecting and retrieving missing references.
   * If LLM is not enabled, returns chunks unchanged.
   */
  async complete(
    initialChunks: SemanticChunk[],
    options?: CompletionOptions
  ): Promise<ContextCompletionResult> {
    // Check if LLM is enabled - skip completion if not
    const llmConfig = getLLMConfig();
    if (!llmConfig.enabled || !llmConfig.apiKey) {
      logger.debug('LLM not enabled, skipping context completion');
      return {
        chunks: initialChunks,
        hopCount: 0,
        searchHistory: [],
        isComplete: true,
      };
    }

    const maxDepth = options?.maxDepth ?? 2;
    const maxBreadth = options?.maxBreadth ?? 5;

    let currentChunks = [...initialChunks];
    let depth = 0;
    const searchHistory: string[] = [];
    const seenChunkIds = new Set(initialChunks.map(c => c.id));

    while (depth < maxDepth) {
      depth++;

      // 1. Check if current chunks are complete
      const verification = await this.verifyCompleteness(currentChunks);
      
      if (verification.isComplete) {
        logger.debug(`Context complete after ${depth - 1} hops`);
        return {
          chunks: currentChunks,
          hopCount: depth - 1,
          searchHistory,
          isComplete: true,
        };
      }

      // 2. Generate search queries from missing references
      const searchQueries = verification.missingReferences.slice(0, maxBreadth);
      logger.debug(`Hop ${depth}: searching for ${searchQueries.length} missing references`);
      searchHistory.push(...searchQueries);

      // 3. Retrieve additional chunks
      const additionalChunks: SemanticChunk[] = [];

      for (const query of searchQueries) {
        try {
          const { vector } = await this.embedding.embed(query);
          const result = await this.chromaDB.queryChunks(vector, 3, this.filter);

          // 4. Verify each candidate's relevance
          for (const candidate of result.chunks) {
            // Skip if already seen
            if (seenChunkIds.has(candidate.id)) continue;

            const relevance = await this.verifyChunkAddition(
              currentChunks,
              query,
              candidate
            );

            if (relevance === 'EXPLANATORY' || relevance === 'RELATED') {
              // Convert to SemanticChunk format
              const semanticChunk: SemanticChunk = {
                id: candidate.id,
                content: candidate.content,
                chunkType: (candidate.metadata.chunkType as SemanticChunk['chunkType']) ?? 'text',
                isComplete: true,
                metadata: {
                  sourceType: candidate.metadata.sourceType,
                  bundleId: candidate.metadata.bundleId,
                  repoId: candidate.metadata.repoId,
                  filePath: candidate.metadata.filePath,
                  chunkIndex: candidate.metadata.chunkIndex,
                },
              };
              additionalChunks.push(semanticChunk);
              seenChunkIds.add(candidate.id);
              logger.debug(`Added chunk ${candidate.id} (relevance: ${relevance})`);
            }
          }
        } catch (err) {
          logger.warn(`Failed to search for "${query}": ${err}`);
        }
      }

      // No new chunks found, stop searching
      if (additionalChunks.length === 0) {
        logger.debug(`No additional chunks found at hop ${depth}`);
        return {
          chunks: currentChunks,
          hopCount: depth,
          searchHistory,
          isComplete: false,
        };
      }

      currentChunks = [...currentChunks, ...additionalChunks];
    }

    return {
      chunks: currentChunks,
      hopCount: depth,
      searchHistory,
      isComplete: false, // Hit max depth
    };
  }

  /**
   * Use LLM to check if chunks have dangling references.
   */
  private async verifyCompleteness(
    chunks: SemanticChunk[]
  ): Promise<CompletenessVerification> {
    if (chunks.length === 0) {
      return { isComplete: true, missingReferences: [] };
    }

    // Build context text
    const contextText = chunks
      .map((chunk, i) => `[${i + 1}] ${chunk.content.slice(0, 500)}`)
      .join('\n\n');

    const prompt = `Analyze the following context and identify any dangling references - mentions of content that is not present in the context.

Look for:
- "as mentioned above/below" without the referenced content
- "see X" or "refer to X" where X is not present
- "the following table/figure/code" without the actual content
- Incomplete explanations that reference external content
- Terms or concepts mentioned but not explained

Context:
${contextText}

Respond in JSON format:
{
  "isComplete": true/false,
  "missingReferences": ["search query 1", "search query 2", ...]
}

If the context is self-contained, return {"isComplete": true, "missingReferences": []}.
Otherwise, list search queries that would help find the missing content.
Limit to 5 most important missing references.

Response:`;

    try {
      const result = await callLLMWithJSON<CompletenessVerification>(prompt);
      
      if (result.data) {
        return {
          isComplete: result.data.isComplete ?? true,
          missingReferences: result.data.missingReferences ?? [],
        };
      }
    } catch (err) {
      logger.warn(`Failed to verify completeness: ${err}`);
    }

    // Default to complete if LLM fails
    return { isComplete: true, missingReferences: [] };
  }

  /**
   * Verify if a candidate chunk is relevant to the missing reference.
   */
  private async verifyChunkAddition(
    currentChunks: SemanticChunk[],
    searchQuery: string,
    candidate: { id: string; content: string }
  ): Promise<ChunkRelevance> {
    // Build brief context summary
    const contextSummary = currentChunks
      .slice(0, 3)
      .map(c => c.content.slice(0, 200))
      .join('\n---\n');

    const prompt = `You are evaluating whether a candidate chunk should be added to the context.

Search Query (what we're looking for): ${searchQuery}

Existing Context Summary:
${contextSummary}

Candidate Chunk:
${candidate.content.slice(0, 800)}

Classify the candidate chunk:
- EXPLANATORY: Directly explains or provides the missing reference
- RELATED: Contains related information that helps understand the context
- IRRELEVANT: Not related to the search query or existing context

Respond with exactly one word: EXPLANATORY, RELATED, or IRRELEVANT`;

    try {
      const response = await callLLM(prompt);
      const relevance = response.content.trim().toUpperCase();
      
      if (relevance === 'EXPLANATORY' || relevance === 'RELATED' || relevance === 'IRRELEVANT') {
        return relevance;
      }
    } catch (err) {
      logger.warn(`Failed to verify chunk relevance: ${err}`);
    }

    // Default to IRRELEVANT if LLM fails
    return 'IRRELEVANT';
  }
}

// ============================================================================
// Standalone Functions (for backward compatibility)
// ============================================================================

/**
 * Multi-hop context completion.
 * 
 * @deprecated Use ContextCompleter class instead for full functionality.
 * This function requires deps to be passed for actual multi-hop completion.
 */
export async function completeContext(
  initialChunks: SemanticChunk[],
  options?: CompletionOptions,
  deps?: ContextCompleterDeps
): Promise<ContextCompletionResult> {
  // If deps provided, use full implementation
  if (deps) {
    const completer = new ContextCompleter(deps);
    return completer.complete(initialChunks, options);
  }

  // Without deps, return chunks unchanged (legacy behavior)
  return {
    chunks: initialChunks,
    hopCount: 0,
    searchHistory: [],
    isComplete: true,
  };
}

/**
 * Check if chunks have dangling references.
 * Uses LLM to detect incomplete context.
 */
export async function verifyChunkCompleteness(
  chunks: SemanticChunk[]
): Promise<{ isComplete: boolean; missingReferences: string[] }> {
  if (chunks.length === 0) {
    return { isComplete: true, missingReferences: [] };
  }

  // Build context text
  const contextText = chunks
    .map((chunk, i) => `[${i + 1}] ${chunk.content.slice(0, 500)}`)
    .join('\n\n');

  const prompt = `Analyze the following context and identify dangling references.

Context:
${contextText}

Respond in JSON:
{"isComplete": true/false, "missingReferences": ["query1", "query2", ...]}

Response:`;

  try {
    const result = await callLLMWithJSON<{ isComplete: boolean; missingReferences: string[] }>(prompt);
    
    if (result.data) {
      return {
        isComplete: result.data.isComplete ?? true,
        missingReferences: result.data.missingReferences ?? [],
      };
    }
  } catch (err) {
    logger.warn(`Failed to verify completeness: ${err}`);
  }

  return { isComplete: true, missingReferences: [] };
}
