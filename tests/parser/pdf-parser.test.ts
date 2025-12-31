/**
 * Unit tests for PDF parser.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PdfParser, createPdfParser } from '../../src/parser/pdf-parser.js';

// Mock unpdf module
vi.mock('unpdf', () => ({
  getDocumentProxy: vi.fn(),
  extractText: vi.fn(),
  extractImages: vi.fn(),
}));

import { getDocumentProxy, extractText, extractImages } from 'unpdf';

describe('PdfParser', () => {
  let parser: PdfParser;

  beforeEach(() => {
    vi.clearAllMocks();
    parser = new PdfParser();
  });

  describe('canParse', () => {
    it('should return true for .pdf files', () => {
      expect(parser.canParse('/path/to/document.pdf')).toBe(true);
      expect(parser.canParse('C:\\docs\\file.PDF')).toBe(true);
    });

    it('should return false for non-pdf files', () => {
      expect(parser.canParse('/path/to/document.docx')).toBe(false);
      expect(parser.canParse('/path/to/image.png')).toBe(false);
      expect(parser.canParse('/path/to/text.txt')).toBe(false);
    });
  });

  describe('checkInstallation', () => {
    it('should return true when unpdf is available', async () => {
      const result = await parser.checkInstallation();
      expect(result).toBe(true);
    });
  });

  describe('name and supportedFormats', () => {
    it('should have correct name', () => {
      expect(parser.name).toBe('unpdf');
    });

    it('should support .pdf format', () => {
      expect(parser.supportedFormats).toContain('.pdf');
    });
  });
});

describe('createPdfParser', () => {
  it('should create a PdfParser instance', () => {
    const parser = createPdfParser();
    expect(parser).toBeInstanceOf(PdfParser);
  });
});
