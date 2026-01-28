/**
 * VectorDB Types for RAG storage.
 * @module vectordb/types
 */

// ============================================================================
// Hierarchical Collection Types (Phase 3)
// ============================================================================

/**
 * L1 content type for coarse-grained overview collections.
 * Each type has its own L1 collection for domain-specific retrieval.
 * 
 * - pdf: Academic papers (title + abstract)
 * - repo: Code repositories (name + description + features)
 * - doc: Documentation (title + summary)
 * - memory: Compressed memory/conversation summaries
 * - web: Web pages (title + meta description)
 */
export type L1ContentType = 'pdf' | 'repo' | 'doc' | 'memory' | 'web';

/**
 * Collection level for hierarchical retrieval.
 * - l1_{type}: Content-type-specific overview (e.g., l1_pdf, l1_repo)
 * - l2_section: Section-level (Introduction, Method, Results...)
 * - l3_chunk: Fragment-level (paragraphs, tables, formulas)
 */
export type CollectionLevel = 
  | `l1_${L1ContentType}`  // Dynamic L1 based on content type
  | 'l2_section' 
  | 'l3_chunk';

/** All possible L1 collection levels */
export const L1_LEVELS: CollectionLevel[] = [
  'l1_pdf', 'l1_repo', 'l1_doc', 'l1_memory', 'l1_web'
];

/**
 * Legacy collection type (for backward compatibility).
 * 'chunks' maps to 'l3_chunk' in hierarchical mode.
 */
export type LegacyCollectionType = 'chunks' | 'entities' | 'relations';

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
  /** Source file SHA256 hash for deduplication */
  contentHash?: string;
  /** Paper identifier (e.g., 'arxiv:2601.14287', 'doi:10.1234/xxx') */
  paperId?: string;
  /** Paper version (e.g., 'v1', 'v2') */
  paperVersion?: string;
  /** arXiv category (e.g., 'cs.AI', 'cs.CL', 'stat.ML') */
  arxivCategory?: string;
  /** Collection level for hierarchical retrieval */
  collectionLevel?: CollectionLevel;
  
  // Hierarchical chunking metadata (for semantic PDF chunking)
  /** Section heading (e.g., 'Introduction', 'Related Work') */
  sectionHeading?: string;
  /** Markdown heading level (1-6) */
  headingLevel?: number;
  /** Full heading path from root (e.g., ['Introduction', 'Background', 'Related Work']) */
  headingPath?: string[];
  /** Parent chunk ID for hierarchical navigation */
  parentChunkId?: string;
  /** Child chunk IDs (for parent chunks) */
  childChunkIds?: string[];
  
  // Multi-scale chunking metadata (for best quality retrieval)
  /** Chunk granularity: section, subsection, paragraph, element */
  granularity?: 'section' | 'subsection' | 'paragraph' | 'element';
  /** Asset ID for figures (image filename, for traceability after bundle deletion) */
  assetId?: string;
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
  /** Single bundle ID filter (backward compatible) */
  bundleId?: string;
  /** Multiple bundle IDs filter (Phase 1: cross-bundle retrieval) */
  bundleIds?: string[];
  repoId?: string;
  sourceType?: SourceType | SourceType[];
  chunkType?: ChunkType | ChunkType[];
}

/**
 * Query filter for hierarchical retrieval (Phase 3).
 */
export interface HierarchicalQueryFilter extends QueryFilter {
  /** Filter by paper IDs (for L2/L3 queries after L1 coarse filtering) */
  paperIds?: string[];
  /** Filter by arXiv category (e.g., 'cs.AI') */
  arxivCategory?: string;
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
