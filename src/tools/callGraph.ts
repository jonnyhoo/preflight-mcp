/**
 * Call Graph MCP Tools
 *
 * Provides MCP tools for:
 * - Building function-level call graphs
 * - Querying call relationships
 * - Extracting code with dependencies
 * - Generating interface summaries
 *
 * @module tools/callGraph
 */

import * as z from 'zod';
import * as path from 'path';
import * as fs from 'fs';
import {
  createCallGraphBuilder,
  createTypeScriptAdapter,
  createPythonAdapter,
  createGoAdapter,
  createRustAdapter,
  serializeCallGraph,
  deserializeCallGraph,
  type CallGraph,
  type SerializedCallGraph,
  type CallGraphNode,
  type TraversalDirection,
} from '../analysis/call-graph/index.js';
import { logger } from '../logging/logger.js';

// ============================================================================
// Input Schemas
// ============================================================================

export const BuildCallGraphInputSchema = {
  path: z.string().describe('Absolute path to file or directory to analyze.'),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe('Maximum traversal depth for call relationships.'),
  includePatterns: z
    .array(z.string())
    .optional()
    .describe('File path patterns to include (e.g., ["src/**/*.ts"]).'),
  excludePatterns: z
    .array(z.string())
    .optional()
    .describe('File path patterns to exclude (e.g., ["**/*.test.ts"]).'),
};

export const QueryCallGraphInputSchema = {
  path: z.string().describe('Absolute path to the project root.'),
  symbol: z
    .string()
    .describe('Symbol name or qualified name to query (e.g., "processData" or "MyClass.method").'),
  direction: z
    .enum(['callers', 'callees', 'both'])
    .default('both')
    .describe('Query direction: who calls this (callers), what it calls (callees), or both.'),
  maxDepth: z.number().int().min(1).max(10).default(3).describe('Maximum traversal depth.'),
};

export const ExtractCodeInputSchema = {
  path: z.string().describe('Absolute path to the project root.'),
  symbol: z.string().describe('Symbol name or qualified name to extract.'),
  includeTransitive: z
    .boolean()
    .default(true)
    .describe('Include transitive dependencies (functions called by called functions).'),
  format: z
    .enum(['minimal', 'full', 'markdown'])
    .default('markdown')
    .describe('Output format: minimal (signatures only), full (complete code), markdown (documented).'),
};

export const InterfaceSummaryInputSchema = {
  path: z.string().describe('Absolute path to file or directory.'),
  exportedOnly: z.boolean().default(true).describe('Only include exported symbols.'),
};

// ============================================================================
// Tool Descriptions
// ============================================================================

export const buildCallGraphToolDescription = `Build a function-level call graph for a TypeScript/JavaScript project.

The call graph shows which functions call which other functions, enabling:
- Understanding code flow and dependencies
- Impact analysis for changes
- Code extraction with minimal dependencies

Returns metadata about the graph (node/edge counts) and can be queried with preflight_query_call_graph.`;

export const queryCallGraphToolDescription = `Query call relationships for a specific function or method.

Given a symbol name, find:
- **callers**: Functions that call this symbol
- **callees**: Functions that this symbol calls
- **both**: Bidirectional relationships

Useful for understanding:
- Who depends on this function?
- What would break if I change this?
- What does this function need to work?`;

export const extractCodeToolDescription = `Extract a function and its dependencies as a self-contained code unit.

Given a symbol name, extracts:
- The function/method definition
- All functions it calls (direct dependencies)
- Optionally, transitive dependencies

Output formats:
- **minimal**: Function signatures only (for quick overview)
- **full**: Complete source code
- **markdown**: Documented with signatures, JSDoc, and relationships`;

export const interfaceSummaryToolDescription = `Generate an interface summary for a file or project.

Creates a documentation of all exported functions/classes including:
- Function signatures
- JSDoc documentation
- Call relationships (what calls what)

Useful for:
- Quick API overview
- Documentation generation
- Understanding module boundaries`;

// ============================================================================
// Types
// ============================================================================

export type BuildCallGraphInput = z.infer<z.ZodObject<typeof BuildCallGraphInputSchema>>;
export type QueryCallGraphInput = z.infer<z.ZodObject<typeof QueryCallGraphInputSchema>>;
export type ExtractCodeInput = z.infer<z.ZodObject<typeof ExtractCodeInputSchema>>;
export type InterfaceSummaryInput = z.infer<z.ZodObject<typeof InterfaceSummaryInputSchema>>;

// Cache for built graphs (simple in-memory cache)
const graphCache = new Map<string, { graph: CallGraph; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// Handlers
// ============================================================================

/**
 * Detect project language(s) based on file extensions.
 */
function detectLanguages(rootPath: string): Set<'typescript' | 'python' | 'go' | 'rust'> {
  const languages = new Set<'typescript' | 'python' | 'go' | 'rust'>();
  const stat = fs.statSync(rootPath);

  if (stat.isDirectory()) {
    const walk = (dir: string, depth: number = 0) => {
      if (depth > 3) return; // Limit depth for detection
      try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          if (item.isDirectory()) {
            if (!item.name.startsWith('.') && item.name !== 'node_modules' && item.name !== 'dist' && item.name !== '__pycache__' && item.name !== 'venv' && item.name !== 'vendor' && item.name !== 'target') {
              walk(path.join(dir, item.name), depth + 1);
            }
          } else {
            if (/\.(ts|tsx|js|jsx)$/.test(item.name)) {
              languages.add('typescript');
            } else if (/\.py$/.test(item.name)) {
              languages.add('python');
            } else if (/\.go$/.test(item.name)) {
              languages.add('go');
            } else if (/\.rs$/.test(item.name)) {
              languages.add('rust');
            }
          }
        }
      } catch {
        // Ignore permission errors
      }
    };
    walk(rootPath);
  } else {
    const ext = path.extname(rootPath).toLowerCase();
    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
      languages.add('typescript');
    } else if (ext === '.py') {
      languages.add('python');
    } else if (ext === '.go') {
      languages.add('go');
    } else if (ext === '.rs') {
      languages.add('rust');
    }
  }

  return languages;
}

async function getOrBuildGraph(
  rootPath: string,
  maxDepth: number = 5
): Promise<CallGraph> {
  const cacheKey = rootPath;
  const cached = graphCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    logger.debug(`Using cached call graph for ${rootPath}`);
    return cached.graph;
  }

  logger.info(`Building call graph for ${rootPath}`);
  const builder = createCallGraphBuilder();

  // Detect languages and register appropriate adapters
  const languages = detectLanguages(rootPath);
  if (languages.has('typescript')) {
    builder.registerAdapter(createTypeScriptAdapter());
  }
  if (languages.has('python')) {
    builder.registerAdapter(createPythonAdapter());
  }
  if (languages.has('go')) {
    builder.registerAdapter(createGoAdapter());
  }
  if (languages.has('rust')) {
    builder.registerAdapter(createRustAdapter());
  }

  // If no languages detected, default to TypeScript
  if (languages.size === 0) {
    builder.registerAdapter(createTypeScriptAdapter());
  }

  logger.info(`Detected languages: ${Array.from(languages).join(', ') || 'typescript (default)'}`);

  // Find entry files
  const entries: string[] = [];
  const stat = fs.statSync(rootPath);

  if (stat.isDirectory()) {
    // Find all supported files in directory
    const walk = (dir: string) => {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          if (!item.name.startsWith('.') && item.name !== 'node_modules' && item.name !== 'dist' && item.name !== '__pycache__' && item.name !== 'venv' && item.name !== '.venv' && item.name !== 'vendor' && item.name !== 'target') {
            walk(fullPath);
          }
        } else {
          const ext = path.extname(item.name).toLowerCase();
          const isTest = item.name.includes('.test.') || item.name.includes('.spec.') || item.name.includes('_test.') || item.name.startsWith('test_') || item.name.endsWith('_test.go');
          if (!isTest) {
            if (languages.has('typescript') && ['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
              entries.push(fullPath);
            } else if (languages.has('python') && ext === '.py') {
              entries.push(fullPath);
            } else if (languages.has('go') && ext === '.go') {
              entries.push(fullPath);
            } else if (languages.has('rust') && ext === '.rs') {
              entries.push(fullPath);
            }
          }
        }
      }
    };
    walk(rootPath);
  } else {
    entries.push(rootPath);
  }

  const graph = await builder.build({
    entries,
    maxDepth,
  });

  graphCache.set(cacheKey, { graph, timestamp: Date.now() });
  return graph;
}

export function createBuildCallGraphHandler() {
  return async (input: BuildCallGraphInput) => {
    const startTime = Date.now();

    try {
      // Clear cache to force rebuild
      graphCache.delete(input.path);

      const graph = await getOrBuildGraph(input.path, input.maxDepth);

      // Apply filters if provided
      let filteredNodeCount = graph.metadata.nodeCount;
      if (input.includePatterns || input.excludePatterns) {
        filteredNodeCount = 0;
        for (const node of graph.nodes.values()) {
          let include = true;

          if (input.includePatterns && input.includePatterns.length > 0) {
            include = input.includePatterns.some((p) =>
              node.location.filePath.includes(p.replace(/\*\*/g, '').replace(/\*/g, ''))
            );
          }

          if (include && input.excludePatterns && input.excludePatterns.length > 0) {
            include = !input.excludePatterns.some((p) =>
              node.location.filePath.includes(p.replace(/\*\*/g, '').replace(/\*/g, ''))
            );
          }

          if (include) filteredNodeCount++;
        }
      }

      // Get top-level summary
      const fileSet = new Set<string>();
      const exportedSymbols: string[] = [];
      for (const node of graph.nodes.values()) {
        fileSet.add(node.location.filePath);
        if (node.isExported) {
          exportedSymbols.push(node.qualifiedName);
        }
      }

      return {
        success: true,
        summary: {
          totalFunctions: graph.metadata.nodeCount,
          totalCalls: graph.metadata.edgeCount,
          filesAnalyzed: graph.metadata.filesAnalyzed,
          buildTimeMs: Date.now() - startTime,
          exportedSymbols: exportedSymbols.slice(0, 20),
          hasMore: exportedSymbols.length > 20,
        },
        hint: 'Use preflight_query_call_graph to explore relationships for specific symbols.',
      };
    } catch (error) {
      logger.error('Failed to build call graph', error instanceof Error ? error : undefined);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

export function createQueryCallGraphHandler() {
  return async (input: QueryCallGraphInput) => {
    try {
      const graph = await getOrBuildGraph(input.path);
      const builder = createCallGraphBuilder();

      // Find the node by symbol name
      let targetNode: CallGraphNode | undefined;
      for (const node of graph.nodes.values()) {
        if (
          node.name === input.symbol ||
          node.qualifiedName === input.symbol ||
          node.qualifiedName.endsWith(`.${input.symbol}`)
        ) {
          targetNode = node;
          break;
        }
      }

      if (!targetNode) {
        // List available symbols for help
        const available = Array.from(graph.nodes.values())
          .filter((n) => n.isExported)
          .map((n) => n.qualifiedName)
          .slice(0, 10);

        return {
          success: false,
          error: `Symbol "${input.symbol}" not found in call graph.`,
          availableSymbols: available,
          hint: 'Try one of the available symbols listed above.',
        };
      }

      const result = await builder.query(graph, {
        entry: targetNode.id,
        direction: input.direction as TraversalDirection,
        maxDepth: input.maxDepth,
      });

      // Format results
      const callers: Array<{ name: string; file: string; line: number }> = [];
      const callees: Array<{ name: string; file: string; line: number }> = [];

      for (const edge of graph.incomingEdges.get(targetNode.id) || []) {
        const caller = graph.nodes.get(edge.callerId);
        if (caller) {
          callers.push({
            name: caller.qualifiedName,
            file: path.basename(caller.location.filePath),
            line: caller.location.line,
          });
        }
      }

      for (const edge of graph.outgoingEdges.get(targetNode.id) || []) {
        const callee = graph.nodes.get(edge.calleeId);
        if (callee) {
          callees.push({
            name: callee.qualifiedName,
            file: path.basename(callee.location.filePath),
            line: callee.location.line,
          });
        }
      }

      return {
        success: true,
        symbol: {
          name: targetNode.qualifiedName,
          kind: targetNode.kind,
          file: targetNode.location.filePath,
          line: targetNode.location.line,
          signature: targetNode.signature,
          documentation: targetNode.documentation,
          isExported: targetNode.isExported,
          isAsync: targetNode.isAsync,
        },
        callers: callers.length > 0 ? callers : undefined,
        callees: callees.length > 0 ? callees : undefined,
        totalRelated: result.subgraph.nodes.size,
        queryTimeMs: result.queryTimeMs,
      };
    } catch (error) {
      logger.error('Failed to query call graph', error instanceof Error ? error : undefined);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

export function createExtractCodeHandler() {
  return async (input: ExtractCodeInput) => {
    try {
      const graph = await getOrBuildGraph(input.path);
      const builder = createCallGraphBuilder();

      // Find the node
      let targetNode: CallGraphNode | undefined;
      for (const node of graph.nodes.values()) {
        if (
          node.name === input.symbol ||
          node.qualifiedName === input.symbol ||
          node.qualifiedName.endsWith(`.${input.symbol}`)
        ) {
          targetNode = node;
          break;
        }
      }

      if (!targetNode) {
        return {
          success: false,
          error: `Symbol "${input.symbol}" not found.`,
        };
      }

      // Extract dependencies
      const deps = builder.extractDependencies(graph, targetNode.id, input.includeTransitive);

      // Read source files and extract code
      const codeBlocks: Array<{
        name: string;
        kind: string;
        file: string;
        signature?: string;
        documentation?: string;
        code?: string;
      }> = [];

      for (const node of deps.nodes) {
        const block: (typeof codeBlocks)[0] = {
          name: node.qualifiedName,
          kind: node.kind,
          file: path.basename(node.location.filePath),
        };

        if (input.format !== 'minimal') {
          // Read the actual code
          try {
            const content = fs.readFileSync(node.location.filePath, 'utf-8');
            const lines = content.split('\n');
            const startLine = node.location.line - 1;
            const endLine = node.location.endLine ? node.location.endLine - 1 : startLine + 20;
            block.code = lines.slice(startLine, endLine + 1).join('\n');
          } catch {
            // Ignore read errors
          }
        }

        if (node.signature) block.signature = node.signature;
        if (node.documentation) block.documentation = node.documentation;

        codeBlocks.push(block);
      }

      if (input.format === 'markdown') {
        // Generate markdown output
        const lines: string[] = [
          `# Code Extraction: ${targetNode.qualifiedName}`,
          '',
          `**Kind:** ${targetNode.kind}`,
          `**File:** ${targetNode.location.filePath}`,
          `**Dependencies:** ${deps.nodes.length} functions from ${deps.files.length} files`,
          '',
        ];

        for (const block of codeBlocks) {
          lines.push(`## ${block.name}`);
          if (block.documentation) {
            lines.push('', block.documentation);
          }
          if (block.signature) {
            lines.push('', '```typescript', block.signature, '```');
          }
          if (block.code) {
            lines.push('', '```typescript', block.code, '```');
          }
          lines.push('');
        }

        return {
          success: true,
          format: 'markdown',
          content: lines.join('\n'),
          summary: {
            mainSymbol: targetNode.qualifiedName,
            dependencyCount: deps.nodes.length,
            fileCount: deps.files.length,
          },
        };
      }

      return {
        success: true,
        format: input.format,
        mainSymbol: {
          name: targetNode.qualifiedName,
          kind: targetNode.kind,
          file: targetNode.location.filePath,
          line: targetNode.location.line,
        },
        dependencies: codeBlocks,
        files: deps.files.map((f) => path.basename(f)),
      };
    } catch (error) {
      logger.error('Failed to extract code', error instanceof Error ? error : undefined);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

export function createInterfaceSummaryHandler() {
  return async (input: InterfaceSummaryInput) => {
    try {
      const graph = await getOrBuildGraph(input.path);
      const builder = createCallGraphBuilder();

      const summary = builder.generateInterfaceSummary(graph);

      // Count exported vs total
      let exportedCount = 0;
      for (const node of graph.nodes.values()) {
        if (node.isExported) exportedCount++;
      }

      return {
        success: true,
        summary,
        stats: {
          totalFunctions: graph.metadata.nodeCount,
          exportedFunctions: exportedCount,
          files: graph.metadata.filesAnalyzed,
        },
      };
    } catch (error) {
      logger.error('Failed to generate interface summary', error instanceof Error ? error : undefined);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

// ============================================================================
// Cache Management
// ============================================================================

export function clearCallGraphCache(path?: string): void {
  if (path) {
    graphCache.delete(path);
  } else {
    graphCache.clear();
  }
}
