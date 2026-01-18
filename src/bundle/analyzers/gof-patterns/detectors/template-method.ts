/**
 * Template Method Pattern Detector
 *
 * Detects the Template Method design pattern which defines the skeleton of an
 * algorithm in the base class but lets subclasses override specific steps of
 * the algorithm without changing its structure.
 *
 * Detection Heuristics:
 * - Surface: Abstract/Base class with template-like names
 * - Deep: Abstract base with hook methods, concrete subclasses override
 * - Full: Template method calls abstract/hook methods
 *
 * Examples:
 * - AbstractProcessor with process() calling abstract steps
 * - BaseParser with parse() template method
 * - Framework base classes with lifecycle hooks
 *
 * @module bundle/analyzers/gof-patterns/detectors/template-method
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

/** Keywords in class names suggesting template method pattern */
const TEMPLATE_CLASS_KEYWORDS = [
  'abstract',
  'base',
  'template',
  'skeleton',
  'framework',
];

/** Hook method name keywords */
const HOOK_METHOD_KEYWORDS = [
  'prepare',
  'initialize',
  'init',
  'validate',
  'process',
  'finalize',
  'cleanup',
  'setup',
  'teardown',
  'before',
  'after',
  'pre',
  'post',
  'hook',
  'step',
  'do',
  'on',
];

/** Template method name keywords */
const TEMPLATE_METHOD_KEYWORDS = [
  'execute',
  'run',
  'process',
  'handle',
  'perform',
  'main',
  'algorithm',
  'workflow',
];

// ============================================================================
// Template Method Detector
// ============================================================================

/**
 * Detector for the Template Method pattern.
 *
 * Template Method pattern defines the skeleton of an algorithm in the
 * superclass but lets subclasses override specific steps without changing
 * the algorithm's structure. Common in frameworks and libraries.
 */
export class TemplateMethodDetector extends BasePatternDetector {
  readonly patternType = 'TemplateMethod' as const;
  readonly category = PatternCategory.Behavioral;

  /**
   * Surface detection: Check naming conventions for Template Method.
   */
  protected detectSurface(context: DetectionContext): PatternInstance | null {
    const { currentClass, allClasses } = context;

    if (this.classNameContains(currentClass.name, TEMPLATE_CLASS_KEYWORDS)) {
      // Check if has subclasses
      const subclasses = this.findSubclasses(allClasses, currentClass.name);

      if (subclasses.length > 0) {
        const subclassNames = subclasses.slice(0, 2).map((s) => s.name).join(', ');
        const evidence: PatternEvidence[] = [
          this.createNamingEvidence(
            `Abstract base with subclasses: ${subclassNames}`,
            0.6
          ),
        ];

        return this.createPatternInstance(
          context,
          0.6,
          evidence,
          DetectionDepth.Surface,
          { relatedClasses: subclasses.map((s) => s.name) }
        );
      }
    }

    return null;
  }

  /**
   * Deep detection: Structural analysis for Template Method.
   *
   * Looks for:
   * - Has subclasses (is base class)
   * - Has methods that look like hooks
   * - Has template method that orchestrates
   */
  protected detectDeep(context: DetectionContext): PatternInstance | null {
    const { currentClass, allClasses } = context;
    const evidence: PatternEvidence[] = [];
    let confidence = 0;

    // Check for subclasses (this is a base class)
    const subclasses = this.findSubclasses(allClasses, currentClass.name);
    if (subclasses.length >= 1) {
      evidence.push(
        this.createStructuralEvidence(
          `Base class with ${subclasses.length} implementation(s)`,
          0.4
        )
      );
      confidence += 0.4;
    }

    // Check for hook-like method names
    const hookMethods = currentClass.methods.filter((m) => {
      const lowerName = m.name.toLowerCase();
      return HOOK_METHOD_KEYWORDS.some((kw) => lowerName.includes(kw));
    });

    if (hookMethods.length >= 2) {
      const hookNames = hookMethods.slice(0, 3).map((m) => m.name).join(', ');
      evidence.push(
        this.createStructuralEvidence(`Has hook methods: ${hookNames}`, 0.3)
      );
      confidence += 0.3;
    }

    // Check for template method (orchestrates the algorithm)
    const templateMethod = currentClass.methods.find((m) => {
      const lowerName = m.name.toLowerCase();
      return TEMPLATE_METHOD_KEYWORDS.some((kw) => lowerName.includes(kw));
    });

    if (templateMethod) {
      evidence.push(
        this.createStructuralEvidence(
          `Template method: ${templateMethod.name}()`,
          0.2
        )
      );
      confidence += 0.2;
    }

    // Check for abstract methods (Python style: raise NotImplementedError)
    const abstractMethods = currentClass.methods.filter((m) => {
      const lowerName = m.name.toLowerCase();
      // Methods starting with underscore or containing 'abstract'
      return lowerName.startsWith('_') && !lowerName.startsWith('__') ||
             lowerName.includes('abstract');
    });

    if (abstractMethods.length > 0) {
      const abstractNames = abstractMethods.slice(0, 2).map((m) => m.name).join(', ');
      evidence.push(
        this.createStructuralEvidence(`Abstract methods: ${abstractNames}`, 0.2)
      );
      confidence += 0.2;
    }

    // Check if class is marked as abstract
    if (currentClass.isAbstract) {
      evidence.push(
        this.createStructuralEvidence(`Abstract base class`, 0.15)
      );
      confidence += 0.15;
    }

    // Check if methods are overridden in subclasses
    if (subclasses.length > 0) {
      const baseMethodNames = new Set(currentClass.methods.map((m) => m.name));
      const overriddenInSubclass = subclasses.some((sub) =>
        sub.methods.some((m) => baseMethodNames.has(m.name))
      );

      if (overriddenInSubclass) {
        evidence.push(
          this.createStructuralEvidence(`Methods overridden in subclasses`, 0.15)
        );
        confidence += 0.15;
      }
    }

    if (confidence >= 0.5) {
      return this.createPatternInstance(
        context,
        Math.min(confidence, 0.85),
        evidence,
        DetectionDepth.Deep,
        {
          methodName: templateMethod?.name,
          relatedClasses: subclasses.map((s) => s.name),
        }
      );
    }

    return null;
  }

  /**
   * Full detection: Behavioral analysis for Template Method.
   */
  protected detectFull(context: DetectionContext): PatternInstance | null {
    if (!context.fileContent) return null;

    // Start with deep detection
    const deepResult = this.detectDeep(context);
    if (!deepResult) return null;

    const evidence = [...deepResult.evidence];
    let confidence = deepResult.confidence;

    // Check for hook method invocation in template
    const invocationPatterns = [
      'self.prepare',
      'self.initialize',
      'self.validate',
      'self.finalize',
      'self.cleanup',
      'self._',
      'this.prepare',
      'this.initialize',
      'this.validate',
      'this.finalize',
      'this.cleanup',
      'this._',
    ];

    const invocationFound = this.contentContains(context.fileContent, invocationPatterns);
    if (invocationFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(
          `Template invokes hooks: ${invocationFound.slice(0, 2).join(', ')}`,
          0.1
        )
      );
      confidence += 0.1;
    }

    // Check for NotImplementedError (Python abstract methods)
    if (
      context.fileContent.includes('NotImplementedError') ||
      context.fileContent.includes('raise NotImplementedError')
    ) {
      evidence.push(
        this.createBehavioralEvidence(`Abstract hook methods (NotImplementedError)`, 0.1)
      );
      confidence += 0.1;
    }

    // Check for @abstractmethod decorator (Python)
    if (context.fileContent.includes('@abstractmethod')) {
      evidence.push(
        this.createBehavioralEvidence(`Python @abstractmethod hooks`, 0.1)
      );
      confidence += 0.1;
    }

    // Check for ordered method calls (algorithm sequence)
    const sequencePatterns = [
      'step1',
      'step2',
      'first',
      'then',
      'finally',
      'before_',
      'after_',
    ];

    const sequenceFound = this.contentContains(context.fileContent, sequencePatterns);
    if (sequenceFound.length >= 2) {
      evidence.push(
        this.createBehavioralEvidence(`Algorithm sequence pattern`, 0.05)
      );
      confidence += 0.05;
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
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new TemplateMethodDetector instance.
 */
export function createTemplateMethodDetector(): TemplateMethodDetector {
  return new TemplateMethodDetector();
}
