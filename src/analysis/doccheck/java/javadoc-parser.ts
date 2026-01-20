/**
 * Java Documentation Checker - Javadoc Parser
 *
 * Parses Javadoc comments to extract @param, @return, @throws tags.
 *
 * @module analysis/doccheck/java/javadoc-parser
 */

import type { DocParamInfo } from '../types.js';
import type { JavaDocInfo, JavaDocThrowsInfo } from './types.js';

// ============================================================================
// Regex Patterns
// ============================================================================

/** Match @param tag: @param name description */
const PARAM_PATTERN = /@param\s+(\w+)\s*(.*)/g;

/** Match @return/@returns tag: @return description */
const RETURN_PATTERN = /@returns?\s+(.*)/;

/** Match @throws/@exception tag: @throws ExceptionType description */
const THROWS_PATTERN = /@(?:throws|exception)\s+(\S+)\s*(.*)/g;

/** Match {@inheritDoc} inline tag */
const INHERIT_DOC_PATTERN = /\{@inheritDoc\}/i;

// ============================================================================
// Parser
// ============================================================================

/**
 * Parse a Javadoc comment string into structured info.
 *
 * @param javadoc - Raw Javadoc text (with or without delimiters)
 */
export function parseJavadoc(javadoc: string): JavaDocInfo {
  // Strip Javadoc delimiters if present
  let text = javadoc.trim();
  if (text.startsWith('/**')) {
    text = text.slice(3);
  }
  if (text.endsWith('*/')) {
    text = text.slice(0, -2);
  }

  // Clean up leading asterisks on each line
  const lines = text.split('\n').map((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith('*') ? trimmed.slice(1).trim() : trimmed;
  });
  const cleaned = lines.join('\n').trim();

  if (!cleaned) {
    return { exists: false, params: [] };
  }

  const params = extractParams(cleaned);
  const returns = extractReturn(cleaned);
  const throws = extractThrows(cleaned);
  const hasInheritDoc = INHERIT_DOC_PATTERN.test(cleaned);
  const description = extractDescription(cleaned);

  return {
    exists: true,
    params,
    returns,
    throws: throws.length > 0 ? throws : undefined,
    hasInheritDoc,
    description,
    raw: javadoc,
  };
}

/**
 * Extract @param tags from cleaned Javadoc text.
 */
function extractParams(text: string): DocParamInfo[] {
  const params: DocParamInfo[] = [];
  const regex = new RegExp(PARAM_PATTERN.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    params.push({
      name: match[1]!,
      description: match[2]?.trim() || undefined,
    });
  }

  return params;
}

/**
 * Extract @return tag from cleaned Javadoc text.
 */
function extractReturn(text: string): { type?: string; description?: string } | undefined {
  const match = text.match(RETURN_PATTERN);
  if (!match) return undefined;

  const desc = match[1]?.trim();
  return desc ? { description: desc } : { description: '' };
}

/**
 * Extract @throws/@exception tags from cleaned Javadoc text.
 */
function extractThrows(text: string): JavaDocThrowsInfo[] {
  const throws: JavaDocThrowsInfo[] = [];
  const regex = new RegExp(THROWS_PATTERN.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    throws.push({
      exception: match[1]!,
      description: match[2]?.trim() || undefined,
    });
  }

  return throws;
}

/**
 * Extract description (text before first tag).
 */
function extractDescription(text: string): string | undefined {
  // Find first tag
  const tagIndex = text.search(/@\w+/);
  if (tagIndex === -1) {
    return text.trim() || undefined;
  }
  if (tagIndex === 0) {
    return undefined;
  }

  const desc = text.slice(0, tagIndex).trim();
  return desc || undefined;
}
