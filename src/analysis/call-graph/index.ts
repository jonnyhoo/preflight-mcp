/**
 * Call Graph Analysis Module
 *
 * Provides function-level call graph analysis for code understanding,
 * extraction, and interface documentation.
 *
 * @module analysis/call-graph
 *
 * @example
 * ```typescript
 * import {
 *   createCallGraphBuilder,
 *   createTypeScriptAdapter,
 *   serializeCallGraph,
 * } from './call-graph';
 *
 * // Build a call graph
 * const builder = createCallGraphBuilder();
 * builder.registerAdapter(createTypeScriptAdapter());
 *
 * const graph = await builder.build({
 *   entries: ['./src/index.ts'],
 *   maxDepth: 5,
 * });
 *
 * // Query the graph
 * const result = await builder.query(graph, {
 *   entry: 'processData',
 *   direction: 'both',
 *   maxDepth: 3,
 * });
 *
 * // Extract dependencies
 * const deps = builder.extractDependencies(graph, result.root.id);
 *
 * // Generate interface summary
 * const summary = builder.generateInterfaceSummary(graph);
 *
 * // Serialize for storage
 * const serialized = serializeCallGraph(graph);
 * ```
 */

// Types
export type {
  // Core types
  CallGraphLanguage,
  SymbolKind,
  SourceLocation,
  CallGraphNode,
  CallGraphEdge,
  CallGraph,
  CallGraphMetadata,

  // Query types
  TraversalDirection,
  CallGraphQuery,
  CallGraphQueryResult,
  CallPath,

  // Adapter types
  SymbolReference,
  SymbolDefinition,
  CallHierarchyItem,
  IncomingCall,
  OutgoingCall,
  CallGraphAdapter,

  // Builder types
  CallGraphBuildOptions,
  BuildProgress,

  // Serialization types
  SerializedCallGraph,
  SerializedNode,
  SerializedEdge,
} from './types.js';

export {
  // Utility functions
  createNodeId,
  parseNodeId,
  createEmptyCallGraph,
  serializeCallGraph,
  deserializeCallGraph,
} from './types.js';

// Builder
export {
  CallGraphBuilder,
  createCallGraphBuilder,
} from './call-graph-builder.js';

// Adapters
export {
  TypeScriptAdapter,
  createTypeScriptAdapter,
} from './adapters/typescript-adapter.js';

export {
  PythonAdapter,
  createPythonAdapter,
} from './adapters/python-adapter.js';

export {
  GoAdapter,
  createGoAdapter,
} from './adapters/go-adapter.js';

export {
  RustAdapter,
  createRustAdapter,
} from './adapters/rust-adapter.js';
