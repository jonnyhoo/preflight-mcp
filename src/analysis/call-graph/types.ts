/**
 * Call Graph Types
 *
 * Type definitions for function-level call graph analysis.
 * Supports multi-language analysis through LSP adapters.
 *
 * @module analysis/call-graph/types
 */

// ============================================================================
// Core Types
// ============================================================================

/**
 * Supported languages for call graph analysis.
 */
export type CallGraphLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust';

/**
 * Kind of symbol in the call graph.
 */
export type SymbolKind =
  | 'function'
  | 'method'
  | 'constructor'
  | 'getter'
  | 'setter'
  | 'class'
  | 'interface'
  | 'module'
  | 'enum';

/**
 * Location in source code.
 */
export interface SourceLocation {
  /** Absolute file path */
  filePath: string;
  /** 1-indexed line number */
  line: number;
  /** 1-indexed column number */
  column: number;
  /** End line (optional) */
  endLine?: number;
  /** End column (optional) */
  endColumn?: number;
}

/**
 * A node in the call graph representing a function/method.
 */
export interface CallGraphNode {
  /** Unique identifier: "filePath:line:column:name" */
  id: string;
  /** Symbol name */
  name: string;
  /** Fully qualified name (e.g., "ClassName.methodName") */
  qualifiedName: string;
  /** Kind of symbol */
  kind: SymbolKind;
  /** Source location */
  location: SourceLocation;
  /** Function signature (if available) */
  signature?: string;
  /** JSDoc/docstring (if available) */
  documentation?: string;
  /** Exported from module */
  isExported?: boolean;
  /** Is async function */
  isAsync?: boolean;
  /** Language */
  language: CallGraphLanguage;
}

/**
 * An edge in the call graph representing a call relationship.
 */
export interface CallGraphEdge {
  /** Caller node ID */
  callerId: string;
  /** Callee node ID */
  calleeId: string;
  /** Call site location */
  callSite: SourceLocation;
  /** Is dynamic call (e.g., callback, computed property) */
  isDynamic?: boolean;
  /** Is conditional call (inside if/switch/try) */
  isConditional?: boolean;
  /** Call arguments (simplified representation) */
  arguments?: string[];
}

/**
 * Complete call graph structure.
 */
export interface CallGraph {
  /** All nodes in the graph */
  nodes: Map<string, CallGraphNode>;
  /** Outgoing edges: callerId -> [calleeIds] */
  outgoingEdges: Map<string, CallGraphEdge[]>;
  /** Incoming edges: calleeId -> [callerIds] */
  incomingEdges: Map<string, CallGraphEdge[]>;
  /** Root entry points */
  entryPoints: string[];
  /** Metadata */
  metadata: CallGraphMetadata;
}

/**
 * Call graph metadata.
 */
export interface CallGraphMetadata {
  /** When the graph was built */
  buildTime: Date;
  /** Build duration in milliseconds */
  buildDurationMs: number;
  /** Total nodes */
  nodeCount: number;
  /** Total edges */
  edgeCount: number;
  /** Files analyzed */
  filesAnalyzed: number;
  /** Errors encountered */
  errors?: string[];
  /** Warnings */
  warnings?: string[];
}

// ============================================================================
// Query Types
// ============================================================================

/**
 * Direction for call graph traversal.
 */
export type TraversalDirection = 'callers' | 'callees' | 'both';

/**
 * Query options for call graph analysis.
 */
export interface CallGraphQuery {
  /** Starting symbol (file:line:col or qualified name) */
  entry: string;
  /** Traversal direction */
  direction: TraversalDirection;
  /** Maximum depth (default: 5) */
  maxDepth?: number;
  /** Include external dependencies */
  includeExternal?: boolean;
  /** Filter by file patterns */
  includePatterns?: string[];
  /** Exclude file patterns */
  excludePatterns?: string[];
}

/**
 * Result of a call graph query.
 */
export interface CallGraphQueryResult {
  /** Root node */
  root: CallGraphNode;
  /** Subgraph matching the query */
  subgraph: CallGraph;
  /** Paths from root to each node (for visualization) */
  paths: CallPath[];
  /** Query execution time in ms */
  queryTimeMs: number;
}

/**
 * A path in the call graph.
 */
export interface CallPath {
  /** Ordered list of node IDs from start to end */
  nodeIds: string[];
  /** Total depth */
  depth: number;
}

// ============================================================================
// Adapter Types
// ============================================================================

/**
 * Reference information from LSP/Language Service.
 */
export interface SymbolReference {
  /** File path */
  filePath: string;
  /** Location */
  location: SourceLocation;
  /** Is definition (not just reference) */
  isDefinition: boolean;
  /** Is write access */
  isWrite?: boolean;
  /** Container symbol (e.g., containing function) */
  containerName?: string;
}

/**
 * Definition information from LSP/Language Service.
 */
export interface SymbolDefinition {
  /** Symbol name */
  name: string;
  /** Qualified name */
  qualifiedName: string;
  /** Kind */
  kind: SymbolKind;
  /** Location */
  location: SourceLocation;
  /** Signature */
  signature?: string;
  /** Documentation */
  documentation?: string;
}

/**
 * Call hierarchy item (LSP-compatible).
 */
export interface CallHierarchyItem {
  /** Symbol name */
  name: string;
  /** Kind */
  kind: SymbolKind;
  /** Location */
  location: SourceLocation;
  /** Selection range (the symbol itself) */
  selectionLocation: SourceLocation;
  /** Detail (e.g., file path) */
  detail?: string;
}

/**
 * Incoming call (who calls this symbol).
 */
export interface IncomingCall {
  /** The caller */
  from: CallHierarchyItem;
  /** Call sites within the caller */
  fromRanges: SourceLocation[];
}

/**
 * Outgoing call (what this symbol calls).
 */
export interface OutgoingCall {
  /** The callee */
  to: CallHierarchyItem;
  /** Call sites within the caller */
  fromRanges: SourceLocation[];
}

// ============================================================================
// Adapter Interface
// ============================================================================

/**
 * Language adapter interface for call graph analysis.
 * Implementations provide language-specific analysis capabilities.
 */
export interface CallGraphAdapter {
  /** Supported language */
  readonly language: CallGraphLanguage;

  /**
   * Initialize the adapter (e.g., start LSP server).
   * @param rootPath - Project root path
   */
  initialize(rootPath: string): Promise<void>;

  /**
   * Shutdown the adapter (e.g., stop LSP server).
   */
  shutdown(): Promise<void>;

  /**
   * Check if a file is supported by this adapter.
   */
  supportsFile(filePath: string): boolean;

  /**
   * Find all references to a symbol.
   */
  findReferences(
    filePath: string,
    line: number,
    column: number
  ): Promise<SymbolReference[]>;

  /**
   * Get definition of a symbol.
   */
  getDefinition(
    filePath: string,
    line: number,
    column: number
  ): Promise<SymbolDefinition | null>;

  /**
   * Get call hierarchy item at position.
   */
  prepareCallHierarchy(
    filePath: string,
    line: number,
    column: number
  ): Promise<CallHierarchyItem | null>;

  /**
   * Get incoming calls to a symbol.
   */
  getIncomingCalls(item: CallHierarchyItem): Promise<IncomingCall[]>;

  /**
   * Get outgoing calls from a symbol.
   */
  getOutgoingCalls(item: CallHierarchyItem): Promise<OutgoingCall[]>;

  /**
   * Get all callable symbols in a file.
   */
  getFileSymbols(filePath: string): Promise<CallGraphNode[]>;
}

// ============================================================================
// Builder Types
// ============================================================================

/**
 * Options for building a call graph.
 */
export interface CallGraphBuildOptions {
  /** Entry files or symbols */
  entries: string[];
  /** Maximum analysis depth */
  maxDepth?: number;
  /** Include patterns */
  includePatterns?: string[];
  /** Exclude patterns */
  excludePatterns?: string[];
  /** Include external dependencies */
  includeExternal?: boolean;
  /** Progress callback */
  onProgress?: (progress: BuildProgress) => void;
}

/**
 * Build progress information.
 */
export interface BuildProgress {
  /** Current phase */
  phase: 'scanning' | 'analyzing' | 'building' | 'complete';
  /** Files processed */
  filesProcessed: number;
  /** Total files (if known) */
  totalFiles?: number;
  /** Current file being processed */
  currentFile?: string;
  /** Symbols discovered */
  symbolsDiscovered: number;
  /** Edges discovered */
  edgesDiscovered: number;
}

// ============================================================================
// Serialization Types
// ============================================================================

/**
 * Serialized call graph for storage/transfer.
 */
export interface SerializedCallGraph {
  version: '1.0';
  nodes: SerializedNode[];
  edges: SerializedEdge[];
  entryPoints: string[];
  metadata: CallGraphMetadata;
}

export interface SerializedNode {
  id: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  filePath: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  signature?: string;
  documentation?: string;
  isExported?: boolean;
  isAsync?: boolean;
  language: CallGraphLanguage;
}

export interface SerializedEdge {
  callerId: string;
  calleeId: string;
  filePath: string;
  line: number;
  column: number;
  isDynamic?: boolean;
  isConditional?: boolean;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create a node ID from location.
 */
export function createNodeId(
  filePath: string,
  line: number,
  column: number,
  name: string
): string {
  return `${filePath}:${line}:${column}:${name}`;
}

/**
 * Parse a node ID.
 */
export function parseNodeId(id: string): {
  filePath: string;
  line: number;
  column: number;
  name: string;
} | null {
  const match = id.match(/^(.+):(\d+):(\d+):(.+)$/);
  if (!match || !match[1] || !match[2] || !match[3] || !match[4]) return null;
  return {
    filePath: match[1],
    line: parseInt(match[2], 10),
    column: parseInt(match[3], 10),
    name: match[4],
  };
}

/**
 * Create an empty call graph.
 */
export function createEmptyCallGraph(): CallGraph {
  return {
    nodes: new Map(),
    outgoingEdges: new Map(),
    incomingEdges: new Map(),
    entryPoints: [],
    metadata: {
      buildTime: new Date(),
      buildDurationMs: 0,
      nodeCount: 0,
      edgeCount: 0,
      filesAnalyzed: 0,
    },
  };
}

/**
 * Serialize a call graph for storage.
 */
export function serializeCallGraph(graph: CallGraph): SerializedCallGraph {
  const nodes: SerializedNode[] = [];
  const edges: SerializedEdge[] = [];

  for (const node of graph.nodes.values()) {
    nodes.push({
      id: node.id,
      name: node.name,
      qualifiedName: node.qualifiedName,
      kind: node.kind,
      filePath: node.location.filePath,
      line: node.location.line,
      column: node.location.column,
      endLine: node.location.endLine,
      endColumn: node.location.endColumn,
      signature: node.signature,
      documentation: node.documentation,
      isExported: node.isExported,
      isAsync: node.isAsync,
      language: node.language,
    });
  }

  for (const edgeList of graph.outgoingEdges.values()) {
    for (const edge of edgeList) {
      edges.push({
        callerId: edge.callerId,
        calleeId: edge.calleeId,
        filePath: edge.callSite.filePath,
        line: edge.callSite.line,
        column: edge.callSite.column,
        isDynamic: edge.isDynamic,
        isConditional: edge.isConditional,
      });
    }
  }

  return {
    version: '1.0',
    nodes,
    edges,
    entryPoints: graph.entryPoints,
    metadata: graph.metadata,
  };
}

/**
 * Deserialize a call graph from storage.
 */
export function deserializeCallGraph(data: SerializedCallGraph): CallGraph {
  const graph = createEmptyCallGraph();

  for (const node of data.nodes) {
    graph.nodes.set(node.id, {
      id: node.id,
      name: node.name,
      qualifiedName: node.qualifiedName,
      kind: node.kind,
      location: {
        filePath: node.filePath,
        line: node.line,
        column: node.column,
        endLine: node.endLine,
        endColumn: node.endColumn,
      },
      signature: node.signature,
      documentation: node.documentation,
      isExported: node.isExported,
      isAsync: node.isAsync,
      language: node.language,
    });
  }

  for (const edge of data.edges) {
    const outgoing = graph.outgoingEdges.get(edge.callerId) || [];
    const incoming = graph.incomingEdges.get(edge.calleeId) || [];

    const graphEdge: CallGraphEdge = {
      callerId: edge.callerId,
      calleeId: edge.calleeId,
      callSite: {
        filePath: edge.filePath,
        line: edge.line,
        column: edge.column,
      },
      isDynamic: edge.isDynamic,
      isConditional: edge.isConditional,
    };

    outgoing.push(graphEdge);
    incoming.push(graphEdge);

    graph.outgoingEdges.set(edge.callerId, outgoing);
    graph.incomingEdges.set(edge.calleeId, incoming);
  }

  graph.entryPoints = data.entryPoints;
  graph.metadata = data.metadata;

  return graph;
}
