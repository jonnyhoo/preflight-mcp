/**
 * Semantic Chunker - Split content by semantic boundaries.
 * Inspired by MiRAGE chunking strategy.
 * 
 * @module bridge/semantic-chunker
 */

import crypto from 'node:crypto';
import type { ChunkType } from '../vectordb/types.js';
import type { SemanticChunk, ChunkOptions } from './types.js';
import { DEFAULT_CHUNK_OPTIONS } from './types.js';

// ============================================================================
// Token Estimation
// ============================================================================

/**
 * Estimate token count (rough approximation: ~4 chars per token for English).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Generate unique chunk ID.
 */
function generateChunkId(content: string, index: number): string {
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
  return `chunk_${hash}_${index}`;
}

// ============================================================================
// Boundary Detection
// ============================================================================

interface ContentSegment {
  content: string;
  type: ChunkType;
  heading?: string;
  startLine: number;
}

/**
 * Detect structural boundaries in markdown.
 */
function detectBoundaries(markdown: string): ContentSegment[] {
  const lines = markdown.split('\n');
  const segments: ContentSegment[] = [];
  
  let currentContent: string[] = [];
  let currentType: ChunkType = 'text';
  let currentHeading: string | undefined;
  let startLine = 0;
  let inCodeBlock = false;
  let inTable = false;

  const flushSegment = () => {
    const content = currentContent.join('\n').trim();
    if (content) {
      segments.push({
        content,
        type: currentType,
        heading: currentHeading,
        startLine,
      });
    }
    currentContent = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Code block detection
    if (trimmed.startsWith('```')) {
      if (!inCodeBlock) {
        // Start of code block
        flushSegment();
        inCodeBlock = true;
        currentType = 'code';
        startLine = i;
        currentContent.push(line);
      } else {
        // End of code block
        currentContent.push(line);
        flushSegment();
        inCodeBlock = false;
        currentType = 'text';
      }
      continue;
    }

    if (inCodeBlock) {
      currentContent.push(line);
      continue;
    }

    // Heading detection
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushSegment();
      currentHeading = headingMatch[2];
      currentType = 'heading';
      startLine = i;
      currentContent.push(line);
      flushSegment();
      currentType = 'text';
      continue;
    }

    // Table detection
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      if (!inTable) {
        flushSegment();
        inTable = true;
        currentType = 'table';
        startLine = i;
      }
      currentContent.push(line);
      continue;
    } else if (inTable) {
      flushSegment();
      inTable = false;
      currentType = 'text';
    }

    // Formula detection (LaTeX blocks)
    if (trimmed.startsWith('$$') || trimmed.startsWith('\\[')) {
      flushSegment();
      currentType = 'formula';
      startLine = i;
      currentContent.push(line);
      // Check if single-line formula
      if ((trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length > 4) ||
          (trimmed.startsWith('\\[') && trimmed.endsWith('\\]'))) {
        flushSegment();
        currentType = 'text';
      }
      continue;
    }
    if (trimmed.endsWith('$$') || trimmed.endsWith('\\]')) {
      currentContent.push(line);
      flushSegment();
      currentType = 'text';
      continue;
    }

    // Image/figure detection
    if (trimmed.match(/^!\[.*\]\(.*\)$/)) {
      flushSegment();
      currentType = 'figure';
      startLine = i;
      currentContent.push(line);
      flushSegment();
      currentType = 'text';
      continue;
    }

    // List detection
    if (trimmed.match(/^[-*+]\s+/) || trimmed.match(/^\d+\.\s+/)) {
      if (currentType !== 'list') {
        flushSegment();
        currentType = 'list';
        startLine = i;
      }
      currentContent.push(line);
      continue;
    } else if (currentType === 'list' && trimmed === '') {
      // Empty line might end list
      currentContent.push(line);
      continue;
    } else if (currentType === 'list' && !trimmed.match(/^\s+/)) {
      // Non-indented, non-list line ends list
      flushSegment();
      currentType = 'text';
    }

    // Regular text
    if (currentContent.length === 0) {
      startLine = i;
    }
    currentContent.push(line);
  }

  // Flush remaining content
  flushSegment();

  return segments;
}

// ============================================================================
// Chunk Merging & Splitting
// ============================================================================

/**
 * Merge small segments and split large ones.
 */
function optimizeSegments(
  segments: ContentSegment[],
  maxTokens: number,
  minTokens: number
): ContentSegment[] {
  const result: ContentSegment[] = [];
  let pendingSegments: ContentSegment[] = [];
  let pendingTokens = 0;

  const flushPending = () => {
    if (pendingSegments.length === 0) return;

    const merged: ContentSegment = {
      content: pendingSegments.map((s) => s.content).join('\n\n'),
      type: pendingSegments[0]!.type,
      heading: pendingSegments[0]!.heading,
      startLine: pendingSegments[0]!.startLine,
    };
    result.push(merged);
    pendingSegments = [];
    pendingTokens = 0;
  };

  for (const segment of segments) {
    const tokens = estimateTokens(segment.content);

    // If segment is too large, split it
    if (tokens > maxTokens) {
      flushPending();
      const splits = splitLargeSegment(segment, maxTokens);
      result.push(...splits);
      continue;
    }

    // If adding this segment would exceed max, flush first
    if (pendingTokens + tokens > maxTokens && pendingTokens >= minTokens) {
      flushPending();
    }

    // Accumulate segment
    pendingSegments.push(segment);
    pendingTokens += tokens;

    // If we've accumulated enough, flush
    if (pendingTokens >= maxTokens) {
      flushPending();
    }
  }

  flushPending();
  return result;
}

/**
 * Split a large segment by paragraph boundaries.
 */
function splitLargeSegment(segment: ContentSegment, maxTokens: number): ContentSegment[] {
  const result: ContentSegment[] = [];
  const paragraphs = segment.content.split(/\n\n+/);
  
  let current: string[] = [];
  let currentTokens = 0;

  for (const para of paragraphs) {
    const tokens = estimateTokens(para);

    if (currentTokens + tokens > maxTokens && current.length > 0) {
      result.push({
        content: current.join('\n\n'),
        type: segment.type,
        heading: segment.heading,
        startLine: segment.startLine,
      });
      current = [];
      currentTokens = 0;
    }

    // If single paragraph is too large, split by sentences
    if (tokens > maxTokens) {
      if (current.length > 0) {
        result.push({
          content: current.join('\n\n'),
          type: segment.type,
          heading: segment.heading,
          startLine: segment.startLine,
        });
        current = [];
        currentTokens = 0;
      }
      const sentenceSplits = splitBySentences(para, maxTokens);
      for (const s of sentenceSplits) {
        result.push({
          content: s,
          type: segment.type,
          heading: segment.heading,
          startLine: segment.startLine,
        });
      }
      continue;
    }

    current.push(para);
    currentTokens += tokens;
  }

  if (current.length > 0) {
    result.push({
      content: current.join('\n\n'),
      type: segment.type,
      heading: segment.heading,
      startLine: segment.startLine,
    });
  }

  return result;
}

/**
 * Split by sentence boundaries as last resort.
 */
function splitBySentences(text: string, maxTokens: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const result: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const sentence of sentences) {
    const tokens = estimateTokens(sentence);

    if (currentTokens + tokens > maxTokens && current.length > 0) {
      result.push(current.join(' '));
      current = [];
      currentTokens = 0;
    }

    current.push(sentence.trim());
    currentTokens += tokens;
  }

  if (current.length > 0) {
    result.push(current.join(' '));
  }

  return result;
}

// ============================================================================
// Completeness Check
// ============================================================================

/**
 * Check if chunk has dangling references.
 */
function checkCompleteness(content: string): boolean {
  // Check for incomplete references
  const incompletePatterns = [
    /\bsee above\b/i,
    /\bas mentioned\b/i,
    /\bthe following\b(?![\s\S]*\n-)/i, // "the following" without a list
    /\bcontinued from\b/i,
    /\bsee below\b/i,
  ];

  for (const pattern of incompletePatterns) {
    if (pattern.test(content)) {
      return false;
    }
  }

  return true;
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Split markdown content into semantic chunks.
 */
export function semanticChunk(markdown: string, options: ChunkOptions): SemanticChunk[] {
  const opts = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  
  // Detect structural boundaries
  const segments = detectBoundaries(markdown);

  // Optimize segment sizes
  const optimized = optimizeSegments(segments, opts.maxTokens, opts.minTokens);

  // Convert to SemanticChunk
  const chunks: SemanticChunk[] = optimized.map((segment, index) => ({
    id: generateChunkId(segment.content, index),
    content: segment.content,
    chunkType: segment.type,
    isComplete: checkCompleteness(segment.content),
    metadata: {
      sourceType: options.sourceType,
      bundleId: options.bundleId,
      repoId: options.repoId,
      filePath: options.filePath,
      chunkIndex: index,
      sectionHeading: segment.heading,
    },
  }));

  return chunks;
}

/**
 * Simple chunk for structured content (RepoCard fields).
 * Each field becomes one chunk without splitting.
 */
export function simpleChunk(
  content: string,
  chunkType: ChunkType,
  fieldName: string,
  options: ChunkOptions,
  index: number
): SemanticChunk {
  return {
    id: generateChunkId(`${fieldName}:${content}`, index),
    content,
    chunkType,
    isComplete: true,
    metadata: {
      sourceType: options.sourceType,
      bundleId: options.bundleId,
      repoId: options.repoId,
      filePath: options.filePath,
      chunkIndex: index,
      fieldName,
    },
  };
}
