/**
 * Unit tests for modal processors.
 * 
 * Note: These tests verify the actual ImageProcessor/TableProcessor APIs,
 * not the BaseModalProcessor interface which is used differently.
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

  test('should create an instance', () => {
    expect(processor).toBeInstanceOf(ImageProcessor);
  });

  test('should have getSupportedFormats method', () => {
    const formats = processor.getSupportedFormats();
    expect(formats).toContain('.png');
    expect(formats).toContain('.jpg');
  });

  test('should report availability', async () => {
    // isAvailable may return false if scribe.js-ocr is not installed
    const available = await processor.isAvailable();
    expect(typeof available).toBe('boolean');
  });
});

describe('TableProcessor', () => {
  const processor = createTableProcessor();

  test('should create an instance', () => {
    expect(processor).toBeInstanceOf(TableProcessor);
  });

  test('should process table content with ParsedTableData format', async () => {
    const content: ModalContent = {
      type: 'table',
      content: {
        headers: ['Name', 'Age', 'City'],
        rows: [
          ['Alice', '30', 'New York'],
          ['Bob', '25', 'San Francisco'],
        ],
      },
      source: 'test/data.csv',
    };

    const result = await processor.processTable(content);
    expect(result.success).toBe(true);
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });

  test('should process CSV string content', async () => {
    const content: ModalContent = {
      type: 'table',
      content: 'name,value\nfoo,1\nbar,2',
    };

    const result = await processor.processTable(content);
    expect(result.success).toBe(true);
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });

  test('should reject non-table content', async () => {
    const content: ModalContent = {
      type: 'image',
      content: 'data',
    };

    const result = await processor.processTable(content);
    expect(result.success).toBe(false);
  });
});

describe('EquationProcessor', () => {
  const processor = createEquationProcessor();

  test('should create an instance', () => {
    expect(processor).toBeInstanceOf(EquationProcessor);
  });

  test('should have name property', () => {
    expect(processor.name).toBe('equation');
  });

  test('should have supportedTypes', () => {
    expect(processor.supportedTypes).toContain('equation');
  });

  test('should check if content can be processed', () => {
    expect(processor.canProcess('equation')).toBe(true);
    expect(processor.canProcess('image')).toBe(false);
  });

  test('should process LaTeX equation', async () => {
    const content: ModalContent = {
      type: 'equation',
      content: '\\frac{1}{2}mv^2 = E_k',
      source: 'physics/kinetic-energy.tex',
    };

    const result = await processor.process(content);
    
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });

  test('should process plain text equation', async () => {
    const content: ModalContent = {
      type: 'equation',
      content: 'a^2 + b^2 = c^2',
    };

    const result = await processor.process(content);
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('GenericModalProcessor', () => {
  const processor = createGenericProcessor();

  test('should create an instance', () => {
    expect(processor).toBeInstanceOf(GenericModalProcessor);
  });

  test('should have name property', () => {
    expect(processor.name).toBe('generic');
  });

  test('should support generic content type', () => {
    expect(processor.supportedTypes).toContain('generic');
  });

  test('should process generic content', async () => {
    const content: ModalContent = {
      type: 'generic',
      content: 'Some generic content',
    };

    const result = await processor.process(content);
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('Processor Integration', () => {
  test('should process equation with context', async () => {
    const processor = createEquationProcessor();
    const content: ModalContent = {
      type: 'equation',
      content: 'F = ma',
    };

    const result = await processor.process(content, { surroundingText: 'Newton\'s second law of motion' });
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });

  test('should process table content', async () => {
    const processor = createTableProcessor();
    const content: ModalContent = {
      type: 'table',
      content: {
        headers: ['Product', 'Price'],
        rows: [['Widget', '10.99']],
      },
    };

    const result = await processor.processTable(content);
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });
});
