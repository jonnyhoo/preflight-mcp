/**
 * Strategy Pattern Detector
 *
 * Detects the Strategy design pattern which defines a family of algorithms,
 * encapsulates each one, and makes them interchangeable. Strategy lets the
 * algorithm vary independently from clients that use it.
 *
 * Detection Heuristics:
 * - Surface: Class/method names with 'Strategy', 'Policy', 'Algorithm'
 * - Deep: Interface with single key method + multiple implementations
 * - Full: Composition with interchangeable strategy objects
 *
 * Examples:
 * - SortStrategy with sort() method
 * - PaymentStrategy with pay() method
 * - CompressionStrategy with compress() method
 *
 * @module bundle/analyzers/gof-patterns/detectors/strategy
 */

import { BasePatternDetector } from '../base-detector.js';
import {
  type PatternInstance,
  type PatternEvidence,
  type DetectionContext,
  type ClassSignature,
  PatternCategory,
  DetectionDepth,
} from '../types.js';

// ============================================================================
// Constants
// ============================================================================

/** Keywords in class names suggesting strategy pattern */
const STRATEGY_CLASS_KEYWORDS = [
  'strategy',
  'policy',
  'algorithm',
  'behavior',
  'comparator',
  'validator',
  'handler',
];

/** Common strategy method names */
const STRATEGY_METHOD_NAMES = [
  'execute',
  'apply',
  'perform',
  'calculate',
  'process',
  'compute',
  'handle',
  'run',
  'do',
  'validate',
  'compare',
  'sort',
  'filter',
  'transform',
];

// ============================================================================
// Strategy Detector
// ============================================================================

/**
 * Detector for the Strategy pattern.
 *
 * Strategy pattern enables selecting an algorithm at runtime. Instead of
 * implementing a single algorithm directly, code receives run-time instructions
 * as to which in a family of algorithms to use.
 */
export class StrategyDetector extends BasePatternDetector {
  readonly patternType = 'Strategy' as const;
  readonly category = PatternCategory.Behavioral;

  /**
   * Surface detection: Check naming conventions for Strategy.
   */
  protected detectSurface(context: DetectionContext): PatternInstance | null {
    const { currentClass } = context;

    if (this.classNameContains(currentClass.name, STRATEGY_CLASS_KEYWORDS)) {
      const evidence: PatternEvidence[] = [
        this.createNamingEvidence(
          `Class name suggests Strategy: ${currentClass.name}`,
          0.7
        ),
      ];

      return this.createPatternInstance(context, 0.7, evidence, DetectionDepth.Surface);
    }

    return null;
  }

  /**
   * Deep detection: Structural analysis for Strategy.
   *
   * Looks for:
   * - Part of strategy family (siblings with same base class)
   * - Single dominant method (strategy interface)
   * - Base class/interface pattern
   */
  protected detectDeep(context: DetectionContext): PatternInstance | null {
    const { currentClass, allClasses } = context;
    const evidence: PatternEvidence[] = [];
    let confidence = 0;

    // Check if this class is a concrete strategy (has base class)
    if (currentClass.baseClasses.length > 0) {
      const baseClass = currentClass.baseClasses[0];

      // Look for siblings (other strategies with same base)
      const siblings = this.findSiblingClasses(allClasses, currentClass);

      if (siblings.length > 0) {
        const siblingNames = siblings.slice(0, 3).map((s) => s.name).join(', ');
        evidence.push(
          this.createStructuralEvidence(
            `Part of strategy family with: ${siblingNames}`,
            0.5
          )
        );
        confidence += 0.5;
      }

      // Check if base class name suggests strategy
      if (baseClass && STRATEGY_CLASS_KEYWORDS.some(
        (kw) => baseClass.toLowerCase().includes(kw)
      )) {
        evidence.push(
          this.createStructuralEvidence(
            `Inherits from strategy base: ${baseClass}`,
            0.3
          )
        );
        confidence += 0.3;
      }
    }

    // Check if this is a strategy base class (has subclasses)
    const subclasses = this.findSubclasses(allClasses, currentClass.name);
    if (subclasses.length >= 2) {
      const subclassNames = subclasses.slice(0, 3).map((s) => s.name).join(', ');
      evidence.push(
        this.createStructuralEvidence(
          `Strategy base with implementations: ${subclassNames}`,
          0.6
        )
      );
      confidence += 0.6;
    }

    // Check for single dominant method (strategy interface characteristic)
    const nonConstructorMethods = currentClass.methods.filter(
      (m) => !['__init__', 'constructor', '__new__', '__str__', '__repr__', 'toString'].includes(m.name)
    );

    if (nonConstructorMethods.length === 1) {
      const mainMethod = nonConstructorMethods[0];
      if (mainMethod) {
        evidence.push(
          this.createStructuralEvidence(
            `Single interface method: ${mainMethod.name}()`,
            0.3
          )
        );
        confidence += 0.3;
      }
    } else if (nonConstructorMethods.length >= 1 && nonConstructorMethods.length <= 3) {
      // Few methods - might be strategy
      const strategyMethod = nonConstructorMethods.find((m) =>
        STRATEGY_METHOD_NAMES.some((name) =>
          m.name.toLowerCase().includes(name)
        )
      );

      if (strategyMethod) {
        evidence.push(
          this.createStructuralEvidence(
            `Strategy interface method: ${strategyMethod.name}()`,
            0.2
          )
        );
        confidence += 0.2;
      }
    }

    // Check for abstract class (strategy base)
    if (currentClass.isAbstract) {
      evidence.push(
        this.createStructuralEvidence(`Abstract strategy base class`, 0.2)
      );
      confidence += 0.2;
    }

    if (confidence >= 0.5) {
      const relatedClasses = [
        ...currentClass.baseClasses,
        ...subclasses.map((s) => s.name),
      ];

      return this.createPatternInstance(
        context,
        Math.min(confidence, 0.9),
        evidence,
        DetectionDepth.Deep,
        { relatedClasses }
      );
    }

    return null;
  }

  /**
   * Full detection: Behavioral analysis for Strategy.
   */
  protected detectFull(context: DetectionContext): PatternInstance | null {
    if (!context.fileContent) return null;

    // Start with deep detection
    const deepResult = this.detectDeep(context);
    if (!deepResult) return null;

    const evidence = [...deepResult.evidence];
    let confidence = deepResult.confidence;

    // Check for strategy composition patterns
    const compositionPatterns = [
      'self.strategy',
      'this.strategy',
      'self._strategy',
      'this._strategy',
      'strategy.execute',
      'strategy.apply',
      'strategy.process',
      'setStrategy',
      'set_strategy',
    ];

    const compositionFound = this.contentContains(context.fileContent, compositionPatterns);
    if (compositionFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(
          `Strategy composition: ${compositionFound.slice(0, 2).join(', ')}`,
          0.1
        )
      );
      confidence += 0.1;
    }

    // Check for polymorphic method calls
    const polymorphicPatterns = [
      '.execute(',
      '.apply(',
      '.process(',
      '.calculate(',
      '.perform(',
    ];

    const polymorphicFound = this.contentContains(context.fileContent, polymorphicPatterns);
    if (polymorphicFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(
          `Polymorphic strategy invocation`,
          0.1
        )
      );
      confidence += 0.1;
    }

    // Check for duck typing / protocol pattern (Python)
    if (
      context.fileContent.includes('Protocol') ||
      context.fileContent.includes('typing_extensions')
    ) {
      evidence.push(
        this.createBehavioralEvidence(`Python Protocol-based strategy`, 0.05)
      );
      confidence += 0.05;
    }

    // Check for interface implementation
    if (
      context.fileContent.includes('implements') ||
      context.fileContent.includes('interface')
    ) {
      evidence.push(
        this.createBehavioralEvidence(`Interface-based strategy`, 0.05)
      );
      confidence += 0.05;
    }

    return this.createPatternInstance(
      context,
      Math.min(confidence, 0.95),
      evidence,
      DetectionDepth.Full,
      { relatedClasses: deepResult.relatedClasses }
    );
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new StrategyDetector instance.
 */
export function createStrategyDetector(): StrategyDetector {
  return new StrategyDetector();
}
