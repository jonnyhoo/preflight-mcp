/**
 * Builder Pattern Detector
 *
 * Detects the Builder design pattern which separates construction of a complex
 * object from its representation, allowing the same construction process to
 * create different representations.
 *
 * Detection Heuristics:
 * - Surface: Class name contains 'Builder'
 * - Deep: Fluent interface (methods return self), build()/create() terminal method
 * - Full: Multiple configuration methods + final build step
 *
 * Examples:
 * - QueryBuilder with where(), orderBy(), build()
 * - RequestBuilder with setHeader(), setBody(), execute()
 * - StringBuilder pattern
 *
 * @module bundle/analyzers/gof-patterns/detectors/builder
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

/** Keywords in class names suggesting builder pattern */
const BUILDER_CLASS_KEYWORDS = ['builder', 'assembler'];

/** Terminal method names that finalize the build */
const TERMINAL_METHOD_NAMES = [
  'build',
  'create',
  'execute',
  'construct',
  'make',
  'get',
  'getResult',
  'finish',
  'done',
  'toObject',
  'toEntity',
];

/** Prefixes for setter/configuration methods */
const SETTER_PREFIXES = ['with', 'set', 'add', 'configure', 'append', 'include'];

/** Fluent interface patterns to look for in code */
const FLUENT_PATTERNS = ['return self', 'return this', 'return *this'];

// ============================================================================
// Builder Detector
// ============================================================================

/**
 * Detector for the Builder pattern.
 *
 * Builder pattern is used to construct complex objects step by step.
 * It's especially useful when an object must be created with many
 * optional parameters or configurations.
 */
export class BuilderDetector extends BasePatternDetector {
  readonly patternType = 'Builder' as const;
  readonly category = PatternCategory.Creational;

  /**
   * Surface detection: Check naming conventions for Builder.
   */
  protected detectSurface(context: DetectionContext): PatternInstance | null {
    const { currentClass } = context;

    if (this.classNameContains(currentClass.name, BUILDER_CLASS_KEYWORDS)) {
      const evidence: PatternEvidence[] = [
        this.createNamingEvidence(
          `Class name contains "Builder": ${currentClass.name}`,
          0.7
        ),
      ];

      return this.createPatternInstance(context, 0.7, evidence, DetectionDepth.Surface);
    }

    return null;
  }

  /**
   * Deep detection: Structural analysis for Builder.
   *
   * Looks for:
   * - Multiple setter/configuration methods
   * - Terminal build()/create() method
   * - Fluent interface pattern
   */
  protected detectDeep(context: DetectionContext): PatternInstance | null {
    const { currentClass } = context;
    const evidence: PatternEvidence[] = [];
    let confidence = 0;

    // Check for terminal build/create method
    const terminalMethod = this.findTerminalMethod(currentClass.methods);
    if (terminalMethod) {
      evidence.push(
        this.createStructuralEvidence(
          `Has terminal build method: ${terminalMethod.name}()`,
          0.4
        )
      );
      confidence += 0.4;

      // Check if terminal method has a return type
      if (terminalMethod.returnType) {
        evidence.push(
          this.createStructuralEvidence(
            `Build method returns: ${terminalMethod.returnType}`,
            0.1
          )
        );
        confidence += 0.1;
      }
    }

    // Check for setter/configuration methods
    const setterMethods = this.findSetterMethods(currentClass.methods);
    const setterCount = setterMethods.length;

    if (setterCount >= 3) {
      const methodNames = setterMethods.slice(0, 4).map((m) => m.name);
      evidence.push(
        this.createStructuralEvidence(
          `Has ${setterCount} configuration methods: ${methodNames.join(', ')}`,
          0.4
        )
      );
      confidence += 0.4;
    } else if (setterCount >= 1) {
      evidence.push(
        this.createStructuralEvidence(
          `Has ${setterCount} configuration method(s)`,
          0.2
        )
      );
      confidence += 0.2;
    }

    // Check total method count (builders typically have many methods)
    const nonConstructorMethods = currentClass.methods.filter(
      (m) => !['__init__', 'constructor', '__new__'].includes(m.name)
    );

    if (nonConstructorMethods.length >= 5) {
      evidence.push(
        this.createStructuralEvidence(
          `Has ${nonConstructorMethods.length} methods (complex builder)`,
          0.1
        )
      );
      confidence += 0.1;
    }

    // Check for chaining signature (methods returning self type)
    const chainingMethods = this.findChainingMethods(currentClass);
    if (chainingMethods.length >= 2) {
      evidence.push(
        this.createStructuralEvidence(
          `Methods return self (fluent interface): ${chainingMethods.slice(0, 3).map((m) => m.name).join(', ')}`,
          0.15
        )
      );
      confidence += 0.15;
    }

    if (confidence >= 0.5) {
      return this.createPatternInstance(
        context,
        Math.min(confidence, 0.9),
        evidence,
        DetectionDepth.Deep,
        { methodName: terminalMethod?.name }
      );
    }

    return null;
  }

  /**
   * Full detection: Behavioral analysis for Builder.
   */
  protected detectFull(context: DetectionContext): PatternInstance | null {
    if (!context.fileContent) return null;

    // Start with deep detection
    const deepResult = this.detectDeep(context);
    if (!deepResult) return null;

    const evidence = [...deepResult.evidence];
    let confidence = deepResult.confidence;

    // Look for fluent interface pattern (return self/this)
    const fluentFound = this.contentContains(context.fileContent, FLUENT_PATTERNS);

    if (fluentFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(`Uses fluent interface (${fluentFound[0]})`, 0.1)
      );
      confidence += 0.1;
    }

    // Check for complex object construction (multiple fields)
    const selfReferences = (context.fileContent.match(/self\./g) || []).length;
    const thisReferences = (context.fileContent.match(/this\./g) || []).length;
    const fieldReferences = selfReferences + thisReferences;

    if (fieldReferences >= 5) {
      evidence.push(
        this.createBehavioralEvidence(
          `Builds complex object with ${fieldReferences}+ field assignments`,
          0.05
        )
      );
      confidence += 0.05;
    }

    // Check for validation in build method
    const validationPatterns = ['validate', 'check', 'assert', 'throw', 'raise', 'if not'];
    const validationFound = this.contentContains(context.fileContent, validationPatterns);

    if (validationFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(`Has validation logic before build`, 0.05)
      );
      confidence += 0.05;
    }

    // Check for director pattern (separate class orchestrating builder)
    const directorPatterns = ['director', 'construct', 'builder.'];
    const directorFound = this.contentContains(context.fileContent, directorPatterns);

    if (directorFound.length > 0 && !this.classNameContains(context.currentClass.name, ['director'])) {
      evidence.push(
        this.createBehavioralEvidence(`May be used with Director pattern`, 0.05)
      );
      confidence += 0.05;
    }

    return this.createPatternInstance(
      context,
      Math.min(confidence, 0.95),
      evidence,
      DetectionDepth.Full,
      { methodName: deepResult.methodName }
    );
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Finds the terminal build/create method.
   */
  private findTerminalMethod(methods: MethodSignature[]): MethodSignature | null {
    for (const method of methods) {
      const lowerName = method.name.toLowerCase();

      // Check for exact match first
      if (TERMINAL_METHOD_NAMES.some((name) => lowerName === name.toLowerCase())) {
        return method;
      }

      // Check for prefix match (e.g., buildUser, createOrder)
      if (
        lowerName.startsWith('build') ||
        lowerName.startsWith('create') ||
        lowerName.startsWith('construct')
      ) {
        return method;
      }
    }

    return null;
  }

  /**
   * Finds setter/configuration methods.
   */
  private findSetterMethods(methods: MethodSignature[]): MethodSignature[] {
    return methods.filter((method) => {
      const lowerName = method.name.toLowerCase();

      // Skip constructors and terminal methods
      if (
        ['__init__', 'constructor', '__new__'].includes(method.name) ||
        TERMINAL_METHOD_NAMES.some((name) => lowerName === name.toLowerCase())
      ) {
        return false;
      }

      // Check for setter prefixes
      return SETTER_PREFIXES.some((prefix) =>
        lowerName.startsWith(prefix.toLowerCase())
      );
    });
  }

  /**
   * Finds methods that likely return 'self' for chaining.
   */
  private findChainingMethods(classSig: ClassSignature): MethodSignature[] {
    return classSig.methods.filter((method) => {
      // Check if return type matches class name or is 'Self'/'this'
      if (method.returnType) {
        const returnLower = method.returnType.toLowerCase();
        return (
          returnLower === classSig.name.toLowerCase() ||
          returnLower === 'self' ||
          returnLower === 'this' ||
          returnLower.includes(classSig.name.toLowerCase())
        );
      }

      // Heuristic: setters without explicit return type might return self
      const lowerName = method.name.toLowerCase();
      return SETTER_PREFIXES.some((prefix) => lowerName.startsWith(prefix.toLowerCase()));
    });
  }
}

// ============================================================================
// Imports for ClassSignature type
// ============================================================================

import type { ClassSignature } from '../types.js';

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new BuilderDetector instance.
 */
export function createBuilderDetector(): BuilderDetector {
  return new BuilderDetector();
}
