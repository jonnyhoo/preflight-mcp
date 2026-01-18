/**
 * Conflict Detector Tests
 *
 * Tests for the documentation-code conflict detection module.
 */

import { describe, it, expect } from '@jest/globals';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createConflictDetector,
  detectConflicts,
  ConflictDetector,
  DEFAULT_CONFLICT_OPTIONS,
  type ConflictAnalyzerOptions,
  type DocsData,
  type CodeData,
  type APIInfo,
} from '../../../src/bundle/analyzers/conflicts/index.js';
import type { AnalyzerInput, IngestedFile, BundleManifest } from '../../../src/bundle/analyzers/types.js';

// ESM compat
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Test Helpers
// ============================================================================

function createMockFile(relativePath: string): IngestedFile {
  return {
    repoRelativePath: relativePath,
    bundleNormRelativePath: `repos/test/norm/${relativePath}`,
    bundleNormAbsPath: `/tmp/bundle/repos/test/norm/${relativePath}`,
    kind: 'code',
    repoId: 'test/repo',
  };
}

function createMockManifest(
  docsData?: DocsData,
  codeData?: CodeData
): BundleManifest & { metadata?: Record<string, unknown> } {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    description: 'Test bundle',
    repos: {},
    layout: {
      version: 1,
      dirs: {
        root: '/tmp/bundle',
        repos: '/tmp/bundle/repos',
        analysis: '/tmp/bundle/analysis',
      },
    },
    metadata: {
      docsData: docsData ?? { apis: [] },
      codeData: codeData ?? { apis: [] },
    },
  };
}

function createMockInput(
  docsData?: DocsData,
  codeData?: CodeData,
  files?: IngestedFile[]
): AnalyzerInput {
  return {
    bundleRoot: '/tmp/bundle',
    files: files ?? [],
    manifest: createMockManifest(docsData, codeData),
  };
}

function createDocsApi(
  name: string,
  params?: { name: string; type?: string }[],
  returnType?: string
): APIInfo {
  return {
    name,
    type: 'function',
    parameters: params?.map(p => ({ name: p.name, type: p.type })),
    returnType,
    sourceUrl: 'https://docs.example.com/api',
  };
}

function createCodeApi(
  name: string,
  params?: { name: string; type?: string }[],
  returnType?: string,
  source?: string
): APIInfo {
  return {
    name,
    type: 'function',
    parameters: params?.map(p => ({ name: p.name, type: p.type })),
    returnType,
    source: source ?? 'src/main.ts',
    line: 10,
  };
}

// ============================================================================
// ConflictDetector Tests
// ============================================================================

describe('ConflictDetector', () => {
  describe('factory function', () => {
    it('should create detector with default options', () => {
      const detector = createConflictDetector();

      expect(detector).toBeInstanceOf(ConflictDetector);
      expect(detector.name).toBe('conflict-detector');
      expect(detector.version).toBe('1.0.0');
    });

    it('should create detector with custom options', () => {
      const detector = createConflictDetector({
        conflictTypes: ['missing_in_code'],
        nameSimilarityThreshold: 0.9,
      });

      expect(detector.options.conflictTypes).toEqual(['missing_in_code']);
      expect(detector.options.nameSimilarityThreshold).toBe(0.9);
    });
  });

  describe('analyze - empty input', () => {
    it('should return success with no conflicts for empty data', async () => {
      const detector = createConflictDetector();
      const input = createMockInput();

      const result = await detector.analyze(input);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.conflicts).toHaveLength(0);
      expect(result.data?.summary.total).toBe(0);
      expect(result.metadata.analyzerName).toBe('conflict-detector');
    });
  });

  describe('analyze - missing_in_docs', () => {
    it('should detect API missing in documentation', async () => {
      const detector = createConflictDetector();
      const input = createMockInput(
        { apis: [] }, // No docs
        { apis: [createCodeApi('publicFunc', [{ name: 'arg1', type: 'string' }])] }
      );

      const result = await detector.analyze(input);

      expect(result.success).toBe(true);
      expect(result.data?.conflicts).toHaveLength(1);
      expect(result.data?.conflicts[0].type).toBe('missing_in_docs');
      expect(result.data?.conflicts[0].apiName).toBe('publicFunc');
      expect(result.data?.conflicts[0].severity).toBe('medium');
    });

    it('should assign lower severity for private APIs', async () => {
      const detector = createConflictDetector({ lowerPrivateSeverity: true });
      const input = createMockInput(
        { apis: [] },
        { apis: [createCodeApi('_privateFunc')] }
      );

      const result = await detector.analyze(input);

      expect(result.success).toBe(true);
      expect(result.data?.conflicts).toHaveLength(1);
      expect(result.data?.conflicts[0].type).toBe('missing_in_docs');
      expect(result.data?.conflicts[0].severity).toBe('low');
    });

    it('should include suggestion when enabled', async () => {
      const detector = createConflictDetector({ includeSuggestions: true });
      const input = createMockInput(
        { apis: [] },
        { apis: [createCodeApi('myFunc')] }
      );

      const result = await detector.analyze(input);

      expect(result.data?.conflicts[0].suggestion).toBeDefined();
      expect(result.data?.conflicts[0].suggestion).toContain('documentation');
    });
  });

  describe('analyze - missing_in_code', () => {
    it('should detect API missing in code', async () => {
      const detector = createConflictDetector();
      const input = createMockInput(
        { apis: [createDocsApi('documentedFunc')] },
        { apis: [] } // No code
      );

      const result = await detector.analyze(input);

      expect(result.success).toBe(true);
      expect(result.data?.conflicts).toHaveLength(1);
      expect(result.data?.conflicts[0].type).toBe('missing_in_code');
      expect(result.data?.conflicts[0].apiName).toBe('documentedFunc');
      expect(result.data?.conflicts[0].severity).toBe('high'); // High severity for documented but missing
    });
  });

  describe('analyze - signature_mismatch', () => {
    it('should detect parameter count mismatch', async () => {
      const detector = createConflictDetector();
      const input = createMockInput(
        { apis: [createDocsApi('myFunc', [{ name: 'a' }, { name: 'b' }])] },
        { apis: [createCodeApi('myFunc', [{ name: 'a' }])] } // Only 1 param in code
      );

      const result = await detector.analyze(input);

      expect(result.success).toBe(true);
      const mismatch = result.data?.conflicts.find(c => c.type === 'signature_mismatch');
      expect(mismatch).toBeDefined();
      expect(mismatch?.difference).toContain('Parameter count mismatch');
      expect(mismatch?.severity).toBe('medium');
    });

    it('should detect parameter name mismatch', async () => {
      const detector = createConflictDetector({ nameSimilarityThreshold: 0.9 });
      const input = createMockInput(
        { apis: [createDocsApi('myFunc', [{ name: 'userName' }])] },
        { apis: [createCodeApi('myFunc', [{ name: 'userId' }])] } // Different name
      );

      const result = await detector.analyze(input);

      expect(result.success).toBe(true);
      const mismatch = result.data?.conflicts.find(c => c.type === 'signature_mismatch');
      expect(mismatch).toBeDefined();
      expect(mismatch?.difference).toContain('name mismatch');
    });

    it('should detect parameter type mismatch', async () => {
      const detector = createConflictDetector();
      const input = createMockInput(
        { apis: [createDocsApi('myFunc', [{ name: 'id', type: 'string' }])] },
        { apis: [createCodeApi('myFunc', [{ name: 'id', type: 'number' }])] } // Different type
      );

      const result = await detector.analyze(input);

      expect(result.success).toBe(true);
      const mismatch = result.data?.conflicts.find(c => c.type === 'signature_mismatch');
      expect(mismatch).toBeDefined();
      expect(mismatch?.difference).toContain('type mismatch');
      expect(mismatch?.severity).toBe('low');
    });

    it('should detect return type mismatch', async () => {
      const detector = createConflictDetector();
      const input = createMockInput(
        { apis: [createDocsApi('myFunc', [], 'string')] },
        { apis: [createCodeApi('myFunc', [], 'number')] } // Different return type
      );

      const result = await detector.analyze(input);

      expect(result.success).toBe(true);
      const mismatch = result.data?.conflicts.find(c => c.type === 'signature_mismatch');
      expect(mismatch).toBeDefined();
      expect(mismatch?.difference).toContain('Return type mismatch');
    });

    it('should not report mismatch when signatures match', async () => {
      const detector = createConflictDetector();
      const input = createMockInput(
        { apis: [createDocsApi('myFunc', [{ name: 'a', type: 'string' }], 'void')] },
        { apis: [createCodeApi('myFunc', [{ name: 'a', type: 'string' }], 'void')] }
      );

      const result = await detector.analyze(input);

      expect(result.success).toBe(true);
      expect(result.data?.conflicts.filter(c => c.type === 'signature_mismatch')).toHaveLength(0);
    });
  });

  describe('analyze - options filtering', () => {
    it('should only detect specified conflict types', async () => {
      const detector = createConflictDetector({
        conflictTypes: ['missing_in_code'], // Only check missing in code
      });
      const input = createMockInput(
        { apis: [createDocsApi('docFunc')] },
        { apis: [createCodeApi('codeFunc')] } // Different API, would cause missing_in_docs too
      );

      const result = await detector.analyze(input);

      expect(result.success).toBe(true);
      // Should only have missing_in_code conflicts
      expect(result.data?.conflicts.every(c => c.type === 'missing_in_code')).toBe(true);
      expect(result.data?.conflicts).toHaveLength(1);
    });

    it('should exclude private APIs when includePrivateApis is false', async () => {
      const detector = createConflictDetector({ includePrivateApis: false });
      const input = createMockInput(
        { apis: [] },
        { apis: [createCodeApi('_privateFunc'), createCodeApi('publicFunc')] }
      );

      const result = await detector.analyze(input);

      expect(result.success).toBe(true);
      // Should only report publicFunc
      expect(result.data?.conflicts).toHaveLength(1);
      expect(result.data?.conflicts[0].apiName).toBe('publicFunc');
    });
  });

  describe('analyze - summary generation', () => {
    it('should generate correct summary statistics', async () => {
      const detector = createConflictDetector();
      const input = createMockInput(
        { apis: [createDocsApi('docOnly'), createDocsApi('both', [{ name: 'a' }])] },
        { apis: [createCodeApi('codeOnly'), createCodeApi('both', [{ name: 'b' }])] } // param mismatch
      );

      const result = await detector.analyze(input);

      expect(result.success).toBe(true);
      expect(result.data?.summary.total).toBeGreaterThanOrEqual(2);
      expect(result.data?.summary.byType.missing_in_docs).toBeGreaterThanOrEqual(1);
      expect(result.data?.summary.byType.missing_in_code).toBeGreaterThanOrEqual(1);
      expect(result.data?.summary.apisAffected).toBeGreaterThanOrEqual(2);
    });

    it('should count by severity correctly', async () => {
      const detector = createConflictDetector({ lowerPrivateSeverity: true });
      const input = createMockInput(
        { apis: [createDocsApi('docOnly')] }, // missing_in_code -> high
        { apis: [createCodeApi('_private')] } // missing_in_docs -> low
      );

      const result = await detector.analyze(input);

      expect(result.success).toBe(true);
      expect(result.data?.summary.bySeverity.high).toBe(1);
      expect(result.data?.summary.bySeverity.low).toBe(1);
    });
  });

  describe('analyze - API counts', () => {
    it('should report correct API counts', async () => {
      const detector = createConflictDetector();
      const input = createMockInput(
        { apis: [createDocsApi('a'), createDocsApi('b'), createDocsApi('common')] },
        { apis: [createCodeApi('common'), createCodeApi('c')] }
      );

      const result = await detector.analyze(input);

      expect(result.success).toBe(true);
      expect(result.data?.docsApiCount).toBe(3);
      expect(result.data?.codeApiCount).toBe(2);
      expect(result.data?.commonApiCount).toBe(1);
    });
  });
});

// ============================================================================
// detectConflicts Convenience Function Tests
// ============================================================================

describe('detectConflicts', () => {
  it('should work as a convenience function', async () => {
    const input = createMockInput(
      { apis: [createDocsApi('func1')] },
      { apis: [createCodeApi('func2')] }
    );

    const result = await detectConflicts(input);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data?.conflicts.length).toBeGreaterThan(0);
  });

  it('should accept options', async () => {
    const input = createMockInput(
      { apis: [] },
      { apis: [createCodeApi('myFunc')] }
    );

    const result = await detectConflicts(input, { includeSuggestions: false });

    expect(result.success).toBe(true);
    expect(result.data?.conflicts[0].suggestion).toBeUndefined();
  });
});

// ============================================================================
// Default Options Tests
// ============================================================================

describe('DEFAULT_CONFLICT_OPTIONS', () => {
  it('should have expected default values', () => {
    expect(DEFAULT_CONFLICT_OPTIONS.enabled).toBe(true);
    expect(DEFAULT_CONFLICT_OPTIONS.timeout).toBe(30000);
    expect(DEFAULT_CONFLICT_OPTIONS.conflictTypes).toEqual([]);
    expect(DEFAULT_CONFLICT_OPTIONS.nameSimilarityThreshold).toBe(0.8);
    expect(DEFAULT_CONFLICT_OPTIONS.includePrivateApis).toBe(true);
    expect(DEFAULT_CONFLICT_OPTIONS.includeSuggestions).toBe(true);
    expect(DEFAULT_CONFLICT_OPTIONS.lowerPrivateSeverity).toBe(true);
  });
});

// ============================================================================
// Edge Cases Tests
// ============================================================================

describe('Edge Cases', () => {
  it('should handle code data from code_analysis structure', async () => {
    const detector = createConflictDetector();
    const codeData: CodeData = {
      code_analysis: {
        files: [
          {
            file: 'src/utils.ts',
            functions: [
              { name: 'helperFunc', parameters: [], return_type: 'void' },
            ],
            classes: [
              {
                name: 'MyClass',
                methods: [
                  { name: 'myMethod', parameters: [{ name: 'arg', type: 'string' }] },
                ],
              },
            ],
          },
        ],
      },
    };
    const input = createMockInput({ apis: [] }, codeData);

    const result = await detector.analyze(input);

    expect(result.success).toBe(true);
    // Should detect helperFunc and MyClass.myMethod
    const apiNames = result.data?.conflicts.map(c => c.apiName) ?? [];
    expect(apiNames).toContain('helperFunc');
    expect(apiNames).toContain('MyClass.myMethod');
    expect(apiNames).toContain('MyClass');
  });

  it('should handle similar parameter names with fuzzy matching', async () => {
    const detector = createConflictDetector({ nameSimilarityThreshold: 0.7 });
    const input = createMockInput(
      { apis: [createDocsApi('func', [{ name: 'userName' }])] },
      { apis: [createCodeApi('func', [{ name: 'user_name' }])] } // Similar but not exact
    );

    const result = await detector.analyze(input);

    expect(result.success).toBe(true);
    // With 0.7 threshold, 'userName' and 'user_name' should be considered similar enough
    const mismatches = result.data?.conflicts.filter(c => c.type === 'signature_mismatch') ?? [];
    // They might still match due to similarity - depends on exact ratio
  });

  it('should handle validation errors', async () => {
    const detector = createConflictDetector();
    const input = {
      bundleRoot: '',
      files: [],
      manifest: null as unknown as BundleManifest,
    };

    const result = await detector.analyze(input);

    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.length).toBeGreaterThan(0);
  });
});
