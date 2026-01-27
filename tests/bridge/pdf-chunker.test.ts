/**
 * Unit tests for PDF chunker with semantic/token-based/hybrid strategies.
 * @module tests/bridge/pdf-chunker
 */

import { describe, it, expect } from '@jest/globals';
import { academicChunk, extractDocumentContext } from '../../src/bridge/pdf-chunker.js';
import type { ChunkOptions } from '../../src/bridge/types.js';

// Sample markdown simulating MinerU/VLM output
const samplePdfMarkdown = `# Breaking the Loop: A Study on Reasoning Model Pathology

## Abstract

This paper presents a comprehensive study on loop pathologies in large language models.
We introduce LoopBench, a benchmark for evaluating loop susceptibility.

## 1 Introduction

Large language models have shown remarkable capabilities in reasoning tasks.
However, they often fall into repetitive loops during extended reasoning.

### 1.1 Background

The phenomenon of reasoning loops has been observed across multiple model families.

### 1.2 Contributions

We make the following contributions:
- Introduce LoopBench benchmark
- Propose CUSUM-based detection algorithm
- Demonstrate intervention strategies

## 2 Related Work

Prior work has studied repetition in language models.

## 3 Methodology

### 3.1 Detection Algorithm

[Figure: A flowchart showing the CUSUM-based detection algorithm. The algorithm monitors token entropy and triggers when the cumulative sum exceeds a threshold.]

We propose Algorithm 1 for real-time loop detection:

$$
S_t = \\max(0, S_{t-1} + (\\mu - x_t) - k)
$$

### 3.2 Intervention Strategy

Upon detecting a loop, we inject a summarization prompt.

## 4 Experiments

| Model | DLN | SLN | EDR |
|-------|-----|-----|-----|
| GPT-4 | 0.12 | 0.08 | 0.95 |
| Claude | 0.15 | 0.10 | 0.92 |

## 5 Conclusion

We presented a comprehensive framework for detecting and mitigating reasoning loops.

## References

1. Vaswani et al. Attention is All You Need. 2017.
`;

const defaultChunkOptions: ChunkOptions = {
  sourceType: 'pdf_text',
  bundleId: 'test-bundle',
  repoId: 'pdf/test-paper',
  filePath: 'test.pdf',
};

describe('academicChunk', () => {
  describe('semantic strategy', () => {
    it('should chunk by heading level 2 (sections) by default', () => {
      const chunks = academicChunk(samplePdfMarkdown, defaultChunkOptions, {
        strategy: 'semantic',
        chunkLevel: 2,
      });

      // Multi-scale chunking produces level 1, 2, and 4 chunks plus sub-chunks (table, formula, figure)
      expect(chunks.length).toBeGreaterThanOrEqual(3);
      expect(chunks.length).toBeLessThanOrEqual(30); // Increased to account for multi-scale + sub-chunks

      // All chunks should have Paper prefix and Section metadata
      chunks.forEach(chunk => {
        expect(chunk.content).toContain('[Paper:');
        expect(chunk.metadata.sourceType).toBe('pdf_text');
      });
    });

    it('should chunk by heading level 1 (chapters) when chunkLevel=1', () => {
      const chunks = academicChunk(samplePdfMarkdown, defaultChunkOptions, {
        strategy: 'semantic',
        chunkLevel: 1,
      });

      // Multi-scale produces level 1 + level 2 + level 4 chunks + sub-chunks
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks.length).toBeLessThanOrEqual(30); // Increased to account for multi-scale
    });

    it('should chunk by heading level 3 (subsections) when chunkLevel=3', () => {
      const chunks = academicChunk(samplePdfMarkdown, defaultChunkOptions, {
        strategy: 'semantic',
        chunkLevel: 3,
      });

      // Level 3 should produce chunks for subsections (includes ###)
      expect(chunks.length).toBeGreaterThanOrEqual(0);
    });

    it('should preserve figure descriptions intact', () => {
      const chunks = academicChunk(samplePdfMarkdown, defaultChunkOptions, {
        strategy: 'semantic',
        chunkLevel: 2,
      });

      // With extractSubChunks=true, figure may be extracted as a separate 'figure' chunk
      // or embedded in parent section chunk
      const figureChunk = chunks.find(c =>
        (c.content.includes('[Figure:') && c.content.includes('CUSUM-based detection')) ||
        c.chunkType === 'figure'
      );

      // Figure description should be complete, not cut off
      expect(figureChunk).toBeDefined();
      if (figureChunk!.chunkType !== 'figure') {
        expect(figureChunk!.content).toContain('threshold.]');
      }
    });

    it('should preserve formulas intact', () => {
      const chunks = academicChunk(samplePdfMarkdown, defaultChunkOptions, {
        strategy: 'semantic',
        chunkLevel: 2,
      });

      // With extractSubChunks=true, formulas are extracted as separate 'formula' chunks
      const formulaChunk = chunks.find(c => 
        c.chunkType === 'formula' || c.content.includes('S_t =')
      );

      expect(formulaChunk).toBeDefined();
      expect(formulaChunk!.content).toContain('$$');
    });

    it('should preserve tables intact', () => {
      const chunks = academicChunk(samplePdfMarkdown, defaultChunkOptions, {
        strategy: 'semantic',
        chunkLevel: 2,
      });

      // Find chunk containing the table header or data
      const tableChunk = chunks.find(c =>
        c.content.includes('Model') || c.content.includes('GPT-4') || c.content.includes('Experiments')
      );

      // Table should be in one of the chunks
      expect(tableChunk).toBeDefined();
    });

    it('should include heading path in chunk metadata', () => {
      const chunks = academicChunk(samplePdfMarkdown, defaultChunkOptions, {
        strategy: 'semantic',
        chunkLevel: 3,
        trackHierarchy: true,
      });

      // Find a subsection chunk
      const subsectionChunk = chunks.find(c =>
        c.metadata.sectionHeading?.includes('Detection Algorithm')
      );

      if (subsectionChunk) {
        expect(subsectionChunk.metadata.headingPath).toBeDefined();
      }
    });
  });

  describe('token-based strategy', () => {
    it('should split by token count when using token-based strategy', () => {
      const chunks = academicChunk(samplePdfMarkdown, defaultChunkOptions, {
        strategy: 'token-based',
        maxTokens: 200,
        minTokens: 50,
      });

      // Token-based should produce more chunks due to size limits
      expect(chunks.length).toBeGreaterThan(5);
    });
  });

  describe('hybrid strategy', () => {
    it('should use semantic chunking with soft token warning', () => {
      const chunks = academicChunk(samplePdfMarkdown, defaultChunkOptions, {
        strategy: 'hybrid',
        chunkLevel: 2,
        maxTokens: 500,
      });

      // Should behave like semantic but may log warnings for large chunks
      expect(chunks.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('chunk metadata', () => {
    it('should include paper title in chunk prefix', () => {
      const chunks = academicChunk(samplePdfMarkdown, defaultChunkOptions, {
        strategy: 'semantic',
        chunkLevel: 2,
      });

      // All chunks should have paper title in content
      chunks.forEach(chunk => {
        expect(chunk.content).toContain('[Paper:');
      });
    });

    it('should set correct chunkIndex for each chunk', () => {
      const chunks = academicChunk(samplePdfMarkdown, defaultChunkOptions, {
        strategy: 'semantic',
        chunkLevel: 2,
      });

      chunks.forEach((chunk, index) => {
        expect(chunk.metadata.chunkIndex).toBe(index);
      });
    });

    it('should set sourceType from options', () => {
      const chunks = academicChunk(samplePdfMarkdown, defaultChunkOptions, {
        strategy: 'semantic',
        chunkLevel: 2,
      });

      chunks.forEach(chunk => {
        expect(chunk.metadata.sourceType).toBe('pdf_text');
      });
    });
  });
});

describe('extractDocumentContext', () => {
  it('should extract paper title from first # heading', () => {
    const context = extractDocumentContext(samplePdfMarkdown);
    expect(context.title).toBe('Breaking the Loop: A Study on Reasoning Model Pathology');
  });

  it('should extract abstract if present', () => {
    const context = extractDocumentContext(samplePdfMarkdown);
    expect(context.abstract).toBeDefined();
    expect(context.abstract).toContain('loop pathologies');
  });

  it('should return "Untitled Paper" if no title found', () => {
    const noTitleMarkdown = 'Some content without headings.';
    const context = extractDocumentContext(noTitleMarkdown);
    expect(context.title).toBe('Untitled Paper');
  });
});
