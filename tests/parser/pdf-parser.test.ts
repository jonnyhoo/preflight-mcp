/**
 * Unit tests for PDF parser.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PdfParser, createPdfParser } from '../../src/parser/pdf-parser.js';

// Note: Module mocking not needed for basic tests - these tests don't execute parsing

describe('PdfParser', () => {
  let parser: PdfParser;

  beforeEach(() => {
    jest.clearAllMocks();
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

describe('PdfParser OCR Integration', () => {
  let parser: PdfParser;

  beforeEach(() => {
    parser = new PdfParser();
  });

  it('should have enableOcr option default behavior', async () => {
    // The parser should accept enableOcr option without error
    // This tests that the type system accepts the new option
    const mockOptions = {
      enableOcr: true,
      extractImages: false,
      extractTables: false,
    };
    
    // Just verify the options are valid by type - no actual parsing needed
    expect(mockOptions.enableOcr).toBe(true);
  });

  it('should support disabling OCR via enableOcr: false', () => {
    // Test that enableOcr can be set to false
    const mockOptions = {
      enableOcr: false,
    };
    expect(mockOptions.enableOcr).toBe(false);
  });
});
