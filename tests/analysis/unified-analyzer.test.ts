/**
 * Tests for Unified Analysis Layer
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createUnifiedAnalyzer,
  createTypeSemanticAnalyzer,
  createPatternAnalyzer,
  type ExtensionPointInfo,
} from '../../src/analysis/index.js';

// ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('TypeSemanticAnalyzer', () => {
  it('should extract union types from modal/types.ts', () => {
    const analyzer = createTypeSemanticAnalyzer();
    const typesFile = path.resolve(__dirname, '../../src/modal/types.ts');
    
    const result = analyzer.analyzeFile(typesFile, 'src/modal/types.ts');
    
    // Should find ModalContentType union
    const modalContentType = result.unionTypes.find(u => u.name === 'ModalContentType');
    expect(modalContentType).toBeDefined();
    expect(modalContentType?.members).toContain('image');
    expect(modalContentType?.members).toContain('table');
    expect(modalContentType?.members).toContain('equation');
    
    // Should find ContentSourceFormat union
    const sourceFormat = result.unionTypes.find(u => u.name === 'ContentSourceFormat');
    expect(sourceFormat).toBeDefined();
    expect(sourceFormat?.members).toContain('minerU');
    expect(sourceFormat?.members).toContain('docling');
    expect(sourceFormat?.inferredPurpose).toBe('format-support');
    
    analyzer.clearCache();
  });

  it('should extract optional callbacks from interfaces', () => {
    const analyzer = createTypeSemanticAnalyzer();
    const typesFile = path.resolve(__dirname, '../../src/modal/types.ts');
    
    const result = analyzer.analyzeFile(typesFile, 'src/modal/types.ts');
    
    // Should find tokenizer optional callback in ContextConfig
    const tokenizer = result.optionalCallbacks.find(c => c.name === 'tokenizer');
    expect(tokenizer).toBeDefined();
    expect(tokenizer?.parent).toBe('ContextConfig');
    
    analyzer.clearCache();
  });
});

describe('PatternAnalyzer', () => {
  it('should detect design reference comments', async () => {
    const analyzer = createPatternAnalyzer();
    const typesFile = path.resolve(__dirname, '../../src/modal/types.ts');
    
    const hints = await analyzer.analyzeFile(typesFile);
    
    // Should find "Design reference: RAG-Anything" comment
    const ragReference = hints.find(h => 
      h.comment.includes('Design reference') && h.comment.includes('RAG-Anything')
    );
    expect(ragReference).toBeDefined();
    expect(ragReference?.intent).toBe('reference');
  });

  it('should detect interface extension patterns', () => {
    const analyzer = createPatternAnalyzer();
    // Use interface name that matches extensibility pattern (IXxxHandler/Processor/etc)
    const content = `
      export interface IDocumentHandler {
        parse(file: string): Promise<void>;
      }
      
      export abstract class BaseModalProcessor {
        abstract process(): void;
      }
    `;
    
    const points = analyzer.findInterfaceExtensionPoints(content, 'test.ts');
    const abstractPoints = analyzer.findAbstractClassPatterns(content, 'test.ts');
    
    // Should detect IDocumentHandler as extensible (matches pattern)
    expect(points.some(p => p.name === 'IDocumentHandler')).toBe(true);
    
    // Should detect BaseModalProcessor as abstract
    expect(abstractPoints.some(p => p.name === 'BaseModalProcessor')).toBe(true);
  });
});

describe('UnifiedAnalyzer', () => {
  it('should analyze single file with all layers', async () => {
    const analyzer = createUnifiedAnalyzer();
    const typesFile = path.resolve(__dirname, '../../src/modal/types.ts');
    
    const result = await analyzer.analyzeFile(typesFile, 'src/modal/types.ts');
    
    // Should have extension points
    expect(result.extensionPoints.length).toBeGreaterThan(0);
    
    // Should have union types
    expect(result.typeSemantics.unionTypes.length).toBeGreaterThan(0);
    
    // Should have design hints
    expect(result.typeSemantics.designHints.length).toBeGreaterThan(0);
    
    // Should include high-value extension points
    const unionPoints = result.extensionPoints.filter(p => p.kind === 'union-type');
    expect(unionPoints.length).toBeGreaterThan(0);
    
    // ContentSourceFormat should have high extensibility score
    const formatPoint = result.extensionPoints.find(p => p.name === 'ContentSourceFormat');
    expect(formatPoint).toBeDefined();
    expect(formatPoint?.extensibilityScore).toBeGreaterThanOrEqual(50);
    
    analyzer.clearCache();
  });

  it('should analyze directory and produce summary', async () => {
    const analyzer = createUnifiedAnalyzer({
      includePatterns: ['**/*.ts'],
      excludePatterns: ['**/*.test.ts', '**/*.spec.ts', '**/node_modules/**'],
    });
    
    const srcDir = path.resolve(__dirname, '../../src/modal');
    const result = await analyzer.analyzeDirectory(srcDir, 'src/modal');
    
    // Should have summary
    expect(result.summary).toBeDefined();
    expect(result.summary.totalExtensionPoints).toBeGreaterThan(0);
    expect(result.summary.filesAnalyzed).toBeGreaterThan(0);
    
    // Should have byKind breakdown
    expect(result.summary.byKind).toBeDefined();
    
    // Should have top extension points
    expect(result.summary.topExtensionPoints.length).toBeGreaterThan(0);
    
    analyzer.clearCache();
  });

  it('should score callbacks appropriately', async () => {
    const analyzer = createUnifiedAnalyzer();
    const typesFile = path.resolve(__dirname, '../../src/modal/types.ts');
    
    const result = await analyzer.analyzeFile(typesFile, 'src/modal/types.ts');
    
    // Find callback extension points
    const callbacks = result.extensionPoints.filter(p => p.kind === 'optional-callback');
    
    // All callbacks should have reasonable scores
    for (const cb of callbacks) {
      expect(cb.extensibilityScore).toBeGreaterThanOrEqual(50);
      expect(cb.extensibilityScore).toBeLessThanOrEqual(100);
    }
    
    analyzer.clearCache();
  });
});

describe('Extension Point Scoring', () => {
  it('should give higher scores to format-support unions', async () => {
    const analyzer = createUnifiedAnalyzer();
    const typesFile = path.resolve(__dirname, '../../src/modal/types.ts');
    
    const result = await analyzer.analyzeFile(typesFile, 'src/modal/types.ts');
    
    const formatPoint = result.extensionPoints.find(
      p => p.inferredPurpose === 'format-support'
    );
    const enumPoint = result.extensionPoints.find(
      p => p.inferredPurpose === 'enum-options'
    );
    
    if (formatPoint && enumPoint) {
      expect(formatPoint.extensibilityScore).toBeGreaterThan(enumPoint.extensibilityScore ?? 0);
    }
    
    analyzer.clearCache();
  });
});

describe('JavaScript Support', () => {
  it('should analyze JavaScript files with JSDoc', () => {
    const analyzer = createTypeSemanticAnalyzer();
    
    // Find a JS config file in the project (jest.config.js exists)
    const jsFile = path.resolve(__dirname, '../../jest.config.js');
    
    // Should not throw when analyzing JS files
    const result = analyzer.analyzeFile(jsFile, 'jest.config.js');
    
    // Result should be valid (even if empty for simple config files)
    expect(result).toBeDefined();
    expect(result.unionTypes).toBeDefined();
    expect(result.optionalCallbacks).toBeDefined();
    
    analyzer.clearCache();
  });

  it('should detect patterns in JavaScript content', () => {
    const analyzer = createPatternAnalyzer();
    
    // JavaScript with JSDoc and extension patterns
    const jsContent = `
/**
 * @typedef {'json' | 'xml' | 'yaml'} DataFormat
 */

/**
 * @callback DataParser
 * @param {string} input
 * @returns {Object}
 */

// Extension point: custom parsers
export class BaseParser {
  /** @abstract */
  parse(data) {
    throw new Error('Not implemented');
  }
}

// TODO: add streaming support
export function createParser(format) {
  // ...
}
    `;
    
    const hints = analyzer.analyzeContent(jsContent, 'parser.js');
    
    // Should find extension point comment
    const extensionHint = hints.find(h => h.intent === 'extension-point');
    expect(extensionHint).toBeDefined();
    
    // Should find TODO
    const todoHint = hints.find(h => h.intent === 'todo');
    expect(todoHint).toBeDefined();
  });
});

describe('Python Support', () => {
  it('should detect ABC and Protocol classes', async () => {
    const analyzer = createUnifiedAnalyzer();
    
    const pythonContent = `
from abc import ABC, abstractmethod
from typing import Protocol, Union, Optional

class IDocumentProcessor(Protocol):
    """Protocol for document processors."""
    def process(self, doc: str) -> str:
        ...

class BaseParser(ABC):
    """Abstract base class for parsers."""
    
    @abstractmethod
    def parse(self, content: str) -> dict:
        pass
    
    @abstractmethod
    def validate(self, data: dict) -> bool:
        pass

FormatType = Union["json", "xml", "yaml", "csv"]
OutputMode = "text" | "binary" | "stream"
    `;
    
    // Create a temp file path for testing (we'll analyze content directly)
    const { createPythonAnalyzer } = await import('../../src/analysis/languages/index.js');
    const pyAnalyzer = createPythonAnalyzer();
    const result = await pyAnalyzer.analyzeContent(pythonContent, 'parser.py');
    
    // Should find Protocol class
    const protocolPoint = result.extensionPoints.find(p => 
      p.name === 'IDocumentProcessor' && p.kind === 'interface'
    );
    expect(protocolPoint).toBeDefined();
    expect(protocolPoint?.extensibilityScore).toBeGreaterThanOrEqual(80);
    
    // Should find ABC class
    const abcPoint = result.extensionPoints.find(p => 
      p.name === 'BaseParser' && p.kind === 'interface'
    );
    expect(abcPoint).toBeDefined();
    
    // Should find abstract methods
    const parseMethod = result.extensionPoints.find(p => 
      p.name === 'BaseParser.parse' && p.kind === 'optional-callback'
    );
    expect(parseMethod).toBeDefined();
  });

  it('should detect Python union types', async () => {
    const { createPythonAnalyzer } = await import('../../src/analysis/languages/index.js');
    const analyzer = createPythonAnalyzer();
    
    const pythonContent = `
from typing import Union, Literal

FormatType = Union[str, bytes, bytearray]
OutputMode: TypeAlias = Literal["text", "json", "xml"]
ContentKind = "image" | "table" | "text" | "code"
    `;
    
    const result = await analyzer.analyzeContent(pythonContent, 'types.py');
    
    // Should find union types
    expect(result.typeSemantics.unionTypes.length).toBeGreaterThan(0);
    
    // Should find ContentKind (Python 3.10+ syntax)
    const contentKind = result.extensionPoints.find(p => p.name === 'ContentKind');
    expect(contentKind).toBeDefined();
    expect(contentKind?.kind).toBe('union-type');
  });
});

describe('Go Support', () => {
  it('should detect Go interfaces', async () => {
    const { createGoAnalyzer } = await import('../../src/analysis/languages/index.js');
    const analyzer = createGoAnalyzer();
    
    const goContent = `
package main

// Handler is the main interface for request handling
type Handler interface {
	Handle(req Request) Response
	Validate(data []byte) error
}

// Processor interface for data processing
type Processor interface {
	Reader
	Writer
	Process(input []byte) ([]byte, error)
}

// HandlerFunc is a function type for HTTP handlers
type HandlerFunc func(w ResponseWriter, r *Request)

// Number is a type constraint for numeric types
type Number interface {
	int | int64 | float32 | float64
}
    `;
    
    const result = await analyzer.analyzeContent(goContent, 'handler.go');
    
    // Should find Handler interface
    const handlerInterface = result.extensionPoints.find(p => 
      p.name === 'Handler' && p.kind === 'interface'
    );
    expect(handlerInterface).toBeDefined();
    expect(handlerInterface?.extensibilityScore).toBeGreaterThanOrEqual(70);
    
    // Should find Processor interface with embedded interfaces
    const processorInterface = result.extensionPoints.find(p => 
      p.name === 'Processor' && p.kind === 'interface'
    );
    expect(processorInterface).toBeDefined();
    
    // Should find HandlerFunc function type
    const handlerFunc = result.extensionPoints.find(p => 
      p.name === 'HandlerFunc' && p.kind === 'optional-callback'
    );
    expect(handlerFunc).toBeDefined();
    
    // Should find Number type constraint
    const numberConstraint = result.extensionPoints.find(p => 
      p.name === 'Number' && p.kind === 'union-type'
    );
    expect(numberConstraint).toBeDefined();
    expect(numberConstraint?.values).toContain('int');
    expect(numberConstraint?.values).toContain('float64');
  });

  it('should detect interface methods as callbacks', async () => {
    const { createGoAnalyzer } = await import('../../src/analysis/languages/index.js');
    const analyzer = createGoAnalyzer();
    
    const goContent = `
package plugin

type Plugin interface {
	Init(config Config) error
	Execute(ctx Context) Result
	Cleanup() error
}
    `;
    
    const result = await analyzer.analyzeContent(goContent, 'plugin.go');
    
    // Should have optional callbacks for each method
    const initCallback = result.typeSemantics.optionalCallbacks.find(c => c.name === 'Init');
    expect(initCallback).toBeDefined();
    expect(initCallback?.parent).toBe('Plugin');
    
    const executeCallback = result.typeSemantics.optionalCallbacks.find(c => c.name === 'Execute');
    expect(executeCallback).toBeDefined();
  });
});

describe('Rust Support', () => {
  it('should detect Rust traits', async () => {
    const { createRustAnalyzer } = await import('../../src/analysis/languages/index.js');
    const analyzer = createRustAnalyzer();
    
    const rustContent = `
use std::io::Result;

/// Handler trait for processing requests
pub trait Handler: Send + Sync {
    fn handle(&self, req: Request) -> Response;
    fn validate(&self, data: &[u8]) -> bool;
    
    /// Default implementation
    fn name(&self) -> &str {
        "default"
    }
}

/// Plugin trait for extensibility
pub trait Plugin {
    async fn init(&mut self) -> Result<()>;
    fn process(&self, input: &str) -> String;
}

pub enum MessageType {
    Text(String),
    Binary(Vec<u8>),
    Json(Value),
    Xml(String),
}

pub enum Status {
    Pending,
    Running,
    Completed,
    Failed,
}
    `;
    
    const result = await analyzer.analyzeContent(rustContent, 'lib.rs');
    
    // Should find Handler trait
    const handlerTrait = result.extensionPoints.find(p => 
      p.name === 'Handler' && p.kind === 'interface'
    );
    expect(handlerTrait).toBeDefined();
    expect(handlerTrait?.extensibilityScore).toBeGreaterThanOrEqual(70);
    
    // Should find Plugin trait
    const pluginTrait = result.extensionPoints.find(p => 
      p.name === 'Plugin' && p.kind === 'interface'
    );
    expect(pluginTrait).toBeDefined();
    expect(pluginTrait?.extensibilityScore).toBeGreaterThanOrEqual(80);
    
    // Should find MessageType enum
    const messageEnum = result.extensionPoints.find(p => 
      p.name === 'MessageType' && p.kind === 'union-type'
    );
    expect(messageEnum).toBeDefined();
    expect(messageEnum?.values).toContain('Text');
    expect(messageEnum?.values).toContain('Json');
    
    // Should find Status enum
    const statusEnum = result.extensionPoints.find(p => 
      p.name === 'Status' && p.kind === 'union-type'
    );
    expect(statusEnum).toBeDefined();
  });

  it('should detect trait methods as callbacks', async () => {
    const { createRustAnalyzer } = await import('../../src/analysis/languages/index.js');
    const analyzer = createRustAnalyzer();
    
    const rustContent = `
pub trait Processor {
    fn process(&self, data: Vec<u8>) -> Result<Vec<u8>>;
    fn cleanup(&mut self);
}
    `;
    
    const result = await analyzer.analyzeContent(rustContent, 'processor.rs');
    
    // Should find trait methods as callbacks
    const processMethod = result.typeSemantics.optionalCallbacks.find(c => c.name === 'process');
    expect(processMethod).toBeDefined();
    expect(processMethod?.parent).toBe('Processor');
    
    // Should find required method extension points
    const processPoint = result.extensionPoints.find(p => 
      p.name === 'Processor::process' && p.kind === 'optional-callback'
    );
    expect(processPoint).toBeDefined();
  });
});
