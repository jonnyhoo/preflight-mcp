/**
 * Tests for PDF Preprocessor (Index-Time Enhancement).
 * 
 * @module tests/rag/pdf-preprocessor
 */

import { describe, it, expect } from '@jest/globals';
import { preprocessPdfMarkdown } from '../../src/rag/pdf-preprocessor.js';

describe('PDF Preprocessor', () => {
  describe('Page Marker Filtering', () => {
    it('should remove ## Page N markers', async () => {
      const markdown = `# Introduction

Some content here.

## Page 1

More content.

## 1.1 Background

Background text.

## Page 2

Even more content.`;

      const result = await preprocessPdfMarkdown(markdown);
      
      expect(result.markdown).not.toContain('## Page 1');
      expect(result.markdown).not.toContain('## Page 2');
      expect(result.markdown).toContain('# Introduction');
      expect(result.markdown).toContain('## 1.1 Background');
      expect(result.stats.pageMarkersRemoved).toBeGreaterThan(0);
    });

    it('should remove standalone Page N markers', async () => {
      const markdown = `Content before.

Page 1

Content after.

Page 2

More content.`;

      const result = await preprocessPdfMarkdown(markdown);
      
      expect(result.markdown).not.toMatch(/^Page \d+$/m);
      expect(result.markdown).toContain('Content before');
      expect(result.markdown).toContain('Content after');
    });

    it('should preserve legitimate headings with "Page" in them', async () => {
      const markdown = `# Landing Page Design

## Page Layout Principles

Content about layouts.`;

      const result = await preprocessPdfMarkdown(markdown);
      
      expect(result.markdown).toContain('# Landing Page Design');
      expect(result.markdown).toContain('## Page Layout Principles');
    });
  });

  describe('HTML Table Conversion', () => {
    it('should convert simple HTML table to markdown', async () => {
      const markdown = `Some text before.

<table>
<tr><th>Method</th><th>Accuracy</th></tr>
<tr><td>Baseline</td><td>0.85</td></tr>
<tr><td>Ours</td><td>0.92</td></tr>
</table>

Some text after.`;

      const result = await preprocessPdfMarkdown(markdown);
      
      expect(result.markdown).toContain('| Method | Accuracy |');
      expect(result.markdown).toContain('| Baseline | 0.85 |');
      expect(result.markdown).toContain('| Ours | 0.92 |');
      expect(result.markdown).not.toContain('<table>');
      expect(result.stats.tablesConverted).toBe(1);
    });

    it('should handle tables with only td (no th)', async () => {
      const markdown = `<table>
<tr><td>A</td><td>B</td></tr>
<tr><td>1</td><td>2</td></tr>
</table>`;

      const result = await preprocessPdfMarkdown(markdown);
      
      expect(result.markdown).toContain('| A | B |');
      expect(result.markdown).toContain('| --- | --- |');
      expect(result.markdown).toContain('| 1 | 2 |');
    });

    it('should handle nested HTML in cells', async () => {
      const markdown = `<table>
<tr><th>Name</th><th>Value</th></tr>
<tr><td><b>Bold</b></td><td>123</td></tr>
</table>`;

      const result = await preprocessPdfMarkdown(markdown);
      
      expect(result.markdown).toContain('| Bold | 123 |');
      expect(result.markdown).not.toContain('<b>');
    });
  });

  describe('Dehyphenation', () => {
    it('should rejoin hyphenated words across line breaks', async () => {
      const markdown = `This is about plan-
ning and develop-
ment strategies.`;

      const result = await preprocessPdfMarkdown(markdown);
      
      expect(result.markdown).toContain('planning');
      expect(result.markdown).toContain('development');
      expect(result.stats.hyphenationsFixed).toBeGreaterThan(0);
    });

    it('should preserve legitimate hyphenated terms', async () => {
      const markdown = `This is a state-of-the-art
approach using self-
attention mechanisms.`;

      const result = await preprocessPdfMarkdown(markdown);
      
      // state-of-the-art should be preserved (common term)
      // self-attention may or may not be merged depending on heuristics
      expect(result.markdown).toContain('state-of-the-art');
    });
  });

  describe('Combined Preprocessing', () => {
    it('should handle markdown with multiple issues', async () => {
      const markdown = `# DynaDebate

## Page 1

## Abstract

This paper presents a novel ap-
proach to multi-agent debate.

<table>
<tr><th>Model</th><th>Score</th></tr>
<tr><td>GPT-4</td><td>0.95</td></tr>
</table>

## Page 2

## 1 Introduction

The field of natu-
ral language processing...`;

      const result = await preprocessPdfMarkdown(markdown);
      
      // Page markers removed
      expect(result.markdown).not.toMatch(/^## Page \d+$/m);
      
      // Legitimate headings preserved
      expect(result.markdown).toContain('# DynaDebate');
      expect(result.markdown).toContain('## Abstract');
      expect(result.markdown).toContain('## 1 Introduction');
      
      // Table converted
      expect(result.markdown).toContain('| Model | Score |');
      
      // Hyphenation fixed
      expect(result.markdown).toContain('approach');
      expect(result.markdown).toContain('natural');
      
      // Stats reflect changes
      expect(result.stats.pageMarkersRemoved).toBeGreaterThan(0);
      expect(result.stats.tablesConverted).toBe(1);
    });
  });
});
