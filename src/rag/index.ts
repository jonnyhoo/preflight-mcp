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

// Main API
export { 
  RAGEngine, 
  initRAG, 
  getRAGEngine,
  indexBundle, 
  ragQuery,
} from './query.js';

// Context Completer (TODO: multi-hop enhancement)
export type {
  ContextCompletionResult,
  CompletionOptions,
} from './context-completer.js';

export {
  completeContext,
  verifyChunkCompleteness,
} from './context-completer.js';
