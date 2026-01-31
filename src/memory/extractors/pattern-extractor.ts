/**
 * Pattern Extractor for Memory Reflection
 * 
 * Provides pattern extraction functionality for the memory system using LLMs with rule-based fallback.
 * @module memory/extractors/pattern-extractor
 */

import { callLLMWithJSON } from '../../distill/llm-client.js';
import { EXTRACT_PATTERNS_PROMPT, EXTRACT_PATTERNS_SYSTEM_PROMPT } from '../prompts/extract-patterns.js';
import type { Memory, ReflectOutput, ReflectFact } from '../types.js';

export interface ExtractPatternsOptions {
  semanticMemories: Memory[];
  minConfidence?: number;
  userId?: string;
}

/**
 * Extract patterns from semantic memories using LLM with rule-based fallback
 */
export async function extractPatterns(options: ExtractPatternsOptions): Promise<ReflectOutput> {
  const { semanticMemories, minConfidence = 0.5, userId } = options;
  let result: ReflectOutput;

  try {
    // Prepare content for LLM
    const memoriesContent = semanticMemories.map(mem => `[${mem.layer}] ${mem.id}: ${mem.content}`).join('\n');

    // Create prompt with the memories content
    const prompt = EXTRACT_PATTERNS_PROMPT.replace('{semantic_memories}', memoriesContent);
    
    // Call LLM to extract patterns
    const llmResult = await callLLMWithJSON<{ patterns: any[] }>(prompt, EXTRACT_PATTERNS_SYSTEM_PROMPT);
    
    if (llmResult.data && llmResult.data.patterns) {
      // Transform LLM output to required format
      const facts: ReflectFact[] = llmResult.data.patterns.map(pattern => ({
        content: pattern.content || '',
        type: (pattern.type as 'fact' | 'relation' | 'preference') || 'fact',
        confidence: Math.max(minConfidence, pattern.confidence || 0.6),
        evidenceEpisodeIds: pattern.evidenceIds || [],
        shouldStore: pattern.shouldStore !== false, // Default to true if not explicitly false
        sensitive: pattern.sensitive || false,
        subject: pattern.subject,
        predicate: pattern.predicate,
        object: pattern.object,
        category: pattern.category || 'pattern',
      }));

      result = {
        facts,
        source: 'llm',
      };
    } else {
      // LLM extraction failed, use rule-based fallback
      result = await extractPatternsRuleBased(semanticMemories, minConfidence);
      result.source = 'fallback';
      if (llmResult.error) {
        result.llmError = llmResult.error;
      }
    }
  } catch (error) {
    // LLM extraction failed, use rule-based fallback
    result = await extractPatternsRuleBased(semanticMemories, minConfidence);
    result.source = 'fallback';
    result.llmError = error instanceof Error ? error.message : String(error);
  }

  return result;
}

/**
 * Rule-based pattern extraction as fallback (when LLM is unavailable or fails)
 */
async function extractPatternsRuleBased(semanticMemories: Memory[], minConfidence: number): Promise<ReflectOutput> {
  const patterns: ReflectFact[] = [];

  // Group memories by category/type to identify patterns
  const patternsByCategory: Record<string, Memory[]> = {};
  for (const memory of semanticMemories) {
    const category = (memory.metadata as any).category || (memory.metadata as any).type || 'general';
    if (!patternsByCategory[category]) {
      patternsByCategory[category] = [];
    }
    patternsByCategory[category].push(memory);
  }

  // Identify patterns in each category
  for (const [category, memories] of Object.entries(patternsByCategory)) {
    if (memories.length >= 2) { // Pattern requires at least 2 occurrences
      // Create a pattern based on commonalities in this category
      const contents = memories.map(m => m.content).join(' ');
      const evidenceIds = memories.map(m => m.id);
      
      patterns.push({
        content: `User frequently engages with ${category} topics: ${contents.substring(0, 100)}...`,
        type: 'pattern',
        confidence: Math.min(0.7, minConfidence + (memories.length * 0.1)), // Higher confidence for more occurrences
        evidenceEpisodeIds: evidenceIds,
        shouldStore: true,
        sensitive: false, // These are behavioral patterns, not sensitive info
        category,
      });
    }
  }

  return {
    facts: patterns,
    source: 'fallback',
  };
}