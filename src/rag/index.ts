/**
 * RAG module for retrieval-augmented generation.
 * @module rag
 */

// Types
export type {
  QueryMode,
  QueryOptions,
  RetrieveResult,
  SourceEvidence,
  GenerateResult,
  VerificationResult,
  QueryResult,
  IndexResult,
  RAGConfig,
} from './types.js';

export { DEFAULT_QUERY_OPTIONS } from './types.js';

// Components
export { RAGRetriever } from './retriever.js';
export { RAGGenerator } from './generator.js';

// Hierarchical Retriever (Phase 3)
export type {
  HierarchicalRetrieveOptions,
  HierarchicalRetrieveResult,
} from './hierarchical-retriever.js';

export {
  HierarchicalRetriever,
  createHierarchicalRetriever,
} from './hierarchical-retriever.js';

// Main API
export { 
  RAGEngine, 
  initRAG, 
  getRAGEngine,
  indexBundle, 
  ragQuery,
} from './query.js';

// Context Completer (multi-hop enhancement)
export type {
  ContextCompletionResult,
  CompletionOptions,
  ContextCompleterDeps,
} from './context-completer.js';

export {
  ContextCompleter,
  completeContext,
  verifyChunkCompleteness,
} from './context-completer.js';
