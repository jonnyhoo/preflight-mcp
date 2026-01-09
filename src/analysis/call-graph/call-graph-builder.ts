/**
 * Call Graph Builder
 *
 * Builds a complete call graph by traversing from entry points
 * using language-specific adapters.
 *
 * @module analysis/call-graph/call-graph-builder
 */

import * as path from 'path';
import * as fs from 'fs';
import {
  CallGraph,
  CallGraphAdapter,
  CallGraphBuildOptions,
  CallGraphEdge,
  CallGraphNode,
  CallGraphQuery,
  CallGraphQueryResult,
  CallHierarchyItem,
  CallPath,
  BuildProgress,
  createEmptyCallGraph,
  createNodeId,
} from './types.js';

// ============================================================================
// Call Graph Builder
// ============================================================================

export class CallGraphBuilder {
  private adapters: Map<string, CallGraphAdapter> = new Map();
  private graph: CallGraph = createEmptyCallGraph();
  private visitedNodes: Set<string> = new Set();
  private rootPath: string = '';

  /**
   * Register a language adapter.
   */
  registerAdapter(adapter: CallGraphAdapter): void {
    this.adapters.set(adapter.language, adapter);
  }

  /**
   * Get adapter for a file.
   */
  private getAdapterForFile(filePath: string): CallGraphAdapter | undefined {
    for (const adapter of this.adapters.values()) {
      if (adapter.supportsFile(filePath)) {
        return adapter;
      }
    }
    return undefined;
  }

  /**
   * Build a call graph from entry points.
   */
  async build(options: CallGraphBuildOptions): Promise<CallGraph> {
    const startTime = Date.now();
    this.graph = createEmptyCallGraph();
    this.visitedNodes.clear();

    // Determine root path from entries
    if (options.entries.length > 0) {
      const firstEntry = options.entries[0]!;
      if (fs.existsSync(firstEntry) && fs.statSync(firstEntry).isDirectory()) {
        this.rootPath = firstEntry;
      } else {
        this.rootPath = path.dirname(firstEntry);
      }
    }

    // Initialize adapters
    for (const adapter of this.adapters.values()) {
      await adapter.initialize(this.rootPath);
    }

    try {
      const maxDepth = options.maxDepth ?? 10;
      const filesAnalyzed = new Set<string>();
      let totalSymbols = 0;
      let totalEdges = 0;

      // Process each entry
      for (const entry of options.entries) {
        this.reportProgress(options.onProgress, {
          phase: 'scanning',
          filesProcessed: filesAnalyzed.size,
          currentFile: entry,
          symbolsDiscovered: totalSymbols,
          edgesDiscovered: totalEdges,
        });

        // Entry can be a file path or a "file:line:col" reference
        const { filePath, line, column } = this.parseEntry(entry);
        
        if (!filePath) continue;

        const adapter = this.getAdapterForFile(filePath);
        if (!adapter) continue;

        filesAnalyzed.add(filePath);

        if (line !== undefined && column !== undefined) {
          // Start from specific symbol
          const item = await adapter.prepareCallHierarchy(filePath, line, column);
          if (item) {
            await this.traverseCallHierarchy(
              adapter,
              item,
              maxDepth,
              'both',
              options,
              filesAnalyzed
            );
          }
        } else {
          // Start from all symbols in file
          const symbols = await adapter.getFileSymbols(filePath);
          for (const symbol of symbols) {
            this.addNode(symbol);
            totalSymbols++;
            
            // Mark exported symbols as entry points
            if (symbol.isExported) {
              if (!this.graph.entryPoints.includes(symbol.id)) {
                this.graph.entryPoints.push(symbol.id);
              }
            }

            // Traverse outgoing calls
            const item = await adapter.prepareCallHierarchy(
              symbol.location.filePath,
              symbol.location.line,
              symbol.location.column
            );

            if (item) {
              await this.traverseCallHierarchy(
                adapter,
                item,
                maxDepth,
                'callees',
                options,
                filesAnalyzed
              );
            }
          }
        }

        this.reportProgress(options.onProgress, {
          phase: 'analyzing',
          filesProcessed: filesAnalyzed.size,
          currentFile: filePath,
          symbolsDiscovered: this.graph.nodes.size,
          edgesDiscovered: this.countEdges(),
        });
      }

      // Update metadata
      this.graph.metadata = {
        buildTime: new Date(),
        buildDurationMs: Date.now() - startTime,
        nodeCount: this.graph.nodes.size,
        edgeCount: this.countEdges(),
        filesAnalyzed: filesAnalyzed.size,
      };

      this.reportProgress(options.onProgress, {
        phase: 'complete',
        filesProcessed: filesAnalyzed.size,
        symbolsDiscovered: this.graph.nodes.size,
        edgesDiscovered: this.countEdges(),
      });

      return this.graph;
    } finally {
      // Shutdown adapters
      for (const adapter of this.adapters.values()) {
        await adapter.shutdown();
      }
    }
  }

  /**
   * Query the call graph.
   */
  async query(
    graph: CallGraph,
    query: CallGraphQuery
  ): Promise<CallGraphQueryResult> {
    const startTime = Date.now();
    
    // Find root node
    let rootNode: CallGraphNode | undefined;
    
    // Try to find by ID
    rootNode = graph.nodes.get(query.entry);
    
    // Try to find by qualified name
    if (!rootNode) {
      for (const node of graph.nodes.values()) {
        if (node.qualifiedName === query.entry || node.name === query.entry) {
          rootNode = node;
          break;
        }
      }
    }

    if (!rootNode) {
      throw new Error(`Symbol not found: ${query.entry}`);
    }

    // Build subgraph
    const subgraph = createEmptyCallGraph();
    const visited = new Set<string>();
    const paths: CallPath[] = [];
    const maxDepth = query.maxDepth ?? 5;

    const traverse = (
      nodeId: string,
      currentPath: string[],
      depth: number
    ) => {
      if (depth > maxDepth || visited.has(nodeId)) return;
      visited.add(nodeId);

      const node = graph.nodes.get(nodeId);
      if (!node) return;

      // Apply filters
      if (query.includePatterns && query.includePatterns.length > 0) {
        const matches = query.includePatterns.some((p) =>
          node.location.filePath.includes(p)
        );
        if (!matches) return;
      }

      if (query.excludePatterns && query.excludePatterns.length > 0) {
        const excluded = query.excludePatterns.some((p) =>
          node.location.filePath.includes(p)
        );
        if (excluded) return;
      }

      // Add node to subgraph
      subgraph.nodes.set(nodeId, node);
      const newPath = [...currentPath, nodeId];
      paths.push({ nodeIds: newPath, depth: newPath.length - 1 });

      // Traverse edges based on direction
      if (query.direction === 'callees' || query.direction === 'both') {
        const outgoing = graph.outgoingEdges.get(nodeId) || [];
        for (const edge of outgoing) {
          // Add edge to subgraph
          const existing = subgraph.outgoingEdges.get(nodeId) || [];
          existing.push(edge);
          subgraph.outgoingEdges.set(nodeId, existing);

          const incoming = subgraph.incomingEdges.get(edge.calleeId) || [];
          incoming.push(edge);
          subgraph.incomingEdges.set(edge.calleeId, incoming);

          traverse(edge.calleeId, newPath, depth + 1);
        }
      }

      if (query.direction === 'callers' || query.direction === 'both') {
        const incoming = graph.incomingEdges.get(nodeId) || [];
        for (const edge of incoming) {
          // Add edge to subgraph
          const existing = subgraph.incomingEdges.get(nodeId) || [];
          existing.push(edge);
          subgraph.incomingEdges.set(nodeId, existing);

          const outgoing = subgraph.outgoingEdges.get(edge.callerId) || [];
          outgoing.push(edge);
          subgraph.outgoingEdges.set(edge.callerId, outgoing);

          traverse(edge.callerId, newPath, depth + 1);
        }
      }
    };

    traverse(rootNode.id, [], 0);
    subgraph.entryPoints = [rootNode.id];

    return {
      root: rootNode,
      subgraph,
      paths,
      queryTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Extract minimal dependency set for a symbol.
   */
  extractDependencies(
    graph: CallGraph,
    symbolId: string,
    includeTransitive: boolean = true
  ): { nodes: CallGraphNode[]; files: string[] } {
    const visited = new Set<string>();
    const nodes: CallGraphNode[] = [];
    const files = new Set<string>();

    const traverse = (nodeId: string) => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);

      const node = graph.nodes.get(nodeId);
      if (!node) return;

      nodes.push(node);
      files.add(node.location.filePath);

      if (includeTransitive) {
        const outgoing = graph.outgoingEdges.get(nodeId) || [];
        for (const edge of outgoing) {
          traverse(edge.calleeId);
        }
      }
    };

    traverse(symbolId);

    return {
      nodes,
      files: Array.from(files),
    };
  }

  /**
   * Generate interface summary for symbols.
   */
  generateInterfaceSummary(graph: CallGraph): string {
    const lines: string[] = ['# Interface Summary\n'];

    // Group by file
    const fileMap = new Map<string, CallGraphNode[]>();
    for (const node of graph.nodes.values()) {
      if (!node.isExported) continue;
      const nodes = fileMap.get(node.location.filePath) || [];
      nodes.push(node);
      fileMap.set(node.location.filePath, nodes);
    }

    for (const [filePath, nodes] of fileMap) {
      lines.push(`## ${path.basename(filePath)}\n`);

      for (const node of nodes) {
        const kindIcon = this.getKindIcon(node.kind);
        lines.push(`### ${kindIcon} ${node.qualifiedName}`);
        
        if (node.signature) {
          lines.push(`\`\`\`typescript`);
          lines.push(node.signature);
          lines.push(`\`\`\``);
        }

        if (node.documentation) {
          lines.push(`\n${node.documentation}`);
        }

        // Add call information
        const outgoing = graph.outgoingEdges.get(node.id) || [];
        const incoming = graph.incomingEdges.get(node.id) || [];

        if (outgoing.length > 0) {
          const callees = outgoing
            .map((e) => graph.nodes.get(e.calleeId)?.name)
            .filter(Boolean)
            .slice(0, 5);
          lines.push(`\n**Calls:** ${callees.join(', ')}${outgoing.length > 5 ? '...' : ''}`);
        }

        if (incoming.length > 0) {
          lines.push(`**Called by:** ${incoming.length} function(s)`);
        }

        lines.push('');
      }
    }

    return lines.join('\n');
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Parse entry string (file path or file:line:col).
   */
  private parseEntry(entry: string): {
    filePath: string | undefined;
    line: number | undefined;
    column: number | undefined;
  } {
    // Try file:line:col format
    const match = entry.match(/^(.+):(\d+):(\d+)$/);
    if (match && match[1] && match[2] && match[3]) {
      return {
        filePath: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
      };
    }

    // Just a file path
    if (fs.existsSync(entry)) {
      return { filePath: entry, line: undefined, column: undefined };
    }

    return { filePath: undefined, line: undefined, column: undefined };
  }

  /**
   * Traverse call hierarchy and build graph.
   */
  private async traverseCallHierarchy(
    adapter: CallGraphAdapter,
    item: CallHierarchyItem,
    maxDepth: number,
    direction: 'callers' | 'callees' | 'both',
    options: CallGraphBuildOptions,
    filesAnalyzed: Set<string>
  ): Promise<void> {
    const nodeId = createNodeId(
      item.location.filePath,
      item.selectionLocation.line,
      item.selectionLocation.column,
      item.name
    );

    if (this.visitedNodes.has(nodeId)) return;
    this.visitedNodes.add(nodeId);

    // Check depth
    const currentDepth = this.getNodeDepth(nodeId);
    if (currentDepth > maxDepth) return;

    // Add node
    const node: CallGraphNode = {
      id: nodeId,
      name: item.name,
      qualifiedName: item.detail ? `${item.detail}.${item.name}` : item.name,
      kind: item.kind,
      location: item.location,
      language: adapter.language,
    };
    this.addNode(node);
    filesAnalyzed.add(item.location.filePath);

    // Traverse outgoing calls
    if (direction === 'callees' || direction === 'both') {
      const outgoing = await adapter.getOutgoingCalls(item);
      
      for (const call of outgoing) {
        const calleeId = createNodeId(
          call.to.location.filePath,
          call.to.selectionLocation.line,
          call.to.selectionLocation.column,
          call.to.name
        );

        // Add callee node
        const calleeNode: CallGraphNode = {
          id: calleeId,
          name: call.to.name,
          qualifiedName: call.to.detail
            ? `${call.to.detail}.${call.to.name}`
            : call.to.name,
          kind: call.to.kind,
          location: call.to.location,
          language: adapter.language,
        };
        this.addNode(calleeNode);

        // Add edges
        for (const callSite of call.fromRanges) {
          this.addEdge({
            callerId: nodeId,
            calleeId,
            callSite,
          });
        }

        // Recurse
        if (currentDepth + 1 < maxDepth) {
          await this.traverseCallHierarchy(
            adapter,
            call.to,
            maxDepth,
            'callees',
            options,
            filesAnalyzed
          );
        }
      }
    }

    // Traverse incoming calls
    if (direction === 'callers' || direction === 'both') {
      const incoming = await adapter.getIncomingCalls(item);

      for (const call of incoming) {
        const callerId = createNodeId(
          call.from.location.filePath,
          call.from.selectionLocation.line,
          call.from.selectionLocation.column,
          call.from.name
        );

        // Add caller node
        const callerNode: CallGraphNode = {
          id: callerId,
          name: call.from.name,
          qualifiedName: call.from.detail
            ? `${call.from.detail}.${call.from.name}`
            : call.from.name,
          kind: call.from.kind,
          location: call.from.location,
          language: adapter.language,
        };
        this.addNode(callerNode);

        // Add edges
        for (const callSite of call.fromRanges) {
          this.addEdge({
            callerId,
            calleeId: nodeId,
            callSite,
          });
        }

        // Recurse
        if (currentDepth + 1 < maxDepth) {
          await this.traverseCallHierarchy(
            adapter,
            call.from,
            maxDepth,
            'callers',
            options,
            filesAnalyzed
          );
        }
      }
    }
  }

  /**
   * Add a node to the graph.
   */
  private addNode(node: CallGraphNode): void {
    if (!this.graph.nodes.has(node.id)) {
      this.graph.nodes.set(node.id, node);
    }
  }

  /**
   * Add an edge to the graph.
   */
  private addEdge(edge: CallGraphEdge): void {
    // Add to outgoing edges
    const outgoing = this.graph.outgoingEdges.get(edge.callerId) || [];
    const existingOutgoing = outgoing.find(
      (e) =>
        e.calleeId === edge.calleeId &&
        e.callSite.line === edge.callSite.line &&
        e.callSite.column === edge.callSite.column
    );
    if (!existingOutgoing) {
      outgoing.push(edge);
      this.graph.outgoingEdges.set(edge.callerId, outgoing);
    }

    // Add to incoming edges
    const incoming = this.graph.incomingEdges.get(edge.calleeId) || [];
    const existingIncoming = incoming.find(
      (e) =>
        e.callerId === edge.callerId &&
        e.callSite.line === edge.callSite.line &&
        e.callSite.column === edge.callSite.column
    );
    if (!existingIncoming) {
      incoming.push(edge);
      this.graph.incomingEdges.set(edge.calleeId, incoming);
    }
  }

  /**
   * Get depth of a node from entry points.
   */
  private getNodeDepth(nodeId: string): number {
    // Simple BFS from entry points
    if (this.graph.entryPoints.includes(nodeId)) return 0;

    const visited = new Set<string>();
    const queue: { id: string; depth: number }[] = this.graph.entryPoints.map(
      (id) => ({ id, depth: 0 })
    );

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (id === nodeId) return depth;
      if (visited.has(id)) continue;
      visited.add(id);

      const edges = this.graph.outgoingEdges.get(id) || [];
      for (const edge of edges) {
        queue.push({ id: edge.calleeId, depth: depth + 1 });
      }
    }

    return 0;
  }

  /**
   * Count total edges in graph.
   */
  private countEdges(): number {
    let count = 0;
    for (const edges of this.graph.outgoingEdges.values()) {
      count += edges.length;
    }
    return count;
  }

  /**
   * Report progress.
   */
  private reportProgress(
    callback: ((progress: BuildProgress) => void) | undefined,
    progress: BuildProgress
  ): void {
    if (callback) {
      callback(progress);
    }
  }

  /**
   * Get icon for symbol kind.
   */
  private getKindIcon(kind: string): string {
    switch (kind) {
      case 'function':
        return 'ƒ';
      case 'method':
        return '⚙';
      case 'constructor':
        return '🔨';
      case 'class':
        return '📦';
      case 'interface':
        return '📋';
      case 'getter':
        return '⬇';
      case 'setter':
        return '⬆';
      default:
        return '•';
    }
  }
}

// Export factory function
export function createCallGraphBuilder(): CallGraphBuilder {
  return new CallGraphBuilder();
}
