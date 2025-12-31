/**
 * Robust JSON Parser for LLM responses.
 * 
 * Implements multiple fallback strategies to parse JSON from LLM outputs,
 * which may contain markdown formatting, escape issues, or other artifacts.
 * 
 * Design reference: RAG-Anything modalprocessors.py:547-674
 */

import { createModuleLogger } from '../../logging/logger.js';

const logger = createModuleLogger('json-parser');

// ============================================================================
// Types
// ============================================================================

/**
 * Standard entity info structure expected in LLM responses.
 */
export interface EntityInfo {
  entity_name?: string;
  entityName?: string;
  entity_type?: string;
  entityType?: string;
  summary?: string;
}

/**
 * Standard modal analysis response structure.
 */
export interface ModalAnalysisResponse {
  detailed_description?: string;
  detailedDescription?: string;
  description?: string;
  entity_info?: EntityInfo;
  entityInfo?: EntityInfo;
  [key: string]: unknown;
}

/**
 * Parse result with metadata.
 */
export interface ParseResult<T = Record<string, unknown>> {
  success: boolean;
  data: T | null;
  method: 'direct' | 'cleanup' | 'quote_fix' | 'regex_fallback';
  warnings?: string[];
}

// ============================================================================
// Main Parser Function
// ============================================================================

/**
 * Robust JSON parsing with multiple fallback strategies.
 * 
 * Strategies (in order):
 * 1. Direct parsing of extracted JSON candidates
 * 2. Basic cleanup (smart quotes, trailing commas) then parse
 * 3. Progressive quote/escape fixing then parse
 * 4. Regex field extraction as last resort
 * 
 * @param response - Raw LLM response string
 * @returns Parsed object or fallback structure
 */
export function robustJsonParse<T = Record<string, unknown>>(
  response: string
): ParseResult<T> {
  if (!response || response.trim().length === 0) {
    return {
      success: false,
      data: null,
      method: 'direct',
      warnings: ['Empty response'],
    };
  }

  const candidates = extractAllJsonCandidates(response);
  
  // Strategy 1: Try direct parsing
  for (const candidate of candidates) {
    const result = tryParseJson<T>(candidate);
    if (result !== null) {
      logger.debug('JSON parsed with direct strategy');
      return { success: true, data: result, method: 'direct' };
    }
  }

  // Strategy 2: Try with basic cleanup
  for (const candidate of candidates) {
    const cleaned = basicJsonCleanup(candidate);
    const result = tryParseJson<T>(cleaned);
    if (result !== null) {
      logger.debug('JSON parsed with cleanup strategy');
      return { success: true, data: result, method: 'cleanup' };
    }
  }

  // Strategy 3: Try progressive quote fixing
  for (const candidate of candidates) {
    const fixed = progressiveQuoteFix(candidate);
    const result = tryParseJson<T>(fixed);
    if (result !== null) {
      logger.debug('JSON parsed with quote fix strategy');
      return { success: true, data: result, method: 'quote_fix' };
    }
  }

  // Strategy 4: Fallback to regex field extraction
  logger.warn('Using regex fallback for JSON parsing');
  const extracted = extractFieldsWithRegex(response);
  return {
    success: extracted !== null,
    data: extracted as T | null,
    method: 'regex_fallback',
    warnings: ['Parsed using regex fallback - some fields may be missing'],
  };
}

// ============================================================================
// JSON Candidate Extraction
// ============================================================================

/**
 * Extract all possible JSON candidates from a response.
 * 
 * Looks for:
 * 1. JSON in markdown code blocks
 * 2. Balanced brace pairs
 * 3. Simple regex match
 */
export function extractAllJsonCandidates(response: string): string[] {
  const candidates: string[] = [];

  // Method 1: JSON in code blocks (```json ... ```)
  const jsonBlockPattern = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
  let match: RegExpExecArray | null;
  while ((match = jsonBlockPattern.exec(response)) !== null) {
    if (match[1]) candidates.push(match[1]);
  }

  // Method 2: Balanced braces extraction
  let braceCount = 0;
  let startPos = -1;

  for (let i = 0; i < response.length; i++) {
    const char = response[i];
    if (char === '{') {
      if (braceCount === 0) {
        startPos = i;
      }
      braceCount++;
    } else if (char === '}') {
      braceCount--;
      if (braceCount === 0 && startPos !== -1) {
        const candidate = response.slice(startPos, i + 1);
        if (!candidates.includes(candidate)) {
          candidates.push(candidate);
        }
        startPos = -1;
      }
    }
  }

  // Method 3: Simple regex fallback (greedy match)
  const simpleMatch = response.match(/\{[\s\S]*\}/);
  if (simpleMatch && !candidates.includes(simpleMatch[0])) {
    candidates.push(simpleMatch[0]);
  }

  return candidates;
}

// ============================================================================
// Parsing Helpers
// ============================================================================

/**
 * Try to parse a JSON string, returning null on failure.
 */
export function tryParseJson<T = Record<string, unknown>>(
  jsonStr: string
): T | null {
  if (!jsonStr || !jsonStr.trim()) {
    return null;
  }

  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    return null;
  }
}

/**
 * Basic cleanup for common JSON issues.
 */
export function basicJsonCleanup(jsonStr: string): string {
  let cleaned = jsonStr.trim();

  // Fix smart quotes (common in LLM outputs)
  cleaned = cleaned
    .replace(/[\u201C\u201D]/g, '"')  // Smart double quotes
    .replace(/[\u2018\u2019]/g, "'"); // Smart single quotes

  // Fix trailing commas before closing brackets
  cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');

  // Fix missing commas between properties (simple cases)
  cleaned = cleaned.replace(/"\s*\n\s*"/g, '",\n"');

  return cleaned;
}

/**
 * Progressive fixing of quote and escape issues.
 */
export function progressiveQuoteFix(jsonStr: string): string {
  let fixed = jsonStr;

  // Fix unescaped backslashes before quotes
  fixed = fixed.replace(/(?<!\\)\\(?=")/g, '\\\\');

  // Fix common escape sequences in string values
  fixed = fixed.replace(/"([^"]*(?:\\.[^"]*)*)"/g, (match, content: string) => {
    // Fix problematic backslash patterns
    let fixedContent = content
      .replace(/\\(?=[a-zA-Z])/g, '\\\\')  // \alpha -> \\alpha
      .replace(/\n/g, '\\n')               // Literal newlines
      .replace(/\r/g, '\\r')               // Literal carriage returns
      .replace(/\t/g, '\\t');              // Literal tabs
    
    return `"${fixedContent}"`;
  });

  // Fix control characters
  fixed = fixed.replace(/[\x00-\x1F\x7F]/g, (char) => {
    const code = char.charCodeAt(0);
    return `\\u${code.toString(16).padStart(4, '0')}`;
  });

  return fixed;
}

// ============================================================================
// Regex Fallback Extraction
// ============================================================================

/**
 * Extract required fields using regex as last resort.
 * Returns a normalized ModalAnalysisResponse structure.
 */
export function extractFieldsWithRegex(
  response: string
): ModalAnalysisResponse | null {
  // Extract detailed_description
  const descPatterns = [
    /"detailed_description"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/s,
    /"detailedDescription"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/s,
    /"description"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/s,
  ];
  
  let description = '';
  for (const pattern of descPatterns) {
    const match = response.match(pattern);
    if (match && match[1]) {
      description = unescapeString(match[1]);
      break;
    }
  }

  // Extract entity_name
  const namePatterns = [
    /"entity_name"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/,
    /"entityName"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/,
    /"name"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/,
  ];
  
  let entityName = 'unknown_entity';
  for (const pattern of namePatterns) {
    const match = response.match(pattern);
    if (match && match[1]) {
      entityName = unescapeString(match[1]);
      break;
    }
  }

  // Extract entity_type
  const typePatterns = [
    /"entity_type"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/,
    /"entityType"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/,
    /"type"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/,
  ];
  
  let entityType = 'unknown';
  for (const pattern of typePatterns) {
    const match = response.match(pattern);
    if (match && match[1]) {
      entityType = unescapeString(match[1]);
      break;
    }
  }

  // Extract summary
  const summaryPatterns = [
    /"summary"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/s,
  ];
  
  let summary = description.slice(0, 100);
  for (const pattern of summaryPatterns) {
    const match = response.match(pattern);
    if (match && match[1]) {
      summary = unescapeString(match[1]);
      break;
    }
  }

  // Return null if no useful content was extracted
  if (!description && !entityName && entityName === 'unknown_entity') {
    return null;
  }

  return {
    detailed_description: description,
    entity_info: {
      entity_name: entityName,
      entity_type: entityType,
      summary: summary,
    },
  };
}

/**
 * Unescape JSON string escape sequences.
 */
function unescapeString(str: string): string {
  if (!str) return '';
  
  return str
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

// ============================================================================
// Specialized Parsers
// ============================================================================

/**
 * Parse a modal analysis response with normalized field names.
 */
export function parseModalResponse(
  response: string
): { description: string; entityInfo: EntityInfo } {
  const result = robustJsonParse<ModalAnalysisResponse>(response);
  
  if (!result.success || !result.data) {
    return {
      description: '',
      entityInfo: {
        entityName: 'unknown_entity',
        entityType: 'unknown',
        summary: '',
      },
    };
  }

  const data = result.data;
  
  // Normalize field names (support both snake_case and camelCase)
  const description = 
    data.detailed_description || 
    data.detailedDescription || 
    data.description || 
    '';

  const rawEntityInfo = data.entity_info || data.entityInfo || {};
  
  const entityInfo: EntityInfo = {
    entityName: rawEntityInfo.entity_name || rawEntityInfo.entityName || 'unknown_entity',
    entityType: rawEntityInfo.entity_type || rawEntityInfo.entityType || 'unknown',
    summary: rawEntityInfo.summary || description.slice(0, 100),
  };

  return { description, entityInfo };
}

/**
 * Extract JSON from markdown code block if present.
 */
export function extractJsonFromMarkdown(text: string): string | null {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return match && match[1] ? match[1].trim() : null;
}

/**
 * Validate that an object has expected modal response structure.
 */
export function isValidModalResponse(obj: unknown): obj is ModalAnalysisResponse {
  if (!obj || typeof obj !== 'object') return false;
  
  const response = obj as Record<string, unknown>;
  
  // Must have at least a description or entity_info
  const hasDescription = 
    typeof response.detailed_description === 'string' ||
    typeof response.detailedDescription === 'string' ||
    typeof response.description === 'string';
  
  const hasEntityInfo = 
    typeof response.entity_info === 'object' ||
    typeof response.entityInfo === 'object';

  return hasDescription || hasEntityInfo;
}

// ============================================================================
// Export Convenience Functions
// ============================================================================

/**
 * Simple wrapper for common use case.
 */
export function parseJson<T = Record<string, unknown>>(response: string): T | null {
  const result = robustJsonParse<T>(response);
  return result.data;
}

/**
 * Parse with full result including metadata.
 */
export function parseJsonWithMeta<T = Record<string, unknown>>(
  response: string
): ParseResult<T> {
  return robustJsonParse<T>(response);
}
