/**
 * Test Example Quality Filter
 *
 * Filters out trivial or low-quality examples based on configurable criteria.
 * Helps ensure only meaningful and valuable examples are included in reports.
 *
 * @module bundle/analyzers/test-examples/quality-filter
 */

import { type TestExample, ExampleCategory } from './types.js';

// ============================================================================
// Default Trivial Patterns
// ============================================================================

/**
 * Default trivial patterns that indicate low-value examples.
 */
export const DEFAULT_TRIVIAL_PATTERNS: string[] = [
  // Mock-only
  'Mock()',
  'MagicMock()',
  'jest.fn()',
  'vi.fn()',
  'sinon.stub()',
  'sinon.spy()',

  // Trivial assertions
  'assertTrue(True)',
  'assertFalse(False)',
  'assertEqual(1, 1)',
  'assertIsNone(None)',
  'assertIsNotNone(None)',
  'expect(true).toBe(true)',
  'expect(false).toBe(false)',
  'expect(1).toBe(1)',
  'expect(null).toBeNull()',
  'expect(undefined).toBeUndefined()',

  // Placeholder code
  'pass',
  '...',
  'TODO',
  'FIXME',
  'XXX',

  // Empty or placeholder functions
  '() => {}',
  'function() {}',
  'lambda: None',
  '=> null',
  '=> undefined',
];

// ============================================================================
// Quality Filter Options
// ============================================================================

/**
 * Configuration options for the quality filter.
 */
export type QualityFilterOptions = {
  /** Minimum confidence threshold (0.0-1.0) */
  minConfidence: number;
  /** Minimum code length to include */
  minCodeLength: number;
  /** Additional trivial patterns to exclude */
  additionalTrivialPatterns: string[];
  /** Whether to remove duplicates (same exampleId) */
  removeDuplicates: boolean;
  /** Maximum examples per category */
  maxPerCategory: number;
  /** Categories to exclude entirely */
  excludeCategories: ExampleCategory[];
  /** Minimum complexity score (0.0-1.0) */
  minComplexity: number;
};

/**
 * Default quality filter options.
 */
export const DEFAULT_QUALITY_FILTER_OPTIONS: Required<QualityFilterOptions> = {
  minConfidence: 0.5,
  minCodeLength: 20,
  additionalTrivialPatterns: [],
  removeDuplicates: true,
  maxPerCategory: 0, // 0 = unlimited
  excludeCategories: [],
  minComplexity: 0,
};

// ============================================================================
// Quality Filter Class
// ============================================================================

/**
 * Filters test examples based on quality criteria.
 *
 * @example
 * ```ts
 * const filter = createQualityFilter({ minConfidence: 0.7 });
 * const filtered = filter.filter(examples);
 * ```
 */
export class QualityFilter {
  private readonly options: Required<QualityFilterOptions>;
  private readonly trivialPatterns: string[];

  /**
   * Creates a new quality filter.
   */
  constructor(options?: Partial<QualityFilterOptions>) {
    this.options = {
      ...DEFAULT_QUALITY_FILTER_OPTIONS,
      ...options,
    };

    this.trivialPatterns = [
      ...DEFAULT_TRIVIAL_PATTERNS,
      ...this.options.additionalTrivialPatterns,
    ];
  }

  /**
   * Filter examples by quality criteria.
   *
   * @param examples - Examples to filter
   * @returns Filtered examples meeting quality criteria
   */
  filter(examples: TestExample[]): TestExample[] {
    let filtered = examples;

    // Remove excluded categories
    if (this.options.excludeCategories.length > 0) {
      filtered = filtered.filter((ex) => !this.options.excludeCategories.includes(ex.category));
    }

    // Apply individual filters
    filtered = filtered.filter((ex) => this.meetsQualityCriteria(ex));

    // Remove duplicates
    if (this.options.removeDuplicates) {
      filtered = this.removeDuplicates(filtered);
    }

    // Apply per-category limits
    if (this.options.maxPerCategory > 0) {
      filtered = this.applyPerCategoryLimit(filtered);
    }

    return filtered;
  }

  /**
   * Check if a single example meets quality criteria.
   */
  meetsQualityCriteria(example: TestExample): boolean {
    // Check confidence threshold
    if (example.confidence < this.options.minConfidence) {
      return false;
    }

    // Check complexity threshold
    if (example.complexityScore < this.options.minComplexity) {
      return false;
    }

    // Check code length
    if (example.code.length < this.options.minCodeLength) {
      return false;
    }

    // Check for trivial patterns
    if (this.isTrivial(example.code)) {
      return false;
    }

    return true;
  }

  /**
   * Check if code contains trivial patterns.
   */
  private isTrivial(code: string): boolean {
    const codeLower = code.toLowerCase();
    return this.trivialPatterns.some((pattern) => codeLower.includes(pattern.toLowerCase()));
  }

  /**
   * Remove duplicate examples (same exampleId).
   */
  private removeDuplicates(examples: TestExample[]): TestExample[] {
    const seen = new Set<string>();
    const unique: TestExample[] = [];

    for (const example of examples) {
      if (!seen.has(example.exampleId)) {
        seen.add(example.exampleId);
        unique.push(example);
      }
    }

    return unique;
  }

  /**
   * Apply per-category limits, keeping highest confidence examples.
   */
  private applyPerCategoryLimit(examples: TestExample[]): TestExample[] {
    const byCategory = new Map<ExampleCategory, TestExample[]>();

    // Group by category
    for (const example of examples) {
      const category = example.category;
      if (!byCategory.has(category)) {
        byCategory.set(category, []);
      }
      byCategory.get(category)!.push(example);
    }

    // Sort each category by confidence and take top N
    const limited: TestExample[] = [];
    for (const [_, categoryExamples] of byCategory) {
      const sorted = categoryExamples.sort((a, b) => b.confidence - a.confidence);
      limited.push(...sorted.slice(0, this.options.maxPerCategory));
    }

    return limited;
  }

  /**
   * Get statistics about filtered examples.
   */
  getFilterStats(
    before: TestExample[],
    after: TestExample[]
  ): {
    totalBefore: number;
    totalAfter: number;
    removedByConfidence: number;
    removedByLength: number;
    removedAsTrivial: number;
    removedAsDuplicate: number;
    removedByCategory: number;
  } {
    const stats = {
      totalBefore: before.length,
      totalAfter: after.length,
      removedByConfidence: 0,
      removedByLength: 0,
      removedAsTrivial: 0,
      removedAsDuplicate: 0,
      removedByCategory: 0,
    };

    const seenIds = new Set<string>();
    const afterIds = new Set(after.map((ex) => ex.exampleId));

    for (const example of before) {
      if (afterIds.has(example.exampleId)) {
        seenIds.add(example.exampleId);
        continue;
      }

      // Determine removal reason
      if (this.options.excludeCategories.includes(example.category)) {
        stats.removedByCategory++;
      } else if (example.confidence < this.options.minConfidence) {
        stats.removedByConfidence++;
      } else if (example.code.length < this.options.minCodeLength) {
        stats.removedByLength++;
      } else if (this.isTrivial(example.code)) {
        stats.removedAsTrivial++;
      } else if (seenIds.has(example.exampleId)) {
        stats.removedAsDuplicate++;
      }

      seenIds.add(example.exampleId);
    }

    return stats;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new QualityFilter instance.
 */
export function createQualityFilter(options?: Partial<QualityFilterOptions>): QualityFilter {
  return new QualityFilter(options);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Sorts examples by value (confidence * complexity).
 */
export function sortByValue(examples: TestExample[]): TestExample[] {
  return [...examples].sort((a, b) => {
    const valueA = a.confidence * (1 + a.complexityScore);
    const valueB = b.confidence * (1 + b.complexityScore);
    return valueB - valueA;
  });
}

/**
 * Groups examples by category.
 */
export function groupByCategory(examples: TestExample[]): Map<ExampleCategory, TestExample[]> {
  const grouped = new Map<ExampleCategory, TestExample[]>();

  for (const example of examples) {
    if (!grouped.has(example.category)) {
      grouped.set(example.category, []);
    }
    grouped.get(example.category)!.push(example);
  }

  return grouped;
}

/**
 * Groups examples by language.
 */
export function groupByLanguage(
  examples: TestExample[]
): Map<TestExample['language'], TestExample[]> {
  const grouped = new Map<TestExample['language'], TestExample[]>();

  for (const example of examples) {
    if (!grouped.has(example.language)) {
      grouped.set(example.language, []);
    }
    grouped.get(example.language)!.push(example);
  }

  return grouped;
}

/**
 * Gets top N examples by confidence.
 */
export function getTopExamples(examples: TestExample[], n: number): TestExample[] {
  return [...examples].sort((a, b) => b.confidence - a.confidence).slice(0, n);
}
