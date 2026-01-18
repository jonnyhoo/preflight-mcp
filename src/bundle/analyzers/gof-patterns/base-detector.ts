/**
 * Base Pattern Detector
 *
 * Abstract base class for all GoF pattern detectors.
 * Provides framework for multi-level detection (surface, deep, full).
 *
 * @module bundle/analyzers/gof-patterns/base-detector
 */

import {
  type PatternInstance,
  type PatternEvidence,
  type DetectionContext,
  type ClassSignature,
  type MethodSignature,
  type PatternType,
  PatternCategory,
  DetectionDepth,
} from './types.js';

// ============================================================================
// Base Detector Abstract Class
// ============================================================================

/**
 * Abstract base class for all pattern detectors.
 *
 * Implements the template method pattern: subclasses override specific
 * detection methods while the base class handles the detection flow.
 *
 * Detection levels:
 * - Surface: Fast check using naming conventions
 * - Deep: Structural analysis (methods, inheritance)
 * - Full: Behavioral analysis (code inspection)
 *
 * @example
 * ```ts
 * class SingletonDetector extends BasePatternDetector {
 *   readonly patternType = 'Singleton';
 *   readonly category = PatternCategory.Creational;
 *
 *   protected detectSurface(ctx: DetectionContext): PatternInstance | null {
 *     // Check naming conventions
 *   }
 *
 *   protected detectDeep(ctx: DetectionContext): PatternInstance | null {
 *     // Check structural characteristics
 *   }
 * }
 * ```
 */
export abstract class BasePatternDetector {
  /** Pattern type this detector handles */
  abstract readonly patternType: PatternType;

  /** Pattern category */
  abstract readonly category: PatternCategory;

  /**
   * Main detection method.
   * Delegates to appropriate level based on depth.
   *
   * @param context - Detection context
   * @param depth - Detection depth to use
   * @returns Pattern instance if detected, null otherwise
   */
  detect(context: DetectionContext, depth: DetectionDepth): PatternInstance | null {
    switch (depth) {
      case DetectionDepth.Surface:
        return this.detectSurface(context);

      case DetectionDepth.Deep: {
        // Try deep first, fallback to surface
        const deepResult = this.detectDeep(context);
        if (deepResult) return deepResult;
        return this.detectSurface(context);
      }

      case DetectionDepth.Full: {
        // Try full, fallback to deep, then surface
        if (context.fileContent) {
          const fullResult = this.detectFull(context);
          if (fullResult) return fullResult;
        }
        const deepResult = this.detectDeep(context);
        if (deepResult) return deepResult;
        return this.detectSurface(context);
      }

      default:
        throw new Error(`Invalid detection depth: ${depth}`);
    }
  }

  /**
   * Surface-level detection using naming conventions.
   * Override in subclasses for pattern-specific naming checks.
   *
   * @param context - Detection context
   * @returns Pattern instance if detected, null otherwise
   */
  protected detectSurface(context: DetectionContext): PatternInstance | null {
    // Default: no surface detection
    return null;
  }

  /**
   * Deep detection using structural analysis.
   * Override in subclasses for pattern-specific structural checks.
   *
   * @param context - Detection context
   * @returns Pattern instance if detected, null otherwise
   */
  protected detectDeep(context: DetectionContext): PatternInstance | null {
    // Default: no deep detection
    return null;
  }

  /**
   * Full detection using behavioral analysis.
   * Override in subclasses for pattern-specific behavioral checks.
   *
   * @param context - Detection context (must have fileContent)
   * @returns Pattern instance if detected, null otherwise
   */
  protected detectFull(context: DetectionContext): PatternInstance | null {
    // Default: no full detection
    return null;
  }

  // ==========================================================================
  // Helper Methods for Building Pattern Instances
  // ==========================================================================

  /**
   * Creates a pattern instance with common fields filled in.
   *
   * @param context - Detection context
   * @param confidence - Detection confidence
   * @param evidence - Evidence supporting detection
   * @param depth - Detection depth that found this pattern
   * @param options - Additional options
   * @returns New PatternInstance
   */
  protected createPatternInstance(
    context: DetectionContext,
    confidence: number,
    evidence: PatternEvidence[],
    depth: DetectionDepth,
    options?: {
      methodName?: string;
      relatedClasses?: string[];
    }
  ): PatternInstance {
    return {
      patternType: this.patternType,
      category: this.category,
      confidence: Math.min(confidence, 1.0), // Cap at 1.0
      location: context.filePath,
      className: context.currentClass.name,
      methodName: options?.methodName,
      lineNumber: context.currentClass.lineNumber,
      evidence,
      relatedClasses: options?.relatedClasses ?? [],
      detectionDepth: depth,
    };
  }

  /**
   * Creates a naming evidence entry.
   */
  protected createNamingEvidence(description: string, confidence: number): PatternEvidence {
    return {
      type: 'naming',
      description,
      confidence,
    };
  }

  /**
   * Creates a structural evidence entry.
   */
  protected createStructuralEvidence(description: string, confidence: number): PatternEvidence {
    return {
      type: 'structural',
      description,
      confidence,
    };
  }

  /**
   * Creates a behavioral evidence entry.
   */
  protected createBehavioralEvidence(description: string, confidence: number): PatternEvidence {
    return {
      type: 'behavioral',
      description,
      confidence,
    };
  }

  // ==========================================================================
  // Common Detection Utilities
  // ==========================================================================

  /**
   * Checks if class name contains any of the given keywords (case-insensitive).
   */
  protected classNameContains(className: string, keywords: string[]): boolean {
    const lower = className.toLowerCase();
    return keywords.some((kw) => lower.includes(kw.toLowerCase()));
  }

  /**
   * Checks if class has a method with any of the given names (case-insensitive).
   */
  protected hasMethodNamed(classSig: ClassSignature, methodNames: string[]): MethodSignature | null {
    const lowerNames = methodNames.map((n) => n.toLowerCase());
    return (
      classSig.methods.find((m) => lowerNames.includes(m.name.toLowerCase())) ?? null
    );
  }

  /**
   * Checks if class has methods starting with any of the given prefixes.
   */
  protected hasMethodsWithPrefix(
    classSig: ClassSignature,
    prefixes: string[]
  ): MethodSignature[] {
    const lowerPrefixes = prefixes.map((p) => p.toLowerCase());
    return classSig.methods.filter((m) =>
      lowerPrefixes.some((prefix) => m.name.toLowerCase().startsWith(prefix))
    );
  }

  /**
   * Finds classes that inherit from the given base class name.
   */
  protected findSubclasses(allClasses: ClassSignature[], baseClassName: string): ClassSignature[] {
    return allClasses.filter((cls) =>
      cls.baseClasses.some((base) => base === baseClassName)
    );
  }

  /**
   * Finds classes that share the same base class.
   */
  protected findSiblingClasses(
    allClasses: ClassSignature[],
    currentClass: ClassSignature
  ): ClassSignature[] {
    if (currentClass.baseClasses.length === 0) return [];

    const baseClass = currentClass.baseClasses[0];
    return allClasses.filter(
      (cls) =>
        cls.name !== currentClass.name &&
        cls.baseClasses.some((base) => base === baseClass)
    );
  }

  /**
   * Checks if content contains any of the given patterns.
   */
  protected contentContains(content: string, patterns: string[]): string[] {
    const found: string[] = [];
    const lowerContent = content.toLowerCase();

    for (const pattern of patterns) {
      if (lowerContent.includes(pattern.toLowerCase())) {
        found.push(pattern);
      }
    }

    return found;
  }

  /**
   * Counts how many methods match a naming pattern.
   */
  protected countMethodsMatching(
    classSig: ClassSignature,
    predicate: (method: MethodSignature) => boolean
  ): number {
    return classSig.methods.filter(predicate).length;
  }

  /**
   * Gets the constructor/initializer method if present.
   */
  protected getConstructor(classSig: ClassSignature): MethodSignature | null {
    const constructorNames = ['__init__', 'constructor', '__new__'];
    return this.hasMethodNamed(classSig, constructorNames);
  }

  /**
   * Gets parameters from constructor (excluding 'self'/'this').
   */
  protected getConstructorParams(classSig: ClassSignature): string[] {
    const ctor = this.getConstructor(classSig);
    if (!ctor) return [];

    return ctor.parameters
      .filter((p) => p.name !== 'self' && p.name !== 'this')
      .map((p) => p.name);
  }

  /**
   * Sums confidence values from evidence array.
   */
  protected sumConfidence(evidence: PatternEvidence[]): number {
    return evidence.reduce((sum, e) => sum + e.confidence, 0);
  }
}

// ============================================================================
// Language-Specific Utilities
// ============================================================================

/**
 * Adapts detection results based on language-specific idioms.
 */
export function adaptForLanguage(
  pattern: PatternInstance,
  language: string
): PatternInstance {
  const adapted = { ...pattern };
  const evidenceStr = pattern.evidence.map((e) => e.description).join(' ').toLowerCase();

  switch (language.toLowerCase()) {
    case 'python':
      adaptForPython(adapted, evidenceStr);
      break;
    case 'javascript':
    case 'typescript':
      adaptForJavaScript(adapted, evidenceStr);
      break;
    case 'java':
    case 'c#':
    case 'csharp':
      adaptForJava(adapted, evidenceStr);
      break;
    case 'go':
      adaptForGo(adapted, evidenceStr);
      break;
    case 'rust':
      adaptForRust(adapted, evidenceStr);
      break;
  }

  return adapted;
}

function adaptForPython(pattern: PatternInstance, evidenceStr: string): void {
  // Python-specific confidence adjustments
  if (pattern.patternType === 'Decorator' && evidenceStr.includes('@')) {
    pattern.confidence = Math.min(pattern.confidence + 0.1, 1.0);
    pattern.evidence.push({
      type: 'behavioral',
      description: 'Python @decorator syntax detected',
      confidence: 0.1,
    });
  }

  if (pattern.patternType === 'Singleton' && evidenceStr.includes('__new__')) {
    pattern.confidence = Math.min(pattern.confidence + 0.1, 1.0);
  }
}

function adaptForJavaScript(pattern: PatternInstance, evidenceStr: string): void {
  // JavaScript/TypeScript specific adjustments
  if (pattern.patternType === 'Singleton' && evidenceStr.includes('module')) {
    pattern.confidence = Math.min(pattern.confidence + 0.1, 1.0);
    pattern.evidence.push({
      type: 'behavioral',
      description: 'JavaScript module pattern',
      confidence: 0.1,
    });
  }

  if (pattern.patternType === 'Observer' && evidenceStr.includes('eventemitter')) {
    pattern.confidence = Math.min(pattern.confidence + 0.1, 1.0);
    pattern.evidence.push({
      type: 'behavioral',
      description: 'EventEmitter pattern detected',
      confidence: 0.1,
    });
  }
}

function adaptForJava(pattern: PatternInstance, evidenceStr: string): void {
  // Java/C# interface-heavy patterns
  if (evidenceStr.includes('interface')) {
    pattern.confidence = Math.min(pattern.confidence + 0.05, 1.0);
  }

  if (pattern.patternType === 'Factory' && evidenceStr.includes('abstract')) {
    pattern.confidence = Math.min(pattern.confidence + 0.1, 1.0);
    pattern.evidence.push({
      type: 'structural',
      description: 'Abstract Factory pattern',
      confidence: 0.1,
    });
  }
}

function adaptForGo(pattern: PatternInstance, evidenceStr: string): void {
  // Go specific patterns
  if (pattern.patternType === 'Singleton' && evidenceStr.includes('sync.once')) {
    pattern.confidence = Math.min(pattern.confidence + 0.15, 1.0);
    pattern.evidence.push({
      type: 'behavioral',
      description: 'Go sync.Once idiom',
      confidence: 0.15,
    });
  }
}

function adaptForRust(pattern: PatternInstance, evidenceStr: string): void {
  // Rust specific patterns
  if (pattern.patternType === 'Singleton' && evidenceStr.includes('lazy_static')) {
    pattern.confidence = Math.min(pattern.confidence + 0.15, 1.0);
    pattern.evidence.push({
      type: 'behavioral',
      description: 'Rust lazy_static/OnceCell',
      confidence: 0.15,
    });
  }

  if (pattern.patternType === 'Builder' && evidenceStr.includes('derive')) {
    pattern.confidence = Math.min(pattern.confidence + 0.1, 1.0);
  }
}
