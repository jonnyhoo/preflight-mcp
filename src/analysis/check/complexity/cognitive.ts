/**
 * Cognitive Complexity AST Visitor
 *
 * Computes cyclomatic and cognitive complexity using tree-sitter AST.
 *
 * Node type mapping (tree-sitter grammar):
 *
 * | Construct      | JS/TS/TSX                    | Java                         |
 * |----------------|------------------------------|------------------------------|
 * | if             | if_statement                 | if_statement                 |
 * | else           | else_clause                  | (else in if_statement)       |
 * | else if        | else_clause > if_statement   | (else if in if_statement)    |
 * | switch         | switch_statement             | switch_expression/statement  |
 * | case           | switch_case                  | switch_block_statement_group |
 * | for            | for_statement                | for_statement                |
 * | for-in/of      | for_in_statement             | enhanced_for_statement       |
 * | while          | while_statement              | while_statement              |
 * | do-while       | do_statement                 | do_statement                 |
 * | ternary        | conditional_expression       | ternary_expression           |
 * | catch          | catch_clause                 | catch_clause                 |
 * | logical &&     | binary_expression (&&)       | binary_expression (&&)       |
 * | logical ||     | binary_expression (||)       | binary_expression (||)       |
 * | function       | function_declaration         | method_declaration           |
 * |                | arrow_function               | constructor_declaration      |
 * |                | function_expression          |                              |
 * |                | method_definition            |                              |
 * | call           | call_expression              | method_invocation            |
 *
 * @module analysis/check/complexity/cognitive
 */

import type { Node, Tree } from 'web-tree-sitter';
import type { TreeSitterLanguageId } from '../../../ast/types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Metrics computed for a single function.
 */
export interface FunctionComplexityMetrics {
  name: string;
  startLine: number;
  endLine: number;
  lineCount: number;
  /** Cyclomatic complexity (decision points + 1) */
  cyclomatic: number;
  /** Cognitive complexity (hybrid + fundamental) */
  cognitive: number;
  /** Maximum nesting depth */
  nestingDepth: number;
  /** Parameter count */
  paramCount: number;
}

/**
 * Context for tracking complexity within a function.
 */
interface FunctionContext {
  name: string;
  node: Node;
  cyclomatic: number;
  hybrid: number;
  fundamental: number;
  nesting: number;
  maxNesting: number;
  /** Track if recursion detected */
  hasRecursion: boolean;
}

// ============================================================================
// AST Visitor
// ============================================================================

/**
 * Compute complexity metrics for all functions in an AST.
 */
export function computeComplexityMetrics(
  tree: Tree,
  lang: TreeSitterLanguageId
): FunctionComplexityMetrics[] {
  const metrics: FunctionComplexityMetrics[] = [];
  const root = tree.rootNode;

  // Find all function nodes
  const functionNodes = findFunctionNodes(root, lang);

  for (const funcNode of functionNodes) {
    const funcName = extractFunctionName(funcNode, lang);
    const ctx: FunctionContext = {
      name: funcName,
      node: funcNode,
      cyclomatic: 1, // Base complexity
      hybrid: 0,
      fundamental: 0,
      nesting: 0,
      maxNesting: 0,
      hasRecursion: false,
    };

    // Visit the function body
    visitNode(funcNode, ctx, lang, false);

    // Recursion is already counted in hybrid as +1 (no extra fundamental)

    const startLine = funcNode.startPosition.row + 1;
    const endLine = funcNode.endPosition.row + 1;

    metrics.push({
      name: funcName,
      startLine,
      endLine,
      lineCount: endLine - startLine + 1,
      cyclomatic: ctx.cyclomatic,
      cognitive: ctx.hybrid + ctx.fundamental,
      nestingDepth: ctx.maxNesting,
      paramCount: countParameters(funcNode, lang),
    });
  }

  return metrics;
}

/**
 * Find all function nodes at any nesting level.
 */
function findFunctionNodes(root: Node, lang: TreeSitterLanguageId): Node[] {
  const types = getFunctionNodeTypes(lang);
  const result: Node[] = [];

  function walk(node: Node) {
    if (types.includes(node.type)) {
      result.push(node);
    }
    // Continue traversing to find nested functions
    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  walk(root);
  return result;
}

/**
 * Get function node types for a language.
 */
function getFunctionNodeTypes(lang: TreeSitterLanguageId): string[] {
  switch (lang) {
    case 'javascript':
    case 'typescript':
    case 'tsx':
      return [
        'function_declaration',
        'function_expression',
        'arrow_function',
        'method_definition',
        'generator_function_declaration',
        'generator_function',
      ];
    case 'java':
      return ['method_declaration', 'constructor_declaration'];
    default:
      return [];
  }
}

/**
 * Get the nearest logical binary operator from the parent chain, skipping parentheses.
 */
function getLogicalParentOperator(node: Node): '&&' | '||' | null {
  let parent = node.parent;
  while (parent && parent.type === 'parenthesized_expression') {
    parent = parent.parent;
  }
  if (parent?.type !== 'binary_expression') return null;
  const op = parent.childForFieldName('operator')?.text;
  return op === '&&' || op === '||' ? (op as '&&' | '||') : null;
}

/**
 * Extract function name from a function node.
 */
function extractFunctionName(node: Node, lang: TreeSitterLanguageId): string {
  switch (lang) {
    case 'javascript':
    case 'typescript':
    case 'tsx': {
      // function_declaration, function_expression, generator_function_declaration
      const name = node.childForFieldName('name');
      if (name) return name.text;

      // method_definition
      if (node.type === 'method_definition') {
        const methodName = node.childForFieldName('name');
        if (methodName) return methodName.text;
      }

      // arrow_function: check parent for variable name
      if (node.type === 'arrow_function' || node.type === 'function_expression') {
        const parent = node.parent;
        if (parent?.type === 'variable_declarator') {
          const varName = parent.childForFieldName('name');
          if (varName) return varName.text;
        }
        if (parent?.type === 'pair') {
          const key = parent.childForFieldName('key');
          if (key) return key.text;
        }
      }

      return '<anonymous>';
    }
    case 'java': {
      const name = node.childForFieldName('name');
      if (name) return name.text;
      if (node.type === 'constructor_declaration') {
        // Constructor uses class name
        const declarator = node.childForFieldName('declarator');
        if (declarator) {
          const ctorName = declarator.namedChild(0);
          if (ctorName) return ctorName.text;
        }
      }
      return '<anonymous>';
    }
    default:
      return '<anonymous>';
  }
}

/**
 * Count function parameters.
 */
function countParameters(node: Node, lang: TreeSitterLanguageId): number {
  const params = node.childForFieldName('parameters');
  if (!params) return 0;

  // Count named children that are parameter-like
  return params.namedChildren.filter((child) => {
    switch (lang) {
      case 'javascript':
      case 'typescript':
      case 'tsx':
        return [
          'identifier',
          'rest_pattern',
          'assignment_pattern',
          'object_pattern',
          'array_pattern',
          'required_parameter',
          'optional_parameter',
        ].includes(child.type);
      case 'java':
        return child.type === 'formal_parameter' || child.type === 'spread_parameter';
      default:
        return false;
    }
  }).length;
}

/**
 * Visit a node and update complexity context.
 * @param fromElseIf - true if this is an if_statement reached from else-if (to avoid double counting)
 */
function visitNode(
  node: Node,
  ctx: FunctionContext,
  lang: TreeSitterLanguageId,
  fromElseIf: boolean = false
): void {
  // Skip nested functions - they have their own context
  const funcTypes = getFunctionNodeTypes(lang);
  if (funcTypes.includes(node.type) && node !== ctx.node) {
    return;
  }

  // Process complexity-increasing constructs
  processComplexityNode(node, ctx, lang, fromElseIf);

  // Note: Recursion into children is handled by processComplexityNode for
  // constructs that need special nesting handling (if, for, while, etc.)
  // For other nodes, we recurse here
}

/**
 * Process a node that may contribute to complexity.
 * @param fromElseIf - true if this is an if_statement from else-if chain
 */
function processComplexityNode(
  node: Node,
  ctx: FunctionContext,
  lang: TreeSitterLanguageId,
  fromElseIf: boolean = false
): void {
  const type = node.type;
  let handled = false;

  switch (lang) {
    case 'javascript':
    case 'typescript':
    case 'tsx':
      handled = processJsTsNode(type, node, ctx, lang, fromElseIf);
      break;
    case 'java':
      handled = processJavaNode(type, node, ctx, lang, fromElseIf);
      break;
  }

  // If not handled specially, recurse into children
  if (!handled) {
    for (const child of node.namedChildren) {
      visitNode(child, ctx, lang, false);
    }
  }
}

/**
 * Process JS/TS/TSX node types.
 * @returns true if children were handled (caller should not recurse)
 */
function processJsTsNode(
  type: string,
  node: Node,
  ctx: FunctionContext,
  lang: TreeSitterLanguageId,
  fromElseIf: boolean
): boolean {
  switch (type) {
    case 'if_statement': {
      // If coming from else-if, don't add complexity again (already counted)
      if (!fromElseIf) {
        // Cyclomatic: +1 for if
        ctx.cyclomatic++;
        // Cognitive: +1 + nesting for entering the if branch
        ctx.hybrid += 1 + ctx.nesting;
      }

      ctx.nesting++;
      ctx.maxNesting = Math.max(ctx.maxNesting, ctx.nesting);

      // Process children manually to handle else properly
      for (const child of node.namedChildren) {
        if (child.type === 'else_clause') {
          // Exit if block nesting before else
          ctx.nesting--;
          processElseClause(child, ctx, lang);
        } else {
          visitNode(child, ctx, lang, false);
        }
      }

      // Restore nesting (already decremented if else was present)
      if (!node.namedChildren.some((c) => c.type === 'else_clause')) {
        ctx.nesting--;
      }
      return true; // Children handled
    }

    case 'switch_statement': {
      // Cyclomatic: +1 for switch
      ctx.cyclomatic++;
      // Cognitive: +1 + nesting for switch
      ctx.hybrid += 1 + ctx.nesting;
      ctx.nesting++;
      ctx.maxNesting = Math.max(ctx.maxNesting, ctx.nesting);

      // Process children, then decrement nesting
      for (const child of node.namedChildren) {
        visitNode(child, ctx, lang, false);
      }
      ctx.nesting--;
      return true;
    }

    case 'switch_case': {
      // Cyclomatic: +1 for each case (except default)
      const caseValue = node.namedChildren.find(
        (c) => c.type !== 'statement_block' && c.type !== 'break_statement'
      );
      if (caseValue && caseValue.text !== 'default') {
        ctx.cyclomatic++;
      }
      // Cognitive: cases don't add nesting penalty (already in switch)
      return false; // Let default recursion handle children
    }

    case 'for_statement':
    case 'for_in_statement':
    case 'while_statement':
    case 'do_statement': {
      // Cyclomatic: +1
      ctx.cyclomatic++;
      // Cognitive: +1 + nesting
      ctx.hybrid += 1 + ctx.nesting;
      ctx.nesting++;
      ctx.maxNesting = Math.max(ctx.maxNesting, ctx.nesting);

      // Process children, then decrement nesting
      for (const child of node.namedChildren) {
        visitNode(child, ctx, lang, false);
      }
      ctx.nesting--;
      return true;
    }

    case 'conditional_expression': {
      // Cyclomatic: +1
      ctx.cyclomatic++;
      // Cognitive: +1 + nesting (ternary doesn't increase nesting for branches)
      ctx.hybrid += 1 + ctx.nesting;
      return false; // Let default recursion handle children
    }

    case 'catch_clause': {
      // Cyclomatic: +1
      ctx.cyclomatic++;
      // Cognitive: +1 + nesting
      ctx.hybrid += 1 + ctx.nesting;
      ctx.nesting++;
      ctx.maxNesting = Math.max(ctx.maxNesting, ctx.nesting);

      // Process children, then decrement nesting
      for (const child of node.namedChildren) {
        visitNode(child, ctx, lang, false);
      }
      ctx.nesting--;
      return true;
    }

    case 'binary_expression': {
      processLogicalOperator(node, ctx);
      return false; // Let default recursion handle children
    }

    case 'call_expression': {
      checkRecursionJsTs(node, ctx);
      return false; // Let default recursion handle children
    }
  }

  return false; // Not handled, caller should recurse
}

/**
 * Check for recursion in JS/TS call expression.
 */
function checkRecursionJsTs(node: Node, ctx: FunctionContext): void {
  if (ctx.hasRecursion) return;

  const callee = node.childForFieldName('function');
  if (!callee) return;

  // Direct call: foo()
  if (callee.type === 'identifier' && callee.text === ctx.name) {
    ctx.hasRecursion = true;
    ctx.hybrid += 1;
    return;
  }

  // this.foo() or super.foo()
  if (callee.type === 'member_expression') {
    const obj = callee.childForFieldName('object');
    const prop = callee.childForFieldName('property');
    if (prop && prop.text === ctx.name) {
      if (obj && (obj.type === 'this' || obj.text === 'this' || obj.text === 'super')) {
        ctx.hasRecursion = true;
        ctx.hybrid += 1;
      }
    }
  }
}

/**
 * Process Java node types.
 * @returns true if children were handled (caller should not recurse)
 */
function processJavaNode(
  type: string,
  node: Node,
  ctx: FunctionContext,
  lang: TreeSitterLanguageId,
  fromElseIf: boolean
): boolean {
  switch (type) {
    case 'if_statement': {
      // If coming from else-if, don't add complexity again
      if (!fromElseIf) {
        // Cyclomatic: +1 for if
        ctx.cyclomatic++;
        // Cognitive: +1 + nesting
        ctx.hybrid += 1 + ctx.nesting;
      }

      ctx.nesting++;
      ctx.maxNesting = Math.max(ctx.maxNesting, ctx.nesting);

      // Process consequence (the "then" block)
      const consequence = node.childForFieldName('consequence');
      if (consequence) {
        visitNode(consequence, ctx, lang, false);
      }

      // Handle else/else-if via alternative field
      const alternative = node.childForFieldName('alternative');
      if (alternative) {
        ctx.nesting--; // Exit if block nesting before else

        if (alternative.type === 'if_statement') {
          // else-if: +1 for cyclomatic and cognitive (no nesting penalty)
          ctx.cyclomatic++;
          ctx.hybrid += 1;
          // Process the else-if, marking it as from else-if to avoid double counting
          visitNode(alternative, ctx, lang, true);
        } else {
          // plain else: +1 cognitive only
          ctx.hybrid += 1;
          ctx.nesting++;
          ctx.maxNesting = Math.max(ctx.maxNesting, ctx.nesting);
          visitNode(alternative, ctx, lang, false);
          ctx.nesting--;
        }
      } else {
        ctx.nesting--;
      }

      return true; // Children handled
    }

    case 'switch_expression':
    case 'switch_statement': {
      ctx.cyclomatic++;
      ctx.hybrid += 1 + ctx.nesting;
      ctx.nesting++;
      ctx.maxNesting = Math.max(ctx.maxNesting, ctx.nesting);

      for (const child of node.namedChildren) {
        visitNode(child, ctx, lang, false);
      }
      ctx.nesting--;
      return true;
    }

    case 'switch_block_statement_group': {
      // Each case label adds to cyclomatic
      const labels = node.descendantsOfType('switch_label');
      for (const label of labels) {
        if (!label.text.startsWith('default')) {
          ctx.cyclomatic++;
        }
      }
      return false; // Let default recursion handle children
    }

    case 'for_statement':
    case 'enhanced_for_statement':
    case 'while_statement':
    case 'do_statement': {
      ctx.cyclomatic++;
      ctx.hybrid += 1 + ctx.nesting;
      ctx.nesting++;
      ctx.maxNesting = Math.max(ctx.maxNesting, ctx.nesting);

      for (const child of node.namedChildren) {
        visitNode(child, ctx, lang, false);
      }
      ctx.nesting--;
      return true;
    }

    case 'ternary_expression': {
      ctx.cyclomatic++;
      ctx.hybrid += 1 + ctx.nesting;
      return false; // Let default recursion handle children
    }

    case 'catch_clause': {
      ctx.cyclomatic++;
      ctx.hybrid += 1 + ctx.nesting;
      ctx.nesting++;
      ctx.maxNesting = Math.max(ctx.maxNesting, ctx.nesting);

      for (const child of node.namedChildren) {
        visitNode(child, ctx, lang, false);
      }
      ctx.nesting--;
      return true;
    }

    case 'binary_expression': {
      processLogicalOperator(node, ctx);
      return false; // Let default recursion handle children
    }

    case 'method_invocation': {
      checkRecursionJava(node, ctx);
      return false; // Let default recursion handle children
    }
  }

  return false; // Not handled, caller should recurse
}

/**
 * Check for recursion in Java method invocation.
 */
function checkRecursionJava(node: Node, ctx: FunctionContext): void {
  if (ctx.hasRecursion) return;

  const methodName = node.childForFieldName('name');
  if (!methodName || methodName.text !== ctx.name) return;

  const obj = node.childForFieldName('object');
  // Direct call (no object), this.foo(), or super.foo()
  if (!obj || obj.text === 'this' || obj.text === 'super') {
    ctx.hasRecursion = true;
    ctx.hybrid += 1;
  }
}

/**
 * Process else clause (JS/TS).
 */
function processElseClause(node: Node, ctx: FunctionContext, lang: TreeSitterLanguageId): void {
  // Check if this is else-if
  const ifChild = node.namedChildren.find((c) => c.type === 'if_statement');

  if (ifChild) {
    // else-if: +1 for cyclomatic and cognitive (no nesting penalty)
    ctx.cyclomatic++;
    ctx.hybrid += 1;

    // Process the inner if_statement, marking as from else-if to avoid double counting
    visitNode(ifChild, ctx, lang, true);
  } else {
    // plain else: +1 for cognitive only (no nesting penalty)
    ctx.hybrid += 1;

    // Enter else block with nesting
    ctx.nesting++;
    ctx.maxNesting = Math.max(ctx.maxNesting, ctx.nesting);

    for (const child of node.namedChildren) {
      visitNode(child, ctx, lang, false);
    }

    ctx.nesting--;
  }
}

/**
 * Process logical operators (&&, ||) with chain scoring.
 *
 * Scoring: same-type operator chain gets +1 at start, type switch adds +1
 * Logical operators contribute to fundamental complexity (not hybrid)
 */
function processLogicalOperator(node: Node, ctx: FunctionContext): void {
  const operator = node.childForFieldName('operator');
  if (!operator) return;

  const op = operator.text;
  if (op !== '&&' && op !== '||') return;

  const currentOp = op as '&&' | '||';

  // Cyclomatic: each logical operator adds +1
  ctx.cyclomatic++;

  // Chain scoring based on parent operator (ignoring parentheses):
  // - If parent isn't a logical binary, this is a new chain (+1)
  // - If parent is logical but a different operator, this is a switch (+1)
  const parentOp = getLogicalParentOperator(node);
  const parentIsLogical = parentOp === '&&' || parentOp === '||';

  if (!parentIsLogical || parentOp !== currentOp) {
    ctx.fundamental += 1;
  }
}

