/**
 * Pattern Analyzer for design comments and extension point candidates.
 *
 * Uses regex patterns to detect:
 * - Design intent comments (TODO, @see, Design reference, etc.)
 * - Extension point markers
 * - Reserved/placeholder patterns
 *
 * @module analysis/pattern-analyzer
 */

import * as fs from 'node:fs/promises';
import type { DesignHintInfo, ExtensionPointInfo } from './types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('pattern-analyzer');

// ============================================================================
// Pattern Definitions
// ============================================================================

/**
 * Pattern for detecting design hints in comments.
 */
interface DesignPattern {
  /** Regex pattern */
  regex: RegExp;
  /** Intent classification */
  intent: DesignHintInfo['intent'];
  /** Extract referenced entity if any */
  extractReference?: (match: RegExpMatchArray) => string | undefined;
}

/**
 * Design hint patterns to detect.
 */
const DESIGN_PATTERNS: DesignPattern[] = [
  // TODO/FIXME comments (// or * style)
  {
    regex: /(?:\/\/|\*)\s*(TODO|FIXME|HACK|XXX):\s*(.+)/gi,
    intent: 'todo',
  },
  // Design reference comments (// or * style)
  {
    regex: /(?:\/\/|\*)\s*Design\s+reference:\s*(.+)/gi,
    intent: 'reference',
    extractReference: (match) => match[1]?.trim(),
  },
  // Extension point markers (// or * style)
  {
    regex: /(?:\/\/|\*)\s*(Extension\s+point|扩展点|Plugin\s+point):\s*(.+)/gi,
    intent: 'extension-point',
  },
  // Reserved/placeholder markers (// or * style)
  {
    regex: /(?:\/\/|\*)\s*(Reserved|预留|Placeholder|占位).*?:\s*(.+)/gi,
    intent: 'reserved',
  },
  // Deprecated markers (// or * style)
  {
    regex: /(?:\/\/|\*)\s*@deprecated\s*(.+)?/gi,
    intent: 'deprecated',
  },
  // JSDoc @see references
  {
    regex: /\*\s*@see\s+(.+)/gi,
    intent: 'reference',
    extractReference: (match) => match[1]?.trim(),
  },
  // JSDoc @extends/@implements hints
  {
    regex: /\*\s*@(extends|implements|mixes)\s+(.+)/gi,
    intent: 'extension-point',
    extractReference: (match) => match[2]?.trim(),
  },
];

/**
 * Patterns for detecting interface extension points.
 */
const INTERFACE_EXTENSION_PATTERNS = [
  // Interface names suggesting extensibility
  /^I[A-Z]\w*(Plugin|Handler|Processor|Provider|Factory|Strategy|Adapter)$/,
  // Base/Abstract prefix
  /^(Base|Abstract)[A-Z]\w+$/,
];

// ============================================================================
// Pattern Analyzer
// ============================================================================

/**
 * Analyzer for design patterns and comments in source code.
 */
export class PatternAnalyzer {
  /**
   * Analyze a file for design hints.
   */
  async analyzeFile(filePath: string, content?: string): Promise<DesignHintInfo[]> {
    const results: DesignHintInfo[] = [];

    try {
      const fileContent = content ?? (await fs.readFile(filePath, 'utf8'));
      const lines = fileContent.split('\n');

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex]!;
        const lineNumber = lineIndex + 1;

        for (const pattern of DESIGN_PATTERNS) {
          // Reset regex lastIndex for global patterns
          pattern.regex.lastIndex = 0;
          const match = pattern.regex.exec(line);

          if (match) {
            results.push({
              comment: match[0].trim(),
              file: filePath,
              line: lineNumber,
              intent: pattern.intent,
              referencedEntity: pattern.extractReference?.(match),
            });
          }
        }
      }

      logger.debug(`Found ${results.length} design hints in ${filePath}`);
      return results;
    } catch (error) {
      logger.error(`Failed to analyze ${filePath}`, error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Analyze content string directly (without file I/O).
   */
  analyzeContent(content: string, filePath: string): DesignHintInfo[] {
    const results: DesignHintInfo[] = [];
    const lines = content.split('\n');

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex]!;
      const lineNumber = lineIndex + 1;

      for (const pattern of DESIGN_PATTERNS) {
        pattern.regex.lastIndex = 0;
        const match = pattern.regex.exec(line);

        if (match) {
          results.push({
            comment: match[0].trim(),
            file: filePath,
            line: lineNumber,
            intent: pattern.intent,
            referencedEntity: pattern.extractReference?.(match),
          });
        }
      }
    }

    return results;
  }

  /**
   * Check if an interface name suggests extensibility.
   */
  isExtensibleInterfaceName(name: string): boolean {
    return INTERFACE_EXTENSION_PATTERNS.some((pattern) => pattern.test(name));
  }

  /**
   * Extract extension point candidates from interface definitions.
   * Uses regex-based detection for speed (complements ts-morph for depth).
   */
  findInterfaceExtensionPoints(content: string, filePath: string): ExtensionPointInfo[] {
    const results: ExtensionPointInfo[] = [];

    // Match exported interfaces
    const interfacePattern = /export\s+interface\s+(\w+)(?:<[^>]+>)?\s*(?:extends\s+(\w+(?:\s*,\s*\w+)*))?\s*\{/g;

    let match;
    while ((match = interfacePattern.exec(content)) !== null) {
      const name = match[1]!;
      const extendsClause = match[2];
      const lineNumber = content.substring(0, match.index).split('\n').length;

      // Check if interface name suggests extensibility
      if (this.isExtensibleInterfaceName(name)) {
        results.push({
          kind: 'interface',
          name,
          file: filePath,
          line: lineNumber,
          semantics: extendsClause
            ? `Extensible interface extending ${extendsClause}`
            : 'Extensible interface pattern detected',
          values: extendsClause ? extendsClause.split(/\s*,\s*/) : undefined,
          inferredPurpose: 'plugin-type',
        });
      }

      // Check for multiple extensions (suggests plugin architecture)
      if (extendsClause && extendsClause.includes(',')) {
        results.push({
          kind: 'interface',
          name,
          file: filePath,
          line: lineNumber,
          semantics: `Multi-inheritance interface: ${extendsClause}`,
          values: extendsClause.split(/\s*,\s*/),
          inferredPurpose: 'plugin-type',
        });
      }
    }

    return results;
  }

  /**
   * Find abstract class patterns suggesting extensibility.
   */
  findAbstractClassPatterns(content: string, filePath: string): ExtensionPointInfo[] {
    const results: ExtensionPointInfo[] = [];

    // Match abstract classes
    const abstractPattern = /export\s+abstract\s+class\s+(\w+)(?:<[^>]+>)?\s*(?:extends\s+(\w+))?\s*(?:implements\s+(\w+(?:\s*,\s*\w+)*))?\s*\{/g;

    let match;
    while ((match = abstractPattern.exec(content)) !== null) {
      const name = match[1]!;
      const extendsClass = match[2];
      const implementsClause = match[3];
      const lineNumber = content.substring(0, match.index).split('\n').length;

      results.push({
        kind: 'interface',
        name,
        file: filePath,
        line: lineNumber,
        semantics: `Abstract class ${extendsClass ? `extending ${extendsClass}` : ''}${implementsClause ? `, implementing ${implementsClause}` : ''}`.trim(),
        inferredPurpose: 'plugin-type',
        extensibilityScore: 70,
      });
    }

    return results;
  }

  /**
   * Analyze file for all pattern-based extension points.
   */
  async analyzeFileForExtensionPoints(
    filePath: string,
    content?: string
  ): Promise<{
    designHints: DesignHintInfo[];
    extensionPoints: ExtensionPointInfo[];
  }> {
    const fileContent = content ?? (await fs.readFile(filePath, 'utf8'));

    const designHints = this.analyzeContent(fileContent, filePath);
    const interfacePoints = this.findInterfaceExtensionPoints(fileContent, filePath);
    const abstractPoints = this.findAbstractClassPatterns(fileContent, filePath);

    // Convert high-value design hints to extension points
    const hintBasedPoints: ExtensionPointInfo[] = designHints
      .filter((h) => h.intent === 'extension-point' || h.intent === 'reference')
      .map((h) => ({
        kind: 'design-comment' as const,
        name: h.comment.substring(0, 50),
        file: h.file,
        line: h.line,
        semantics: h.comment,
        inferredPurpose: 'unknown' as const,
        extensibilityScore: h.intent === 'extension-point' ? 60 : 40,
      }));

    return {
      designHints,
      extensionPoints: [...interfacePoints, ...abstractPoints, ...hintBasedPoints],
    };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new pattern analyzer.
 */
export function createPatternAnalyzer(): PatternAnalyzer {
  return new PatternAnalyzer();
}
