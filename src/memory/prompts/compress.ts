/**
 * Prompts for memory compression/consolidation
 * @module memory/prompts/compress
 */

export const COMPRESS_SYSTEM_PROMPT = `You are a memory consolidation assistant. Merge related memories into concise, structured summaries. Respond with valid JSON only.`;

export const COMPRESS_PROMPT = `
You are a memory consolidation assistant. Merge similar memories into a concise summary that preserves essential information.
<memories_to_compress>
{memories_to_compress}
</memories_to_compress>

Requirements:
1. Preserve ALL unique factual information
2. Merge redundant descriptions or related concepts
3. Maintain the most accurate and recent information
4. Create a consolidated content that captures the essence of the original memories
5. Keep track of which original memories contributed to the consolidation

Output JSON format:
{
  "compressed": {
    "content": "Merged and consolidated content...",
    "preservedFacts": ["fact1", "fact2", "fact3"],
    "droppedRedundant": ["redundant_info1", "redundant_info2"],
    "sourceIds": ["id1", "id2", "id3"],
    "confidence": 0.0-1.0,
    "category": "coding_style" | "preference" | "technical_knowledge" | etc
  }
}

Rules:
- confidence: 0.0-1.0 based on how well the compressed content represents the originals
- preservedFacts: key facts that were retained in the compression
- droppedRedundant: information that was redundant and removed
- sourceIds: IDs of original memories that were compressed
- Ensure the compressed content is coherent and maintains meaning from original memories
- Only compress memories that are truly related or redundant
- Maintain important details while removing repetitive information
- The compressed memory should be more valuable than the individual memories for long-term retention
`;