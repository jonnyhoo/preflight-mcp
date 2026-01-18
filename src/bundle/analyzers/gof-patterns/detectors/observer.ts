/**
 * Observer Pattern Detector
 *
 * Detects the Observer design pattern (also known as Publish/Subscribe) which
 * defines a one-to-many dependency between objects so that when one object
 * changes state, all its dependents are notified and updated automatically.
 *
 * Detection Heuristics:
 * - Surface: Class/method names with 'Observer', 'Listener', 'Subscribe'
 * - Deep: attach/detach + notify methods, observer collection
 * - Full: Collection iteration + callback invocation pattern
 *
 * Examples:
 * - addObserver(), removeObserver(), notifyObservers()
 * - addEventListener(), removeEventListener(), emit()
 * - subscribe(), unsubscribe(), publish()
 *
 * @module bundle/analyzers/gof-patterns/detectors/observer
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

/** Keywords in class names suggesting observer pattern */
const OBSERVER_CLASS_KEYWORDS = [
  'observer',
  'listener',
  'subscriber',
  'watcher',
  'eventbus',
  'emitter',
  'dispatcher',
  'subject',
  'observable',
  'publisher',
];

/** Method names for attaching observers */
const ATTACH_METHOD_NAMES = [
  'attach',
  'add',
  'subscribe',
  'register',
  'addeventlistener',
  'addlistener',
  'addobserver',
  'on',
  'bind',
  'connect',
];

/** Method names for detaching observers */
const DETACH_METHOD_NAMES = [
  'detach',
  'remove',
  'unsubscribe',
  'unregister',
  'removeeventlistener',
  'removelistener',
  'removeobserver',
  'off',
  'unbind',
  'disconnect',
];

/** Method names for notifying observers */
const NOTIFY_METHOD_NAMES = [
  'notify',
  'update',
  'emit',
  'publish',
  'fire',
  'trigger',
  'dispatch',
  'broadcast',
  'notifyall',
  'notifyobservers',
];

/** Patterns indicating observer collection in code */
const OBSERVER_COLLECTION_PATTERNS = [
  'observers',
  'listeners',
  'subscribers',
  'watchers',
  'handlers',
  'callbacks',
  '_observers',
  '_listeners',
  '_subscribers',
  'self.observers',
  'this.observers',
  'self.listeners',
  'this.listeners',
];

// ============================================================================
// Observer Detector
// ============================================================================

/**
 * Detector for the Observer pattern.
 *
 * Observer pattern establishes a one-to-many relationship between objects.
 * When one object (subject) changes state, all registered observers are
 * notified automatically. Common in event-driven architectures.
 */
export class ObserverDetector extends BasePatternDetector {
  readonly patternType = 'Observer' as const;
  readonly category = PatternCategory.Behavioral;

  /**
   * Surface detection: Check naming conventions for Observer.
   */
  protected detectSurface(context: DetectionContext): PatternInstance | null {
    const { currentClass } = context;

    // Check class name
    if (this.classNameContains(currentClass.name, OBSERVER_CLASS_KEYWORDS)) {
      const evidence: PatternEvidence[] = [
        this.createNamingEvidence(
          `Class name suggests Observer: ${currentClass.name}`,
          0.6
        ),
      ];

      return this.createPatternInstance(context, 0.6, evidence, DetectionDepth.Surface);
    }

    // Check method names
    const allMethodKeywords = [...ATTACH_METHOD_NAMES, ...DETACH_METHOD_NAMES, ...NOTIFY_METHOD_NAMES];

    for (const method of currentClass.methods) {
      const methodLower = method.name.toLowerCase().replace(/_/g, '');
      if (allMethodKeywords.some((kw) => methodLower.includes(kw))) {
        const evidence: PatternEvidence[] = [
          this.createNamingEvidence(
            `Observer method detected: ${method.name}()`,
            0.65
          ),
        ];

        return this.createPatternInstance(
          context,
          0.65,
          evidence,
          DetectionDepth.Surface,
          { methodName: method.name }
        );
      }
    }

    return null;
  }

  /**
   * Deep detection: Structural analysis for Observer.
   *
   * Looks for the characteristic method triplet: attach/detach/notify
   */
  protected detectDeep(context: DetectionContext): PatternInstance | null {
    const { currentClass } = context;
    const evidence: PatternEvidence[] = [];
    let confidence = 0;

    let hasAttach = false;
    let hasDetach = false;
    let hasNotify = false;
    let attachMethodName = '';
    let detachMethodName = '';
    let notifyMethodName = '';

    // Check for attach/detach/notify methods
    for (const method of currentClass.methods) {
      const methodLower = method.name.toLowerCase().replace(/_/g, '');

      if (!hasAttach && ATTACH_METHOD_NAMES.some((name) => methodLower.includes(name))) {
        hasAttach = true;
        attachMethodName = method.name;
        evidence.push(
          this.createStructuralEvidence(`Attach method: ${method.name}()`, 0.3)
        );
        confidence += 0.3;
      }

      if (!hasDetach && DETACH_METHOD_NAMES.some((name) => methodLower.includes(name))) {
        hasDetach = true;
        detachMethodName = method.name;
        evidence.push(
          this.createStructuralEvidence(`Detach method: ${method.name}()`, 0.3)
        );
        confidence += 0.3;
      }

      if (!hasNotify && NOTIFY_METHOD_NAMES.some((name) => methodLower.includes(name))) {
        hasNotify = true;
        notifyMethodName = method.name;
        evidence.push(
          this.createStructuralEvidence(`Notify method: ${method.name}()`, 0.3)
        );
        confidence += 0.3;
      }
    }

    // Strong signal if has all three characteristic methods
    if (hasAttach && hasDetach && hasNotify) {
      evidence.push(
        this.createStructuralEvidence(
          `Complete Observer pattern: ${attachMethodName}, ${detachMethodName}, ${notifyMethodName}`,
          0.15
        )
      );
      confidence = Math.min(confidence + 0.15, 0.95);
    }

    // Check for observer in parameters (suggests Subject role)
    const attachMethod = currentClass.methods.find((m) => {
      const methodLower = m.name.toLowerCase().replace(/_/g, '');
      return ATTACH_METHOD_NAMES.some((name) => methodLower.includes(name));
    });

    if (attachMethod) {
      const params = attachMethod.parameters.filter(
        (p) => p.name !== 'self' && p.name !== 'this'
      );
      const observerParam = params.find((p) =>
        ['observer', 'listener', 'subscriber', 'callback', 'handler'].some(
          (name) => p.name.toLowerCase().includes(name)
        )
      );

      if (observerParam) {
        evidence.push(
          this.createStructuralEvidence(
            `Takes observer parameter: ${observerParam.name}`,
            0.1
          )
        );
        confidence += 0.1;
      }
    }

    if (confidence >= 0.5) {
      return this.createPatternInstance(
        context,
        Math.min(confidence, 0.95),
        evidence,
        DetectionDepth.Deep,
        { methodName: notifyMethodName || attachMethodName }
      );
    }

    return null;
  }

  /**
   * Full detection: Behavioral analysis for Observer.
   */
  protected detectFull(context: DetectionContext): PatternInstance | null {
    if (!context.fileContent) return null;

    // Start with deep detection
    const deepResult = this.detectDeep(context);
    if (!deepResult) return null;

    const evidence = [...deepResult.evidence];
    let confidence = deepResult.confidence;

    // Look for observer collection patterns
    const collectionFound = this.contentContains(context.fileContent, OBSERVER_COLLECTION_PATTERNS);

    if (collectionFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(
          `Observer collection: ${collectionFound.slice(0, 2).join(', ')}`,
          0.1
        )
      );
      confidence += 0.1;
    }

    // Check for iteration over observers
    const iterationPatterns = [
      'for observer in',
      'for listener in',
      'for subscriber in',
      'forEach',
      'for (const',
      'for (let',
      '.map(',
      'observers.forEach',
      'listeners.forEach',
    ];

    const iterationFound = this.contentContains(context.fileContent, iterationPatterns);
    if (iterationFound.length > 0 && collectionFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(
          `Iterates over observers to notify`,
          0.1
        )
      );
      confidence += 0.1;
    }

    // Check for callback invocation
    const callbackPatterns = [
      '.update(',
      '.notify(',
      '.callback(',
      '.call(',
      '(event)',
      '(data)',
    ];

    const callbackFound = this.contentContains(context.fileContent, callbackPatterns);
    if (callbackFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(
          `Callback invocation detected`,
          0.05
        )
      );
      confidence += 0.05;
    }

    // Check for event/message object
    const eventPatterns = ['event', 'message', 'notification', 'payload', 'data'];
    const eventFound = this.contentContains(context.fileContent, eventPatterns);

    if (eventFound.length > 0 && collectionFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(
          `Event/message passing pattern`,
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
      { methodName: deepResult.methodName }
    );
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new ObserverDetector instance.
 */
export function createObserverDetector(): ObserverDetector {
  return new ObserverDetector();
}
