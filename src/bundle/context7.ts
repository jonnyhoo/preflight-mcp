import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { type Client } from '@modelcontextprotocol/sdk/client/index.js';

import { type PreflightConfig } from '../config.js';
import { connectContext7 } from '../context7/client.js';
import { extractContext7IdsFromResult, textFromToolResult } from '../context7/tools.js';

type ResolveEntry = {
  title?: string;
  id: string;
  benchmarkScore?: number;
  sourceReputation?: 'High' | 'Medium' | 'Low' | 'Unknown';
  codeSnippets?: number;
};

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parseResolveEntries(text: string): ResolveEntry[] {
  const entries: ResolveEntry[] = [];
  for (const chunk of text.split('----------')) {
    const lines = chunk
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    let title: string | undefined;
    let id: string | undefined;
    let benchmarkScore: number | undefined;
    let sourceReputation: ResolveEntry['sourceReputation'] | undefined;
    let codeSnippets: number | undefined;

    for (const line of lines) {
      if (line.startsWith('- Title:')) {
        title = line.slice('- Title:'.length).trim();
      } else if (line.toLowerCase().includes('context7-compatible library id:')) {
        const idx = line.toLowerCase().indexOf('context7-compatible library id:');
        id = line.slice(idx + 'context7-compatible library id:'.length).trim();
      } else if (line.toLowerCase().startsWith('- benchmark score:')) {
        const raw = line.slice('- Benchmark Score:'.length).trim();
        const n = Number(raw);
        if (Number.isFinite(n)) benchmarkScore = n;
      } else if (line.toLowerCase().startsWith('- source reputation:')) {
        const raw = line.slice('- Source Reputation:'.length).trim();
        if (raw === 'High' || raw === 'Medium' || raw === 'Low') {
          sourceReputation = raw;
        } else {
          sourceReputation = 'Unknown';
        }
      } else if (line.toLowerCase().startsWith('- code snippets:')) {
        const raw = line.slice('- Code Snippets:'.length).trim();
        const n = Number(raw);
        if (Number.isFinite(n)) codeSnippets = n;
      }
    }

    if (id && id.startsWith('/') && id.includes('/')) {
      entries.push({ title, id, benchmarkScore, sourceReputation, codeSnippets });
    }
  }
  return entries;
}

function reputationWeight(rep: ResolveEntry['sourceReputation'] | undefined): number {
  if (rep === 'High') return 3;
  if (rep === 'Medium') return 2;
  if (rep === 'Low') return 1;
  return 0;
}

function chooseBestEntry(entries: ResolveEntry[], input: string): { id?: string; notes: string[] } {
  const notes: string[] = [];
  if (entries.length === 0) return { notes };

  const nk = normalizeKey(input);

  // Score entries: prefer name match, then reputation/benchmark/snippets.
  const scored = entries.map((e) => {
    const titleKey = e.title ? normalizeKey(e.title) : '';
    const idKey = normalizeKey(e.id);

    let match = 0;
    if (titleKey && nk && titleKey === nk) match = 3;
    else if (titleKey && nk && (titleKey.includes(nk) || nk.includes(titleKey))) match = 2;
    else if (nk && idKey.includes(nk)) match = 1;

    const score =
      match * 1_000_000 +
      reputationWeight(e.sourceReputation) * 10_000 +
      (e.benchmarkScore ?? 0) * 100 +
      Math.min(e.codeSnippets ?? 0, 50_000) * 0.01;

    return { e, match, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return { notes };

  const alternatives = scored.filter((s) => s.e.id !== best.e.id && s.match === best.match).slice(0, 3);
  if (alternatives.length) {
    notes.push(`resolve-library-id chose ${best.e.id}; alternatives: ${alternatives.map((a) => a.e.id).join(', ')}`);
  }

  // If we didn't get even a weak match, still proceed but note.
  if (best.match === 0) {
    notes.push(`resolve-library-id had no clear match for ${JSON.stringify(input)}; using ${best.e.id}`);
  }

  return { id: best.e.id, notes };
}

import { type IngestedFile } from './ingest.js';
import { type BundlePaths } from './paths.js';

export type Context7LibrarySummary = {
  kind: 'context7';
  input: string;
  id?: string;
  fetchedAt: string;
  notes?: string[];
  files?: string[]; // bundle-relative posix paths
};

function nowIso(): string {
  return new Date().toISOString();
}

function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function safeIdSegments(context7Id: string): string[] {
  const raw = context7Id.trim().replace(/^\/+/, '');
  const parts = raw.split('/').filter(Boolean);
  // Prevent any weird traversal segments.
  return parts.filter((p) => p !== '.' && p !== '..');
}

function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function clipUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const normalized = text.replace(/\r\n/g, '\n');
  const buf = Buffer.from(normalized, 'utf8');
  if (buf.length <= maxBytes) return { text: normalized, truncated: false };
  // Cutting at a byte boundary may split a multi-byte codepoint; Node will replace invalid sequences.
  const clipped = buf.subarray(0, maxBytes).toString('utf8');
  return { text: `${clipped}\n\n[TRUNCATED]\n`, truncated: true };
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

async function writeJson(targetPath: string, obj: unknown): Promise<void> {
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

async function callOrThrow(client: Client, name: string, args: Record<string, unknown>): Promise<{
  text: string;
  structured?: Record<string, unknown>;
}> {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) {
    throw new Error(textFromToolResult(res) || `${name} failed`);
  }
  return {
    text: textFromToolResult(res),
    structured: res.structuredContent as Record<string, unknown> | undefined,
  };
}

async function resolveContext7Id(client: Client, input: string): Promise<{ id?: string; notes: string[] }> {
  const notes: string[] = [];
  const trimmed = input.trim();
  if (trimmed.startsWith('/')) {
    return { id: trimmed, notes };
  }

  try {
    const res = await client.callTool({
      name: 'resolve-library-id',
      arguments: { libraryName: trimmed },
    });

    if (res.isError) {
      notes.push(`resolve-library-id error: ${textFromToolResult(res)}`);
      return { notes };
    }

    const text = textFromToolResult(res);

    // Prefer parsing the structured list output for better selection.
    const parsed = parseResolveEntries(text);
    const chosen = chooseBestEntry(parsed, trimmed);
    if (chosen.id) {
      notes.push(...chosen.notes);
      return { id: chosen.id, notes };
    }

    // Fallback: regex/structured extraction.
    const ids = extractContext7IdsFromResult(res);
    if (ids.length === 0) {
      notes.push('resolve-library-id returned no Context7 IDs');
      return { notes };
    }

    if (ids.length > 1) {
      notes.push(`resolve-library-id returned multiple IDs; using first: ${ids[0]}`);
    }

    return { id: ids[0], notes };
  } catch (err) {
    notes.push(`resolve-library-id threw: ${err instanceof Error ? err.message : String(err)}`);
    return { notes };
  }
}

export async function ingestContext7Libraries(params: {
  cfg: PreflightConfig;
  bundlePaths: BundlePaths;
  libraries?: string[];
  topics?: string[];
}): Promise<{ files: IngestedFile[]; libraries: Context7LibrarySummary[] }> {
  const libs = (params.libraries ?? []).map((s) => s.trim()).filter(Boolean);
  if (libs.length === 0) return { files: [], libraries: [] };

  const topics = (params.topics ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 10);
  const maxLibraries = 20;

  await ensureDir(params.bundlePaths.librariesDir);

  let ctx: Awaited<ReturnType<typeof connectContext7>> | null = null;
  try {
    ctx = await connectContext7(params.cfg);
  } catch (err) {
    // Best-effort: still write per-library meta.json so the bundle explains what failed.
    const libraries: Context7LibrarySummary[] = [];
    for (const input of libs.slice(0, maxLibraries)) {
      const fetchedAt = nowIso();
      const notes = [`context7 connect failed: ${err instanceof Error ? err.message : String(err)}`];
      const baseDir = path.join(params.bundlePaths.librariesDir, 'context7', '_unresolved', slug(input) || 'library');
      await writeJson(path.join(baseDir, 'meta.json'), {
        kind: 'context7',
        input,
        fetchedAt,
        notes,
      });
      libraries.push({ kind: 'context7', input, fetchedAt, notes });
    }
    return { files: [], libraries };
  }

  const client = ctx.client;
  const files: IngestedFile[] = [];
  const libraries: Context7LibrarySummary[] = [];

  try {
    for (const input of libs.slice(0, maxLibraries)) {
      const fetchedAt = nowIso();
      const notes: string[] = [];
      const fileRelPaths: string[] = [];

      const resolved = await resolveContext7Id(client, input);
      notes.push(...resolved.notes);

      const id = resolved.id;
      const baseDir = id
        ? path.join(params.bundlePaths.librariesDir, 'context7', ...safeIdSegments(id))
        : path.join(params.bundlePaths.librariesDir, 'context7', '_unresolved', slug(input) || 'library');

      await ensureDir(baseDir);

      if (id) {
        const topicList = topics.length > 0 ? topics : [''];
        for (const topic of topicList) {
          const topicLabel = topic || 'all';
          const fileName = topic
            ? `topic-${slug(topicLabel)}-page-1.md`
            : 'docs-page-1.md';

          try {
            const args: Record<string, unknown> = {
              context7CompatibleLibraryID: id,
              page: 1,
            };
            if (topic) args.topic = topic;

            const { text } = await callOrThrow(client, 'get-library-docs', args);
            if (!text.trim()) {
              notes.push(`get-library-docs returned empty text for topic=${JSON.stringify(topicLabel)}`);
              continue;
            }

            const clipped = clipUtf8(text, params.cfg.maxFileBytes);
            if (clipped.truncated) {
              notes.push(`docs truncated to maxFileBytes=${params.cfg.maxFileBytes} for topic=${JSON.stringify(topicLabel)}`);
            }

            const absDocPath = path.join(baseDir, fileName);
            await fs.writeFile(absDocPath, clipped.text, 'utf8');

            const bundleRelPosix = toPosix(path.relative(params.bundlePaths.rootDir, absDocPath));
            fileRelPaths.push(bundleRelPosix);

            files.push({
              repoId: `context7:${id}`,
              kind: 'doc',
              repoRelativePath: fileName,
              bundleNormRelativePath: bundleRelPosix,
              bundleNormAbsPath: absDocPath,
              sha256: sha256Hex(clipped.text),
              bytes: Buffer.byteLength(clipped.text, 'utf8'),
            });
          } catch (err) {
            notes.push(
              `get-library-docs failed for topic=${JSON.stringify(topicLabel)}: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        }
      } else {
        notes.push('Context7 ID unresolved; skipped get-library-docs');
      }

      await writeJson(path.join(baseDir, 'meta.json'), {
        kind: 'context7',
        input,
        id,
        fetchedAt,
        topics: topics.length > 0 ? topics : undefined,
        files: fileRelPaths,
        notes: notes.length > 0 ? notes : undefined,
      });

      libraries.push({
        kind: 'context7',
        input,
        id,
        fetchedAt,
        files: fileRelPaths.length > 0 ? fileRelPaths : undefined,
        notes: notes.length > 0 ? notes.slice(0, 50) : undefined,
      });
    }
  } finally {
    await ctx.close();
  }

  return { files, libraries };
}
