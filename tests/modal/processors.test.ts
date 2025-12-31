/**
 * Unit tests for modal processors.
 */

import { describe, test, expect } from '@jest/globals';

import {
  ImageProcessor,
  TableProcessor,
  EquationProcessor,
  GenericModalProcessor,
  createImageProcessor,
  createTableProcessor,
  createEquationProcessor,
  createGenericProcessor,
} from '../../src/modal/processors/index.js';
import type { ModalContent } from '../../src/modal/types.js';

describe('ImageProcessor', () => {
  const processor = createImageProcessor();

  test('should create an instance with default config', () => {
    expect(processor).toBeInstanceOf(ImageProcessor);
    expect(processor.name).toBe('image');
  });

  test('should support image content type', () => {
    expect(processor.supportedTypes).toContain('image');
  });

  test('should check if content is supported', () => {
    const imageContent: ModalContent = { type: 'image', content: 'base64data' };
    const tableContent: ModalContent = { type: 'table', content: [[]] };
    
    expect(processor.supports(imageContent)).toBe(true);
    expect(processor.supports(tableContent)).toBe(false);
  });

  test('should process image content with text OCR result', async () => {
    const content: ModalContent = {
      type: 'image',
      content: { text: 'Hello World OCR Result' },
      source: 'test/image.png',
    };

    const result = await processor.process(content);
    
    expect(result.success).toBe(true);
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.description).toBeDefined();
  });

  test('should handle empty image content gracefully', async () => {
    const content: ModalContent = {
      type: 'image',
      content: null,
    };

    const result = await processor.process(content);
    
    // Should succeed but with minimal output
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('TableProcessor', () => {
  const processor = createTableProcessor();

  test('should create an instance with default config', () => {
    expect(processor).toBeInstanceOf(TableProcessor);
    expect(processor.name).toBe('table');
  });

  test('should support table content type', () => {
    expect(processor.supportedTypes).toContain('table');
  });

  test('should check if content is supported', () => {
    const tableContent: ModalContent = { type: 'table', content: [[]] };
    const imageContent: ModalContent = { type: 'image', content: 'data' };
    
    expect(processor.supports(tableContent)).toBe(true);
    expect(processor.supports(imageContent)).toBe(false);
  });

  test('should process table content with 2D array', async () => {
    const content: ModalContent = {
      type: 'table',
      content: [
        ['Name', 'Age', 'City'],
        ['Alice', '30', 'New York'],
        ['Bob', '25', 'San Francisco'],
      ],
      source: 'test/data.csv',
    };

    const result = await processor.process(content);
    
    expect(result.success).toBe(true);
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.description).toBeDefined();
    expect(result.metadata).toBeDefined();
    expect(result.metadata?.analysis).toBeDefined();
  });

  test('should process table content with header row', async () => {
    const content: ModalContent = {
      type: 'table',
      content: {
        headers: ['ID', 'Value'],
        rows: [
          ['1', '100'],
          ['2', '200'],
        ],
      },
    };

    const result = await processor.process(content);
    
    expect(result.success).toBe(true);
  });

  test('should process CSV string content', async () => {
    const content: ModalContent = {
      type: 'table',
      content: 'name,value\nfoo,1\nbar,2',
    };

    const result = await processor.process(content);
    
    expect(result.success).toBe(true);
    expect(result.description).toBeDefined();
  });

  test('should handle empty table gracefully', async () => {
    const content: ModalContent = {
      type: 'table',
      content: [],
    };

    const result = await processor.process(content);
    
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('EquationProcessor', () => {
  const processor = createEquationProcessor();

  test('should create an instance with default config', () => {
    expect(processor).toBeInstanceOf(EquationProcessor);
    expect(processor.name).toBe('equation');
  });

  test('should support equation content type', () => {
    expect(processor.supportedTypes).toContain('equation');
  });

  test('should check if content is supported', () => {
    const eqContent: ModalContent = { type: 'equation', content: 'E=mc^2' };
    const imageContent: ModalContent = { type: 'image', content: 'data' };
    
    expect(processor.supports(eqContent)).toBe(true);
    expect(processor.supports(imageContent)).toBe(false);
  });

  test('should process LaTeX equation', async () => {
    const content: ModalContent = {
      type: 'equation',
      content: '\\frac{1}{2}mv^2 = E_k',
      source: 'physics/kinetic-energy.tex',
    };

    const result = await processor.process(content);
    
    expect(result.success).toBe(true);
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.description).toBeDefined();
    expect(result.metadata?.analysis).toBeDefined();
    expect(result.metadata?.format).toBe('latex');
  });

  test('should detect equation type as calculus', async () => {
    const content: ModalContent = {
      type: 'equation',
      content: '\\int_0^1 x^2 dx = \\frac{1}{3}',
    };

    const result = await processor.process(content);
    
    expect(result.success).toBe(true);
    expect(result.metadata?.analysis).toBeDefined();
    expect((result.metadata?.analysis as any)?.type).toBe('calculus');
  });

  test('should process plain text equation', async () => {
    const content: ModalContent = {
      type: 'equation',
      content: 'a^2 + b^2 = c^2',
    };

    const result = await processor.process(content);
    
    expect(result.success).toBe(true);
    expect(result.metadata?.format).toBe('text');
  });

  test('should handle MathML content', async () => {
    const content: ModalContent = {
      type: 'equation',
      content: '<math><mi>x</mi><mo>=</mo><mn>2</mn></math>',
    };

    const result = await processor.process(content);
    
    expect(result.success).toBe(true);
    expect(result.metadata?.format).toBe('mathml');
  });

  test('should handle empty equation gracefully', async () => {
    const content: ModalContent = {
      type: 'equation',
      content: '',
    };

    const result = await processor.process(content);
    
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('GenericModalProcessor', () => {
  const processor = createGenericProcessor();

  test('should create an instance', () => {
    expect(processor).toBeInstanceOf(GenericModalProcessor);
    expect(processor.name).toBe('generic');
  });

  test('should support generic content type', () => {
    expect(processor.supportedTypes).toContain('generic');
  });

  test('should process any content type', async () => {
    const content: ModalContent = {
      type: 'generic',
      content: 'Some generic content',
    };

    const result = await processor.process(content);
    
    expect(result.success).toBe(true);
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('Processor Integration', () => {
  test('should process with context', async () => {
    const processor = createEquationProcessor();
    const content: ModalContent = {
      type: 'equation',
      content: 'F = ma',
    };

    const result = await processor.process(content, 'Newton\'s second law of motion');
    
    expect(result.success).toBe(true);
    expect(result.description).toContain('Context');
  });

  test('should generate entity info for successful processing', async () => {
    const processor = createTableProcessor();
    const content: ModalContent = {
      type: 'table',
      content: [
        ['Product', 'Price'],
        ['Widget', '10.99'],
      ],
    };

    const result = await processor.process(content);
    
    expect(result.success).toBe(true);
    expect(result.entityInfo).toBeDefined();
    expect(result.entityInfo?.entityType).toBe('table');
    expect(result.entityInfo?.keywords).toBeDefined();
    expect(Array.isArray(result.entityInfo?.keywords)).toBe(true);
  });
});
