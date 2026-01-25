/**
 * VectorDB Types for RAG storage.
 * @module vectordb/types
 */

// ============================================================================
// Chunk Types
// ============================================================================

export type ChunkType = 'text' | 'heading' | 'table' | 'figure' | 'formula' | 'code' | 'list' | 'summary' | 'api';

export type SourceType = 'repocard' | 'readme' | 'overview' | 'pdf_text' | 'pdf_table' | 'pdf_formula' | 'pdf_image';

export interface ChunkMetadata {
  sourceType: SourceType;
  bundleId: string;
  repoId?: string;
  filePath?: string;
  pageIndex?: number;
  chunkIndex: number;
  chunkType: ChunkType;
  /** Original field name in RepoCard (e.g., 'oneLiner', 'useCases') */
  fieldName?: string;
}

/**
 * Document chunk for vector storage.
 */
export interface ChunkDocument {
  id: string;
  content: string;
  metadata: ChunkMetadata;
  embedding?: number[];
}

// ============================================================================
// Entity & Relation Types (for KG)
// ============================================================================

export type EntityKind = 'class' | 'interface' | 'enum' | 'function' | 'type' | 'concept';

export interface EntityDocument {
  id: string;
  name: string;
  kind: EntityKind;
  description: string;
  filePath?: string;
  sourceChunkId?: string;
  embedding?: number[];
}

export type RelationType = 'extends' | 'implements' | 'injects' | 'imports' | 'related_to';

export interface RelationDocument {
  id: string;
  srcEntity: string;
  tgtEntity: string;
  relationType: RelationType;
  srcFile?: string;
  description?: string;
}

// ============================================================================
// Query Types
// ============================================================================

export interface QueryFilter {
  bundleId?: string;
  repoId?: string;
  sourceType?: SourceType | SourceType[];
  chunkType?: ChunkType | ChunkType[];
}

export interface QueryResult {
  chunks: Array<ChunkDocument & { score: number }>;
}

export interface EntityQueryResult {
  entities: Array<EntityDocument & { score: number }>;
}

// ============================================================================
// ChromaDB Config
// ============================================================================

export interface ChromaConfig {
  /** ChromaDB server URL (default: http://localhost:8000) */
  url?: string;
  /** Tenant name */
  tenant?: string;
  /** Database name */
  database?: string;
  /** Collection name prefix */
  collectionPrefix?: string;
}

export const DEFAULT_CHROMA_CONFIG: Required<ChromaConfig> = {
  url: 'https://chromadb.sicko.top:16669',
  tenant: 'default_tenant',
  database: 'default_database',
  collectionPrefix: 'preflight',
};
