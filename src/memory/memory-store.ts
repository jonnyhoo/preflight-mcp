/**
 * Memory Store for 3-Layer LTM System.
 * 
 * Provides ChromaDB-based storage for episodic, semantic, and procedural memories.
 * Uses HTTP API directly for maximum compatibility (same pattern as chroma-client.ts).
 * 
 * @module memory/memory-store
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createModuleLogger } from '../logging/logger.js';
import { getConfig } from '../config.js';

import type {
  MemoryLayer,
  Memory,
  EpisodicMemory,
  SemanticMemory,
  ProceduralMemory,
  EpisodicMetadata,
  SemanticMetadata,
  ProceduralMetadata,
  AddEpisodicInput,
  AddSemanticInput,
  AddProceduralInput,
  SearchResult,
  SearchOptions,
  SearchFilters,
  MemorySearchResult,
  StatsResult,
  ListResult,
  ListOptions,
  GCOptions,
  GCResult,
  MemoryHealthMeta,
  AccessDelta,
  ChromaQueryResponse,
  ChromaGetResponse,
  ChromaCollection,
} from './types.js';

import {
  SCHEMA_VERSION,
  MEMORY_COLLECTION_PREFIX,
  MEMORY_LAYERS,
  SIMILARITY_THRESHOLDS,
  CONFIDENCE_THRESHOLDS,
  generateMemoryId,
  joinArray,
  containsPII,
  calculateFinalScore,
  getCollectionName,
} from './types.js';

const logger = createModuleLogger('memory-store');

// ============================================================================
// Configuration Types
// ============================================================================

export interface MemoryStoreConfig {
  /** ChromaDB server URL (default: from config.chromaUrl) */
  chromaUrl?: string;
  /** ChromaDB tenant */
  tenant?: string;
  /** ChromaDB database */
  database?: string;
  /** User ID override (default: machine fingerprint) */
  userId?: string;
  /** Embedding model ID for tracking */
  embeddingModelId?: string;
  /** Access count flush interval in ms (default: 60000) */
  accessFlushIntervalMs?: number;
  /** Max accumulated accesses before flush (default: 100) */
  accessFlushThreshold?: number;
}

const DEFAULT_CONFIG: Required<Omit<MemoryStoreConfig, 'chromaUrl' | 'userId' | 'embeddingModelId'>> = {
  tenant: 'default_tenant',
  database: 'default_database',
  accessFlushIntervalMs: 60_000,
  accessFlushThreshold: 100,
};

// ============================================================================
// User ID Generation
// ============================================================================

/**
 * Generate default user ID from machine fingerprint.
 * Uses: hash(hostname + username)
 */
function generateMachineUserId(): string {
  const hostname = os.hostname();
  const username = os.userInfo().username;
  return crypto.createHash('sha256')
    .update(`${hostname}${username}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Resolve effective user ID.
 * Priority: config userId > env PREFLIGHT_USER_ID > config file memory.userId > machine fingerprint
 */
function resolveUserId(configUserId?: string): string {
  if (configUserId) return configUserId;
  
  const envUserId = process.env.PREFLIGHT_USER_ID;
  if (envUserId) return envUserId;
  
  // Note: Could also check config file memory.userId here if needed
  return generateMachineUserId();
}

// ============================================================================
// Memory Store Class
// ============================================================================

/**
 * Memory Store for 3-Layer LTM System.
 */
export class MemoryStore {
  private config: Required<Omit<MemoryStoreConfig, 'userId' | 'embeddingModelId'>> & {
    chromaUrl: string;
    userId: string;
    embeddingModelId: string;
  };
  
  private collections: Map<string, ChromaCollection> = new Map();
  
  /** Access count buffer for batch updates */
  private accessBuffer: Map<string, AccessDelta> = new Map();
  private accessFlushTimer?: ReturnType<typeof setInterval>;
  private totalAccessesSinceFlush = 0;

  constructor(config?: MemoryStoreConfig) {
    const appConfig = getConfig();
    
    this.config = {
      ...DEFAULT_CONFIG,
      chromaUrl: config?.chromaUrl ?? appConfig.chromaUrl,
      userId: resolveUserId(config?.userId),
      embeddingModelId: config?.embeddingModelId ?? 'unknown',
      ...config,
    };
    
    this.startAccessFlushTimer();
    logger.info(`MemoryStore initialized`, {
      userId: this.config.userId,
      chromaUrl: this.config.chromaUrl,
    });
  }

  // --------------------------------------------------------------------------
  // HTTP Helpers
  // --------------------------------------------------------------------------

  private getBasePath(): string {
    return `/api/v2/tenants/${this.config.tenant}/databases/${this.config.database}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.config.chromaUrl}${path}`;
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

  /**
   * Ensure all memory collections exist.
   */
  async ensureCollections(): Promise<void> {
    for (const layer of MEMORY_LAYERS) {
      await this.ensureCollection(layer);
    }
  }

  /**
   * Ensure a single collection exists.
   */
  private async ensureCollection(layer: MemoryLayer): Promise<ChromaCollection> {
    const name = getCollectionName(layer);
    
    // Check cache
    const cached = this.collections.get(name);
    if (cached) return cached;

    const basePath = this.getBasePath();

    try {
      // Try to get existing collection
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

    // Create new collection with cosine distance (important for semantic similarity)
    logger.info(`Creating memory collection: ${name}`);
    const collection = await this.request<ChromaCollection>(
      'POST',
      `${basePath}/collections`,
      {
        name,
        metadata: { 
          layer, 
          schemaVersion: SCHEMA_VERSION,
        },
        configuration: {
          hnsw_configuration: {
            space: 'cosine',  // Use cosine distance for semantic similarity
          },
        },
      }
    );
    this.collections.set(name, collection);
    return collection;
  }

  // --------------------------------------------------------------------------
  // User ID Access
  // --------------------------------------------------------------------------

  /**
   * Get the effective user ID.
   */
  getEffectiveUserId(): string {
    return this.config.userId;
  }

  // --------------------------------------------------------------------------
  // Add Operations
  // --------------------------------------------------------------------------

  /**
   * Add episodic memory.
   */
  async addEpisodic(
    input: AddEpisodicInput,
    embedding?: number[]
  ): Promise<EpisodicMemory> {
    // PII check
    if (containsPII(input.content)) {
      throw new Error('Content contains sensitive information (PII/secrets). Cannot store.');
    }

    const now = Date.now();
    const id = generateMemoryId('episodic', this.config.userId, input.content, {
      sessionId: input.sessionId,
      createdAtMs: now,
    });

    const metadata: EpisodicMetadata = {
      userId: this.config.userId,
      sessionId: input.sessionId ?? 'default',
      type: input.type ?? 'conversation',
      participantsJoined: joinArray(input.participants),
      tagsJoined: joinArray(input.tags),
      embeddingModelId: this.config.embeddingModelId,
    };

    const memory: EpisodicMemory = {
      id,
      content: input.content,
      embedding,
      layer: 'episodic',
      createdAtMs: now,
      lastAccessedAtMs: now,
      accessCount: 1,
      schemaVersion: SCHEMA_VERSION,
      metadata,
    };

    // Check for duplicates (similarity > 0.9)
    if (embedding) {
      const duplicates = await this.findDuplicates('episodic', embedding, 0.9);
      if (duplicates.length > 0) {
        logger.warn(`Duplicate episodic memory detected`, { duplicateIds: duplicates.map(d => d.id) });
        // Could either throw, merge, or just warn - for now we warn and continue
      }
    }

    await this.upsertMemory(memory);
    
    // Check episodic limit (1000 per user)
    await this.enforceEpisodicLimit();
    
    return memory;
  }

  /**
   * Add semantic memory with confidence gating.
   */
  async addSemantic(
    input: AddSemanticInput,
    embedding?: number[]
  ): Promise<SemanticMemory | null> {
    // Confidence gate
    if (input.confidence < CONFIDENCE_THRESHOLDS.semantic) {
      logger.info(`Semantic memory rejected: confidence ${input.confidence} < ${CONFIDENCE_THRESHOLDS.semantic}`);
      return null;
    }

    // PII check
    if (containsPII(input.content)) {
      throw new Error('Content contains sensitive information (PII/secrets). Cannot store.');
    }

    const now = Date.now();
    const id = generateMemoryId('semantic', this.config.userId, input.content, {
      type: input.type,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
    });

    // Conflict detection for relations
    let status: 'active' | 'disputed' = 'active';
    if (input.type === 'relation' && input.subject && input.predicate) {
      const conflicts = await this.findConflictingRelations(
        input.subject,
        input.predicate,
        input.object
      );
      if (conflicts.length > 0) {
        status = 'disputed';
        logger.warn(`Conflicting relation detected`, {
          subject: input.subject,
          predicate: input.predicate,
          newObject: input.object,
          conflictingIds: conflicts.map(c => c.id),
        });
      }
    }

    const metadata: SemanticMetadata = {
      userId: this.config.userId,
      type: input.type,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      confidence: input.confidence,
      sourceEpisodeIdsJoined: joinArray(input.sourceEpisodeIds),
      status,
      embeddingModelId: this.config.embeddingModelId,
    };

    const memory: SemanticMemory = {
      id,
      content: input.content,
      embedding,
      layer: 'semantic',
      createdAtMs: now,
      lastAccessedAtMs: now,
      accessCount: 1,
      schemaVersion: SCHEMA_VERSION,
      metadata,
    };

    await this.upsertMemory(memory);
    return memory;
  }

  /**
   * Add procedural memory with confidence and occurrence gating.
   */
  async addProcedural(
    input: AddProceduralInput,
    embedding?: number[]
  ): Promise<ProceduralMemory | null> {
    const strength = input.strength ?? 0.8;
    const occurrenceCount = input.occurrenceCount ?? 1;

    // Procedural gate: occurrenceCount >= 2 AND confidence >= 0.8
    if (occurrenceCount < 2 || strength < CONFIDENCE_THRESHOLDS.procedural) {
      logger.info(`Procedural memory rejected: occurrenceCount=${occurrenceCount}, strength=${strength}`);
      return null;
    }

    // PII check
    if (containsPII(input.content)) {
      throw new Error('Content contains sensitive information (PII/secrets). Cannot store.');
    }

    const now = Date.now();
    const id = generateMemoryId('procedural', this.config.userId, input.content, {
      category: input.category,
    });

    const metadata: ProceduralMetadata = {
      userId: this.config.userId,
      type: input.type,
      category: input.category,
      strength,
      occurrenceCount,
      lastUpdatedAtMs: now,
      sourceMemoryIdsJoined: joinArray(input.sourceMemoryIds),
      abstractionLevel: input.abstractionLevel ?? 'shallow',
      status: 'active',
      embeddingModelId: this.config.embeddingModelId,
    };

    const memory: ProceduralMemory = {
      id,
      content: input.content,
      embedding,
      layer: 'procedural',
      createdAtMs: now,
      lastAccessedAtMs: now,
      accessCount: 1,
      schemaVersion: SCHEMA_VERSION,
      metadata,
    };

    await this.upsertMemory(memory);
    return memory;
  }

  // --------------------------------------------------------------------------
  // Upsert Helper
  // --------------------------------------------------------------------------

  private async upsertMemory(memory: Memory): Promise<void> {
    const collection = await this.ensureCollection(memory.layer);
    const basePath = this.getBasePath();

    // Flatten metadata for ChromaDB
    const flatMetadata: Record<string, string | number | boolean> = {
      userId: memory.metadata.userId,
      layer: memory.layer,
      createdAtMs: memory.createdAtMs,
      lastAccessedAtMs: memory.lastAccessedAtMs,
      accessCount: memory.accessCount,
      schemaVersion: memory.schemaVersion,
    };

    // Add layer-specific metadata
    for (const [key, value] of Object.entries(memory.metadata)) {
      if (value !== undefined && value !== null) {
        flatMetadata[key] = value as string | number | boolean;
      }
    }

    const upsertData: {
      ids: string[];
      documents: string[];
      metadatas: Record<string, string | number | boolean>[];
      embeddings?: number[][];
    } = {
      ids: [memory.id],
      documents: [memory.content],
      metadatas: [flatMetadata],
    };

    if (memory.embedding && memory.embedding.length > 0) {
      upsertData.embeddings = [memory.embedding];
    }

    await this.request('POST', `${basePath}/collections/${collection.id}/upsert`, upsertData);
    logger.debug(`Upserted memory: ${memory.id}`, { layer: memory.layer });
  }

  // --------------------------------------------------------------------------
  // Search Operations
  // --------------------------------------------------------------------------

  /**
   * Search memories across layers.
   */
  async search(
    options: SearchOptions,
    queryEmbedding?: number[]
  ): Promise<SearchResult> {
    const layers = options.layers ?? MEMORY_LAYERS;
    const topK = options.topK ?? 5;
    const limit = Math.min(options.limit ?? 20, 100);
    
    // topK allocation weights: procedural=3, semantic=2, episodic=1
    const weights = { procedural: 3, semantic: 2, episodic: 1 };
    const totalWeight = layers.reduce((sum, l) => sum + weights[l], 0);

    const byLayer: SearchResult['byLayer'] = {
      procedural: [],
      semantic: [],
      episodic: [],
    };

    let totalFound = 0;
    const conflictingIds: string[] = [];

    for (const layer of layers) {
      const layerTopK = Math.ceil(topK * (weights[layer] / totalWeight));
      const threshold = SIMILARITY_THRESHOLDS[layer];

      const results = await this.searchLayer(
        layer,
        queryEmbedding,
        layerTopK * 2, // Fetch more for filtering
        options.filters
      );

      // Apply threshold and score calculation
      for (const result of results) {
        const similarity = result.score;
        if (similarity < threshold) continue;

        const { score, breakdown } = calculateFinalScore(
          similarity,
          result.lastAccessedAtMs,
          result.accessCount
        );

        const searchResult: MemorySearchResult = {
          id: result.id,
          layer,
          content: result.content,
          metadata: result.metadata,
          score,
          scoreBreakdown: breakdown,
        };

        byLayer[layer].push(searchResult);
        totalFound++;

        // Track access
        this.trackAccess(result.id);
      }

      // Sort by score and limit
      byLayer[layer].sort((a, b) => b.score - a.score);
      byLayer[layer] = byLayer[layer].slice(0, layerTopK);
    }

    // Detect conflicts in semantic results
    const semanticConflicts = this.detectSemanticConflicts(byLayer.semantic);
    conflictingIds.push(...semanticConflicts);

    // Merge all results with layer priority
    const allMemories: MemorySearchResult[] = [
      ...byLayer.procedural,
      ...byLayer.semantic,
      ...byLayer.episodic,
    ];
    allMemories.sort((a, b) => b.score - a.score);

    const memories = allMemories.slice(options.offset ?? 0, (options.offset ?? 0) + limit);

    const result: SearchResult = {
      memories,
      byLayer,
      totalFound,
      coldStart: totalFound === 0,
    };

    if (conflictingIds.length > 0) {
      result._conflictWarning = `Conflicting facts detected in semantic memories`;
      result.conflictingIds = conflictingIds;
    }

    if (result.coldStart) {
      result.suggestion = 'No memories found. Consider adding some memories first.';
    }


    return result;
  }

  private async searchLayer(
    layer: MemoryLayer,
    embedding: number[] | undefined,
    topK: number,
    filters?: SearchFilters
  ): Promise<Array<{
    id: string;
    content: string;
    metadata: Record<string, unknown>;
    score: number;
    lastAccessedAtMs: number;
    accessCount: number;
  }>> {
    const collection = await this.ensureCollection(layer);
    const basePath = this.getBasePath();

    // Build where clause
    const whereClause = this.buildWhereClause(filters);
    
    // Safety check: ensure whereClause is valid
    // If undefined, pass undefined to query (no filter)
    const finalWhere = (whereClause && Object.keys(whereClause).length > 0) 
      ? whereClause 
      : undefined;

    if (!embedding || embedding.length === 0) {
      // No embedding - get all and return with score 0
      const response = await this.request<ChromaGetResponse>(
        'POST',
        `${basePath}/collections/${collection.id}/get`,
        {
          where: finalWhere,
          include: ['documents', 'metadatas'],
          limit: topK,
        }
      );

      return response.ids.map((id, i) => ({
        id,
        content: response.documents?.[i] ?? '',
        metadata: response.metadatas?.[i] ?? {},
        score: 0,
        lastAccessedAtMs: (response.metadatas?.[i]?.lastAccessedAtMs as number) ?? Date.now(),
        accessCount: (response.metadatas?.[i]?.accessCount as number) ?? 1,
      }));
    }

    // Query with embedding
    const response = await this.request<ChromaQueryResponse>(
      'POST',
      `${basePath}/collections/${collection.id}/query`,
      {
        query_embeddings: [embedding],
        n_results: topK,
        include: ['documents', 'metadatas', 'distances'],
        where: finalWhere,
      }
    );

    const results: Array<{
      id: string;
      content: string;
      metadata: Record<string, unknown>;
      score: number;
      lastAccessedAtMs: number;
      accessCount: number;
    }> = [];

    if (response.ids[0]) {
      for (let i = 0; i < response.ids[0].length; i++) {
        const id = response.ids[0][i]!;
        const distance = response.distances?.[0]?.[i] ?? 0;
        const metadata = response.metadatas?.[0]?.[i] ?? {};

        results.push({
          id,
          content: response.documents?.[0]?.[i] ?? '',
          metadata,
          score: Math.max(0, 1 - distance), // Convert distance to similarity
          lastAccessedAtMs: (metadata.lastAccessedAtMs as number) ?? Date.now(),
          accessCount: (metadata.accessCount as number) ?? 1,
        });
      }
    }

    return results;
  }

  private buildWhereClause(filters?: SearchFilters): Record<string, unknown> | undefined {
    // If no filters provided, return undefined to query all (skip userId check for debugging)
    if (!filters) return undefined;

    const conditions: Record<string, unknown>[] = [];
    
    // Optional: Include userId if needed, but disable for now to fix "Invalid where clause"
    // conditions.push({ userId: this.config.userId });

    if (filters.type) {
      conditions.push({ type: filters.type });
    }
    if (filters.category) {
      conditions.push({ category: filters.category });
    }
    if (filters.subject) {
      conditions.push({ subject: filters.subject });
    }
    if (filters.status) {
      conditions.push({ status: filters.status });
    }
    if (filters.timeRangeMs?.startMs) {
      conditions.push({ createdAtMs: { $gte: filters.timeRangeMs.startMs } });
    }
    if (filters.timeRangeMs?.endMs) {
      conditions.push({ createdAtMs: { $lte: filters.timeRangeMs.endMs } });
    }

    if (conditions.length === 1) return conditions[0];
    return { $and: conditions };
  }

  // --------------------------------------------------------------------------
  // Conflict Detection
  // --------------------------------------------------------------------------

  private async findConflictingRelations(
    subject: string,
    predicate: string,
    newObject?: string
  ): Promise<Array<{ id: string; object?: string }>> {
    const collection = await this.ensureCollection('semantic');
    const basePath = this.getBasePath();

    // Skip complex where clause - get all and filter client-side
    let response: ChromaGetResponse;
    try {
      response = await this.request<ChromaGetResponse>(
        'POST',
        `${basePath}/collections/${collection.id}/get`,
        {
          include: ['metadatas'],
        }
      );
    } catch {
      // If get fails, return empty (no conflicts)
      return [];
    }

    const conflicts: Array<{ id: string; object?: string }> = [];
    for (let i = 0; i < response.ids.length; i++) {
      const meta = response.metadatas?.[i];
      // Client-side filter: match userId, type=relation, subject, predicate
      if (meta?.userId !== this.config.userId) continue;
      if (meta?.type !== 'relation') continue;
      if (meta?.subject !== subject) continue;
      if (meta?.predicate !== predicate) continue;
      
      const obj = meta?.object as string | undefined;
      if (obj && obj !== newObject) {
        conflicts.push({ id: response.ids[i]!, object: obj });
      }
    }

    return conflicts;
  }

  private detectSemanticConflicts(semanticResults: MemorySearchResult[]): string[] {
    const relationMap = new Map<string, string[]>();
    const conflicts: string[] = [];

    for (const result of semanticResults) {
      const type = result.metadata.type as string;
      if (type !== 'relation') continue;

      const subject = result.metadata.subject as string;
      const predicate = result.metadata.predicate as string;
      const key = `${subject}:${predicate}`;

      const existing = relationMap.get(key);
      if (existing) {
        existing.push(result.id);
        conflicts.push(...existing);
      } else {
        relationMap.set(key, [result.id]);
      }
    }

    return [...new Set(conflicts)];
  }

  // --------------------------------------------------------------------------
  // Duplicate Detection
  // --------------------------------------------------------------------------

  private async findDuplicates(
    layer: MemoryLayer,
    embedding: number[],
    threshold: number
  ): Promise<Array<{ id: string; score: number }>> {
    const collection = await this.ensureCollection(layer);
    const basePath = this.getBasePath();

    // Skip duplicate check if collection might be empty or userId filtering fails
    try {
      const response = await this.request<ChromaQueryResponse>(
        'POST',
        `${basePath}/collections/${collection.id}/query`,
        {
          query_embeddings: [embedding],
          n_results: 5,
          include: ['distances'],
          // Skip where clause - query all and filter client-side for safety
        }
      );

    const duplicates: Array<{ id: string; score: number }> = [];
    if (response.ids[0]) {
      for (let i = 0; i < response.ids[0].length; i++) {
        const distance = response.distances?.[0]?.[i] ?? 1;
        const similarity = 1 - distance;
        if (similarity >= threshold) {
          duplicates.push({ id: response.ids[0][i]!, score: similarity });
        }
      }
    }

    return duplicates;
    } catch (err) {
      // If query fails (e.g., empty collection), skip duplicate check
      logger.debug('findDuplicates query failed, skipping', { error: (err as Error).message });
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // Delete Operations
  // --------------------------------------------------------------------------

  /**
   * Delete a memory by ID.
   */
  async delete(memoryId: string): Promise<boolean> {
    // Determine layer from ID prefix
    const layer = this.getLayerFromId(memoryId);
    if (!layer) {
      logger.warn(`Invalid memory ID format: ${memoryId}`);
      return false;
    }

    const collection = await this.ensureCollection(layer);
    const basePath = this.getBasePath();

    try {
      await this.request('POST', `${basePath}/collections/${collection.id}/delete`, {
        ids: [memoryId],
      });
      logger.info(`Deleted memory: ${memoryId}`);
      return true;
    } catch (err) {
      logger.error(`Failed to delete memory: ${memoryId}`, err as Error);
      return false;
    }
  }

  private getLayerFromId(memoryId: string): MemoryLayer | null {
    if (memoryId.startsWith('mem_epi_')) return 'episodic';
    if (memoryId.startsWith('mem_sem_')) return 'semantic';
    if (memoryId.startsWith('mem_pro_')) return 'procedural';
    return null;
  }

  // --------------------------------------------------------------------------
  // List Operations
  // --------------------------------------------------------------------------

  /**
   * List memories with pagination.
   */
  async list(options?: ListOptions): Promise<ListResult> {
    const layers = options?.layer ? [options.layer] : MEMORY_LAYERS;
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;
    const sortBy = options?.sortBy ?? 'lastAccessed';
    const order = options?.order ?? 'desc';

    const allMemories: Memory[] = [];

    for (const layer of layers) {
      const collection = await this.ensureCollection(layer);
      const basePath = this.getBasePath();

      // Temporarily disable userId filter for list
      const where = undefined; // { userId: this.config.userId };
      // logger.debug(`List ${layer} with where:`, where);

      const response = await this.request<ChromaGetResponse>(
        'POST',
        `${basePath}/collections/${collection.id}/get`,
        {
          where: where || undefined, // Fix: pass undefined if where is empty
          include: ['documents', 'metadatas'],
        }
      );

      for (let i = 0; i < response.ids.length; i++) {
        const metadata = response.metadatas?.[i] ?? {};
        const memory = this.reconstructMemory(
          response.ids[i]!,
          response.documents?.[i] ?? '',
          metadata,
          layer
        );
        if (memory) allMemories.push(memory);
      }
    }

    // Sort
    const sortKey = sortBy === 'createdAt' ? 'createdAtMs' : 
                    sortBy === 'lastAccessed' ? 'lastAccessedAtMs' : 'accessCount';
    allMemories.sort((a, b) => {
      const aVal = a[sortKey] as number;
      const bVal = b[sortKey] as number;
      return order === 'desc' ? bVal - aVal : aVal - bVal;
    });

    const total = allMemories.length;
    const memories = allMemories.slice(offset, offset + limit);

    return {
      memories,
      total,
      hasMore: offset + limit < total,
    };
  }

  private reconstructMemory(
    id: string,
    content: string,
    metadata: Record<string, unknown>,
    layer: MemoryLayer
  ): Memory | null {
    const base = {
      id,
      content,
      layer,
      createdAtMs: (metadata.createdAtMs as number) ?? Date.now(),
      lastAccessedAtMs: (metadata.lastAccessedAtMs as number) ?? Date.now(),
      accessCount: (metadata.accessCount as number) ?? 1,
      schemaVersion: (metadata.schemaVersion as string) ?? SCHEMA_VERSION,
    };

    switch (layer) {
      case 'episodic':
        return {
          ...base,
          layer: 'episodic',
          metadata: {
            userId: metadata.userId as string,
            sessionId: (metadata.sessionId as string) ?? 'default',
            type: (metadata.type as EpisodicMetadata['type']) ?? 'conversation',
            participantsJoined: metadata.participantsJoined as string | undefined,
            tagsJoined: metadata.tagsJoined as string | undefined,
            embeddingModelId: metadata.embeddingModelId as string | undefined,
          },
        } as EpisodicMemory;
      
      case 'semantic':
        return {
          ...base,
          layer: 'semantic',
          metadata: {
            userId: metadata.userId as string,
            type: (metadata.type as SemanticMetadata['type']) ?? 'fact',
            subject: metadata.subject as string | undefined,
            predicate: metadata.predicate as string | undefined,
            object: metadata.object as string | undefined,
            confidence: (metadata.confidence as number) ?? 0.7,
            sourceEpisodeIdsJoined: metadata.sourceEpisodeIdsJoined as string | undefined,
            status: (metadata.status as SemanticMetadata['status']) ?? 'active',
            embeddingModelId: metadata.embeddingModelId as string | undefined,
          },
        } as SemanticMemory;
      
      case 'procedural':
        return {
          ...base,
          layer: 'procedural',
          metadata: {
            userId: metadata.userId as string,
            type: (metadata.type as ProceduralMetadata['type']) ?? 'preference',
            category: (metadata.category as string) ?? 'general',
            strength: (metadata.strength as number) ?? 0.8,
            occurrenceCount: (metadata.occurrenceCount as number) ?? 1,
            lastUpdatedAtMs: (metadata.lastUpdatedAtMs as number) ?? Date.now(),
            sourceMemoryIdsJoined: metadata.sourceMemoryIdsJoined as string | undefined,
            abstractionLevel: (metadata.abstractionLevel as ProceduralMetadata['abstractionLevel']) ?? 'shallow',
            status: (metadata.status as ProceduralMetadata['status']) ?? 'active',
            embeddingModelId: metadata.embeddingModelId as string | undefined,
          },
        } as ProceduralMemory;
    }
  }

  // --------------------------------------------------------------------------
  // Stats Operations
  // --------------------------------------------------------------------------

  /**
   * Get memory statistics.
   */
  async stats(): Promise<StatsResult> {
    const counts: Record<MemoryLayer, number> = {
      episodic: 0,
      semantic: 0,
      procedural: 0,
    };

    const embeddingModels = new Set<string>();

    for (const layer of MEMORY_LAYERS) {
      const collection = await this.ensureCollection(layer);
      const basePath = this.getBasePath();

      try {
        const response = await this.request<ChromaGetResponse>(
          'POST',
          `${basePath}/collections/${collection.id}/get`,
          {
            // Skip where clause - get all
            include: ['metadatas'],
          }
        );
        
        counts[layer] = response.ids.length;
        
        // Track embedding models
        for (const meta of response.metadatas ?? []) {
          const modelId = meta?.embeddingModelId as string | undefined;
          if (modelId) embeddingModels.add(modelId);
        }
      } catch {
        counts[layer] = 0;
      }
    }

    // Load health meta
    const healthMeta = this.loadHealthMeta();

    const embeddingInfo: StatsResult['embeddingInfo'] = {
      currentModelId: this.config.embeddingModelId,
    };

    if (embeddingModels.size > 1) {
      embeddingInfo.mixedModelsWarning = `Multiple embedding models detected: ${[...embeddingModels].join(', ')}. This may affect search quality.`;
    }

    return {
      effectiveUserId: this.config.userId,
      episodicCount: counts.episodic,
      semanticCount: counts.semantic,
      proceduralCount: counts.procedural,
      healthCheck: {
        lastReflectAtMs: healthMeta.lastReflectAtMs,
        episodicSinceReflect: counts.episodic - healthMeta.episodicCountAtReflect,
        shouldReflect: counts.episodic - healthMeta.episodicCountAtReflect >= 10,
        oldestUnreflectedAtMs: null, // Would need to track this
      },
      embeddingInfo,
    };
  }

  // --------------------------------------------------------------------------
  // GC (Garbage Collection)
  // --------------------------------------------------------------------------

  /**
   * Garbage collect old memories.
   */
  async gc(options?: GCOptions): Promise<GCResult> {
    const layers = options?.layers ?? ['episodic'];
    const maxAgeDays = options?.maxAgeDays ?? 90;
    const minAccessCount = options?.minAccessCount ?? 1;
    const dryRun = options?.dryRun ?? false;

    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const cutoffMs = Date.now() - maxAgeMs;

    const deletedByLayer: Record<MemoryLayer, number> = {
      episodic: 0,
      semantic: 0,
      procedural: 0,
    };

    let dangerWarning: string | undefined;

    // Warn if cleaning non-episodic layers
    if (layers.includes('semantic') || layers.includes('procedural')) {
      dangerWarning = 'Warning: Cleaning semantic or procedural memories may remove valuable learned information.';
    }

    for (const layer of layers) {
      const collection = await this.ensureCollection(layer);
      const basePath = this.getBasePath();

      const response = await this.request<ChromaGetResponse>(
        'POST',
        `${basePath}/collections/${collection.id}/get`,
        {
          // Skip where clause - get all and filter client-side
          include: ['metadatas'],
        }
      );

      const toDelete: string[] = [];
      for (let i = 0; i < response.ids.length; i++) {
        const meta = response.metadatas?.[i];
        const lastAccessed = (meta?.lastAccessedAtMs as number) ?? Date.now();
        const accessCount = (meta?.accessCount as number) ?? 1;

        // Delete if: (older than maxAge) OR (low access count)
        if (lastAccessed < cutoffMs || accessCount < minAccessCount) {
          toDelete.push(response.ids[i]!);
        }
      }

      if (!dryRun && toDelete.length > 0) {
        await this.request('POST', `${basePath}/collections/${collection.id}/delete`, {
          ids: toDelete,
        });
      }

      deletedByLayer[layer] = toDelete.length;
    }

    const deletedCount = Object.values(deletedByLayer).reduce((a, b) => a + b, 0);

    logger.info(`GC completed`, { deletedCount, dryRun, layers });

    const result: GCResult = {
      deletedCount,
      deletedByLayer,
    };

    if (dangerWarning) {
      result._dangerWarning = dangerWarning;
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // Episodic Limit Enforcement
  // --------------------------------------------------------------------------

  private async enforceEpisodicLimit(): Promise<void> {
    const MAX_EPISODIC = 1000;
    
    const collection = await this.ensureCollection('episodic');
    const basePath = this.getBasePath();

    try {
      const response = await this.request<ChromaGetResponse>(
        'POST',
        `${basePath}/collections/${collection.id}/get`,
        {
          // Skip where clause for now - get all and filter client-side
          include: ['metadatas'],
        }
      );

    if (response.ids.length <= MAX_EPISODIC) return;

    // Sort by createdAtMs and delete oldest
    const items = response.ids.map((id, i) => ({
      id,
      createdAtMs: (response.metadatas?.[i]?.createdAtMs as number) ?? 0,
    }));
    items.sort((a, b) => a.createdAtMs - b.createdAtMs);

    const toDelete = items.slice(0, items.length - MAX_EPISODIC).map(item => item.id);
    
    if (toDelete.length > 0) {
      await this.request('POST', `${basePath}/collections/${collection.id}/delete`, {
        ids: toDelete,
      });
      logger.info(`Enforced episodic limit, deleted ${toDelete.length} oldest memories`);
    }
    } catch (err) {
      // If enforcement fails, log and continue (non-critical)
      logger.debug('enforceEpisodicLimit failed, skipping', { error: (err as Error).message });
    }
  }

  // --------------------------------------------------------------------------
  // Access Count Buffering
  // --------------------------------------------------------------------------

  private trackAccess(memoryId: string): void {
    const now = Date.now();
    const existing = this.accessBuffer.get(memoryId);
    
    if (existing) {
      existing.accessDelta++;
      existing.lastAccessedAtMs = now;
    } else {
      this.accessBuffer.set(memoryId, { accessDelta: 1, lastAccessedAtMs: now });
    }

    this.totalAccessesSinceFlush++;

    // Flush if threshold reached
    if (this.totalAccessesSinceFlush >= this.config.accessFlushThreshold) {
      this.flushAccessBuffer().catch(err => {
        logger.error('Failed to flush access buffer', err);
      });
    }
  }

  private startAccessFlushTimer(): void {
    this.accessFlushTimer = setInterval(() => {
      this.flushAccessBuffer().catch(err => {
        logger.error('Failed to flush access buffer', err);
      });
    }, this.config.accessFlushIntervalMs);

    // Don't keep process alive
    this.accessFlushTimer.unref?.();
  }

  private async flushAccessBuffer(): Promise<void> {
    if (this.accessBuffer.size === 0) return;

    const buffer = new Map(this.accessBuffer);
    this.accessBuffer.clear();
    this.totalAccessesSinceFlush = 0;

    // Group by layer
    const byLayer = new Map<MemoryLayer, Array<{ id: string; delta: AccessDelta }>>();
    
    for (const [id, delta] of buffer) {
      const layer = this.getLayerFromId(id);
      if (!layer) continue;

      const layerItems = byLayer.get(layer) ?? [];
      layerItems.push({ id, delta });
      byLayer.set(layer, layerItems);
    }

    // Update each layer
    for (const [layer, items] of byLayer) {
      const collection = await this.ensureCollection(layer);
      const basePath = this.getBasePath();

      // Get current values
      const ids = items.map(item => item.id);
      const response = await this.request<ChromaGetResponse>(
        'POST',
        `${basePath}/collections/${collection.id}/get`,
        { ids, include: ['metadatas'] }
      );

      // Update metadata
      const updates: Array<{
        id: string;
        metadata: Record<string, string | number | boolean>;
      }> = [];

      for (let i = 0; i < response.ids.length; i++) {
        const id = response.ids[i]!;
        const item = items.find(it => it.id === id);
        if (!item) continue;

        const meta = response.metadatas?.[i] ?? {};
        const currentCount = (meta.accessCount as number) ?? 1;
        
        updates.push({
          id,
          metadata: {
            ...(meta as Record<string, string | number | boolean>),
            accessCount: currentCount + item.delta.accessDelta,
            lastAccessedAtMs: item.delta.lastAccessedAtMs,
          },
        });
      }

      // Batch update
      if (updates.length > 0) {
        await this.request('POST', `${basePath}/collections/${collection.id}/update`, {
          ids: updates.map(u => u.id),
          metadatas: updates.map(u => u.metadata),
        });
      }
    }

    logger.debug(`Flushed access buffer`, { count: buffer.size });
  }

  // --------------------------------------------------------------------------
  // Health Meta Persistence
  // --------------------------------------------------------------------------

  private getHealthMetaPath(): string {
    const preflightDir = path.join(os.homedir(), '.preflight');
    return path.join(preflightDir, `memory_meta_${this.config.userId}.json`);
  }

  private loadHealthMeta(): MemoryHealthMeta {
    const metaPath = this.getHealthMetaPath();
    
    try {
      if (fs.existsSync(metaPath)) {
        const content = fs.readFileSync(metaPath, 'utf8');
        return JSON.parse(content) as MemoryHealthMeta;
      }
    } catch (err) {
      logger.warn(`Failed to load health meta`, { path: metaPath, error: err });
    }

    return {
      lastReflectAtMs: null,
      episodicCountAtReflect: 0,
      schemaVersion: SCHEMA_VERSION,
    };
  }

  /**
   * Save health meta (called after reflection).
   */
  async saveHealthMeta(episodicCount: number): Promise<void> {
    const metaPath = this.getHealthMetaPath();
    const preflightDir = path.dirname(metaPath);

    try {
      if (!fs.existsSync(preflightDir)) {
        fs.mkdirSync(preflightDir, { recursive: true });
      }

      const meta: MemoryHealthMeta = {
        lastReflectAtMs: Date.now(),
        episodicCountAtReflect: episodicCount,
        schemaVersion: SCHEMA_VERSION,
      };

      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      logger.info(`Saved health meta`, { path: metaPath });
    } catch (err) {
      logger.error(`Failed to save health meta`, err as Error);
    }
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  /**
   * Get a specific memory by ID.
   */
  async getById(memoryId: string): Promise<Memory | null> {
    // Determine layer from ID prefix
    const layer = this.getLayerFromId(memoryId);
    if (!layer) {
      logger.warn(`Invalid memory ID format: ${memoryId}`);
      return null;
    }

    const collection = await this.ensureCollection(layer);
    const basePath = this.getBasePath();

    const response = await this.request<ChromaGetResponse>(
      'POST',
      `${basePath}/collections/${collection.id}/get`,
      {
        ids: [memoryId],
        include: ['documents', 'metadatas'],
      }
    );

    if (response.ids.length === 0) {
      logger.debug(`Memory not found: ${memoryId}`);
      return null;
    }

    const content = response.documents?.[0] ?? '';
    const metadata = response.metadatas?.[0] ?? {};
    
    return this.reconstructMemory(memoryId, content, metadata, layer);
  }

  /**
   * Update memory metadata by ID (only metadata, not content).
   */
  async update(memoryId: string, metadataUpdates: Partial<EpisodicMetadata | SemanticMetadata | ProceduralMetadata>, mergeMode: 'replace' | 'append' = 'replace'): Promise<boolean> {
    // Determine layer from ID prefix
    const layer = this.getLayerFromId(memoryId);
    if (!layer) {
      logger.warn(`Invalid memory ID format: ${memoryId}`);
      return false;
    }

    const collection = await this.ensureCollection(layer);
    const basePath = this.getBasePath();

    // Get existing memory
    const response = await this.request<ChromaGetResponse>(
      'POST',
      `${basePath}/collections/${collection.id}/get`,
      {
        ids: [memoryId],
        include: ['documents', 'metadatas'],
      }
    );

    if (response.ids.length === 0) {
      logger.warn(`Memory not found for update: ${memoryId}`);
      return false;
    }

    const existingContent = response.documents?.[0] ?? '';
    const existingMetadata = response.metadatas?.[0] ?? {};
    const newMetadata = { ...existingMetadata };

    // Apply updates based on merge mode and metadata type
    for (const [key, value] of Object.entries(metadataUpdates)) {
      if (value !== undefined) {
        if (mergeMode === 'append' && typeof value === 'string' && typeof newMetadata[key] === 'string') {
          // For append mode with string values, concatenate
          newMetadata[key] = `${newMetadata[key]} ${value}`.trim();
        } else if (mergeMode === 'append' && Array.isArray(value)) {
          // For append mode with array values, merge arrays
          const existingValue = newMetadata[key];
          const existingArray = typeof existingValue === 'string' ? existingValue.split(',').filter(Boolean) : [];
          newMetadata[key] = [...new Set([...existingArray, ...value])].join(',');
        } else {
          // For replace mode or non-appendable types, replace directly
          newMetadata[key] = value as string | number | boolean;
        }
      }
    }

    // Update the memory in ChromaDB
    await this.request('POST', `${basePath}/collections/${collection.id}/update`, {
      ids: [memoryId],
      documents: [existingContent], // Keep original content
      metadatas: [newMetadata],
    });

    logger.info(`Updated memory metadata: ${memoryId}`, { mergeMode });
    return true;
  }

  /**
   * Close the memory store and flush buffers.
   */
  async close(): Promise<void> {
    if (this.accessFlushTimer) {
      clearInterval(this.accessFlushTimer);
    }
    await this.flushAccessBuffer();
    logger.info('MemoryStore closed');
  }

  // --------------------------------------------------------------------------
  // Embedding Model Configuration
  // --------------------------------------------------------------------------

  /**
   * Update the embedding model ID (for tracking).
   */
  setEmbeddingModelId(modelId: string): void {
    this.config.embeddingModelId = modelId;
  }
}
