/**
 * Knowledge Graph Types for code analysis.
 * Based on Reliable Graph-RAG paper (arXiv 2601.08773).
 * 
 * @module kg/types
 */

// ============================================================================
// AST Graph Types
// ============================================================================

export type AstNodeKind = 'class' | 'interface' | 'enum' | 'function' | 'type';

export type AstEdgeRelation = 'extends' | 'implements' | 'injects';

export interface AstGraphNode {
  name: string;
  kind: AstNodeKind;
  filePath: string;
  /** Start line in source file */
  startLine?: number;
  /** Brief description extracted from comments */
  description?: string;
}

export interface AstGraphEdge {
  src: string;       // Source type name
  tgt: string;       // Target type name
  relation: AstEdgeRelation;
  srcFile: string;   // Source file path
}

export interface AstGraph {
  nodes: Map<string, AstGraphNode>;
  edges: AstGraphEdge[];
}

// ============================================================================
// Build Options
// ============================================================================

export interface AstGraphBuildOptions {
  /** File patterns to include */
  includePatterns?: string[];
  /** File patterns to exclude */
  excludePatterns?: string[];
  /** Max files to process (for large repos) */
  maxFiles?: number;
}

export const DEFAULT_AST_GRAPH_OPTIONS: AstGraphBuildOptions = {
  excludePatterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/*.test.*',
    '**/*.spec.*',
    '**/__tests__/**',
  ],
  maxFiles: 1000,
};

// ============================================================================
// Build Result
// ============================================================================

export interface AstGraphBuildResult {
  graph: AstGraph;
  stats: {
    filesProcessed: number;
    nodesCount: number;
    edgesCount: number;
    durationMs: number;
  };
  errors: string[];
}

// ============================================================================
// Storage Types (for ChromaDB)
// ============================================================================

export interface KGEntity {
  id: string;
  name: string;
  kind: AstNodeKind;
  filePath: string;
  description: string;
}

export interface KGRelation {
  id: string;
  srcEntity: string;
  tgtEntity: string;
  relationType: AstEdgeRelation;
  srcFile: string;
}
