/**
 * Command Pattern Detector
 *
 * Detects the Command design pattern which encapsulates a request as an object,
 * thereby letting you parameterize clients with different requests, queue or
 * log requests, and support undoable operations.
 *
 * Detection Heuristics:
 * - Surface: Class name contains 'Command', 'Action', 'Task'
 * - Deep: Has execute()/run() method, encapsulates action
 * - Full: Receiver composition + undo support
 *
 * Examples:
 * - SaveCommand with execute() method
 * - UndoableCommand with undo() and redo()
 * - TaskCommand in task queue
 *
 * @module bundle/analyzers/gof-patterns/detectors/command
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

/** Keywords in class names suggesting command pattern */
const COMMAND_CLASS_KEYWORDS = [
  'command',
  'action',
  'task',
  'operation',
  'request',
  'job',
  'instruction',
];

/** Execute/run method names */
const EXECUTE_METHOD_NAMES = [
  'execute',
  'run',
  'call',
  'do',
  'perform',
  'invoke',
  '__call__',
  'handle',
  'process',
];

/** Undo/redo method names */
const UNDO_METHOD_NAMES = ['undo', 'rollback', 'revert', 'cancel', 'redo', 'unexecute'];

/** Receiver parameter names */
const RECEIVER_PARAM_NAMES = ['receiver', 'target', 'subject', 'context', 'handler'];

// ============================================================================
// Command Detector
// ============================================================================

/**
 * Detector for the Command pattern.
 *
 * Command pattern turns a request into a stand-alone object containing all
 * information about the request. This transformation allows for parameterizing
 * methods with different requests, delaying or queuing request execution,
 * and supporting undoable operations.
 */
export class CommandDetector extends BasePatternDetector {
  readonly patternType = 'Command' as const;
  readonly category = PatternCategory.Behavioral;

  /**
   * Surface detection: Check naming conventions for Command.
   */
  protected detectSurface(context: DetectionContext): PatternInstance | null {
    const { currentClass } = context;

    if (this.classNameContains(currentClass.name, COMMAND_CLASS_KEYWORDS)) {
      const evidence: PatternEvidence[] = [
        this.createNamingEvidence(
          `Class name suggests Command: ${currentClass.name}`,
          0.65
        ),
      ];

      return this.createPatternInstance(context, 0.65, evidence, DetectionDepth.Surface);
    }

    return null;
  }

  /**
   * Deep detection: Structural analysis for Command.
   *
   * Looks for:
   * - execute()/run() method
   * - undo()/redo() methods
   * - Receiver in constructor
   */
  protected detectDeep(context: DetectionContext): PatternInstance | null {
    const { currentClass } = context;
    const evidence: PatternEvidence[] = [];
    let confidence = 0;
    let executeMethodName = '';

    // Check for execute/run method
    const executeMethod = this.hasMethodNamed(currentClass, EXECUTE_METHOD_NAMES);
    if (executeMethod) {
      executeMethodName = executeMethod.name;
      evidence.push(
        this.createStructuralEvidence(
          `Has execute method: ${executeMethod.name}()`,
          0.5
        )
      );
      confidence += 0.5;
    }

    // Check for undo/redo support
    const undoMethod = this.hasMethodNamed(currentClass, UNDO_METHOD_NAMES);
    if (undoMethod) {
      evidence.push(
        this.createStructuralEvidence(`Supports undo/redo: ${undoMethod.name}()`, 0.3)
      );
      confidence += 0.3;
    }

    // Check for receiver in constructor (encapsulates request parameters)
    const constructor = this.getConstructor(currentClass);
    if (constructor) {
      const params = constructor.parameters.filter(
        (p) => p.name !== 'self' && p.name !== 'this'
      );

      if (params.length > 0) {
        // Check for receiver parameter
        const receiverParam = params.find((p) =>
          RECEIVER_PARAM_NAMES.some((name) =>
            p.name.toLowerCase().includes(name)
          )
        );

        if (receiverParam) {
          evidence.push(
            this.createStructuralEvidence(
              `Encapsulates receiver: ${receiverParam.name}`,
              0.2
            )
          );
          confidence += 0.2;
        } else {
          // Generic parameters - might be command params
          evidence.push(
            this.createStructuralEvidence(
              `Encapsulates parameters: ${params.map((p) => p.name).join(', ')}`,
              0.15
            )
          );
          confidence += 0.15;
        }
      }
    }

    // Check for __call__ (Python callable command)
    const callMethod = currentClass.methods.find((m) => m.name === '__call__');
    if (callMethod) {
      evidence.push(
        this.createStructuralEvidence(`Callable command (__call__)`, 0.2)
      );
      confidence += 0.2;
    }

    // Check if part of command hierarchy
    if (currentClass.baseClasses.length > 0) {
      const baseClass = currentClass.baseClasses[0];
      if (baseClass && COMMAND_CLASS_KEYWORDS.some(
        (kw) => baseClass.toLowerCase().includes(kw)
      )) {
        evidence.push(
          this.createStructuralEvidence(`Inherits from command base: ${baseClass}`, 0.15)
        );
        confidence += 0.15;
      }
    }

    if (confidence >= 0.5) {
      return this.createPatternInstance(
        context,
        Math.min(confidence, 0.9),
        evidence,
        DetectionDepth.Deep,
        { methodName: executeMethodName }
      );
    }

    return null;
  }

  /**
   * Full detection: Behavioral analysis for Command.
   */
  protected detectFull(context: DetectionContext): PatternInstance | null {
    if (!context.fileContent) return null;

    // Start with deep detection
    const deepResult = this.detectDeep(context);
    if (!deepResult) return null;

    const evidence = [...deepResult.evidence];
    let confidence = deepResult.confidence;

    // Check for receiver invocation in execute
    const receiverPatterns = [
      'self.receiver',
      'this.receiver',
      'self._receiver',
      'this._receiver',
      'self.target',
      'this.target',
    ];

    const receiverFound = this.contentContains(context.fileContent, receiverPatterns);
    if (receiverFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(
          `Invokes receiver: ${receiverFound[0]}`,
          0.1
        )
      );
      confidence += 0.1;
    }

    // Check for state storage (for undo)
    const statePatterns = [
      'self.state',
      'this.state',
      'self._state',
      'this._state',
      'self.backup',
      'this.backup',
      'self.previous',
      'this.previous',
    ];

    const stateFound = this.contentContains(context.fileContent, statePatterns);
    if (stateFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(
          `Stores state for undo: ${stateFound[0]}`,
          0.1
        )
      );
      confidence += 0.1;
    }

    // Check for command queuing/invoker patterns
    const invokerPatterns = [
      'command_queue',
      'commands',
      'history',
      'invoker',
      'commandQueue',
      'command_history',
    ];

    const invokerFound = this.contentContains(context.fileContent, invokerPatterns);
    if (invokerFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(
          `Command queue/history pattern`,
          0.05
        )
      );
      confidence += 0.05;
    }

    // Check for macro command (composite)
    const macroPatterns = ['commands', 'subcommands', 'child_commands', 'macro'];
    const macroFound = this.contentContains(context.fileContent, macroPatterns);

    if (macroFound.length > 0) {
      evidence.push(
        this.createBehavioralEvidence(`May be macro/composite command`, 0.05)
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
 * Creates a new CommandDetector instance.
 */
export function createCommandDetector(): CommandDetector {
  return new CommandDetector();
}
