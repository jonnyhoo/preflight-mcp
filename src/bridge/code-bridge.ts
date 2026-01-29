/**
 * Code Bridge - Convert AST nodes to vector chunks for code indexing.
 * 
 * @module bridge/code-bridge
 */

import * as path from 'node:path';
import type { ChunkDocument, ChunkType } from '../vectordb/types.js';
import type { BridgeOptions, BridgeResult } from './types.js';
import type { AstGraphNode, AstNodeKind, CodeFilterOptions } from '../kg/index.js';
import {
  buildAstGraph,
  shouldIndexFile,
  shouldIndexFunction,
  applyQuota,
  DEFAULT_CODE_FILTER_OPTIONS,
} from '../kg/index.js';
import { languageForFile } from '../ast/parser.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('code-bridge');

// ============================================================================
// Types
// ============================================================================

export interface CodeBridgeOptions extends BridgeOptions {
  /** Code filter options */
  codeFilter?: CodeFilterOptions;
}

export interface CodeBridgeResult extends BridgeResult {
  /** Number of files processed */
  filesProcessed: number;
  /** Number of symbols extracted */
  symbolsExtracted: number;
  /** Number of symbols indexed (after filtering) */
  symbolsIndexed: number;
}

// ============================================================================
// AST Node Kind to Chunk Type Mapping
// ============================================================================

function nodeKindToChunkType(kind: AstNodeKind): ChunkType {
  switch (kind) {
    case 'class':
    case 'interface':
    case 'enum':
    case 'type':
      return 'code';
    case 'function':
    case 'method':
    case 'block':
      return 'code';
    default:
      return 'code';
  }
}

function nodeKindToSymbolKind(kind: AstNodeKind): 'class' | 'interface' | 'function' | 'method' | 'enum' | 'type' {
  switch (kind) {
    case 'class':
      return 'class';
    case 'interface':
      return 'interface';
    case 'function':
      return 'function';
    case 'method':
      return 'method';
    case 'enum':
      return 'enum';
    case 'type':
      return 'type';
    case 'block':
      return 'function'; // blocks are treated as functions
    default:
      return 'function';
  }
}

// ============================================================================
// Content Formatting
// ============================================================================

/**
 * Format AST node content for vectorization.
 * Creates a structured representation that's good for embedding.
 */
function formatNodeContent(node: AstGraphNode, parentName?: string): string {
  const parts: string[] = [];
  
  // Header with symbol info
  const kindLabel = node.kind.charAt(0).toUpperCase() + node.kind.slice(1);
  const fullName = parentName ? `${parentName}.${node.name}` : node.name;
  parts.push(`# ${kindLabel}: ${fullName}`);
  
  // File location
  if (node.filePath) {
    const location = node.startLine 
      ? `${node.filePath}:${node.startLine}` 
      : node.filePath;
    parts.push(`File: ${location}`);
  }
  
  // Export status
  if (node.isExported !== undefined) {
    parts.push(`Exported: ${node.isExported ? 'yes' : 'no'}`);
  }
  
  // Description/docstring
  if (node.description) {
    parts.push('');
    parts.push('## Description');
    parts.push(node.description);
  }
  
  // Code content
  if (node.content) {
    parts.push('');
    parts.push('## Code');
    parts.push('```');
    parts.push(node.content);
    parts.push('```');
  }
  
  return parts.join('\n');
}

// ============================================================================
// Main Bridge Function
// ============================================================================

/**
 * Bridge code files to ChunkDocuments.
 * Extracts functions, methods, classes from source code and converts to chunks.
 * 
 * @param repoPath - Path to the repository root
 * @param bundleId - Bundle identifier
 * @param repoId - Repository identifier
 * @param options - Bridge options including embedding provider
 * @returns Promise of chunks and bridge result
 */
export async function bridgeCodeFiles(
  repoPath: string,
  bundleId: string,
  repoId: string,
  options: CodeBridgeOptions
): Promise<{ chunks: ChunkDocument[]; result: CodeBridgeResult }> {
  const filterOpts = { ...DEFAULT_CODE_FILTER_OPTIONS, ...options.codeFilter };
  const chunks: ChunkDocument[] = [];
  const errors: string[] = [];
  
  logger.info(`Bridging code files from ${repoPath}`);
  
  // Build AST graph
  const graphResult = await buildAstGraph(repoPath, {
    maxFiles: filterOpts.maxFunctions ? filterOpts.maxFunctions * 2 : 1000, // Estimate
  });
  
  if (graphResult.errors.length > 0) {
    errors.push(...graphResult.errors);
  }
  
  const { graph, stats } = graphResult;
  logger.info(`AST graph: ${stats.nodesCount} nodes, ${stats.edgesCount} edges`);
  
  // Collect indexable nodes
  const indexableNodes: AstGraphNode[] = [];
  
  for (const [nodeKey, node] of graph.nodes) {
    // Skip if file shouldn't be indexed
    if (!shouldIndexFile(node.filePath)) {
      continue;
    }
    
    // Skip if function/method doesn't meet criteria
    if (!shouldIndexFunction(node, filterOpts)) {
      continue;
    }
    
    indexableNodes.push(node);
  }
  
  logger.info(`Found ${indexableNodes.length} indexable symbols`);
  
  // Apply quota
  const quotaApplied = applyQuota(indexableNodes, filterOpts.maxFunctions);
  const skippedByQuota = indexableNodes.length - quotaApplied.length;
  if (skippedByQuota > 0) {
    logger.info(`Applied quota: kept ${quotaApplied.length}, skipped ${skippedByQuota}`);
  }
  
  // Convert nodes to chunks
  let chunkIndex = 0;
  const chunksByType: Record<ChunkType, number> = {} as Record<ChunkType, number>;
  
  for (const node of quotaApplied) {
    // Find parent name for methods
    let parentName: string | undefined;
    if (node.kind === 'method') {
      // Try to find parent from node key (format: "ParentClass.methodName")
      for (const [key] of graph.nodes) {
        if (key.includes('.') && key.endsWith(`.${node.name}`)) {
          parentName = key.split('.')[0];
          break;
        }
      }
    }
    
    // Format content
    const content = formatNodeContent(node, parentName);
    if (!content.trim()) {
      continue; // Skip empty content
    }
    
    // Detect language from file path
    const language = languageForFile(node.filePath) || 'unknown';
    
    // Create chunk
    const chunkType = nodeKindToChunkType(node.kind);
    const symbolKind = nodeKindToSymbolKind(node.kind);
    const fullName = parentName ? `${parentName}.${node.name}` : node.name;
    
    const chunk: ChunkDocument = {
      id: `${bundleId}:${repoId}:code:${fullName}:${chunkIndex}`,
      content,
      metadata: {
        sourceType: 'code',
        bundleId,
        repoId,
        filePath: node.filePath,
        chunkIndex,
        chunkType,
        // Code-specific metadata
        language,
        symbolName: node.name,
        symbolKind,
        parentSymbol: parentName,
        importance: node.importance,
        isExported: node.isExported,
        startLine: node.startLine,
        endLine: node.endLine,
        // For hierarchical collections, use section heading
        sectionHeading: `${symbolKind}: ${fullName}`,
      },
    };
    
    chunks.push(chunk);
    chunksByType[chunkType] = (chunksByType[chunkType] || 0) + 1;
    chunkIndex++;
  }
  
  logger.info(`Created ${chunks.length} code chunks`);
  
  // Generate embeddings
  if (chunks.length > 0 && options.embedding) {
    try {
      const texts = chunks.map(c => c.content);
      const embeddings = await options.embedding.embedBatch(texts);
      
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = embeddings[i];
        if (chunk && embedding) {
          chunk.embedding = embedding.vector;
        }
      }
      
      logger.info(`Generated embeddings for ${chunks.length} code chunks`);
    } catch (err) {
      const msg = `Failed to generate embeddings: ${err}`;
      logger.error(msg);
      errors.push(msg);
    }
  }
  
  const result: CodeBridgeResult = {
    chunksWritten: chunks.length,
    chunksByType,
    errors,
    filesProcessed: stats.filesProcessed,
    symbolsExtracted: stats.nodesCount,
    symbolsIndexed: chunks.length,
  };
  
  return { chunks, result };
}

/**
 * Bridge a single code file to ChunkDocuments.
 * Useful for incremental indexing.
 * 
 * @param filePath - Path to the source file
 * @param bundleId - Bundle identifier
 * @param repoId - Repository identifier
 * @param options - Bridge options
 * @returns Promise of chunks and bridge result
 */
export async function bridgeCodeFile(
  filePath: string,
  bundleId: string,
  repoId: string,
  options: CodeBridgeOptions
): Promise<{ chunks: ChunkDocument[]; result: CodeBridgeResult }> {
  // Use the file's directory as repo path
  const repoPath = path.dirname(filePath);
  
  // Build AST for single file
  const result = await bridgeCodeFiles(repoPath, bundleId, repoId, {
    ...options,
    codeFilter: {
      ...options.codeFilter,
      maxFunctions: 100, // Limit for single file
    },
  });
  
  // Filter to only chunks from the target file
  const targetFileName = path.basename(filePath);
  result.chunks = result.chunks.filter(c => 
    c.metadata.filePath?.includes(targetFileName)
  );
  result.result.chunksWritten = result.chunks.length;
  result.result.symbolsIndexed = result.chunks.length;
  
  return result;
}
