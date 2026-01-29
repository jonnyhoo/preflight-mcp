/**
 * Knowledge Graph Storage - In-memory graph + ChromaDB persistence.
 * 
 * @module kg/storage
 */

import type { AstGraph, AstGraphNode, AstGraphEdge } from './types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('kg-storage');

// ============================================================================
// In-Memory Graph Storage
// ============================================================================

/**
 * In-memory graph for fast traversal.
 */
export class KGStorage {
  private nodes: Map<string, AstGraphNode> = new Map();
  private edges: AstGraphEdge[] = [];
  private outEdges: Map<string, AstGraphEdge[]> = new Map();
  private inEdges: Map<string, AstGraphEdge[]> = new Map();

  /**
   * Load graph from build result.
   */
  loadGraph(graph: AstGraph): void {
    this.nodes = new Map(graph.nodes);
    this.edges = [...graph.edges];
    this.buildEdgeIndex();
    logger.info(`Loaded graph: ${this.nodes.size} nodes, ${this.edges.length} edges`);
  }

  private buildEdgeIndex(): void {
    this.outEdges.clear();
    this.inEdges.clear();

    for (const edge of this.edges) {
      // Outgoing edges (src → tgt)
      if (!this.outEdges.has(edge.src)) {
        this.outEdges.set(edge.src, []);
      }
      this.outEdges.get(edge.src)!.push(edge);

      // Incoming edges (tgt ← src)
      if (!this.inEdges.has(edge.tgt)) {
        this.inEdges.set(edge.tgt, []);
      }
      this.inEdges.get(edge.tgt)!.push(edge);
    }
  }

  // --------------------------------------------------------------------------
  // Node Operations
  // --------------------------------------------------------------------------

  getNode(name: string): AstGraphNode | undefined {
    return this.nodes.get(name);
  }

  getAllNodes(): AstGraphNode[] {
    return Array.from(this.nodes.values());
  }

  hasNode(name: string): boolean {
    return this.nodes.has(name);
  }

  // --------------------------------------------------------------------------
  // Edge Operations
  // --------------------------------------------------------------------------

  getOutEdges(nodeName: string): AstGraphEdge[] {
    return this.outEdges.get(nodeName) ?? [];
  }

  getInEdges(nodeName: string): AstGraphEdge[] {
    return this.inEdges.get(nodeName) ?? [];
  }

  getAllEdges(): AstGraphEdge[] {
    return this.edges;
  }

  // --------------------------------------------------------------------------
  // Graph Traversal
  // --------------------------------------------------------------------------

  /**
   * Get successor nodes (nodes this node depends on).
   * Follows: extends, implements, injects
   */
  getSuccessors(nodeName: string, depth: number = 1): AstGraphNode[] {
    const visited = new Set<string>();
    const result: AstGraphNode[] = [];

    const traverse = (name: string, currentDepth: number) => {
      if (currentDepth > depth || visited.has(name)) return;
      visited.add(name);

      const edges = this.getOutEdges(name);
      for (const edge of edges) {
        if (!visited.has(edge.tgt)) {
          const node = this.nodes.get(edge.tgt);
          if (node) {
            result.push(node);
            traverse(edge.tgt, currentDepth + 1);
          }
        }
      }
    };

    traverse(nodeName, 0);
    return result;
  }

  /**
   * Get predecessor nodes (nodes that depend on this node).
   * Reverse of successors.
   */
  getPredecessors(nodeName: string, depth: number = 1): AstGraphNode[] {
    const visited = new Set<string>();
    const result: AstGraphNode[] = [];

    const traverse = (name: string, currentDepth: number) => {
      if (currentDepth > depth || visited.has(name)) return;
      visited.add(name);

      const edges = this.getInEdges(name);
      for (const edge of edges) {
        if (!visited.has(edge.src)) {
          const node = this.nodes.get(edge.src);
          if (node) {
            result.push(node);
            traverse(edge.src, currentDepth + 1);
          }
        }
      }
    };

    traverse(nodeName, 0);
    return result;
  }

  /**
   * Get neighbors (both successors and predecessors).
   */
  getNeighbors(nodeName: string, depth: number = 1): AstGraphNode[] {
    const successors = this.getSuccessors(nodeName, depth);
    const predecessors = this.getPredecessors(nodeName, depth);
    
    // Deduplicate by name
    const seen = new Set<string>();
    const result: AstGraphNode[] = [];
    
    for (const node of [...successors, ...predecessors]) {
      if (!seen.has(node.name)) {
        seen.add(node.name);
        result.push(node);
      }
    }
    
    return result;
  }

  /**
   * Get all implementors of an interface.
   * (InterfaceConsumerExpand from the paper)
   */
  getImplementors(interfaceName: string): AstGraphNode[] {
    const node = this.nodes.get(interfaceName);
    if (!node || node.kind !== 'interface') {
      return [];
    }

    const implementors: AstGraphNode[] = [];
    const edges = this.getInEdges(interfaceName);
    
    for (const edge of edges) {
      if (edge.relation === 'implements') {
        const implNode = this.nodes.get(edge.src);
        if (implNode) {
          implementors.push(implNode);
        }
      }
    }

    return implementors;
  }

  /**
   * Find all types in a file.
   */
  getTypesByFile(filePath: string): AstGraphNode[] {
    return Array.from(this.nodes.values()).filter(n => n.filePath === filePath);
  }

  // --------------------------------------------------------------------------
  // Serialization (for persistence)
  // --------------------------------------------------------------------------

  /**
   * Serialize graph to JSON string.
   */
  toJSON(): string {
    const data = {
      nodes: Array.from(this.nodes.entries()),
      edges: this.edges,
    };
    return JSON.stringify(data);
  }

  /**
   * Load graph from JSON string.
   */
  static fromJSON(json: string): KGStorage {
    const data = JSON.parse(json);
    const storage = new KGStorage();
    storage.nodes = new Map(data.nodes);
    storage.edges = data.edges;
    storage.buildEdgeIndex();
    return storage;
  }

  /**
   * Get graph stats.
   */
  getStats(): { nodeCount: number; edgeCount: number } {
    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.length,
    };
  }
}

