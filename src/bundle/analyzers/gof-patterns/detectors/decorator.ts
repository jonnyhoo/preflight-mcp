/**
 * Decorator Pattern Detector
 *
 * Detects the Decorator design pattern which attaches additional responsibilities
 * to an object dynamically. Decorators provide a flexible alternative to
 * subclassing for extending functionality.
 *
 * Detection Heuristics:
 * - Surface: Class name contains 'Decorator', 'Wrapper'
 * - Deep: Wraps same interface, delegates to wrapped object
 * - Full: Composition + delegation + interface matching
 *
 * Examples:
 * - LoggingDecorator wraps Service
 * - CachingDecorator wraps DataFetcher
 * - Python @decorator syntax
 *
 * @module bundle/analyzers/gof-patterns/detectors/decorator
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

/** Keywords in class names suggesting decorator pattern */
const DECORATOR_CLASS_KEYWORDS = ['decorator', 'wrapper', 'enhancer', 'interceptor'];

/** Parameter names suggesting wrapped object */
const WRAPPED_PARAM_NAMES = [
  'wrapped',
  'component',
  'inner',
  'obj',
  'target',
  'decorated',
  'delegate',
  'base',
  'original',
];

/** Patterns indicating delegation to wrapped object */
const DELEGATION_PATTERNS = [
  'self._',
  'self.wrapped',
  'self.component',
  'self.delegate',
  'this._',
  'this.wrapped',
  'this.component',
  'this.delegate',
  'super(',
  'super.',
];

// ============================================================================
// Decorator Detector
// ============================================================================

/**
 * Detector for the Decorator pattern.
 *
 * Decorator pattern is used to add behavior to objects without affecting
 * other objects of the same class. It's particularly useful for adhering
 * to the Single Responsibility Principle.
 */
export class DecoratorDetector extends BasePatternDetector {
  readonly patternType = 'Decorator' as const;
  readonly category = PatternCategory.Structural;

  /**
   * Surface detection: Check naming conventions for Decorator.
   */
  protected detectSurface(context: DetectionContext): PatternInstance | null {
    const { currentClass } = context;

    // Check class name
    if (this.classNameContains(currentClass.name, DECORATOR_CLASS_KEYWORDS)) {
      const evidence: PatternEvidence[] = [
        this.createNamingEvidence(
          `Class name suggests Decorator: ${currentClass.name}`,
          0.65
        ),
      ];

      return this.createPatternInstance(context, 0.65, evidence, DetectionDepth.Surface);
    }

    // Check for Python decorator syntax in methods
    for (const method of currentClass.methods) {
      if (method.decorators && method.decorators.length > 0) {
        // Having decorators is very common, so low confidence
        const evidence: PatternEvidence[] = [
          this.createNamingEvidence(
            `Method uses decorators: @${method.decorators.join(', @')}`,
            0.3
          ),
        ];

        return this.createPatternInstance(
          context,
          0.3,
          evidence,
          DetectionDepth.Surface,
          { methodName: method.name }
        );
      }
    }

    return null;
  }

  /**
   * Deep detection: Structural analysis for Decorator.
   *
   * Looks for:
   * - Has same base class as wrapped object
   * - Takes wrapped object in constructor
   * - Delegates calls to wrapped object
   */
  protected detectDeep(context: DetectionContext): PatternInstance | null {
    const { currentClass, allClasses } = context;
    const evidence: PatternEvidence[] = [];
    let confidence = 0;

    // Check if class shares base class with other classes
    if (currentClass.baseClasses.length > 0) {
      const baseClass = currentClass.baseClasses[0];
      const siblings = this.findSiblingClasses(allClasses, currentClass);

      if (siblings.length > 0) {
        evidence.push(
          this.createStructuralEvidence(
            `Shares interface with: ${siblings.slice(0, 2).map((s) => s.name).join(', ')}`,
            0.3
          )
        );
        confidence += 0.3;
      }

      evidence.push(
        this.createStructuralEvidence(
          `Implements interface: ${baseClass}`,
          0.15
        )
      );
      confidence += 0.15;
    }

    // Check constructor for wrapped object parameter
    const constructor = this.getConstructor(currentClass);
    if (constructor) {
      const params = constructor.parameters.filter(
        (p) => p.name !== 'self' && p.name !== 'this'
      );

      // Check if any parameter name suggests wrapped object
      const wrappedParam = params.find((p) =>
        WRAPPED_PARAM_NAMES.some((name) =>
          p.name.toLowerCase().includes(name.toLowerCase())
        )
      );

      if (wrappedParam) {
        evidence.push(
          this.createStructuralEvidence(
            `Takes wrapped object in constructor: ${wrappedParam.name}`,
            0.4
          )
        );
        confidence += 0.4;
      } else if (params.length === 1) {
        // Single parameter in constructor might be the wrapped object
        const param = params[0];

        // Check if parameter type matches a sibling class or base interface
        if (param && param.typeHint) {
          const typeHint = param.typeHint;
          const matchesSibling = this.findSiblingClasses(allClasses, currentClass).some(
            (s) => typeHint.includes(s.name)
          );

          if (matchesSibling || currentClass.baseClasses.some((b) => typeHint.includes(b))) {
            evidence.push(
              this.createStructuralEvidence(
                `Constructor takes interface type: ${typeHint}`,
                0.35
              )
            );
            confidence += 0.35;
          }
        }
      }
    }

    // Check if methods match base class/interface methods (delegation signature)
    if (currentClass.baseClasses.length > 0) {
      const baseClassName = currentClass.baseClasses[0];
      const baseClass = allClasses.find((c) => c.name === baseClassName);

      if (baseClass) {
        const overriddenMethods = currentClass.methods.filter((m) =>
          baseClass.methods.some((bm) => bm.name === m.name)
        );

        if (overriddenMethods.length >= 2) {
          evidence.push(
            this.createStructuralEvidence(
              `Overrides ${overriddenMethods.length} interface methods`,
              0.2
            )
          );
          confidence += 0.2;
        }
      }
    }

    // Check for multiple interface methods (suggests decoration of behavior)
    const nonConstructorMethods = currentClass.methods.filter(
      (m) => !['__init__', 'constructor', '__new__'].includes(m.name)
    );

    if (nonConstructorMethods.length >= 3) {
      evidence.push(
        this.createStructuralEvidence(
          `Has ${nonConstructorMethods.length} interface methods`,
          0.1
        )
      );
      confidence += 0.1;
    }

    if (confidence >= 0.5) {
      return this.createPatternInstance(
        context,
        Math.min(confidence, 0.85),
        evidence,
        DetectionDepth.Deep,
        { relatedClasses: currentClass.baseClasses }
      );
    }

    return null;
  }

  /**
   * Full detection: Behavioral analysis for Decorator.
   */
  protected detectFull(context: DetectionContext): PatternInstance | null {
    if (!context.fileContent) return null;

    // Start with deep detection
    const deepResult = this.detectDeep(context);
    if (!deepResult) return null;

    const evidence = [...deepResult.evidence];
    let confidence = deepResult.confidence;

    // Look for delegation patterns in code
    const delegationFound = this.contentContains(context.fileContent, DELEGATION_PATTERNS);

    if (delegationFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(
          `Delegates to wrapped object: ${delegationFound.slice(0, 2).join(', ')}`,
          0.15
        )
      );
      confidence += 0.15;
    }

    // Check for method forwarding pattern
    const forwardingPatterns = [
      'return self._',
      'return this._',
      'return self.wrapped',
      'return this.wrapped',
      'self.component.',
      'this.component.',
    ];

    const forwardingFound = this.contentContains(context.fileContent, forwardingPatterns);
    if (forwardingFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(`Method forwarding detected`, 0.1)
      );
      confidence += 0.1;
    }

    // Check for before/after hooks pattern (common in decorators)
    const hookPatterns = [
      'before',
      'after',
      'pre_',
      'post_',
      '_before',
      '_after',
      'intercept',
    ];

    const hookFound = this.contentContains(context.fileContent, hookPatterns);
    if (hookFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(
          `Has lifecycle hooks: ${hookFound.slice(0, 2).join(', ')}`,
          0.05
        )
      );
      confidence += 0.05;
    }

    // Check for Python @functools.wraps or similar
    if (
      context.fileContent.includes('functools.wraps') ||
      context.fileContent.includes('@wraps')
    ) {
      evidence.push(
        this.createBehavioralEvidence(`Uses @wraps decorator (Python)`, 0.1)
      );
      confidence += 0.1;
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
 * Creates a new DecoratorDetector instance.
 */
export function createDecoratorDetector(): DecoratorDetector {
  return new DecoratorDetector();
}
