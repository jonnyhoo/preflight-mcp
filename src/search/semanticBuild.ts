/**
 * Semantic index builder (schema v3) with file-level incremental updates.
 */

import fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { IngestedFile } from '../bundle/ingest.js';
import type { BaseEmbedding } from '../embedding/base.js';
import type { EmbeddingDocument } from '../embedding/types.js';

export type SemanticIndexScope = 'docs' | 'code' | 'all';

export type BuildSemanticIndexOptions = {
  scope: SemanticIndexScope;
  fileTypeFilters?: string[];
  chunkLines: number;
  overlapLines: number;
  maxChunkChars: number;
  maxFiles?: number;
  maxChunks?: number;
  rebuild?: boolean;
};

export type BuildSemanticIndexResult = {
  ok: boolean;
  rebuilt: boolean;
  schemaVersion: number;
  dbPath: string;
  filesTotal: number;
  filesChanged: number;
  filesUnchanged: number;
  filesRemoved: number;
  chunksWritten: number;
  chunksEmbedded: number;
  durationMs: number;
  warnings?: string[];
  error?: string;
};

function normalizeExtFilter(filters: string[] | undefined): string[] | undefined {
  if (!filters || filters.length === 0) return undefined;
  const normalized = filters
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`));
  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}

function matchesExt(pathPosix: string, exts: string[] | undefined): boolean {
  if (!exts || exts.length === 0) return true;
  const idx = pathPosix.lastIndexOf('.');
  if (idx < 0) return false;
  const ext = pathPosix.slice(idx).toLowerCase();
  return exts.includes(ext);
}

function chunkByLines(text: string, opts: { chunkLines: number; overlapLines: number; maxChunkChars: number }): Array<{ startLine: number; endLine: number; content: string }> {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const total = lines.length;

  const chunkLines = Math.max(1, opts.chunkLines);
  const overlapLines = Math.max(0, Math.min(opts.overlapLines, chunkLines - 1));
  const step = Math.max(1, chunkLines - overlapLines);

  const chunks: Array<{ startLine: number; endLine: number; content: string }> = [];
  for (let i = 0; i < total; i += step) {
    const startIdx = i;
    const endIdxExclusive = Math.min(total, i + chunkLines);
    const startLine = startIdx + 1;
    const endLine = endIdxExclusive;

    let content = lines.slice(startIdx, endIdxExclusive).join('\n').trim();
    if (!content) continue;

    if (content.length > opts.maxChunkChars) {
      content = content.slice(0, opts.maxChunkChars);
    }

    chunks.push({ startLine, endLine, content });
    if (endIdxExclusive >= total) break;
  }

  return chunks;
}

function vectorToBlob(vector: number[]): Buffer {
  const arr = new Float32Array(vector);
  return Buffer.from(arr.buffer);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function safeUnlinkSync(dbPath: string): void {
  try {
    fsSync.unlinkSync(dbPath);
  } catch {
    // ignore
  }
  try {
    fsSync.unlinkSync(dbPath + '-wal');
  } catch {
    // ignore
  }
  try {
    fsSync.unlinkSync(dbPath + '-shm');
  } catch {
    // ignore
  }
}

function ensureSchemaV3(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      kind TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_files_kind ON files(kind);
    CREATE INDEX IF NOT EXISTS idx_files_repo ON files(repo);

    CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      repo TEXT NOT NULL,
      kind TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content TEXT NOT NULL,
      vector BLOB NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_embeddings_path ON embeddings(path);
    CREATE INDEX IF NOT EXISTS idx_embeddings_kind ON embeddings(kind);
    CREATE INDEX IF NOT EXISTS idx_embeddings_repo ON embeddings(repo);
  `);
}

function readSchemaVersion(db: Database.Database): number | null {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
    if (!row?.value) return null;
    const n = parseInt(row.value, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function buildSemanticIndexForBundle(params: {
  bundleRootDir: string;
  files: IngestedFile[];
  embedding: BaseEmbedding;
  embeddingMeta?: {
    endpoint?: string;
    authMode?: string;
  };
  options: BuildSemanticIndexOptions;
}): Promise<BuildSemanticIndexResult> {
  const startedAt = Date.now();
  const warnings: string[] = [];

  const dbPath = path.join(params.bundleRootDir, 'indexes', 'semantic.sqlite3');
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  const scope = params.options.scope;
  const fileExts = normalizeExtFilter(params.options.fileTypeFilters);

  // Filter to indexable files.
  let candidates = params.files.filter((f) => {
    if (scope === 'docs' && f.kind !== 'doc') return false;
    if (scope === 'code' && f.kind !== 'code') return false;
    return matchesExt(f.bundleNormRelativePath, fileExts);
  });

  if (params.options.maxFiles && candidates.length > params.options.maxFiles) {
    candidates = candidates.slice(0, params.options.maxFiles);
    warnings.push(`maxFiles reached: indexing first ${candidates.length} files`);
  }

  let rebuilt = false;
  let db: Database.Database | null = null;

  const openDb = (readonly = false): Database.Database => {
    const instance = new Database(dbPath, { readonly });
    instance.pragma('journal_mode = WAL');
    instance.pragma('synchronous = NORMAL');
    return instance;
  };

  const wantRebuild = !!params.options.rebuild;

  // Track whether a DB existed before this build attempt.
  let existedBefore = await fileExists(dbPath);

  if (wantRebuild && existedBefore) {
    safeUnlinkSync(dbPath);
    rebuilt = true;
    existedBefore = false;
  }

  try {
    db = openDb(false);
    ensureSchemaV3(db);

    const schemaVersion = readSchemaVersion(db);

    // If the DB existed before and isn't explicitly schema v3, rebuild to avoid partial/mismatched schemas.
    if (existedBefore && schemaVersion !== 3) {
      db.close();
      db = null;
      safeUnlinkSync(dbPath);
      rebuilt = true;
      existedBefore = false;
      db = openDb(false);
      ensureSchemaV3(db);
    }

    // Write meta (overwrites provider/model/dimension so consumers can validate compatibility).
    const upsertMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    upsertMeta.run('schema_version', '3');
    upsertMeta.run('dimension', String(params.embedding.getDimension()));
    upsertMeta.run('provider', params.embedding.getProvider());
    upsertMeta.run('model', params.embedding.getModel());
    if (params.embeddingMeta?.endpoint) upsertMeta.run('endpoint', params.embeddingMeta.endpoint);
    if (params.embeddingMeta?.authMode) upsertMeta.run('auth_mode', params.embeddingMeta.authMode);
    upsertMeta.run('updated_at', new Date().toISOString());

    // Load existing file hashes.
    const existingRows = db
      .prepare('SELECT path, sha256 FROM files')
      .all() as Array<{ path: string; sha256: string }>;
    const existing = new Map(existingRows.map((r) => [r.path, r.sha256] as const));

    const currentPaths = new Set<string>();
    let filesChanged = 0;
    let filesUnchanged = 0;

    const changedFiles: IngestedFile[] = [];

    for (const f of candidates) {
      currentPaths.add(f.bundleNormRelativePath);
      const prevSha = existing.get(f.bundleNormRelativePath);
      if (prevSha && prevSha === f.sha256 && !rebuilt) {
        filesUnchanged++;
        continue;
      }
      filesChanged++;
      changedFiles.push(f);
    }

    // Removed files: present in DB but not in current scan.
    const removedPaths: string[] = [];
    for (const p of existing.keys()) {
      if (!currentPaths.has(p)) removedPaths.push(p);
    }

    const deleteEmbeddingsByPath = db.prepare('DELETE FROM embeddings WHERE path = ?');
    const deleteFileByPath = db.prepare('DELETE FROM files WHERE path = ?');
    const upsertFile = db.prepare(
      "INSERT OR REPLACE INTO files (path, repo, kind, sha256, updated_at) VALUES (?, ?, ?, ?, strftime('%s','now'))"
    );
    const insertEmbedding = db.prepare(
      'INSERT OR REPLACE INTO embeddings (id, path, repo, kind, start_line, end_line, content, vector) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );

    const pruneTx = db.transaction((pathsToRemove: string[]) => {
      for (const p of pathsToRemove) {
        deleteEmbeddingsByPath.run(p);
        deleteFileByPath.run(p);
      }
    });
    pruneTx(removedPaths);

    let chunksWritten = 0;
    let chunksEmbedded = 0;

    const BATCH_SIZE = 64;

    for (const f of changedFiles) {
      let text: string;
      try {
        text = await fs.readFile(f.bundleNormAbsPath, 'utf8');
      } catch {
        warnings.push(`Failed to read file: ${f.bundleNormRelativePath}`);
        continue;
      }

      const chunks = chunkByLines(text, {
        chunkLines: params.options.chunkLines,
        overlapLines: params.options.overlapLines,
        maxChunkChars: params.options.maxChunkChars,
      });

      if (params.options.maxChunks && chunks.length > params.options.maxChunks) {
        warnings.push(`maxChunks reached for ${f.bundleNormRelativePath}: keeping first ${params.options.maxChunks} chunks`);
        chunks.splice(params.options.maxChunks);
      }

      const docs: EmbeddingDocument[] = chunks.map((c) => ({
        id: `${f.bundleNormRelativePath}:${c.startLine}-${c.endLine}`,
        path: f.bundleNormRelativePath,
        repo: f.repoId,
        kind: f.kind,
        startLine: c.startLine,
        endLine: c.endLine,
        content: c.content,
      }));

      // Embed in batches and accumulate.
      const vectors: Array<{ doc: EmbeddingDocument; vector: number[] }> = [];
      for (let i = 0; i < docs.length; i += BATCH_SIZE) {
        const batch = docs.slice(i, i + BATCH_SIZE);
        const embeddings = await params.embedding.embedBatch(batch.map((d) => d.content));
        for (let j = 0; j < batch.length; j++) {
          vectors.push({ doc: batch[j]!, vector: embeddings[j]!.vector });
        }
        chunksEmbedded += batch.length;
      }

      const writeTx = db.transaction(() => {
        deleteEmbeddingsByPath.run(f.bundleNormRelativePath);
        deleteFileByPath.run(f.bundleNormRelativePath);

        for (const v of vectors) {
          insertEmbedding.run(
            v.doc.id,
            v.doc.path,
            v.doc.repo,
            v.doc.kind,
            v.doc.startLine,
            v.doc.endLine,
            v.doc.content,
            vectorToBlob(v.vector)
          );
        }

        upsertFile.run(f.bundleNormRelativePath, f.repoId, f.kind, f.sha256);
      });

      writeTx();
      chunksWritten += vectors.length;
    }

    db.close();
    db = null;

    return {
      ok: true,
      rebuilt,
      schemaVersion: 3,
      dbPath,
      filesTotal: candidates.length,
      filesChanged,
      filesUnchanged,
      filesRemoved: removedPaths.length,
      chunksWritten,
      chunksEmbedded,
      durationMs: Date.now() - startedAt,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (err) {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }

    const message = err instanceof Error ? err.message : String(err);

    return {
      ok: false,
      rebuilt,
      schemaVersion: 3,
      dbPath,
      filesTotal: candidates.length,
      filesChanged: 0,
      filesUnchanged: 0,
      filesRemoved: 0,
      chunksWritten: 0,
      chunksEmbedded: 0,
      durationMs: Date.now() - startedAt,
      warnings: warnings.length > 0 ? warnings : undefined,
      error: message,
    };
  }
}
