/**
 * Factory Pattern Detector
 *
 * Detects Factory Method and Abstract Factory design patterns.
 *
 * Factory Method defines an interface for creating objects, letting subclasses
 * decide which class to instantiate.
 *
 * Abstract Factory provides an interface for creating families of related
 * objects without specifying their concrete classes.
 *
 * Detection Heuristics:
 * - Surface: Class/method name contains 'Factory', 'create', 'make'
 * - Deep: Method returns object types, parameterized creation
 * - Full: Polymorphic object creation with inheritance hierarchy
 *
 * @module bundle/analyzers/gof-patterns/detectors/factory
 */

import { BasePatternDetector } from '../base-detector.js';
import {
  type PatternInstance,
  type PatternEvidence,
  type DetectionContext,
  type MethodSignature,
  PatternCategory,
  DetectionDepth,
} from '../types.js';

// ============================================================================
// Constants
// ============================================================================

/** Keywords in class names suggesting factory pattern */
const FACTORY_CLASS_KEYWORDS = ['factory', 'creator', 'builder', 'producer'];

/** Keywords in method names suggesting factory methods */
const FACTORY_METHOD_KEYWORDS = ['create', 'make', 'build', 'new', 'get', 'construct', 'produce'];

/** Prefixes for factory methods */
const FACTORY_METHOD_PREFIXES = ['create', 'make', 'build', 'new', 'get', 'construct'];

// ============================================================================
// Factory Detector
// ============================================================================

/**
 * Detector for the Factory pattern (Factory Method and Abstract Factory).
 *
 * Factory patterns encapsulate object creation, promoting loose coupling
 * and making the system more flexible and extensible.
 */
export class FactoryDetector extends BasePatternDetector {
  readonly patternType = 'Factory' as const;
  readonly category = PatternCategory.Creational;

  /**
   * Surface detection: Check naming conventions for Factory.
   */
  protected detectSurface(context: DetectionContext): PatternInstance | null {
    const { currentClass } = context;

    // Check class name
    if (this.classNameContains(currentClass.name, FACTORY_CLASS_KEYWORDS)) {
      const evidence: PatternEvidence[] = [
        this.createNamingEvidence(
          `Class name contains factory keyword: ${currentClass.name}`,
          0.7
        ),
      ];

      return this.createPatternInstance(context, 0.7, evidence, DetectionDepth.Surface);
    }

    // Check for factory methods
    const factoryMethods = this.findFactoryMethods(currentClass.methods);

    if (factoryMethods.length > 0) {
      const methodNames = factoryMethods.map((m) => m.name);
      const evidence: PatternEvidence[] = [
        this.createNamingEvidence(
          `Factory method detected: ${methodNames[0]}()`,
          0.6
        ),
      ];

      // Check if method has return type (suggests it creates something)
      const methodWithReturn = factoryMethods.find((m) => m.returnType);
      if (methodWithReturn) {
        evidence.push(
          this.createStructuralEvidence(
            `Method returns: ${methodWithReturn.returnType}`,
            0.1
          )
        );
      }

      return this.createPatternInstance(
        context,
        this.sumConfidence(evidence),
        evidence,
        DetectionDepth.Surface,
        { methodName: factoryMethods[0]?.name }
      );
    }

    return null;
  }

  /**
   * Deep detection: Structural analysis for Factory.
   */
  protected detectDeep(context: DetectionContext): PatternInstance | null {
    const { currentClass, allClasses } = context;
    const evidence: PatternEvidence[] = [];
    let confidence = 0;

    // Find factory methods
    const factoryMethods = this.findFactoryMethods(currentClass.methods);
    const factoryMethodNames: string[] = [];

    for (const method of factoryMethods) {
      factoryMethodNames.push(method.name);

      // Check if method takes parameters (suggests different object types)
      const nonSelfParams = method.parameters.filter(
        (p) => p.name !== 'self' && p.name !== 'this'
      );

      if (nonSelfParams.length > 0) {
        evidence.push(
          this.createStructuralEvidence(
            `Parameterized factory method: ${method.name}(${nonSelfParams.map((p) => p.name).join(', ')})`,
            0.3
          )
        );
        confidence += 0.3;
      } else {
        evidence.push(
          this.createStructuralEvidence(`Factory method: ${method.name}()`, 0.2)
        );
        confidence += 0.2;
      }

      // Check return type
      if (method.returnType) {
        evidence.push(
          this.createStructuralEvidence(
            `Returns type: ${method.returnType}`,
            0.1
          )
        );
        confidence += 0.1;
      }
    }

    // Multiple factory methods suggest Abstract Factory pattern
    if (factoryMethodNames.length >= 2) {
      evidence.push(
        this.createStructuralEvidence(
          `Multiple factory methods: ${factoryMethodNames.slice(0, 3).join(', ')}`,
          0.2
        )
      );
      confidence += 0.2;
    }

    // Check for inheritance (factory hierarchy)
    if (currentClass.baseClasses.length > 0) {
      evidence.push(
        this.createStructuralEvidence(
          `Inherits from: ${currentClass.baseClasses.join(', ')}`,
          0.1
        )
      );
      confidence += 0.1;

      // Check if base class also contains factory keywords
      const factoryBase = currentClass.baseClasses.some((base) =>
        FACTORY_CLASS_KEYWORDS.some((kw) => base.toLowerCase().includes(kw))
      );

      if (factoryBase) {
        evidence.push(
          this.createStructuralEvidence(`Extends factory base class`, 0.15)
        );
        confidence += 0.15;
      }
    }

    // Check for concrete factory implementations (subclasses)
    const subclasses = this.findSubclasses(allClasses, currentClass.name);
    if (subclasses.length >= 2) {
      evidence.push(
        this.createStructuralEvidence(
          `Has ${subclasses.length} concrete factory implementations`,
          0.2
        )
      );
      confidence += 0.2;
    }

    // Check if this is an abstract factory (has abstract methods)
    if (currentClass.isAbstract) {
      evidence.push(
        this.createStructuralEvidence(`Abstract factory base class`, 0.15)
      );
      confidence += 0.15;
    }

    if (confidence >= 0.5) {
      return this.createPatternInstance(
        context,
        Math.min(confidence, 0.9),
        evidence,
        DetectionDepth.Deep,
        {
          methodName: factoryMethodNames[0],
          relatedClasses: currentClass.baseClasses,
        }
      );
    }

    return null;
  }

  /**
   * Full detection: Behavioral analysis for Factory.
   */
  protected detectFull(context: DetectionContext): PatternInstance | null {
    if (!context.fileContent) return null;

    // Start with deep detection
    const deepResult = this.detectDeep(context);
    if (!deepResult) return null;

    const evidence = [...deepResult.evidence];
    let confidence = deepResult.confidence;

    // Check for object instantiation patterns in code
    const instantiationPatterns = [
      'new ',
      'return new',
      'return cls(',
      'return self.__class__(',
      '= new',
      'Object.create',
    ];

    const foundPatterns = this.contentContains(context.fileContent, instantiationPatterns);
    if (foundPatterns.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(
          `Object instantiation patterns: ${foundPatterns.join(', ')}`,
          0.1
        )
      );
      confidence += 0.1;
    }

    // Check for conditional object creation (type-based factory)
    const conditionalPatterns = [
      'if.*type',
      'switch.*type',
      'match.*type',
      'case.*:.*new',
      'elif.*:.*return',
    ];

    const conditionalFound = conditionalPatterns.some((pattern) => {
      try {
        return new RegExp(pattern, 'i').test(context.fileContent!);
      } catch {
        return false;
      }
    });

    if (conditionalFound) {
      evidence.push(
        this.createBehavioralEvidence(`Conditional object creation detected`, 0.1)
      );
      confidence += 0.1;
    }

    // Check for registration/mapping patterns (plugin-style factory)
    const registryPatterns = ['registry', 'register', 'mapping', 'types[', '_creators'];
    const registryFound = this.contentContains(context.fileContent, registryPatterns);

    if (registryFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(
          `Factory registry pattern: ${registryFound.join(', ')}`,
          0.1
        )
      );
      confidence += 0.1;
    }

    return this.createPatternInstance(
      context,
      Math.min(confidence, 0.95),
      evidence,
      DetectionDepth.Full,
      {
        methodName: deepResult.methodName,
        relatedClasses: deepResult.relatedClasses,
      }
    );
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Finds methods that look like factory methods.
   */
  private findFactoryMethods(methods: MethodSignature[]): MethodSignature[] {
    return methods.filter((method) => {
      const lowerName = method.name.toLowerCase();

      // Skip constructors
      if (['__init__', 'constructor', '__new__'].includes(method.name)) {
        return false;
      }

      // Check for factory method keywords
      return FACTORY_METHOD_PREFIXES.some((prefix) =>
        lowerName.startsWith(prefix.toLowerCase())
      );
    });
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new FactoryDetector instance.
 */
export function createFactoryDetector(): FactoryDetector {
  return new FactoryDetector();
}
