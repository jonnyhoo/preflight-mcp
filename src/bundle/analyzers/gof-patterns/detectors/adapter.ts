/**
 * Adapter Pattern Detector
 *
 * Detects the Adapter design pattern which converts the interface of a class
 * into another interface clients expect. Adapter lets classes work together
 * that couldn't otherwise because of incompatible interfaces.
 *
 * Detection Heuristics:
 * - Surface: Class name contains 'Adapter', 'Wrapper', 'Bridge'
 * - Deep: Wraps external/incompatible class, translates method calls
 * - Full: Composition + delegation with interface translation
 *
 * Examples:
 * - DatabaseAdapter wraps external DB library
 * - ApiAdapter translates REST to internal interface
 * - FileSystemAdapter wraps OS file operations
 *
 * @module bundle/analyzers/gof-patterns/detectors/adapter
 */

import { BasePatternDetector } from '../base-detector.js';
import {
  type PatternInstance,
  type PatternEvidence,
  type DetectionContext,
  PatternCategory,
  DetectionDepth,
} from '../types.js';

// ============================================================================
// Constants
// ============================================================================

/** Keywords in class names suggesting adapter pattern */
const ADAPTER_CLASS_KEYWORDS = ['adapter', 'wrapper', 'bridge', 'translator', 'converter'];

/** Parameter names suggesting adaptee object */
const ADAPTEE_PARAM_NAMES = [
  'adaptee',
  'wrapped',
  'client',
  'service',
  'api',
  'source',
  'target',
  'impl',
  'delegate',
  'inner',
];

/** Patterns indicating delegation to adaptee */
const DELEGATION_PATTERNS = [
  'self.adaptee',
  'self.wrapped',
  'self.client',
  'self._',
  'this.adaptee',
  'this.wrapped',
  'this.client',
  'this._',
];

// ============================================================================
// Adapter Detector
// ============================================================================

/**
 * Detector for the Adapter pattern.
 *
 * Adapter pattern is used to make incompatible interfaces work together.
 * It acts as a bridge between two incompatible interfaces by wrapping
 * an existing class with a new interface.
 */
export class AdapterDetector extends BasePatternDetector {
  readonly patternType = 'Adapter' as const;
  readonly category = PatternCategory.Structural;

  /**
   * Surface detection: Check naming conventions for Adapter.
   */
  protected detectSurface(context: DetectionContext): PatternInstance | null {
    const { currentClass } = context;

    if (this.classNameContains(currentClass.name, ADAPTER_CLASS_KEYWORDS)) {
      const evidence: PatternEvidence[] = [
        this.createNamingEvidence(
          `Class name suggests Adapter: ${currentClass.name}`,
          0.7
        ),
      ];

      return this.createPatternInstance(context, 0.7, evidence, DetectionDepth.Surface);
    }

    return null;
  }

  /**
   * Deep detection: Structural analysis for Adapter.
   *
   * Looks for:
   * - Takes adaptee in constructor
   * - Implements target interface (has base class)
   * - Delegates calls to adaptee
   */
  protected detectDeep(context: DetectionContext): PatternInstance | null {
    const { currentClass, allClasses } = context;
    const evidence: PatternEvidence[] = [];
    let confidence = 0;

    // Check constructor for adaptee parameter
    const constructor = this.getConstructor(currentClass);
    if (constructor) {
      const params = constructor.parameters.filter(
        (p) => p.name !== 'self' && p.name !== 'this'
      );

      // Check if any parameter name suggests adaptee object
      const adapteeParam = params.find((p) =>
        ADAPTEE_PARAM_NAMES.some((name) =>
          p.name.toLowerCase().includes(name.toLowerCase())
        )
      );

      if (adapteeParam) {
        evidence.push(
          this.createStructuralEvidence(
            `Takes adaptee in constructor: ${adapteeParam.name}`,
            0.4
          )
        );
        confidence += 0.4;
      } else if (params.length >= 1) {
        // Has parameters - might be adaptee
        evidence.push(
          this.createStructuralEvidence(
            `Constructor takes ${params.length} parameter(s) - potential adaptee`,
            0.15
          )
        );
        confidence += 0.15;
      }
    }

    // Check if implements interface (has base class)
    if (currentClass.baseClasses.length > 0) {
      const baseClass = currentClass.baseClasses[0];
      evidence.push(
        this.createStructuralEvidence(
          `Implements target interface: ${baseClass}`,
          0.3
        )
      );
      confidence += 0.3;

      // Check if base class has other implementations (siblings)
      const siblings = this.findSiblingClasses(allClasses, currentClass);
      if (siblings.length > 0) {
        evidence.push(
          this.createStructuralEvidence(
            `Other implementations exist: ${siblings.slice(0, 2).map((s) => s.name).join(', ')}`,
            0.1
          )
        );
        confidence += 0.1;
      }
    }

    // Check for delegation methods
    const nonConstructorMethods = currentClass.methods.filter(
      (m) => !['__init__', 'constructor', '__new__'].includes(m.name)
    );

    if (nonConstructorMethods.length >= 3) {
      evidence.push(
        this.createStructuralEvidence(
          `Has ${nonConstructorMethods.length} interface methods for delegation`,
          0.2
        )
      );
      confidence += 0.2;
    }

    // Check for interfaces (TypeScript/Java style)
    if (currentClass.interfaces.length > 0) {
      evidence.push(
        this.createStructuralEvidence(
          `Implements interfaces: ${currentClass.interfaces.join(', ')}`,
          0.2
        )
      );
      confidence += 0.2;
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
   * Full detection: Behavioral analysis for Adapter.
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
          `Delegates to adaptee: ${delegationFound.slice(0, 2).join(', ')}`,
          0.15
        )
      );
      confidence += 0.15;
    }

    // Check for method translation patterns
    const translationPatterns = [
      'return self.',
      'return this.',
      '.convert(',
      '.translate(',
      '.transform(',
      '.map(',
    ];

    const translationFound = this.contentContains(context.fileContent, translationPatterns);
    if (translationFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(
          `Interface translation detected`,
          0.1
        )
      );
      confidence += 0.1;
    }

    // Check for wrapping external libraries
    const externalPatterns = ['import', 'require', 'from', 'external', 'third_party', 'vendor'];
    const externalFound = this.contentContains(context.fileContent, externalPatterns);

    if (externalFound.length > 0 && delegationFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(
          `Wraps external dependency`,
          0.05
        )
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
 * Creates a new AdapterDetector instance.
 */
export function createAdapterDetector(): AdapterDetector {
  return new AdapterDetector();
}
