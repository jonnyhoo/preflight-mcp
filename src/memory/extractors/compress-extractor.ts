/**
 * Compress Extractor for Memory Consolidation
 * 
 * Provides memory compression/consolidation functionality for the memory system using LLMs with rule-based fallback.
 * @module memory/extractors/compress-extractor
 */

import { callLLMWithJSON } from '../../distill/llm-client.js';
import { COMPRESS_PROMPT, COMPRESS_SYSTEM_PROMPT } from '../prompts/compress.js';
import type { Memory, MemoryLayer } from '../types.js';

export interface CompressOptions {
  memoriesToCompress: Memory[];
  minConfidence?: number;
  userId?: string;
}

export interface CompressedMemory {
  content: string;
  preservedFacts: string[];
  droppedRedundant: string[];
  sourceIds: string[];
  confidence: number;
  category: string;
}

export interface CompressResult {
  compressed: CompressedMemory[];
  source: 'llm' | 'fallback';
  llmError?: string;
}

/**
 * Compress/consolidate multiple memories into fewer, more meaningful representations using LLM with rule-based fallback
 */
export async function compressMemories(options: CompressOptions): Promise<CompressResult> {
  const { memoriesToCompress, minConfidence = 0.5, userId } = options;
  let result: CompressResult;

  try {
    if (memoriesToCompress.length === 0) {
      return {
        compressed: [],
        source: 'fallback',
      };
    }

    // Prepare content for LLM - convert memories to text format
    const memoriesContent = memoriesToCompress.map(mem => `[${mem.layer}] ID:${mem.id} - ${mem.content}`).join('\n---\n');

    // Create prompt with the memories content
    const prompt = COMPRESS_PROMPT.replace('{memories_to_compress}', memoriesContent);
    
    // Call LLM to compress memories
    const llmResult = await callLLMWithJSON<{ compressed: any }>(prompt, COMPRESS_SYSTEM_PROMPT);
    
    if (llmResult.data && llmResult.data.compressed) {
      // Handle both single compressed object and array of compressed objects
      const compressedData = Array.isArray(llmResult.data.compressed) ? llmResult.data.compressed : [llmResult.data.compressed];
      
      const compressedMemories: CompressedMemory[] = compressedData.map(comp => ({
        content: comp.content || '',
        preservedFacts: Array.isArray(comp.preservedFacts) ? comp.preservedFacts : [],
        droppedRedundant: Array.isArray(comp.droppedRedundant) ? comp.droppedRedundant : [],
        sourceIds: Array.isArray(comp.sourceIds) ? comp.sourceIds : [],
        confidence: Math.max(minConfidence, comp.confidence || 0.6),
        category: comp.category || 'compressed',
      }));

      result = {
        compressed: compressedMemories,
        source: 'llm',
      };
    } else {
      // LLM compression failed, use rule-based fallback
      result = await compressMemoriesRuleBased(memoriesToCompress, minConfidence);
      result.source = 'fallback';
      if (llmResult.error) {
        result.llmError = llmResult.error;
      }
    }
  } catch (error) {
    // LLM compression failed, use rule-based fallback
    result = await compressMemoriesRuleBased(memoriesToCompress, minConfidence);
    result.source = 'fallback';
    result.llmError = error instanceof Error ? error.message : String(error);
  }

  return result;
}

/**
 * Rule-based memory compression as fallback (when LLM is unavailable or fails)
 */
async function compressMemoriesRuleBased(memoriesToCompress: Memory[], minConfidence: number): Promise<CompressResult> {
  if (memoriesToCompress.length === 0) {
    return {
      compressed: [],
      source: 'fallback',
    };
  }

  // Simple rule-based approach: group by layer/type and create summaries
  const compressed: CompressedMemory[] = [];
  const byLayer: Record<MemoryLayer, Memory[]> = {
    episodic: [],
    semantic: [],
    procedural: [],
  };

  // Group memories by layer
  for (const memory of memoriesToCompress) {
    byLayer[memory.layer].push(memory);
  }

  // Create a compressed memory for each layer that has items
  for (const [layer, layerMemories] of Object.entries(byLayer)) {
    if (layerMemories.length > 0) {
      // Create a summary content from the memories in this layer
      const summaryContent = layerMemories.map(m => m.content).join(' ... ');
      const sourceIds = layerMemories.map(m => m.id);
      
      compressed.push({
        content: `Summary of ${layerMemories.length} ${layer} memories: ${summaryContent.substring(0, 500)}${summaryContent.length > 500 ? '...' : ''}`,
        preservedFacts: layerMemories.map(m => m.content.substring(0, 100)), // First 100 chars as preserved facts
        droppedRedundant: [], // No specific redundant info in this simple approach
        sourceIds,
        confidence: Math.min(0.6, minConfidence + (layerMemories.length * 0.05)), // Slightly higher confidence for more memories
        category: `${layer}_summary`,
      });
    }
  }

  return {
    compressed,
    source: 'fallback',
  };
}