import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import Database from 'better-sqlite3';

export type TraceEntityRef = {
  type: string; // commit | jira_ticket | linear_issue | doc | symbol | test | ...
  id: string;
};

export type TraceSource = {
  file?: string; // bundle-relative posix
  range?: { startLine: number; startCol: number; endLine: number; endCol: number };
  externalUrl?: string;
  note?: string;
};

export type TraceEdgeInput = {
  id?: string;
  source: TraceEntityRef;
  target: TraceEntityRef;
  type: string; // mentions/tests/implements/relates_to/...
  confidence?: number; // 0..1
  method?: 'exact' | 'heuristic';
  sources?: TraceSource[];
};

export type TraceEdgeRow = {
  id: string;
  source: TraceEntityRef;
  target: TraceEntityRef;
  type: string;
  confidence: number;
  method: 'exact' | 'heuristic';
  sources: TraceSource[];
  createdAt: string;
  updatedAt: string;
};

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function edgeDeterministicId(e: TraceEdgeInput): string {
  if (e.id && e.id.trim()) return e.id.trim();
  return `tr_${sha256Hex(`${e.source.type}|${e.source.id}|${e.type}|${e.target.type}|${e.target.id}`).slice(0, 24)}`;
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export async function ensureTraceDb(traceDbPath: string): Promise<void> {
  await ensureDir(path.dirname(traceDbPath));

  const db = new Database(traceDbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    db.exec(`
      CREATE TABLE IF NOT EXISTS trace_edges (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        confidence REAL NOT NULL,
        method TEXT NOT NULL,
        sources_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_trace_edges_source ON trace_edges(source_type, source_id);
      CREATE INDEX IF NOT EXISTS idx_trace_edges_target ON trace_edges(target_type, target_id);
      CREATE INDEX IF NOT EXISTS idx_trace_edges_edge_type ON trace_edges(edge_type);
    `);
  } finally {
    db.close();
  }
}

export async function upsertTraceEdges(traceDbPath: string, edges: TraceEdgeInput[]): Promise<{ upserted: number; ids: string[] }> {
  await ensureTraceDb(traceDbPath);

  const db = new Database(traceDbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    const upsert = db.prepare(`
      INSERT INTO trace_edges (
        id, source_type, source_id, target_type, target_id, edge_type,
        confidence, method, sources_json, created_at, updated_at
      ) VALUES (
        @id, @source_type, @source_id, @target_type, @target_id, @edge_type,
        @confidence, @method, @sources_json, @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        source_type=excluded.source_type,
        source_id=excluded.source_id,
        target_type=excluded.target_type,
        target_id=excluded.target_id,
        edge_type=excluded.edge_type,
        confidence=excluded.confidence,
        method=excluded.method,
        sources_json=excluded.sources_json,
        updated_at=excluded.updated_at;
    `);

    const now = new Date().toISOString();

    const tx = db.transaction((items: TraceEdgeInput[]) => {
      const ids: string[] = [];
      for (const e of items) {
        const id = edgeDeterministicId(e);
        const confidence = typeof e.confidence === 'number' ? Math.max(0, Math.min(1, e.confidence)) : 0.5;
        const method = e.method === 'exact' ? 'exact' : 'heuristic';
        const sourcesJson = JSON.stringify(e.sources ?? []);

        // Preserve created_at on update by reading existing row (cheap single get)
        const existing = db
          .prepare('SELECT created_at FROM trace_edges WHERE id = ?')
          .get(id) as { created_at: string } | undefined;

        upsert.run({
          id,
          source_type: e.source.type,
          source_id: e.source.id,
          target_type: e.target.type,
          target_id: e.target.id,
          edge_type: e.type,
          confidence,
          method,
          sources_json: sourcesJson,
          created_at: existing?.created_at ?? now,
          updated_at: now,
        });

        ids.push(id);
      }
      return ids;
    });

    const ids = tx(edges);
    
    // Close DB before export (export opens its own readonly connection)
    db.close();
    
    // Auto-export to JSON after each upsert for LLM direct reading
    try {
      await exportTraceToJson(traceDbPath);
    } catch {
      // Non-critical: JSON export failure shouldn't block upsert
    }
    
    return { upserted: ids.length, ids };
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * Export all trace edges to a JSON file for LLM direct reading.
 * Called automatically after upsertTraceEdges.
 */
export async function exportTraceToJson(traceDbPath: string): Promise<{ exported: number; jsonPath: string }> {
  const jsonPath = traceDbPath.replace(/\.sqlite3$/, '.json');
  
  const db = new Database(traceDbPath, { readonly: true });
  try {
    const rows = db.prepare(`
      SELECT
        id, source_type, source_id, target_type, target_id,
        edge_type, confidence, method, sources_json, created_at, updated_at
      FROM trace_edges
      ORDER BY updated_at DESC
    `).all() as Array<{
      id: string;
      source_type: string;
      source_id: string;
      target_type: string;
      target_id: string;
      edge_type: string;
      confidence: number;
      method: string;
      sources_json: string;
      created_at: string;
      updated_at: string;
    }>;

    const edges = rows.map((r) => ({
      id: r.id,
      source: { type: r.source_type, id: r.source_id },
      target: { type: r.target_type, id: r.target_id },
      type: r.edge_type,
      confidence: r.confidence,
      method: r.method,
      sources: JSON.parse(r.sources_json || '[]'),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    const exportData = {
      exportedAt: new Date().toISOString(),
      totalEdges: edges.length,
      edges,
    };

    await fs.writeFile(jsonPath, JSON.stringify(exportData, null, 2), 'utf8');
    return { exported: edges.length, jsonPath };
  } finally {
    db.close();
  }
}

/**
 * List all unique source_ids in the trace database.
 * Used for "did you mean" suggestions.
 */
export function listAllSourceIds(traceDbPath: string, sourceType?: string): string[] {
  try {
    const db = new Database(traceDbPath, { readonly: true });
    try {
      let sql = 'SELECT DISTINCT source_id FROM trace_edges';
      const bind: Record<string, unknown> = {};
      
      if (sourceType) {
        sql += ' WHERE source_type = @source_type';
        bind.source_type = sourceType;
      }
      
      sql += ' LIMIT 1000';
      
      const rows = db.prepare(sql).all(bind) as Array<{ source_id: string }>;
      return rows.map((r) => r.source_id);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * Query trace edges with flexible source_id matching.
 * Supports both exact match and partial match (for normalized paths).
 */
export function queryTraceEdgesFlexible(traceDbPath: string, params: {
  source?: TraceEntityRef;
  sourceIdVariants?: string[];
  target?: TraceEntityRef;
  edgeType?: string;
  limit?: number;
}): TraceEdgeRow[] {
  const db = new Database(traceDbPath, { readonly: true });
  try {
    const where: string[] = [];
    const bind: Record<string, unknown> = {};

    if (params.source) {
      where.push('source_type = @source_type');
      bind.source_type = params.source.type;
      
      // If we have variants, use OR matching
      if (params.sourceIdVariants && params.sourceIdVariants.length > 1) {
        const idConditions = params.sourceIdVariants.map((_, i) => {
          bind[`source_id_${i}`] = params.sourceIdVariants![i];
          return `source_id = @source_id_${i}`;
        });
        // Also add LIKE conditions for partial matching (e.g., %/path/to/file%)
        const lastPart = params.source.id.split('/').pop() || params.source.id;
        bind.source_id_like = `%${lastPart}`;
        idConditions.push('source_id LIKE @source_id_like');
        
        where.push(`(${idConditions.join(' OR ')})`);
      } else {
        bind.source_id = params.source.id;
        where.push('source_id = @source_id');
      }
    }

    if (params.target) {
      where.push('target_type = @target_type AND target_id = @target_id');
      bind.target_type = params.target.type;
      bind.target_id = params.target.id;
    }

    if (params.edgeType) {
      where.push('edge_type = @edge_type');
      bind.edge_type = params.edgeType;
    }

    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, params.limit ?? 50));

    const stmt = db.prepare(`
      SELECT
        id,
        source_type,
        source_id,
        target_type,
        target_id,
        edge_type,
        confidence,
        method,
        sources_json,
        created_at,
        updated_at
      FROM trace_edges
      ${sqlWhere}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `);

    const rows = stmt.all(bind) as Array<{
      id: string;
      source_type: string;
      source_id: string;
      target_type: string;
      target_id: string;
      edge_type: string;
      confidence: number;
      method: 'exact' | 'heuristic';
      sources_json: string;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      source: { type: r.source_type, id: r.source_id },
      target: { type: r.target_type, id: r.target_id },
      type: r.edge_type,
      confidence: r.confidence,
      method: r.method === 'exact' ? 'exact' : 'heuristic',
      sources: ((): TraceSource[] => {
        try {
          const parsed = JSON.parse(r.sources_json) as TraceSource[];
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })(),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  } finally {
    db.close();
  }
}

export function queryTraceEdges(traceDbPath: string, params: {
  source?: TraceEntityRef;
  target?: TraceEntityRef;
  edgeType?: string;
  limit?: number;
}): TraceEdgeRow[] {
  const db = new Database(traceDbPath, { readonly: true });
  try {
    const where: string[] = [];
    const bind: Record<string, unknown> = {};

    if (params.source) {
      where.push('source_type = @source_type AND source_id = @source_id');
      bind.source_type = params.source.type;
      bind.source_id = params.source.id;
    }

    if (params.target) {
      where.push('target_type = @target_type AND target_id = @target_id');
      bind.target_type = params.target.type;
      bind.target_id = params.target.id;
    }

    if (params.edgeType) {
      where.push('edge_type = @edge_type');
      bind.edge_type = params.edgeType;
    }

    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, params.limit ?? 50));

    const stmt = db.prepare(`
      SELECT
        id,
        source_type,
        source_id,
        target_type,
        target_id,
        edge_type,
        confidence,
        method,
        sources_json,
        created_at,
        updated_at
      FROM trace_edges
      ${sqlWhere}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `);

    const rows = stmt.all(bind) as Array<{
      id: string;
      source_type: string;
      source_id: string;
      target_type: string;
      target_id: string;
      edge_type: string;
      confidence: number;
      method: 'exact' | 'heuristic';
      sources_json: string;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      source: { type: r.source_type, id: r.source_id },
      target: { type: r.target_type, id: r.target_id },
      type: r.edge_type,
      confidence: r.confidence,
      method: r.method === 'exact' ? 'exact' : 'heuristic',
      sources: ((): TraceSource[] => {
        try {
          const parsed = JSON.parse(r.sources_json) as TraceSource[];
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })(),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  } finally {
    db.close();
  }
}
