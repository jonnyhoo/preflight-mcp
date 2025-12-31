/**
 * Unit tests for prompt templates.
 */

import { describe, test, expect } from '@jest/globals';

import {
  getImagePrompt,
  getTablePrompt,
  getEquationPrompt,
} from '../../src/prompts/templates.js';
import type { PromptInput } from '../../src/prompts/types.js';

describe('getImagePrompt', () => {
  test('should generate prompt with focus placeholder', () => {
    const input: PromptInput = { focus: 'text content' };
    const result = getImagePrompt(input);
    
    expect(result).toContain('text content');
    expect(result).toContain('Describe the image');
  });

  test('should handle empty focus', () => {
    const input: PromptInput = {};
    const result = getImagePrompt(input);
    
    expect(result).toContain('Describe the image');
    // Should not have leftover placeholder
    expect(result).not.toContain('{{focus}}');
  });

  test('should handle various focus values', () => {
    const inputs = [
      { focus: 'diagrams' },
      { focus: 'charts and graphs' },
      { focus: 'code snippets' },
    ];

    for (const input of inputs) {
      const result = getImagePrompt(input);
      expect(result).toContain(input.focus as string);
    }
  });
});

describe('getTablePrompt', () => {
  test('should generate prompt with columns placeholder', () => {
    const input: PromptInput = { columns: 'Name, Age, City' };
    const result = getTablePrompt(input);
    
    expect(result).toContain('Name, Age, City');
    expect(result).toContain('Summarize the table');
  });

  test('should handle empty columns', () => {
    const input: PromptInput = {};
    const result = getTablePrompt(input);
    
    expect(result).toContain('Summarize the table');
    expect(result).not.toContain('{{columns}}');
  });

  test('should handle numeric column names', () => {
    const input: PromptInput = { columns: 'Col1, Col2, Col3' };
    const result = getTablePrompt(input);
    
    expect(result).toContain('Col1, Col2, Col3');
  });
});

describe('getEquationPrompt', () => {
  test('should generate prompt with equation placeholder', () => {
    const input: PromptInput = { equation: 'E = mc^2' };
    const result = getEquationPrompt(input);
    
    expect(result).toContain('E = mc^2');
    expect(result).toContain('Explain the equation');
  });

  test('should handle empty equation', () => {
    const input: PromptInput = {};
    const result = getEquationPrompt(input);
    
    expect(result).toContain('Explain the equation');
    expect(result).not.toContain('{{equation}}');
  });

  test('should handle LaTeX equation', () => {
    const input: PromptInput = { equation: '\\frac{1}{2}mv^2' };
    const result = getEquationPrompt(input);
    
    expect(result).toContain('\\frac{1}{2}mv^2');
  });

  test('should handle complex equations', () => {
    const input: PromptInput = {
      equation: '\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}',
    };
    const result = getEquationPrompt(input);
    
    expect(result).toContain('\\int_0^\\infty');
  });
});

describe('Prompt Template Integration', () => {
  test('should handle all placeholder types', () => {
    // Test that different templates don't interfere with each other
    const imageInput = { focus: 'test-focus' };
    const tableInput = { columns: 'test-columns' };
    const equationInput = { equation: 'test-equation' };

    const imageResult = getImagePrompt(imageInput);
    const tableResult = getTablePrompt(tableInput);
    const equationResult = getEquationPrompt(equationInput);

    expect(imageResult).toContain('test-focus');
    expect(tableResult).toContain('test-columns');
    expect(equationResult).toContain('test-equation');

    // Ensure no cross-contamination
    expect(imageResult).not.toContain('test-columns');
    expect(tableResult).not.toContain('test-focus');
  });

  test('should handle special characters in input', () => {
    const specialInput: PromptInput = {
      focus: 'text with "quotes" and <tags>',
    };
    const result = getImagePrompt(specialInput);
    
    expect(result).toContain('"quotes"');
    expect(result).toContain('<tags>');
  });

  test('should handle numeric values', () => {
    const input: PromptInput = {
      columns: '42',
    };
    const result = getTablePrompt(input);
    
    expect(result).toContain('42');
  });

  test('should handle boolean values', () => {
    const input: PromptInput = {
      focus: true as unknown as string,
    };
    const result = getImagePrompt(input);
    
    // Boolean should be converted to string
    expect(result).toContain('true');
  });
});
