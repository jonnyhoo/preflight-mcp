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
  KGEntity,
  KGRelation,
} from './types.js';

export { DEFAULT_AST_GRAPH_OPTIONS } from './types.js';

// Builder
export { buildAstGraph } from './ast-graph-builder.js';

// Storage
export { KGStorage, astGraphToEntities, astGraphToRelations } from './storage.js';
