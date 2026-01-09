/**
 * Equation modal processor for mathematical formulas.
 *
 * This module provides processing capabilities for:
 * - LaTeX equations
 * - MathML expressions
 * - Inline and display math
 * - Formula structure analysis
 *
 * @module modal/processors/equation-processor
 */

import type {
  ModalContent,
  ModalContentType,
  ModalProcessorConfig,
} from '../types.js';
import {
  BaseModalProcessor,
  type BaseProcessorResult,
  type ProcessingContext,
} from './base-processor.js';
import { createModuleLogger } from '../../logging/logger.js';

const logger = createModuleLogger('equation-processor');

// ============================================================================
// Types
// ============================================================================

/**
 * Equation processor configuration.
 */
export interface EquationProcessorConfig extends ModalProcessorConfig {
  /** Preferred input format */
  inputFormat?: 'latex' | 'mathml' | 'auto';
  
  /** Whether to extract variable names */
  extractVariables?: boolean;
  
  /** Whether to detect equation type */
  detectType?: boolean;
}

/**
 * Detected equation type.
 */
export type EquationType =
  | 'algebraic'
  | 'calculus'
  | 'differential'
  | 'linear_algebra'
  | 'statistics'
  | 'trigonometric'
  | 'physics'
  | 'chemistry'
  | 'general';

/**
 * Equation analysis result.
 */
export interface EquationAnalysis {
  /** Detected equation type */
  type: EquationType;
  
  /** Variables found in equation */
  variables: string[];
  
  /** Operators used */
  operators: string[];
  
  /** Whether equation has subscripts/superscripts */
  hasSubscripts: boolean;
  hasSuperscripts: boolean;
  
  /** Whether it's an inline or display equation */
  displayStyle: 'inline' | 'display';
  
  /** Complexity estimate (1-10) */
  complexity: number;
}

// ============================================================================
// Equation Processor Implementation
// ============================================================================

/**
 * Processor for mathematical equations and formulas.
 */
export class EquationProcessor extends BaseModalProcessor {
  readonly name = 'equation';
  readonly supportedTypes: readonly ModalContentType[] = ['equation'];
  
  private equationConfig: EquationProcessorConfig;

  constructor(config: EquationProcessorConfig = {}) {
    super(config);
    this.equationConfig = {
      inputFormat: 'auto',
      extractVariables: true,
      detectType: true,
      ...config,
    };
  }

  protected async processContent(
    content: ModalContent,
    context?: string
  ): Promise<BaseProcessorResult> {
    const startTime = Date.now();

    try {
      // Extract equation string
      const equation = this.extractEquationString(content);
      
      if (!equation) {
        return {
          success: false,
          error: 'No equation content found',
          processingTimeMs: Date.now() - startTime,
        };
      }

      // Detect format
      const format = this.detectFormat(equation);
      
      // Analyze equation
      const analysis = this.analyzeEquation(equation, format);
      
      // Generate description
      const description = this.generateDescription(equation, analysis, context);
      
      // Generate summary
      const summary = this.generateSummary(equation, analysis);

      return {
        success: true,
        description,
        extractedContent: equation,
        confidence: 0.85,
        processingTimeMs: Date.now() - startTime,
        entityInfo: {
          entityName: this.generateEquationName(analysis),
          entityType: 'equation',
          summary,
          keywords: this.generateKeywords(analysis),
        },
        metadata: {
          analysis,
          format,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        processingTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Extract equation string from content.
   */
  private extractEquationString(content: ModalContent): string | null {
    if (typeof content.content === 'string') {
      return content.content.trim();
    }
    
    if (typeof content.content === 'object' && content.content !== null) {
      // Try common equation object properties
      const obj = content.content as Record<string, unknown>;
      if (typeof obj.latex === 'string') return obj.latex;
      if (typeof obj.mathml === 'string') return obj.mathml;
      if (typeof obj.equation === 'string') return obj.equation;
      if (typeof obj.formula === 'string') return obj.formula;
    }
    
    return null;
  }

  /**
   * Detect equation format.
   */
  private detectFormat(equation: string): 'latex' | 'mathml' | 'text' {
    if (this.equationConfig.inputFormat !== 'auto') {
      return this.equationConfig.inputFormat === 'mathml' ? 'mathml' : 'latex';
    }
    
    // Check for MathML
    if (equation.includes('<math') || equation.includes('<mrow')) {
      return 'mathml';
    }
    
    // Check for LaTeX indicators
    if (
      equation.includes('\\') ||
      equation.includes('{') ||
      equation.includes('^') ||
      equation.includes('_')
    ) {
      return 'latex';
    }
    
    return 'text';
  }

  /**
   * Analyze equation structure.
   */
  private analyzeEquation(
    equation: string,
    format: 'latex' | 'mathml' | 'text'
  ): EquationAnalysis {
    const analysis: EquationAnalysis = {
      type: 'general',
      variables: [],
      operators: [],
      hasSubscripts: false,
      hasSuperscripts: false,
      displayStyle: 'inline',
      complexity: 1,
    };

    if (format === 'latex') {
      this.analyzeLatex(equation, analysis);
    } else if (format === 'mathml') {
      this.analyzeMathML(equation, analysis);
    } else {
      this.analyzeText(equation, analysis);
    }

    // Detect equation type
    analysis.type = this.detectEquationType(equation, analysis);
    
    // Calculate complexity
    analysis.complexity = this.calculateComplexity(equation, analysis);

    return analysis;
  }

  /**
   * Analyze LaTeX equation.
   */
  private analyzeLatex(equation: string, analysis: EquationAnalysis): void {
    // Check display style
    if (
      equation.includes('\\[') ||
      equation.includes('$$') ||
      equation.includes('\\begin{equation}')
    ) {
      analysis.displayStyle = 'display';
    }

    // Extract variables (single letters not followed by backslash)
    const varMatch = equation.match(/(?<!\\)[a-zA-Z](?![a-zA-Z])/g);
    if (varMatch) {
      analysis.variables = [...new Set(varMatch)].filter(
        v => !['d', 'e', 'i', 'n'].includes(v.toLowerCase()) || equation.includes(`\\${v}`)
      );
    }

    // Check subscripts and superscripts
    analysis.hasSubscripts = equation.includes('_');
    analysis.hasSuperscripts = equation.includes('^');

    // Detect operators
    const latexOps: Record<string, string> = {
      '\\frac': 'fraction',
      '\\sqrt': 'root',
      '\\sum': 'summation',
      '\\int': 'integral',
      '\\prod': 'product',
      '\\lim': 'limit',
      '\\partial': 'partial_derivative',
      '\\nabla': 'gradient',
      '\\times': 'cross_product',
      '\\cdot': 'dot_product',
      '\\sin': 'sine',
      '\\cos': 'cosine',
      '\\tan': 'tangent',
      '\\log': 'logarithm',
      '\\ln': 'natural_log',
      '\\exp': 'exponential',
      '\\det': 'determinant',
      '\\vec': 'vector',
      '\\matrix': 'matrix',
    };

    for (const [latex, name] of Object.entries(latexOps)) {
      if (equation.includes(latex)) {
        analysis.operators.push(name);
      }
    }

    // Check for basic operators
    if (equation.includes('+')) analysis.operators.push('addition');
    if (equation.includes('-')) analysis.operators.push('subtraction');
    if (equation.includes('=')) analysis.operators.push('equality');
    if (equation.includes('<') || equation.includes('>')) {
      analysis.operators.push('inequality');
    }
  }

  /**
   * Analyze MathML equation.
   */
  private analyzeMathML(equation: string, analysis: EquationAnalysis): void {
    // Check display style
    if (equation.includes('display="block"')) {
      analysis.displayStyle = 'display';
    }

    // Extract variables from <mi> tags
    const miMatch = equation.match(/<mi>([a-zA-Z])<\/mi>/g);
    if (miMatch) {
      analysis.variables = [...new Set(
        miMatch.map(m => m.replace(/<\/?mi>/g, ''))
      )];
    }

    // Check subscripts and superscripts
    analysis.hasSubscripts = equation.includes('<msub');
    analysis.hasSuperscripts = equation.includes('<msup');

    // Detect operators from MathML elements
    if (equation.includes('<mfrac')) analysis.operators.push('fraction');
    if (equation.includes('<msqrt')) analysis.operators.push('root');
    if (equation.includes('<munder') || equation.includes('<mover')) {
      if (equation.includes('∑')) analysis.operators.push('summation');
      if (equation.includes('∫')) analysis.operators.push('integral');
      if (equation.includes('∏')) analysis.operators.push('product');
    }
  }

  /**
   * Analyze plain text equation.
   */
  private analyzeText(equation: string, analysis: EquationAnalysis): void {
    // Extract single letter variables
    const varMatch = equation.match(/[a-zA-Z]/g);
    if (varMatch) {
      analysis.variables = [...new Set(varMatch)];
    }

    // Check basic operators
    if (equation.includes('+')) analysis.operators.push('addition');
    if (equation.includes('-')) analysis.operators.push('subtraction');
    if (equation.includes('*') || equation.includes('×')) {
      analysis.operators.push('multiplication');
    }
    if (equation.includes('/') || equation.includes('÷')) {
      analysis.operators.push('division');
    }
    if (equation.includes('=')) analysis.operators.push('equality');
    if (equation.includes('^')) {
      analysis.operators.push('exponent');
      analysis.hasSuperscripts = true;
    }
  }

  /**
   * Detect equation type based on content.
   */
  private detectEquationType(
    equation: string,
    analysis: EquationAnalysis
  ): EquationType {
    const eq = equation.toLowerCase();

    // Calculus indicators
    if (
      analysis.operators.includes('integral') ||
      analysis.operators.includes('partial_derivative') ||
      eq.includes('\\int') ||
      eq.includes('\\partial') ||
      eq.includes("'") ||
      eq.includes('dy/dx')
    ) {
      return analysis.operators.includes('integral') ? 'calculus' : 'differential';
    }

    // Linear algebra indicators
    if (
      analysis.operators.includes('matrix') ||
      analysis.operators.includes('determinant') ||
      analysis.operators.includes('vector') ||
      eq.includes('\\begin{matrix}') ||
      eq.includes('\\vec')
    ) {
      return 'linear_algebra';
    }

    // Statistics indicators
    if (
      eq.includes('\\mu') ||
      eq.includes('\\sigma') ||
      eq.includes('\\bar') ||
      eq.includes('e^{-') ||
      eq.includes('\\binom')
    ) {
      return 'statistics';
    }

    // Trigonometry indicators
    if (
      analysis.operators.some(op =>
        ['sine', 'cosine', 'tangent'].includes(op)
      ) ||
      eq.includes('\\theta') ||
      eq.includes('\\alpha') ||
      eq.includes('\\beta')
    ) {
      return 'trigonometric';
    }

    // Physics indicators
    if (
      eq.includes('\\hbar') ||
      eq.includes('\\psi') ||
      eq.includes('\\phi') ||
      eq.includes('\\omega') ||
      (eq.includes('f') && eq.includes('=') && eq.includes('m') && eq.includes('a'))
    ) {
      return 'physics';
    }

    // Chemistry indicators
    if (
      eq.includes('->') ||
      eq.includes('\\rightarrow') ||
      eq.includes('\\ce{') ||
      /[A-Z][a-z]?\d*/.test(equation)
    ) {
      return 'chemistry';
    }

    // Default to algebraic
    return 'algebraic';
  }

  /**
   * Calculate equation complexity.
   */
  private calculateComplexity(
    equation: string,
    analysis: EquationAnalysis
  ): number {
    let complexity = 1;

    // Length factor
    complexity += Math.min(equation.length / 50, 3);

    // Operator complexity
    const complexOps = ['integral', 'summation', 'product', 'limit', 'partial_derivative'];
    complexity += analysis.operators.filter(op => complexOps.includes(op)).length * 2;

    // Nesting (count braces)
    const braceDepth = (equation.match(/{/g) || []).length;
    complexity += Math.min(braceDepth / 3, 2);

    // Variable count
    complexity += Math.min(analysis.variables.length / 4, 1);

    // Subscripts/superscripts
    if (analysis.hasSubscripts) complexity += 0.5;
    if (analysis.hasSuperscripts) complexity += 0.5;

    return Math.min(Math.round(complexity), 10);
  }

  /**
   * Generate description for equation.
   */
  private generateDescription(
    equation: string,
    analysis: EquationAnalysis,
    context?: string
  ): string {
    const parts: string[] = [];

    // Type description
    const typeNames: Record<EquationType, string> = {
      algebraic: 'algebraic equation',
      calculus: 'calculus expression',
      differential: 'differential equation',
      linear_algebra: 'linear algebra expression',
      statistics: 'statistical formula',
      trigonometric: 'trigonometric expression',
      physics: 'physics equation',
      chemistry: 'chemical equation/formula',
      general: 'mathematical expression',
    };
    parts.push(`This is a ${typeNames[analysis.type]}.`);

    // Variables
    if (analysis.variables.length > 0) {
      parts.push(`Variables: ${analysis.variables.join(', ')}.`);
    }

    // Key operations
    if (analysis.operators.length > 0) {
      const opNames = analysis.operators
        .slice(0, 5)
        .map(op => op.replace(/_/g, ' '));
      parts.push(`Key operations: ${opNames.join(', ')}.`);
    }

    // Complexity
    parts.push(`Complexity: ${analysis.complexity}/10.`);

    // Display style
    parts.push(
      analysis.displayStyle === 'display'
        ? 'This is a display-style (block) equation.'
        : 'This is an inline equation.'
    );

    // Context if provided
    if (context) {
      parts.push(`Context: ${context.slice(0, 200)}`);
    }

    return parts.join(' ');
  }

  /**
   * Generate summary for equation.
   */
  private generateSummary(equation: string, analysis: EquationAnalysis): string {
    const preview = equation.length > 50 ? equation.slice(0, 50) + '...' : equation;
    return `${analysis.type.replace(/_/g, ' ')} expression: ${preview}`;
  }

  /**
   * Generate equation entity name.
   */
  private generateEquationName(analysis: EquationAnalysis): string {
    const parts: string[] = ['eq'];
    parts.push(analysis.type.slice(0, 4));
    
    if (analysis.variables.length > 0) {
      parts.push(analysis.variables.slice(0, 2).join(''));
    }
    
    return parts.join('_');
  }

  /**
   * Generate keywords for equation.
   */
  private generateKeywords(analysis: EquationAnalysis): string[] {
    const keywords: string[] = [
      'equation',
      'math',
      'formula',
      analysis.type.replace(/_/g, ' '),
    ];

    // Add variable names
    keywords.push(...analysis.variables);

    // Add operator keywords
    keywords.push(
      ...analysis.operators.map(op => op.replace(/_/g, ' '))
    );

    return [...new Set(keywords)];
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an equation processor instance.
 */
export function createEquationProcessor(
  config?: EquationProcessorConfig
): EquationProcessor {
  return new EquationProcessor(config);
}

export default EquationProcessor;
