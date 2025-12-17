import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { type IngestedFile } from '../bundle/ingest.js';

export type IndexBuildOptions = {
  includeDocs: boolean;
  includeCode: boolean;
};

export type SearchScope = 'docs' | 'code' | 'all';

export type SearchHit = {
  path: string; // bundle-relative posix path
  repo: string; // owner/repo
  kind: 'doc' | 'code';
  lineNo: number;
  snippet: string;
};

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export async function rebuildIndex(dbPath: string, files: IngestedFile[], opts: IndexBuildOptions): Promise<void> {
  await ensureDir(path.dirname(dbPath));
  await fs.rm(dbPath, { force: true });
  // Also remove WAL/SHM files if present.
  await fs.rm(dbPath + '-wal', { force: true });
  await fs.rm(dbPath + '-shm', { force: true });

  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    db.exec(`
      CREATE VIRTUAL TABLE lines USING fts5(
        content,
        path UNINDEXED,
        repo UNINDEXED,
        kind UNINDEXED,
        lineNo UNINDEXED,
        tokenize='unicode61'
      );
    `);

    const insert = db.prepare(
      `INSERT INTO lines (content, path, repo, kind, lineNo) VALUES (?, ?, ?, ?, ?)`
    );

    const insertMany = db.transaction((fileList: IngestedFile[]) => {
      for (const f of fileList) {
        if (f.kind === 'doc' && !opts.includeDocs) continue;
        if (f.kind === 'code' && !opts.includeCode) continue;

        // Read file synchronously inside transaction for better performance.
        const text = fsSync.readFileSync(f.bundleNormAbsPath, 'utf8');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? '';
          // Skip empty lines to keep the index smaller.
          if (!line.trim()) continue;
          insert.run(line, f.bundleNormRelativePath, f.repoId, f.kind, i + 1);
        }
      }
    });

    insertMany(files);
  } finally {
    db.close();
  }
}

function tokenizeForSafeQuery(input: string): string[] {
  const s = input.trim();
  if (!s) return [];
  // Include unicode letters/digits/underscore/dot/slash/dash.
  const re = /[\p{L}\p{N}_.\/-]{2,}/gu;
  const out: string[] = [];
  for (const m of s.matchAll(re)) {
    const tok = m[0];
    if (tok) out.push(tok);
    if (out.length >= 12) break;
  }
  return out;
}

export function buildFtsQuery(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith('fts:')) {
    return trimmed.slice(4).trim();
  }

  const tokens = tokenizeForSafeQuery(trimmed);
  if (tokens.length === 0) {
    // Quote the whole thing (best-effort) to avoid syntax errors.
    const escaped = trimmed.replaceAll('"', '""');
    return `"${escaped}"`;
  }

  // Quote each token to keep syntax safe.
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ');
}

export function searchIndex(dbPath: string, query: string, scope: SearchScope, limit: number): SearchHit[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const ftsQuery = buildFtsQuery(query);

    const whereKind =
      scope === 'docs' ? `kind = 'doc' AND` : scope === 'code' ? `kind = 'code' AND` : '';

    const stmt = db.prepare(
      `
      SELECT
        path,
        repo,
        kind,
        lineNo,
        snippet(lines, 0, '[', ']', '…', 10) AS snippet
      FROM lines
      WHERE ${whereKind} lines MATCH ?
      ORDER BY bm25(lines)
      LIMIT ?
      `
    );

    const rows = stmt.all(ftsQuery, limit) as Array<{
      path: string;
      repo: string;
      kind: 'doc' | 'code';
      lineNo: number;
      snippet: string;
    }>;

    return rows.map((r) => ({
      path: r.path,
      repo: r.repo,
      kind: r.kind,
      lineNo: r.lineNo,
      snippet: r.snippet,
    }));
  } finally {
    db.close();
  }
}
