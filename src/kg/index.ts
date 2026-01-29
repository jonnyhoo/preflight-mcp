/**
 * Knowledge Graph module for code analysis.
 * @module kg
 */

// Types
export type {
  AstNodeKind,
  AstEdgeRelation,
  AstGraphNode,
  AstGraphEdge,
  AstGraph,
  AstGraphBuildOptions,
  AstGraphBuildResult,
} from './types.js';

export { DEFAULT_AST_GRAPH_OPTIONS } from './types.js';

// Builder
export { buildAstGraph } from './ast-graph-builder.js';

// Code Filter
export type { CodeFilterOptions } from './code-filter.js';
export {
  DEFAULT_CODE_FILTER_OPTIONS,
  shouldIndexFile,
  shouldIndexFunction,
  calculateImportance,
  truncateContent,
  sortByImportance,
  applyQuota,
} from './code-filter.js';

// Storage
export { KGStorage } from './storage.js';
