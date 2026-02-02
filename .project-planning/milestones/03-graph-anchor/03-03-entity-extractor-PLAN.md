---
stage: 1
depends_on: []
files_modified:
  - src/graph/entity-extractor.ts
autonomous: true
---

# Plan: Entity Extractor Implementation

## Goal
Implement LLM-based entity and triple extraction from document chunks, with structured output parsing and confidence scoring.

## Tasks

<task id="1" name="Create EntityExtractor class">
Create `src/graph/entity-extractor.ts` with LLM-based extraction.

```typescript
// src/graph/entity-extractor.ts

/**
 * Entity Extractor - LLM-based entity and triple extraction.
 * Extracts knowledge graph elements from document chunks.
 * @module graph/entity-extractor
 */

import {
  type ExtractionResult,
  type ExtractionOptions,
  type RelationType,
  DEFAULT_EXTRACTION_OPTIONS,
} from './types.js';
import { callLLMWithJSON, getLLMConfig } from '../distill/llm-client.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('entity-extractor');

// ============================================================================
// Extraction Prompts
// ============================================================================

const EXTRACTION_SYSTEM_PROMPT = `You are a knowledge graph extraction expert. Extract entities and relations from text.

RULES:
1. Extract named entities: concepts, methods, metrics, people, organizations, tools
2. Extract relations between entities as triples: (head, relation, tail)
3. Use consistent entity names (e.g., "BERT" not "the BERT model")
4. Assign confidence scores (0-1) based on how explicit the information is
5. Include brief evidence snippets for triples

RELATION TYPES:
- is_a: Taxonomy (X is a type of Y)
- part_of: Composition (X is part of Y)
- has_property: Attribute (X has property Y)
- uses: Usage (X uses Y)
- produces: Output (X produces Y)
- related_to: General relation
- compared_to: Comparison
- improves: Enhancement
- extends: Extension
- implements: Implementation

Output JSON format:
{
  "entities": [
    {
      "name": "Entity Name",
      "entityType": "CONCEPT|METHOD|METRIC|PERSON|ORG|TOOL",
      "attributes": ["attr1", "attr2"],
      "confidence": 0.9
    }
  ],
  "triples": [
    {
      "headName": "Entity A",
      "relation": "uses",
      "tailName": "Entity B",
      "confidence": 0.85,
      "evidence": "brief quote from text"
    }
  ]
}`;

function buildExtractionPrompt(
  content: string,
  query?: string,
  previousReasoning?: string,
  options?: ExtractionOptions
): string {
  const maxEntities = options?.maxEntitiesPerChunk ?? DEFAULT_EXTRACTION_OPTIONS.maxEntitiesPerChunk;
  const maxTriples = options?.maxTriplesPerChunk ?? DEFAULT_EXTRACTION_OPTIONS.maxTriplesPerChunk;
  
  let prompt = `Extract entities and relations from the following text.

TEXT:
${content}

CONSTRAINTS:
- Maximum ${maxEntities} entities
- Maximum ${maxTriples} triples
- Minimum confidence: ${options?.minConfidence ?? DEFAULT_EXTRACTION_OPTIONS.minConfidence}`;

  if (query) {
    prompt += `\n\nFOCUS: Prioritize entities and relations relevant to this query: "${query}"`;
  }

  if (previousReasoning) {
    prompt += `\n\nCONTEXT: Previous reasoning identified these as important:\n${previousReasoning}`;
  }

  if (options?.entityTypes && options.entityTypes.length > 0) {
    prompt += `\n\nENTITY TYPES TO FOCUS ON: ${options.entityTypes.join(', ')}`;
  }

  prompt += '\n\nExtract entities and triples as JSON:';
  
  return prompt;
}

// ============================================================================
// Response Types
// ============================================================================

interface ExtractedEntity {
  name: string;
  entityType?: string;
  attributes?: string[];
  confidence?: number;
}

interface ExtractedTriple {
  headName: string;
  relation: string;
  tailName: string;
  confidence?: number;
  evidence?: string;
}

interface ExtractionResponse {
  entities?: ExtractedEntity[];
  triples?: ExtractedTriple[];
}

// ============================================================================
// EntityExtractor Class
// ============================================================================

/**
 * LLM-based entity and triple extractor.
 */
export class EntityExtractor {
  private options: Required<ExtractionOptions>;

  constructor(options?: ExtractionOptions) {
    this.options = { ...DEFAULT_EXTRACTION_OPTIONS, ...options };
  }

  /**
   * Extract entities and triples from a single chunk.
   * 
   * @param content - Text content to extract from
   * @param sourceChunkId - ID of the source chunk
   * @param query - Optional query to focus extraction
   * @param previousReasoning - Optional context from previous iterations
   * @returns Extraction result with entities and triples
   */
  async extract(
    content: string,
    sourceChunkId: string,
    query?: string,
    previousReasoning?: string
  ): Promise<ExtractionResult> {
    const llmConfig = getLLMConfig();
    
    if (!llmConfig.enabled || !llmConfig.apiKey) {
      logger.warn('LLM not enabled, returning empty extraction');
      return {
        entities: [],
        triples: [],
        sourceChunkId,
      };
    }

    const prompt = buildExtractionPrompt(
      content,
      query,
      previousReasoning,
      this.options
    );

    try {
      const result = await callLLMWithJSON<ExtractionResponse>(
        prompt,
        EXTRACTION_SYSTEM_PROMPT
      );

      if (!result.data) {
        logger.warn(`Extraction failed: ${result.error}`);
        return { entities: [], triples: [], sourceChunkId };
      }

      // Process and validate entities
      const entities = this.processEntities(
        result.data.entities || [],
        sourceChunkId
      );

      // Process and validate triples
      const triples = this.processTriples(
        result.data.triples || [],
        entities.map(e => e.name)
      );

      logger.debug(
        `Extracted ${entities.length} entities, ${triples.length} triples from chunk ${sourceChunkId}`
      );

      return {
        entities,
        triples,
        sourceChunkId,
      };
    } catch (err) {
      logger.error(`Extraction error: ${err}`);
      return { entities: [], triples: [], sourceChunkId };
    }
  }

  /**
   * Extract from multiple chunks in batch.
   * 
   * @param chunks - Array of {content, chunkId} pairs
   * @param query - Optional query to focus extraction
   * @param batchSize - Number of parallel extractions (default: 3)
   * @returns Array of extraction results
   */
  async extractBatch(
    chunks: Array<{ content: string; chunkId: string }>,
    query?: string,
    batchSize: number = 3
  ): Promise<ExtractionResult[]> {
    const results: ExtractionResult[] = [];
    
    // Process in batches to avoid rate limits
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(({ content, chunkId }) =>
          this.extract(content, chunkId, query)
        )
      );
      results.push(...batchResults);
    }
    
    return results;
  }

  // --------------------------------------------------------------------------
  // Processing Helpers
  // --------------------------------------------------------------------------

  private processEntities(
    rawEntities: ExtractedEntity[],
    sourceChunkId: string
  ): Array<Omit<import('./types.js').Entity, 'id'>> {
    const minConfidence = this.options.minConfidence;
    const maxEntities = this.options.maxEntitiesPerChunk;
    
    return rawEntities
      .filter(e => {
        // Filter by confidence
        if ((e.confidence ?? 1) < minConfidence) return false;
        // Filter by entity type if specified
        if (this.options.entityTypes.length > 0) {
          if (!e.entityType || !this.options.entityTypes.includes(e.entityType)) {
            return false;
          }
        }
        return true;
      })
      .slice(0, maxEntities)
      .map(e => ({
        name: e.name.trim(),
        normalizedName: e.name.toLowerCase().replace(/[^\w\s]/g, '').trim(),
        entityType: e.entityType,
        attributes: e.attributes || [],
        sourceChunkIds: [sourceChunkId],
        confidence: e.confidence,
      }));
  }

  private processTriples(
    rawTriples: ExtractedTriple[],
    entityNames: string[]
  ): ExtractionResult['triples'] {
    const minConfidence = this.options.minConfidence;
    const maxTriples = this.options.maxTriplesPerChunk;
    const entityNameSet = new Set(entityNames.map(n => n.toLowerCase()));
    
    return rawTriples
      .filter(t => {
        // Filter by confidence
        if ((t.confidence ?? 1) < minConfidence) return false;
        // Validate head and tail exist in extracted entities
        // (relaxed: allow if at least one exists)
        const headExists = entityNameSet.has(t.headName.toLowerCase());
        const tailExists = entityNameSet.has(t.tailName.toLowerCase());
        return headExists || tailExists;
      })
      .slice(0, maxTriples)
      .map(t => ({
        headName: t.headName.trim(),
        relation: this.normalizeRelation(t.relation),
        tailName: t.tailName.trim(),
        confidence: t.confidence,
        evidence: t.evidence?.slice(0, 200), // Truncate evidence
      }));
  }

  private normalizeRelation(relation: string): RelationType {
    // Normalize common variations
    const normalized = relation.toLowerCase().replace(/[_\s]+/g, '_');
    
    const relationMap: Record<string, RelationType> = {
      'is_a': 'is_a',
      'isa': 'is_a',
      'type_of': 'is_a',
      'part_of': 'part_of',
      'partof': 'part_of',
      'has_property': 'has_property',
      'has': 'has_property',
      'uses': 'uses',
      'use': 'uses',
      'used_by': 'uses',
      'produces': 'produces',
      'produce': 'produces',
      'outputs': 'produces',
      'related_to': 'related_to',
      'related': 'related_to',
      'compared_to': 'compared_to',
      'compared': 'compared_to',
      'vs': 'compared_to',
      'improves': 'improves',
      'improve': 'improves',
      'better_than': 'improves',
      'extends': 'extends',
      'extend': 'extends',
      'implements': 'implements',
      'implement': 'implements',
    };
    
    return relationMap[normalized] || relation as RelationType;
  }

  // --------------------------------------------------------------------------
  // Configuration
  // --------------------------------------------------------------------------

  /**
   * Update extraction options.
   */
  setOptions(options: Partial<ExtractionOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * Get current options.
   */
  getOptions(): Required<ExtractionOptions> {
    return { ...this.options };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an EntityExtractor instance.
 */
export function createEntityExtractor(options?: ExtractionOptions): EntityExtractor {
  return new EntityExtractor(options);
}
```

<verify>
- EntityExtractor class compiles without errors
- extract() returns ExtractionResult with entities and triples
- extractBatch() processes multiple chunks with rate limiting
- Confidence filtering works correctly
- Relation normalization handles common variations
- LLM disabled case returns empty result gracefully
</verify>
</task>

<task id="2" name="Add extractor to module exports" depends_on="1">
Update `src/graph/index.ts` to export EntityExtractor.

```typescript
// Add to src/graph/index.ts

export {
  EntityExtractor,
  createEntityExtractor,
} from './entity-extractor.js';
```

<verify>
- EntityExtractor is exported from src/graph/index.ts
- createEntityExtractor factory function is exported
</verify>
</task>

<task id="3" name="Create extraction prompt variants for different content types" depends_on="1">
Add specialized prompts for different content types (papers, code, documentation).

```typescript
// Add to src/graph/entity-extractor.ts

// ============================================================================
// Content-Type Specific Prompts
// ============================================================================

const PAPER_EXTRACTION_HINTS = `
PAPER-SPECIFIC GUIDANCE:
- Extract: methods, datasets, metrics, baselines, architectures
- Look for: "we propose", "our method", "compared to", "achieves"
- Capture: performance numbers as attributes (e.g., "accuracy: 95.2%")
- Relations: "outperforms", "based_on", "evaluated_on"
`;

const CODE_EXTRACTION_HINTS = `
CODE-SPECIFIC GUIDANCE:
- Extract: classes, functions, modules, APIs, dependencies
- Look for: imports, class definitions, function signatures
- Capture: parameters, return types as attributes
- Relations: "imports", "extends", "implements", "calls"
`;

const DOC_EXTRACTION_HINTS = `
DOCUMENTATION-SPECIFIC GUIDANCE:
- Extract: features, commands, configurations, concepts
- Look for: headings, bullet points, code examples
- Capture: usage patterns, options as attributes
- Relations: "configures", "enables", "requires", "depends_on"
`;

/**
 * Content type for specialized extraction.
 */
export type ContentType = 'paper' | 'code' | 'documentation' | 'general';

/**
 * Get content-type specific hints for extraction.
 */
export function getContentTypeHints(contentType: ContentType): string {
  switch (contentType) {
    case 'paper':
      return PAPER_EXTRACTION_HINTS;
    case 'code':
      return CODE_EXTRACTION_HINTS;
    case 'documentation':
      return DOC_EXTRACTION_HINTS;
    default:
      return '';
  }
}
```

<verify>
- ContentType type is defined
- getContentTypeHints returns appropriate hints for each type
- Hints are integrated into extraction prompt when content type is specified
</verify>
</task>

## Acceptance Criteria

Goal: Implement LLM-based entity and triple extraction from document chunks

- [ ] EntityExtractor class extracts entities with: name, entityType, attributes, confidence
- [ ] EntityExtractor class extracts triples with: headName, relation, tailName, confidence, evidence
- [ ] extract() method calls LLM with structured prompt and parses JSON response
- [ ] extractBatch() processes multiple chunks with configurable batch size
- [ ] Confidence filtering removes low-confidence extractions
- [ ] Relation normalization handles common variations (e.g., "uses" vs "use")
- [ ] Entity type filtering works when entityTypes option is set
- [ ] Graceful fallback when LLM is not enabled
- [ ] Content-type specific hints available for papers, code, documentation
- [ ] createEntityExtractor factory function works
