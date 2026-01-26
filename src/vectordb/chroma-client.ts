/**
 * ChromaDB Client for vector storage.
 * Uses HTTP API directly for maximum compatibility.
 * 
 * @module vectordb/chroma-client
 */

import type {
  ChunkDocument,
  ChunkMetadata,
  EntityDocument,
  RelationDocument,
  QueryFilter,
  QueryResult,
  EntityQueryResult,
  ChromaConfig,
} from './types.js';
import { DEFAULT_CHROMA_CONFIG } from './types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('chroma');

// ============================================================================
// ChromaDB HTTP Client
// ============================================================================

interface ChromaCollection {
  name: string;
  id: string;
  metadata?: Record<string, unknown>;
}

interface ChromaQueryResponse {
  ids: string[][];
  embeddings?: number[][][];
  documents?: (string | null)[][];
  metadatas?: (Record<string, unknown> | null)[][];
  distances?: number[][];
}

interface ChromaGetResponse {
  ids: string[];
  embeddings?: number[][];
  documents?: (string | null)[];
  metadatas?: (Record<string, unknown> | null)[];
}

/**
 * ChromaDB Vector Database client.
 */
export class ChromaVectorDB {
  private config: Required<ChromaConfig>;
  private collections: Map<string, ChromaCollection> = new Map();

  constructor(config?: ChromaConfig) {
    this.config = { ...DEFAULT_CHROMA_CONFIG, ...config };
  }

  // --------------------------------------------------------------------------
  // HTTP Helpers
  // --------------------------------------------------------------------------

  /**
   * Get the base path for v2 API with tenant/database.
   */
  private getBasePath(): string {
    return `/api/v2/tenants/${this.config.tenant}/databases/${this.config.database}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.config.url}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ChromaDB request failed: ${response.status} ${text}`);
    }

    return response.json() as Promise<T>;
  }

  // --------------------------------------------------------------------------
  // Collection Management
  // --------------------------------------------------------------------------

  private getCollectionName(type: 'chunks' | 'entities' | 'relations'): string {
    return `${this.config.collectionPrefix}_${type}`;
  }

  /**
   * Ensure collection exists, create if not.
   */
  async ensureCollection(
    type: 'chunks' | 'entities' | 'relations'
  ): Promise<ChromaCollection> {
    const name = this.getCollectionName(type);
    
    // Check cache
    const cached = this.collections.get(name);
    if (cached) return cached;

    const basePath = this.getBasePath();

    try {
      // Try to get existing collection by listing and finding
      const collections = await this.request<ChromaCollection[]>(
        'GET',
        `${basePath}/collections`
      );
      const existing = collections.find(c => c.name === name);
      if (existing) {
        this.collections.set(name, existing);
        return existing;
      }
    } catch {
      // Ignore - will create
    }

    // Create new collection
    logger.info(`Creating collection: ${name}`);
    const collection = await this.request<ChromaCollection>(
      'POST',
      `${basePath}/collections`,
      {
        name,
        metadata: { type },
      }
    );
    this.collections.set(name, collection);
    return collection;
  }

  /**
   * Delete a collection.
   */
  async deleteCollection(type: 'chunks' | 'entities' | 'relations'): Promise<void> {
    const name = this.getCollectionName(type);
    const basePath = this.getBasePath();
    try {
      const collection = await this.ensureCollection(type);
      await this.request('DELETE', `${basePath}/collections/${collection.id}`);
      this.collections.delete(name);
      logger.info(`Deleted collection: ${name}`);
    } catch (err) {
      logger.warn(`Failed to delete collection ${name}: ${err}`);
    }
  }

  // --------------------------------------------------------------------------
  // Chunk Operations
  // --------------------------------------------------------------------------

  /**
   * Upsert chunk documents with embeddings.
   * All chunks must have embeddings. Batches to avoid payload size limits.
   */
  async upsertChunks(chunks: ChunkDocument[]): Promise<void> {
    if (chunks.length === 0) return;

    // Filter to only chunks with embeddings
    const validChunks = chunks.filter((c) => c.embedding && c.embedding.length > 0);
    if (validChunks.length === 0) {
      logger.warn('No chunks with embeddings to upsert');
      return;
    }
    if (validChunks.length < chunks.length) {
      logger.warn(`Skipping ${chunks.length - validChunks.length} chunks without embeddings`);
    }

    const collection = await this.ensureCollection('chunks');
    
    // Batch size - smaller batches to avoid 413 Payload Too Large
    const BATCH_SIZE = 5;
    
    for (let i = 0; i < validChunks.length; i += BATCH_SIZE) {
      const batch = validChunks.slice(i, i + BATCH_SIZE);
      
      const ids = batch.map((c) => c.id);
      const embeddings = batch.map((c) => c.embedding!);
      const documents = batch.map((c) => c.content);
      const metadatas = batch.map((c) => ({
        // ChromaDB requires flat metadata values
        sourceType: c.metadata.sourceType,
        bundleId: c.metadata.bundleId,
        repoId: c.metadata.repoId ?? '',
        filePath: c.metadata.filePath ?? '',
        chunkIndex: c.metadata.chunkIndex,
        chunkType: c.metadata.chunkType,
        fieldName: c.metadata.fieldName ?? '',
        // Deduplication fields
        contentHash: c.metadata.contentHash ?? '',
        paperId: c.metadata.paperId ?? '',
        paperVersion: c.metadata.paperVersion ?? '',
        // Hierarchical chunking fields (for semantic PDF chunking)
        sectionHeading: c.metadata.sectionHeading ?? '',
        headingLevel: c.metadata.headingLevel ?? 0,
        // ChromaDB doesn't support array values, so join headingPath
        headingPath: c.metadata.headingPath?.join(' > ') ?? '',
        parentChunkId: c.metadata.parentChunkId ?? '',
      }));

      await this.request('POST', `${this.getBasePath()}/collections/${collection.id}/upsert`, {
        ids,
        embeddings,
        documents,
        metadatas,
      });
      
      logger.debug(`Upserted batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} chunks)`);
    }

    logger.debug(`Upserted ${validChunks.length} chunks total`);
  }

  /**
   * Query chunks by embedding similarity.
   */
  async queryChunks(
    embedding: number[],
    topK: number = 10,
    filter?: QueryFilter
  ): Promise<QueryResult> {
    const collection = await this.ensureCollection('chunks');

    const whereClause = this.buildWhereClause(filter);

    const response = await this.request<ChromaQueryResponse>(
      'POST',
      `${this.getBasePath()}/collections/${collection.id}/query`,
      {
        query_embeddings: [embedding],
        n_results: topK,
        include: ['documents', 'metadatas', 'distances'],
        where: whereClause,
      }
    );

    const chunks: Array<ChunkDocument & { score: number }> = [];
    
    if (response.ids[0]) {
      for (let i = 0; i < response.ids[0].length; i++) {
        const id = response.ids[0][i]!;
        const document = response.documents?.[0]?.[i] ?? '';
        const metadata = response.metadatas?.[0]?.[i] as ChunkMetadata | null;
        const distance = response.distances?.[0]?.[i] ?? 0;

        chunks.push({
          id,
          content: document,
          metadata: metadata ?? {
            sourceType: 'readme',
            bundleId: '',
            chunkIndex: 0,
            chunkType: 'text',
          },
          score: 1 - distance, // Convert distance to similarity
        });
      }
    }

    return { chunks };
  }

  /**
   * Get chunks by IDs.
   */
  async getChunks(ids: string[]): Promise<ChunkDocument[]> {
    if (ids.length === 0) return [];

    const collection = await this.ensureCollection('chunks');

    const response = await this.request<ChromaGetResponse>(
      'POST',
      `${this.getBasePath()}/collections/${collection.id}/get`,
      {
        ids,
        include: ['documents', 'metadatas'],
      }
    );

    const chunks: ChunkDocument[] = [];
    for (let i = 0; i < response.ids.length; i++) {
      const id = response.ids[i]!;
      const document = response.documents?.[i] ?? '';
      const metadata = response.metadatas?.[i] as ChunkMetadata | null;

      chunks.push({
        id,
        content: document,
        metadata: metadata ?? {
          sourceType: 'readme',
          bundleId: '',
          chunkIndex: 0,
          chunkType: 'text',
        },
      });
    }

    return chunks;
  }

  /**
   * Get chunks by parent chunk ID (for sibling retrieval).
   */
  async getChunksByParentId(parentChunkId: string): Promise<ChunkDocument[]> {
    if (!parentChunkId) return [];

    const collection = await this.ensureCollection('chunks');

    const response = await this.request<ChromaGetResponse>(
      'POST',
      `${this.getBasePath()}/collections/${collection.id}/get`,
      {
        where: { parentChunkId },
        include: ['documents', 'metadatas'],
      }
    );

    const chunks: ChunkDocument[] = [];
    for (let i = 0; i < response.ids.length; i++) {
      const id = response.ids[i]!;
      const document = response.documents?.[i] ?? '';
      const metadata = response.metadatas?.[i] as ChunkMetadata | null;

      chunks.push({
        id,
        content: document,
        metadata: metadata ?? {
          sourceType: 'readme',
          bundleId: '',
          chunkIndex: 0,
          chunkType: 'text',
        },
      });
    }

    return chunks;
  }

  /**
   * Delete chunks by IDs.
   */
  async deleteChunks(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const collection = await this.ensureCollection('chunks');
    await this.request('POST', `${this.getBasePath()}/collections/${collection.id}/delete`, { ids });
    logger.debug(`Deleted ${ids.length} chunks`);
  }

  /**
   * Delete all chunks for a bundle.
   */
  async deleteByBundle(bundleId: string): Promise<void> {
    const collection = await this.ensureCollection('chunks');
    await this.request('POST', `${this.getBasePath()}/collections/${collection.id}/delete`, {
      where: { bundleId },
    });
    logger.info(`Deleted chunks for bundle: ${bundleId}`);
  }

  // --------------------------------------------------------------------------
  // Content Hash Operations (for deduplication)
  // --------------------------------------------------------------------------

  /**
   * Get chunks by contentHash (source file SHA256).
   * Used for deduplication check before indexing.
   */
  async getChunksByContentHash(contentHash: string): Promise<ChunkDocument[]> {
    const collection = await this.ensureCollection('chunks');

    const response = await this.request<ChromaGetResponse>(
      'POST',
      `${this.getBasePath()}/collections/${collection.id}/get`,
      {
        where: { contentHash },
        include: ['documents', 'metadatas'],
      }
    );

    const chunks: ChunkDocument[] = [];
    for (let i = 0; i < response.ids.length; i++) {
      const id = response.ids[i]!;
      const document = response.documents?.[i] ?? '';
      const metadata = response.metadatas?.[i] as ChunkMetadata | null;

      chunks.push({
        id,
        content: document,
        metadata: metadata ?? {
          sourceType: 'readme',
          bundleId: '',
          chunkIndex: 0,
          chunkType: 'text',
        },
      });
    }

    return chunks;
  }

  /**
   * Delete all chunks with a specific contentHash.
   * Used when force-replacing content.
   */
  async deleteByContentHash(contentHash: string): Promise<number> {
    const collection = await this.ensureCollection('chunks');
    
    // First get count of chunks to delete
    const existing = await this.getChunksByContentHash(contentHash);
    if (existing.length === 0) return 0;

    await this.request('POST', `${this.getBasePath()}/collections/${collection.id}/delete`, {
      where: { contentHash },
    });
    
    logger.info(`Deleted ${existing.length} chunks with contentHash: ${contentHash.slice(0, 12)}...`);
    return existing.length;
  }

  /**
   * List all unique contentHash values in the collection.
   * Returns summary info for each indexed content.
   */
  async listIndexedContent(): Promise<Array<{
    contentHash: string;
    paperId?: string;
    paperVersion?: string;
    bundleId: string;
    chunkCount: number;
  }>> {
    const collection = await this.ensureCollection('chunks');

    // Get all chunks (ChromaDB doesn't support DISTINCT)
    const response = await this.request<ChromaGetResponse>(
      'POST',
      `${this.getBasePath()}/collections/${collection.id}/get`,
      {
        include: ['metadatas'],
      }
    );

    // Group by contentHash
    const contentMap = new Map<string, {
      contentHash: string;
      paperId?: string;
      paperVersion?: string;
      bundleId: string;
      chunkCount: number;
    }>();

    for (let i = 0; i < response.ids.length; i++) {
      const metadata = response.metadatas?.[i] as ChunkMetadata | null;
      const contentHash = metadata?.contentHash;
      if (!contentHash) continue;

      const existing = contentMap.get(contentHash);
      if (existing) {
        existing.chunkCount++;
      } else {
        contentMap.set(contentHash, {
          contentHash,
          paperId: metadata?.paperId,
          paperVersion: metadata?.paperVersion,
          bundleId: metadata?.bundleId ?? '',
          chunkCount: 1,
        });
      }
    }

    return Array.from(contentMap.values());
  }

  /**
   * Get collection statistics.
   */
  async getCollectionStats(): Promise<{
    totalChunks: number;
    uniqueContentHashes: number;
    byPaperId: Array<{ paperId: string; chunkCount: number }>;
  }> {
    const indexed = await this.listIndexedContent();
    
    // Group by paperId
    const paperMap = new Map<string, number>();
    let totalChunks = 0;

    for (const item of indexed) {
      totalChunks += item.chunkCount;
      if (item.paperId) {
        const current = paperMap.get(item.paperId) ?? 0;
        paperMap.set(item.paperId, current + item.chunkCount);
      }
    }

    return {
      totalChunks,
      uniqueContentHashes: indexed.length,
      byPaperId: Array.from(paperMap.entries()).map(([paperId, chunkCount]) => ({
        paperId,
        chunkCount,
      })),
    };
  }

  // --------------------------------------------------------------------------
  // Entity Operations
  // --------------------------------------------------------------------------

  /**
   * Upsert entity documents. Batched to avoid payload size limits.
   * Only entities with embeddings are upserted.
   */
  async upsertEntities(entities: EntityDocument[]): Promise<void> {
    if (entities.length === 0) return;

    // Filter to only entities with embeddings
    const validEntities = entities.filter((e) => e.embedding && e.embedding.length > 0);
    if (validEntities.length === 0) {
      logger.warn('No entities with embeddings to upsert');
      return;
    }
    if (validEntities.length < entities.length) {
      logger.warn(`Skipping ${entities.length - validEntities.length} entities without embeddings`);
    }

    const collection = await this.ensureCollection('entities');
    const BATCH_SIZE = 50;

    for (let i = 0; i < validEntities.length; i += BATCH_SIZE) {
      const batch = validEntities.slice(i, i + BATCH_SIZE);
      
      const ids = batch.map((e) => e.id);
      const embeddings = batch.map((e) => e.embedding!);
      const documents = batch.map((e) => `${e.name}: ${e.description}`);
      const metadatas = batch.map((e) => ({
        name: e.name,
        kind: e.kind,
        filePath: e.filePath ?? '',
        sourceChunkId: e.sourceChunkId ?? '',
      }));

      await this.request('POST', `${this.getBasePath()}/collections/${collection.id}/upsert`, {
        ids,
        embeddings,
        documents,
        metadatas,
      });
    }

    logger.debug(`Upserted ${validEntities.length} entities`);
  }

  /**
   * Query entities by embedding similarity.
   */
  async queryEntities(
    embedding: number[],
    topK: number = 10
  ): Promise<EntityQueryResult> {
    const collection = await this.ensureCollection('entities');

    const response = await this.request<ChromaQueryResponse>(
      'POST',
      `${this.getBasePath()}/collections/${collection.id}/query`,
      {
        query_embeddings: [embedding],
        n_results: topK,
        include: ['documents', 'metadatas', 'distances'],
      }
    );

    const entities: Array<EntityDocument & { score: number }> = [];

    if (response.ids[0]) {
      for (let i = 0; i < response.ids[0].length; i++) {
        const id = response.ids[0][i]!;
        const metadata = response.metadatas?.[0]?.[i] as Record<string, string> | null;
        const distance = response.distances?.[0]?.[i] ?? 0;

        entities.push({
          id,
          name: metadata?.name ?? '',
          kind: (metadata?.kind as EntityDocument['kind']) ?? 'concept',
          description: response.documents?.[0]?.[i] ?? '',
          filePath: metadata?.filePath,
          sourceChunkId: metadata?.sourceChunkId,
          score: 1 - distance,
        });
      }
    }

    return { entities };
  }

  // --------------------------------------------------------------------------
  // Relation Operations
  // --------------------------------------------------------------------------

  /**
   * Upsert relation documents. Batched to avoid payload size limits.
   */
  async upsertRelations(relations: RelationDocument[]): Promise<void> {
    if (relations.length === 0) return;

    const collection = await this.ensureCollection('relations');
    const BATCH_SIZE = 100; // Relations are small, can batch more

    for (let i = 0; i < relations.length; i += BATCH_SIZE) {
      const batch = relations.slice(i, i + BATCH_SIZE);
      
      const ids = batch.map((r) => r.id);
      const documents = batch.map(
        (r) => `${r.srcEntity} ${r.relationType} ${r.tgtEntity}`
      );
      const metadatas = batch.map((r) => ({
        srcEntity: r.srcEntity,
        tgtEntity: r.tgtEntity,
        relationType: r.relationType,
        srcFile: r.srcFile ?? '',
        description: r.description ?? '',
      }));

      await this.request('POST', `${this.getBasePath()}/collections/${collection.id}/upsert`, {
        ids,
        documents,
        metadatas,
      });
    }

    logger.debug(`Upserted ${relations.length} relations`);
  }

  /**
   * Get relations by entity name.
   */
  async getRelationsByEntity(entityName: string): Promise<RelationDocument[]> {
    const collection = await this.ensureCollection('relations');

    // Query for relations where entity is source
    const srcResponse = await this.request<ChromaGetResponse>(
      'POST',
      `${this.getBasePath()}/collections/${collection.id}/get`,
      {
        where: { srcEntity: entityName },
        include: ['metadatas'],
      }
    );

    // Query for relations where entity is target
    const tgtResponse = await this.request<ChromaGetResponse>(
      'POST',
      `${this.getBasePath()}/collections/${collection.id}/get`,
      {
        where: { tgtEntity: entityName },
        include: ['metadatas'],
      }
    );

    const relations: RelationDocument[] = [];

    for (let i = 0; i < srcResponse.ids.length; i++) {
      const metadata = srcResponse.metadatas?.[i] as Record<string, string> | null;
      if (metadata && metadata.srcEntity && metadata.tgtEntity) {
        relations.push({
          id: srcResponse.ids[i]!,
          srcEntity: metadata.srcEntity,
          tgtEntity: metadata.tgtEntity,
          relationType: metadata.relationType as RelationDocument['relationType'],
          srcFile: metadata.srcFile || undefined,
          description: metadata.description || undefined,
        });
      }
    }

    for (let i = 0; i < tgtResponse.ids.length; i++) {
      const metadata = tgtResponse.metadatas?.[i] as Record<string, string> | null;
      if (metadata && metadata.srcEntity && metadata.tgtEntity) {
        relations.push({
          id: tgtResponse.ids[i]!,
          srcEntity: metadata.srcEntity,
          tgtEntity: metadata.tgtEntity,
          relationType: metadata.relationType as RelationDocument['relationType'],
          srcFile: metadata.srcFile || undefined,
          description: metadata.description || undefined,
        });
      }
    }

    return relations;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private buildWhereClause(filter?: QueryFilter): Record<string, unknown> | undefined {
    if (!filter) return undefined;

    const conditions: Record<string, unknown>[] = [];

    if (filter.bundleId) {
      conditions.push({ bundleId: filter.bundleId });
    }

    if (filter.repoId) {
      conditions.push({ repoId: filter.repoId });
    }

    if (filter.sourceType) {
      if (Array.isArray(filter.sourceType)) {
        conditions.push({ sourceType: { $in: filter.sourceType } });
      } else {
        conditions.push({ sourceType: filter.sourceType });
      }
    }

    if (filter.chunkType) {
      if (Array.isArray(filter.chunkType)) {
        conditions.push({ chunkType: { $in: filter.chunkType } });
      } else {
        conditions.push({ chunkType: filter.chunkType });
      }
    }

    if (conditions.length === 0) return undefined;
    if (conditions.length === 1) return conditions[0];
    return { $and: conditions };
  }

  /**
   * Check if ChromaDB server is available.
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.request('GET', '/api/v2/heartbeat');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get server version info.
   */
  async getVersion(): Promise<string> {
    const info = await this.request<{ version: string }>('GET', '/api/v2/version');
    return info.version;
  }

  // --------------------------------------------------------------------------
  // AST Graph Storage (no embedding needed)
  // --------------------------------------------------------------------------

  /**
   * Get or create the AST graph collection.
   * This collection stores serialized JSON without embeddings.
   */
  private async ensureAstGraphCollection(): Promise<ChromaCollection> {
    const name = `${this.config.collectionPrefix}_astgraph`;
    
    const cached = this.collections.get(name);
    if (cached) return cached;

    const basePath = this.getBasePath();

    try {
      const collections = await this.request<ChromaCollection[]>(
        'GET',
        `${basePath}/collections`
      );
      const existing = collections.find(c => c.name === name);
      if (existing) {
        this.collections.set(name, existing);
        return existing;
      }
    } catch {
      // Ignore - will create
    }

    logger.info(`Creating AST graph collection: ${name}`);
    const collection = await this.request<ChromaCollection>(
      'POST',
      `${basePath}/collections`,
      {
        name,
        metadata: { type: 'astgraph' },
      }
    );
    this.collections.set(name, collection);
    return collection;
  }

  /**
   * Store AST graph JSON for a bundle.
   * Uses a minimal dummy embedding since ChromaDB v2 requires embeddings.
   */
  async storeAstGraph(bundleId: string, graphJson: string): Promise<void> {
    const collection = await this.ensureAstGraphCollection();
    const id = `astgraph_${bundleId}`;

    // ChromaDB v2 requires embeddings, so we use a minimal dummy embedding
    // The graph is stored as the document, retrieved by ID not by similarity
    const dummyEmbedding = new Array(8).fill(0); // Minimal 8-dim dummy

    await this.request('POST', `${this.getBasePath()}/collections/${collection.id}/upsert`, {
      ids: [id],
      embeddings: [dummyEmbedding],
      documents: [graphJson],
      metadatas: [{ bundleId, type: 'astgraph', updatedAt: Date.now() }],
    });

    logger.info(`Stored AST graph for bundle: ${bundleId} (${graphJson.length} bytes)`);
  }

  /**
   * Load AST graph JSON for a bundle.
   * Returns null if not found.
   */
  async loadAstGraph(bundleId: string): Promise<string | null> {
    try {
      const collection = await this.ensureAstGraphCollection();
      const id = `astgraph_${bundleId}`;

      const response = await this.request<ChromaGetResponse>(
        'POST',
        `${this.getBasePath()}/collections/${collection.id}/get`,
        {
          ids: [id],
          include: ['documents'],
        }
      );

      if (response.ids.length > 0 && response.documents?.[0]) {
        logger.info(`Loaded AST graph for bundle: ${bundleId}`);
        return response.documents[0];
      }

      return null;
    } catch (err) {
      logger.debug(`No AST graph found for bundle: ${bundleId}`);
      return null;
    }
  }

  /**
   * Delete AST graph for a bundle.
   */
  async deleteAstGraph(bundleId: string): Promise<void> {
    try {
      const collection = await this.ensureAstGraphCollection();
      const id = `astgraph_${bundleId}`;

      await this.request('POST', `${this.getBasePath()}/collections/${collection.id}/delete`, {
        ids: [id],
      });

      logger.info(`Deleted AST graph for bundle: ${bundleId}`);
    } catch (err) {
      logger.warn(`Failed to delete AST graph for bundle ${bundleId}: ${err}`);
    }
  }
}
