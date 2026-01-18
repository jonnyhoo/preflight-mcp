/**
 * Singleton Pattern Detector
 *
 * Detects the Singleton design pattern which ensures a class has only one
 * instance and provides a global point of access to it.
 *
 * Detection Heuristics:
 * - Surface: Class name contains 'Singleton'
 * - Deep: Private/controlled constructor + static getInstance() method
 * - Full: Instance caching + thread safety checks
 *
 * Language-specific patterns:
 * - Python: __new__ override with instance caching
 * - JavaScript: Module pattern or class with getInstance()
 * - Java: Private constructor + synchronized getInstance()
 * - Go: sync.Once pattern
 * - Rust: lazy_static / OnceCell
 *
 * @module bundle/analyzers/gof-patterns/detectors/singleton
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

/** Method names indicating getInstance pattern */
const INSTANCE_METHOD_NAMES = [
  'getInstance',
  'instance',
  'get_instance',
  'getinstance',
  'Instance',
  'GetInstance',
  'INSTANCE',
  'shared',
  'sharedInstance',
  'default',
];

/** Constructor/initializer names */
const CONSTRUCTOR_NAMES = ['__init__', '__new__', 'constructor'];

/** Caching patterns to look for in code */
const CACHING_PATTERNS = [
  '_instance',
  '__instance',
  'instance',
  'if not',
  'if self._instance is None',
  'synchronized',
  'Lock(',
  'threading',
  'sync.Once',
  'lazy_static',
  'OnceCell',
  'OnceLock',
];

// ============================================================================
// Singleton Detector
// ============================================================================

/**
 * Detector for the Singleton pattern.
 *
 * Singleton ensures a class has only one instance and provides global access.
 * Common in configuration managers, logging services, and resource pools.
 */
export class SingletonDetector extends BasePatternDetector {
  readonly patternType = 'Singleton' as const;
  readonly category = PatternCategory.Creational;

  /**
   * Surface detection: Check if class name suggests Singleton.
   */
  protected detectSurface(context: DetectionContext): PatternInstance | null {
    const { currentClass } = context;

    if (this.classNameContains(currentClass.name, ['singleton'])) {
      const evidence: PatternEvidence[] = [
        this.createNamingEvidence(`Class name contains "Singleton": ${currentClass.name}`, 0.6),
      ];

      return this.createPatternInstance(context, 0.6, evidence, DetectionDepth.Surface);
    }

    return null;
  }

  /**
   * Deep detection: Check structural characteristics of Singleton.
   *
   * Looks for:
   * - getInstance() or similar static accessor method
   * - Controlled initialization (__new__, __init__, constructor)
   */
  protected detectDeep(context: DetectionContext): PatternInstance | null {
    const { currentClass } = context;
    const evidence: PatternEvidence[] = [];
    let confidence = 0;

    // Check for getInstance method
    const instanceMethod = this.hasMethodNamed(currentClass, INSTANCE_METHOD_NAMES);
    if (instanceMethod) {
      evidence.push(
        this.createStructuralEvidence(`Has instance accessor method: ${instanceMethod.name}()`, 0.4)
      );
      confidence += 0.4;

      // Bonus if method is static
      if (instanceMethod.isStatic) {
        evidence.push(
          this.createStructuralEvidence(`Instance method is static`, 0.1)
        );
        confidence += 0.1;
      }
    }

    // Check for controlled constructor
    const constructor = this.hasMethodNamed(currentClass, CONSTRUCTOR_NAMES);
    if (constructor) {
      // Check if it has parameters (suggests it does something)
      const nonSelfParams = constructor.parameters.filter(
        (p) => p.name !== 'self' && p.name !== 'this'
      );

      if (nonSelfParams.length > 0 || constructor.docstring) {
        evidence.push(
          this.createStructuralEvidence(
            `Controlled initialization: ${constructor.name}`,
            0.3
          )
        );
        confidence += 0.3;
      }

      // Check for private/protected constructor (visibility check)
      if (constructor.visibility === 'private' || constructor.visibility === 'protected') {
        evidence.push(
          this.createStructuralEvidence(
            `Private constructor prevents direct instantiation`,
            0.2
          )
        );
        confidence += 0.2;
      }
    }

    // Check for __new__ in Python (strong singleton indicator)
    const newMethod = currentClass.methods.find((m) => m.name === '__new__');
    if (newMethod) {
      evidence.push(
        this.createStructuralEvidence(`Has __new__ method for instance control`, 0.3)
      );
      confidence += 0.3;
    }

    // If we found sufficient evidence, return pattern
    if (confidence >= 0.5) {
      return this.createPatternInstance(
        context,
        Math.min(confidence, 0.9), // Cap at 0.9 for deep detection
        evidence,
        DetectionDepth.Deep,
        { methodName: instanceMethod?.name }
      );
    }

    return null;
  }

  /**
   * Full detection: Behavioral analysis for Singleton.
   *
   * Looks for:
   * - Instance caching in method body
   * - Thread safety (locks, synchronized)
   * - Lazy vs eager initialization
   */
  protected detectFull(context: DetectionContext): PatternInstance | null {
    if (!context.fileContent) return null;

    // Start with deep detection
    const deepResult = this.detectDeep(context);
    if (!deepResult) return null;

    // Copy evidence and continue analysis
    const evidence = [...deepResult.evidence];
    let confidence = deepResult.confidence;

    // Look for caching patterns in code
    const foundPatterns = this.contentContains(context.fileContent, CACHING_PATTERNS);

    for (const pattern of foundPatterns) {
      // Avoid duplicate evidence
      const alreadyFound = evidence.some((e) =>
        e.description.toLowerCase().includes(pattern.toLowerCase())
      );

      if (!alreadyFound) {
        evidence.push(
          this.createBehavioralEvidence(`Instance caching detected: ${pattern}`, 0.1)
        );
        confidence += 0.1;
      }
    }

    // Check for thread safety patterns
    const threadSafePatterns = ['synchronized', 'Lock(', 'threading', 'sync.Once', 'Mutex'];
    const threadSafeFound = this.contentContains(context.fileContent, threadSafePatterns);

    if (threadSafeFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(
          `Thread-safe singleton implementation: ${threadSafeFound.join(', ')}`,
          0.1
        )
      );
      confidence += 0.1;
    }

    // Check for lazy initialization pattern
    const lazyPatterns = ['if.*is None', 'if.*== null', 'if.*=== null', 'if.*undefined'];
    const lazyFound = lazyPatterns.some((pattern) => {
      try {
        return new RegExp(pattern, 'i').test(context.fileContent!);
      } catch {
        return false;
      }
    });

    if (lazyFound) {
      evidence.push(
        this.createBehavioralEvidence(`Lazy initialization pattern detected`, 0.05)
      );
      confidence += 0.05;
    }

    // Cap confidence at 0.95 (never 100% certain without runtime analysis)
    return this.createPatternInstance(
      context,
      Math.min(confidence, 0.95),
      evidence,
      DetectionDepth.Full,
      { methodName: deepResult.methodName }
    );
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new SingletonDetector instance.
 */
export function createSingletonDetector(): SingletonDetector {
  return new SingletonDetector();
}
