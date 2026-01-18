/**
 * Chain of Responsibility Pattern Detector
 *
 * Detects the Chain of Responsibility design pattern which passes a request
 * along a chain of handlers. Upon receiving a request, each handler decides
 * either to process the request or to pass it to the next handler in the chain.
 *
 * Detection Heuristics:
 * - Surface: Class name contains 'Handler', 'Chain', 'Middleware'
 * - Deep: Has next/successor reference, handle() method
 * - Full: Chain traversal logic, request passing
 *
 * Examples:
 * - LogHandler with next handler
 * - AuthMiddleware chain
 * - EventHandler chain
 *
 * @module bundle/analyzers/gof-patterns/detectors/chain-of-responsibility
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

/** Keywords in class names suggesting chain of responsibility pattern */
const CHAIN_CLASS_KEYWORDS = [
  'handler',
  'chain',
  'middleware',
  'filter',
  'processor',
  'interceptor',
  'pipeline',
];

/** Handle/process method names */
const HANDLE_METHOD_NAMES = [
  'handle',
  'process',
  'execute',
  'filter',
  'intercept',
  'invoke',
  'dispatch',
  'call',
  'next',
];

/** Next handler parameter/field names */
const NEXT_HANDLER_NAMES = [
  'next',
  'successor',
  'next_handler',
  'nextHandler',
  'next_middleware',
  'nextMiddleware',
  'chain',
  'parent',
];

/** Chain patterns to look for in code */
const CHAIN_PATTERNS = [
  'self.next',
  'this.next',
  'self._next',
  'this._next',
  'self.successor',
  'this.successor',
  'next.handle',
  'next.process',
  'nextHandler',
  'next_handler',
];

// ============================================================================
// Chain of Responsibility Detector
// ============================================================================

/**
 * Detector for the Chain of Responsibility pattern.
 *
 * Chain of Responsibility lets you pass requests along a chain of handlers.
 * Each handler can either process the request or pass it to the next handler.
 * Common in middleware systems and event processing.
 */
export class ChainOfResponsibilityDetector extends BasePatternDetector {
  readonly patternType = 'ChainOfResponsibility' as const;
  readonly category = PatternCategory.Behavioral;

  /**
   * Surface detection: Check naming conventions for Chain of Responsibility.
   */
  protected detectSurface(context: DetectionContext): PatternInstance | null {
    const { currentClass } = context;

    if (this.classNameContains(currentClass.name, CHAIN_CLASS_KEYWORDS)) {
      const evidence: PatternEvidence[] = [
        this.createNamingEvidence(
          `Class name suggests handler chain: ${currentClass.name}`,
          0.6
        ),
      ];

      return this.createPatternInstance(context, 0.6, evidence, DetectionDepth.Surface);
    }

    return null;
  }

  /**
   * Deep detection: Structural analysis for Chain of Responsibility.
   *
   * Looks for:
   * - handle()/process() method
   * - next/successor reference
   * - set_next() method
   */
  protected detectDeep(context: DetectionContext): PatternInstance | null {
    const { currentClass, allClasses } = context;
    const evidence: PatternEvidence[] = [];
    let confidence = 0;
    let handleMethodName = '';
    let hasNextRef = false;

    // Check for handle/process method
    const handleMethod = this.hasMethodNamed(currentClass, HANDLE_METHOD_NAMES);
    if (handleMethod) {
      handleMethodName = handleMethod.name;
      evidence.push(
        this.createStructuralEvidence(
          `Has handle/process method: ${handleMethod.name}()`,
          0.4
        )
      );
      confidence += 0.4;
    }

    // Check for next handler in constructor
    const constructor = this.getConstructor(currentClass);
    if (constructor) {
      const params = constructor.parameters.filter(
        (p) => p.name !== 'self' && p.name !== 'this'
      );

      const nextParam = params.find((p) =>
        NEXT_HANDLER_NAMES.some((name) =>
          p.name.toLowerCase().includes(name.toLowerCase())
        )
      );

      if (nextParam) {
        evidence.push(
          this.createStructuralEvidence(
            `Takes next handler in chain: ${nextParam.name}`,
            0.3
          )
        );
        confidence += 0.3;
        hasNextRef = true;
      }
    }

    // Check for set_next() method
    const setNextMethod = currentClass.methods.find((m) => {
      const lowerName = m.name.toLowerCase();
      return (
        (lowerName.includes('next') || lowerName.includes('successor')) &&
        (lowerName.includes('set') || lowerName.includes('add'))
      );
    });

    if (setNextMethod) {
      evidence.push(
        this.createStructuralEvidence(
          `Has set_next() method: ${setNextMethod.name}()`,
          0.3
        )
      );
      confidence += 0.3;
      hasNextRef = true;
    }

    // Check if part of handler family (shares base class with other handlers)
    if (currentClass.baseClasses.length > 0) {
      const baseClass = currentClass.baseClasses[0];
      const siblings = this.findSiblingClasses(allClasses, currentClass);

      if (siblings.length > 0 && hasNextRef) {
        const siblingNames = siblings.slice(0, 2).map((s) => s.name).join(', ');
        evidence.push(
          this.createStructuralEvidence(
            `Part of handler chain with: ${siblingNames}`,
            0.2
          )
        );
        confidence += 0.2;
      }

      // Check if base class suggests handler
      if (baseClass && CHAIN_CLASS_KEYWORDS.some(
        (kw) => baseClass.toLowerCase().includes(kw)
      )) {
        evidence.push(
          this.createStructuralEvidence(
            `Inherits from handler base: ${baseClass}`,
            0.15
          )
        );
        confidence += 0.15;
      }
    }

    // Check for abstract handler (base of chain)
    const subclasses = this.findSubclasses(allClasses, currentClass.name);
    if (subclasses.length >= 2) {
      evidence.push(
        this.createStructuralEvidence(
          `Handler base with ${subclasses.length} concrete handlers`,
          0.2
        )
      );
      confidence += 0.2;
    }

    if (confidence >= 0.5) {
      return this.createPatternInstance(
        context,
        Math.min(confidence, 0.9),
        evidence,
        DetectionDepth.Deep,
        { methodName: handleMethodName }
      );
    }

    return null;
  }

  /**
   * Full detection: Behavioral analysis for Chain of Responsibility.
   */
  protected detectFull(context: DetectionContext): PatternInstance | null {
    if (!context.fileContent) return null;

    // Start with deep detection
    const deepResult = this.detectDeep(context);
    if (!deepResult) return null;

    const evidence = [...deepResult.evidence];
    let confidence = deepResult.confidence;

    // Look for chain traversal patterns
    const chainFound = this.contentContains(context.fileContent, CHAIN_PATTERNS);

    if (chainFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(
          `Chain traversal: ${chainFound.slice(0, 2).join(', ')}`,
          0.15
        )
      );
      confidence += 0.15;
    }

    // Check for conditional handling (can handle check)
    const conditionalPatterns = [
      'can_handle',
      'canHandle',
      'shouldHandle',
      'should_handle',
      'accepts',
      'matches',
    ];

    const conditionalFound = this.contentContains(context.fileContent, conditionalPatterns);
    if (conditionalFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(
          `Conditional handling: ${conditionalFound[0]}`,
          0.1
        )
      );
      confidence += 0.1;
    }

    // Check for request passing pattern
    const passingPatterns = [
      'return self.next',
      'return this.next',
      'self.next.handle',
      'this.next.handle',
      'return next(',
      'next(request',
      'next(req',
    ];

    const passingFound = this.contentContains(context.fileContent, passingPatterns);
    if (passingFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(`Request passing to next handler`, 0.1)
      );
      confidence += 0.1;
    }

    // Check for early termination pattern
    const terminationPatterns = [
      'return None',
      'return null',
      'return;',
      'handled = True',
      'handled = true',
    ];

    const terminationFound = this.contentContains(context.fileContent, terminationPatterns);
    if (terminationFound.length > 0 && chainFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(`Can terminate chain processing`, 0.05)
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
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new ChainOfResponsibilityDetector instance.
 */
export function createChainOfResponsibilityDetector(): ChainOfResponsibilityDetector {
  return new ChainOfResponsibilityDetector();
}
