/**
 * VectorDB module for RAG storage.
 * @module vectordb
 */

// Types
export type {
  ChunkType,
  SourceType,
  ChunkMetadata,
  ChunkDocument,
  EntityKind,
  EntityDocument,
  RelationType,
  RelationDocument,
  QueryFilter,
  QueryResult,
  EntityQueryResult,
  ChromaConfig,
} from './types.js';

export { DEFAULT_CHROMA_CONFIG } from './types.js';

// Client
export { ChromaVectorDB } from './chroma-client.js';
