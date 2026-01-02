/**
 * Unit tests for text-based parsers (HTML, Markdown, PlainText).
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  HtmlParser,
  MarkdownParser,
  PlainTextParser,
  createHtmlParser,
  createMarkdownParser,
  createPlainTextParser,
} from '../../src/parser/text-parser.js';

describe('HtmlParser', () => {
  let parser: HtmlParser;

  beforeEach(() => {
    parser = new HtmlParser();
  });

  describe('canParse', () => {
    it('should return true for HTML files', () => {
      expect(parser.canParse('/path/to/page.html')).toBe(true);
      expect(parser.canParse('/path/to/page.htm')).toBe(true);
      expect(parser.canParse('/path/to/page.xhtml')).toBe(true);
      expect(parser.canParse('C:\\docs\\file.HTML')).toBe(true);
    });

    it('should return false for non-HTML files', () => {
      expect(parser.canParse('/path/to/document.pdf')).toBe(false);
      expect(parser.canParse('/path/to/document.md')).toBe(false);
    });
  });

  describe('name and supportedFormats', () => {
    it('should have correct name', () => {
      expect(parser.name).toBe('html-parser');
    });

    it('should support HTML formats', () => {
      const formats = parser.supportedFormats;
      expect(formats).toContain('.html');
      expect(formats).toContain('.htm');
      expect(formats).toContain('.xhtml');
    });
  });

  describe('checkInstallation', () => {
    it('should return true (no external dependencies)', async () => {
      const result = await parser.checkInstallation();
      expect(result).toBe(true);
    });
  });
});

describe('MarkdownParser', () => {
  let parser: MarkdownParser;

  beforeEach(() => {
    parser = new MarkdownParser();
  });

  describe('canParse', () => {
    it('should return true for Markdown files', () => {
      expect(parser.canParse('/path/to/readme.md')).toBe(true);
      expect(parser.canParse('/path/to/docs.markdown')).toBe(true);
      expect(parser.canParse('C:\\docs\\README.MD')).toBe(true);
    });

    it('should return false for non-Markdown files', () => {
      expect(parser.canParse('/path/to/document.pdf')).toBe(false);
      expect(parser.canParse('/path/to/page.html')).toBe(false);
    });
  });

  describe('name and supportedFormats', () => {
    it('should have correct name', () => {
      expect(parser.name).toBe('markdown-parser');
    });

    it('should support Markdown formats', () => {
      const formats = parser.supportedFormats;
      expect(formats).toContain('.md');
      expect(formats).toContain('.markdown');
    });
  });
});

describe('PlainTextParser', () => {
  let parser: PlainTextParser;

  beforeEach(() => {
    parser = new PlainTextParser();
  });

  describe('canParse', () => {
    it('should return true for text files', () => {
      expect(parser.canParse('/path/to/file.txt')).toBe(true);
      expect(parser.canParse('/path/to/notes.text')).toBe(true);
      expect(parser.canParse('C:\\docs\\README.TXT')).toBe(true);
    });

    it('should return false for non-text files', () => {
      expect(parser.canParse('/path/to/document.pdf')).toBe(false);
      expect(parser.canParse('/path/to/page.html')).toBe(false);
    });
  });

  describe('name and supportedFormats', () => {
    it('should have correct name', () => {
      expect(parser.name).toBe('plaintext-parser');
    });

    it('should support text formats', () => {
      const formats = parser.supportedFormats;
      expect(formats).toContain('.txt');
      expect(formats).toContain('.text');
    });
  });
});

describe('Factory functions', () => {
  it('createHtmlParser should create HtmlParser instance', () => {
    expect(createHtmlParser()).toBeInstanceOf(HtmlParser);
  });

  it('createMarkdownParser should create MarkdownParser instance', () => {
    expect(createMarkdownParser()).toBeInstanceOf(MarkdownParser);
  });

  it('createPlainTextParser should create PlainTextParser instance', () => {
    expect(createPlainTextParser()).toBeInstanceOf(PlainTextParser);
  });
});
