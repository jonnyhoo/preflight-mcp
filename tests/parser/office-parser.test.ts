/**
 * Unit tests for Office document parser.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OfficeParser, createOfficeParser } from '../../src/parser/office-parser.js';

// Mock child_process for LibreOffice execution
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  exec: vi.fn(),
}));

describe('OfficeParser', () => {
  let parser: OfficeParser;

  beforeEach(() => {
    vi.clearAllMocks();
    parser = new OfficeParser();
  });

  describe('canParse', () => {
    it('should return true for Word documents', () => {
      expect(parser.canParse('/path/to/document.doc')).toBe(true);
      expect(parser.canParse('/path/to/document.docx')).toBe(true);
      expect(parser.canParse('C:\\docs\\file.DOCX')).toBe(true);
    });

    it('should return true for Excel spreadsheets', () => {
      expect(parser.canParse('/path/to/spreadsheet.xls')).toBe(true);
      expect(parser.canParse('/path/to/spreadsheet.xlsx')).toBe(true);
    });

    it('should return true for PowerPoint presentations', () => {
      expect(parser.canParse('/path/to/presentation.ppt')).toBe(true);
      expect(parser.canParse('/path/to/presentation.pptx')).toBe(true);
    });

    it('should return false for non-office files', () => {
      expect(parser.canParse('/path/to/document.pdf')).toBe(false);
      expect(parser.canParse('/path/to/image.png')).toBe(false);
      expect(parser.canParse('/path/to/text.txt')).toBe(false);
    });
  });

  describe('name and supportedFormats', () => {
    it('should have correct name', () => {
      expect(parser.name).toBe('office-parser');
    });

    it('should support all office formats', () => {
      const formats = parser.supportedFormats;
      expect(formats).toContain('.doc');
      expect(formats).toContain('.docx');
      expect(formats).toContain('.xls');
      expect(formats).toContain('.xlsx');
      expect(formats).toContain('.ppt');
      expect(formats).toContain('.pptx');
    });
  });
});

describe('createOfficeParser', () => {
  it('should create an OfficeParser instance', () => {
    const parser = createOfficeParser();
    expect(parser).toBeInstanceOf(OfficeParser);
  });
});
