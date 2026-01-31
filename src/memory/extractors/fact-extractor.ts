/**
 * Fact Extractor for Memory Reflection
 * 
 * Provides fact extraction functionality for the memory system using LLMs with rule-based fallback.
 * @module memory/extractors/fact-extractor
 */

import { callLLMWithJSON } from '../../distill/llm-client.js';
import { EXTRACT_FACTS_PROMPT, EXTRACT_FACTS_SYSTEM_PROMPT } from '../prompts/extract-facts.js';
import { containsPII } from '../types.js';
import type { Memory, MemoryLayer, ReflectOutput, ReflectFact } from '../types.js';

export interface ExtractFactsOptions {
  sourceMemories?: Memory[];
  content?: string;
  minConfidence?: number;
}

/**
 * Extract facts from content or memories using LLM with rule-based fallback
 */
export async function extractFacts(options: ExtractFactsOptions): Promise<ReflectOutput> {
  const { sourceMemories, content, minConfidence = 0.5 } = options;
  let result: ReflectOutput;

  try {
    // Prepare content for LLM
    let extractionContent = content || '';
    if (sourceMemories && sourceMemories.length > 0) {
      // Combine content from memories if no direct content provided
      if (!content) {
        extractionContent = sourceMemories.map(mem => `[${mem.layer}] ${mem.id}: ${mem.content}`).join('\n');
      }
    }

    // If there's content to extract from, use LLM
    if (extractionContent.trim()) {
      // Create prompt with the content
      const prompt = EXTRACT_FACTS_PROMPT.replace('{content}', extractionContent);
      
      // Call LLM to extract facts
      const llmResult = await callLLMWithJSON<{ facts: any[] }>(prompt, EXTRACT_FACTS_SYSTEM_PROMPT);
      
      if (llmResult.data && llmResult.data.facts) {
        // Transform LLM output to required format with validation
        const facts: ReflectFact[] = [];
        for (const fact of llmResult.data.facts) {
          // Apply PII/Secret detection
          const hasPII = fact.content && containsPII(fact.content);
          if (hasPII) {
            fact.sensitive = true;
            fact.shouldStore = false;
          }

          facts.push({
            content: fact.content || '',
            type: fact.type || 'fact',
            confidence: Math.max(minConfidence, fact.confidence || 0.6),
            evidenceEpisodeIds: Array.isArray(fact.evidenceEpisodeIds) ? fact.evidenceEpisodeIds : [],
            shouldStore: fact.shouldStore !== false, // Default to true if not explicitly false
            sensitive: fact.sensitive || hasPII || false,
            subject: fact.subject,
            predicate: fact.predicate,
            object: fact.object,
            category: fact.category || 'fact',
          });
        }

        result = {
          facts,
          source: 'llm',
        };
      } else {
        // LLM extraction failed, use rule-based fallback
        result = await extractFactsRuleBased(sourceMemories, content, minConfidence);
        result.source = 'fallback';
        if (llmResult.error) {
          result.llmError = llmResult.error;
        }
      }
    } else {
      // No content to extract from, use rule-based approach on memories
      result = await extractFactsRuleBased(sourceMemories, content, minConfidence);
      result.source = 'fallback';
    }
  } catch (error) {
    // LLM extraction failed, use rule-based fallback
    result = await extractFactsRuleBased(sourceMemories, content, minConfidence);
    result.source = 'fallback';
    result.llmError = error instanceof Error ? error.message : String(error);
  }

  return result;
}

/**
 * Rule-based fact extraction from content (fallback implementation)
 */
function extractFactsFromContent(content: string, minConfidence: number): ReflectFact[] {
  const facts: ReflectFact[] = [];
  const lowerContent = content.toLowerCase();

  // Extract simple user preferences patterns
  const preferencePatterns = [
    /user prefers ([^.,;]+)/gi,
    /likes ([^.,;]+)/gi,
    /prefers ([^.,;]+)/gi,
    /enjoys ([^.,;]+)/gi,
    /uses ([^.,;]+)/gi,
    /likes to use ([^.,;]+)/gi,
  ];

  for (const pattern of preferencePatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (match && match[1] !== undefined) {
        facts.push({
          content: match[1].trim(),
          type: 'preference',
          confidence: Math.min(0.7, minConfidence + 0.2), // Default confidence for pattern matches
          evidenceEpisodeIds: [],
          shouldStore: true,
          sensitive: false,
          category: 'preference',
        });
      }
    }
  }

  // Extract simple facts patterns
  const factPatterns = [
    /([^.,;]+) is ([^.,;]+)/gi,
    /([^.,;]+) are ([^.,;]+)/gi,
  ];

  for (const pattern of factPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (match && match[1] !== undefined && match[2] !== undefined) {
        const subject = match[1].trim();
        const object = match[2].trim();
        
        facts.push({
          content: `${subject} is ${object}`,
          type: 'fact',
          confidence: Math.min(0.6, minConfidence + 0.1),
          evidenceEpisodeIds: [],
          shouldStore: true,
          sensitive: false,
          subject,
          predicate: 'is',
          object,
        });
      }
    }
  }

  return facts;
}

/**
 * Rule-based fact extraction as fallback (when LLM is unavailable or fails)
 */
async function extractFactsRuleBased(sourceMemories: Memory[] | undefined, content: string | undefined, minConfidence: number): Promise<ReflectOutput> {
  const facts: ReflectFact[] = [];

  // If content is provided directly, extract from it
  if (content) {
    const extractedFacts = extractFactsFromContent(content, minConfidence);
    facts.push(...extractedFacts);
  }

  // If source memories are provided, extract from them
  if (sourceMemories && sourceMemories.length > 0) {
    for (const memory of sourceMemories) {
      const hasPII = containsPII(memory.content);
      if (!hasPII) { // Only extract if no PII detected
        const memoryFacts = extractFactsFromMemory(memory, minConfidence);
        facts.push(...memoryFacts);
      } else {
        // If PII is detected, still create a fact but mark it appropriately
        facts.push({
          content: memory.content,
          type: 'fact',
          confidence: 0.9, // High confidence that this is sensitive
          evidenceEpisodeIds: [memory.id],
          shouldStore: false, // Don't store sensitive info
          sensitive: true,
          category: 'sensitive_info',
        });
      }
    }
  }

  return {
    facts,
    source: 'fallback',
  };
}

/**
 * Extract facts from a memory object
 */
function extractFactsFromMemory(memory: Memory, minConfidence: number): ReflectFact[] {
  // Add the memory's content as fact evidence
  return [{
    content: memory.content,
    type: memory.layer === 'episodic' ? 'fact' : (memory.layer as 'fact' | 'relation' | 'preference'),
    confidence: Math.min(0.8, minConfidence + 0.3),
    evidenceEpisodeIds: [memory.id],
    shouldStore: true,
    sensitive: containsPII(memory.content), // Check for PII/Secrets
    category: (memory.metadata as any).type || memory.layer,
  }];
}