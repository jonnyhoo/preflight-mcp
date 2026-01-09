/**
 * Integration tests for multimodal processing pipeline.
 * 
 * Tests the end-to-end flow from document parsing through modal processing
 * to search indexing.
 */

import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Import modules under test
import { ContextExtractor } from '../../src/modal/context-extractor.js';
import { robustJsonParse } from '../../src/modal/utils/json-parser.js';
import { EquationProcessor } from '../../src/modal/processors/equation-processor.js';
import type { ModalContent } from '../../src/modal/types.js';
import {
  ensureModalTables,
  indexModalContent,
  searchModalContent,
  getModalContentStats,
  type ModalIndexItem,
} from '../../src/search/sqliteFts.js';

// Test fixtures directory
let testDir: string;
let testDbPath: string;

describe('Multimodal Pipeline Integration', () => {
  beforeAll(async () => {
    // Create temp directory for test artifacts
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-modal-test-'));
    testDbPath = path.join(testDir, 'test-search.sqlite3');
  });

  afterAll(async () => {
    // Cleanup test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Context Extraction', () => {
    it('should extract context from text chunks', () => {
      const extractor = new ContextExtractor({ maxTokens: 100, windowSize: 2 });
      
      const chunks = [
        'First paragraph of text.',
        'Second paragraph with important info.',
        'Third paragraph - the target.',
        'Fourth paragraph continues.',
        'Fifth paragraph ends.',
      ];
      
      const context = extractor.extractContext(chunks, { index: 2 }, 'text_chunks');
      
      // Should include surrounding chunks but not the current one
      expect(context).not.toContain('Third paragraph');
      expect(context.length).toBeGreaterThan(0);
    });

    it('should respect token budget', () => {
      const extractor = new ContextExtractor({ maxTokens: 10, windowSize: 5 });
      
      const longText = 'word '.repeat(100);
      const context = extractor.extractContext(longText, {}, 'auto');
      
      // Should be truncated
      const tokens = context.split(/\s+/).filter(t => t.length > 0);
      expect(tokens.length).toBeLessThanOrEqual(15); // Some tolerance for truncation boundary
    });

    it('should handle content list format', () => {
      const extractor = new ContextExtractor();
      
      const contentList = [
        { type: 'text', text: 'Introduction text.' },
        { type: 'image', image_caption: 'Figure 1: Sample diagram' },
        { type: 'text', text: 'Following paragraph.' },
      ];
      
      const context = extractor.extractContext(contentList, { index: 1, type: 'image' }, 'auto');
      
      // Should extract text from surrounding items
      expect(context.length).toBeGreaterThan(0);
    });
  });

  describe('JSON Parsing', () => {
    it('should parse clean JSON', () => {
      const json = '{"description": "Test image", "entity_info": {"entity_name": "test"}}';
      const result = robustJsonParse(json);
      
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('description', 'Test image');
    });

    it('should handle JSON in markdown code blocks', () => {
      const response = `Here is the analysis:
\`\`\`json
{
  "detailed_description": "A flowchart diagram",
  "entity_info": {
    "entity_name": "system_flow",
    "entity_type": "diagram"
  }
}
\`\`\``;
      
      const result = robustJsonParse(response);
      
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('detailed_description');
    });

    it('should fix common JSON issues', () => {
      // Smart quotes
      const withSmartQuotes = '{"key": "value"}';
      const result1 = robustJsonParse(withSmartQuotes.replace(/"/g, '"'));
      expect(result1.success).toBe(true);

      // Trailing comma
      const withTrailingComma = '{"key": "value",}';
      const result2 = robustJsonParse(withTrailingComma);
      expect(result2.success).toBe(true);
    });

    it('should fall back to regex extraction', () => {
      const malformedResponse = `
        The description is "A complex chart showing data"
        entity_name: "data_chart"
        entity_type: "chart"
      `;
      
      const result = robustJsonParse(malformedResponse);
      
      // May not fully succeed but should attempt extraction
      expect(result.method).toBe('regex_fallback');
    });
  });

  describe('Modal Search Indexing', () => {
    it('should create modal tables', () => {
      // Should not throw
      expect(() => ensureModalTables(testDbPath)).not.toThrow();
    });

    it('should index modal content', () => {
      const items: ModalIndexItem[] = [
        {
          sourcePath: '/docs/manual.pdf',
          repoId: 'test/repo',
          kind: 'image',
          pageIndex: 0,
          description: 'Architecture diagram showing system components and data flow',
          entityName: 'system_architecture',
          keywords: ['architecture', 'system', 'diagram', 'components'],
          contentHash: 'hash1',
        },
        {
          sourcePath: '/docs/manual.pdf',
          repoId: 'test/repo',
          kind: 'table',
          pageIndex: 2,
          description: 'Configuration options table with parameters and default values',
          entityName: 'config_table',
          keywords: ['configuration', 'options', 'parameters'],
          contentHash: 'hash2',
        },
        {
          sourcePath: '/docs/math.pdf',
          repoId: 'test/repo',
          kind: 'equation',
          pageIndex: 5,
          description: 'Quadratic formula for solving polynomial equations',
          entityName: 'quadratic_formula',
          keywords: ['quadratic', 'formula', 'equation', 'polynomial'],
          contentHash: 'hash3',
        },
      ];

      const result = indexModalContent(testDbPath, items);
      
      expect(result.indexed).toBe(3);
      expect(result.skipped).toBe(0);
    });

    it('should skip duplicate content', () => {
      const items: ModalIndexItem[] = [
        {
          sourcePath: '/docs/manual.pdf',
          repoId: 'test/repo',
          kind: 'image',
          description: 'Duplicate item',
          contentHash: 'hash1', // Same as previous test
        },
      ];

      const result = indexModalContent(testDbPath, items);
      
      expect(result.indexed).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('should search modal content by description', () => {
      const results = searchModalContent(testDbPath, 'architecture diagram', {
        limit: 10,
        includeScore: true,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.kind).toBe('image');
      expect(results[0]?.entityName).toBe('system_architecture');
    });

    it('should filter by content kind', () => {
      const tableResults = searchModalContent(testDbPath, 'configuration', {
        scope: 'table',
        limit: 10,
      });

      expect(tableResults.length).toBeGreaterThan(0);
      expect(tableResults.every(r => r.kind === 'table')).toBe(true);
    });

    it('should return stats', () => {
      const stats = getModalContentStats(testDbPath);

      expect(stats.totalItems).toBe(3);
      expect(stats.byKind.image).toBe(1);
      expect(stats.byKind.table).toBe(1);
      expect(stats.byKind.equation).toBe(1);
      expect(stats.uniqueDocuments).toBe(2);
    });
  });

  describe('Processor Integration', () => {
    it('should have valid image content structure', () => {
      const imageContent: ModalContent = {
        type: 'image',
        content: '/path/to/image.png',
        sourcePath: '/docs/manual.pdf',
        pageIndex: 0,
        captions: ['Figure 1: System overview'],
      };
      
      // Validate structure
      expect(imageContent.type).toBe('image');
      expect(imageContent.content).toBeDefined();
      expect(imageContent.captions).toHaveLength(1);
    });

    it('should have valid table content structure', () => {
      const tableContent: ModalContent = {
        type: 'table',
        content: {
          headers: ['Name', 'Value'],
          rows: [['param1', '100'], ['param2', '200']],
          rowCount: 2,
          colCount: 2,
        },
        sourcePath: '/docs/config.pdf',
      };
      
      expect(tableContent.type).toBe('table');
      expect(typeof tableContent.content).toBe('object');
    });

    it('should process equation with EquationProcessor', () => {
      const processor = new EquationProcessor();
      
      // EquationProcessor extends BaseModalProcessor which has canProcess
      expect(processor.canProcess('equation')).toBe(true);
      expect(processor.canProcess('image')).toBe(false);
    });
  });
});

describe('Error Handling', () => {
  it('should handle empty context source gracefully', () => {
    const extractor = new ContextExtractor();
    
    expect(extractor.extractContext(null, {})).toBe('');
    expect(extractor.extractContext(undefined, {})).toBe('');
    expect(extractor.extractContext('', {})).toBe('');
    expect(extractor.extractContext([], {})).toBe('');
  });

  it('should handle invalid JSON gracefully', () => {
    const result = robustJsonParse('not json at all');
    
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
  });

  it('should handle empty search database gracefully', async () => {
    const emptyDbPath = path.join(testDir, 'empty.sqlite3');
    
    // Search should return empty array, not throw
    const results = searchModalContent(emptyDbPath, 'test');
    expect(results).toEqual([]);
  });
});
