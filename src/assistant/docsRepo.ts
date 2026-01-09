/**
 * Managed "docs repo" workspace for caching extracted text from external documents.
 *
 * This enables pairing paper + code by indexing extracted paper text alongside code bundles.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { PreflightConfig } from '../config.js';
import { ingestDocument, isParseableDocument } from '../bundle/document-ingest.js';

export type DocsRepoUpsertResult = {
  repoDir: string;
  docsDir: string;
  manifestPath: string;
  changed: boolean;
  processed: number;
  updated: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
  entries: Array<{
    sourcePath: string;
    docKey: string;
    bundleRelativePath: string;
    signature: { size: number; mtimeMs: number };
  }>;
};

type DocsManifestV1 = {
  schemaVersion: 1;
  updatedAt: string;
  entries: Record<
    string,
    {
      sourcePath: string;
      size: number;
      mtimeMs: number;
      bundleRelativePath: string;
      updatedAt: string;
    }
  >;
};

function nowIso(): string {
  return new Date().toISOString();
}

function stableDocKey(absPath: string): string {
  // Normalize for Windows case-insensitivity.
  const normalized = path.resolve(absPath).replace(/\\/g, '/').toLowerCase();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

async function readManifest(manifestPath: string): Promise<DocsManifestV1> {
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as DocsManifestV1;
    if (parsed && parsed.schemaVersion === 1 && parsed.entries) return parsed;
  } catch {
    // ignore
  }
  return { schemaVersion: 1, updatedAt: nowIso(), entries: {} };
}

async function writeManifest(manifestPath: string, manifest: DocsManifestV1): Promise<void> {
  const out: DocsManifestV1 = { ...manifest, schemaVersion: 1, updatedAt: nowIso() };
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(out, null, 2), 'utf8');
}

export async function ensureDocsRepo(cfg: PreflightConfig): Promise<{ repoDir: string; docsDir: string; manifestPath: string }> {
  const repoDir = path.join(cfg.assistantDir, 'docs_repo');
  const docsDir = path.join(repoDir, 'docs');
  const manifestPath = path.join(cfg.assistantDir, 'docs_manifest.json');

  await fs.mkdir(docsDir, { recursive: true });
  return { repoDir, docsDir, manifestPath };
}

export async function upsertDocsRepo(cfg: PreflightConfig, docPaths: string[], options?: { maxPages?: number }): Promise<DocsRepoUpsertResult> {
  const { repoDir, docsDir, manifestPath } = await ensureDocsRepo(cfg);
  const manifest = await readManifest(manifestPath);

  let changed = false;
  let processed = 0;
  let updated = 0;
  let skipped = 0;
  const errors: Array<{ path: string; error: string }> = [];
  const entries: DocsRepoUpsertResult['entries'] = [];

  for (const p of docPaths) {
    processed++;

    const absPath = path.resolve(p);
    const docKey = stableDocKey(absPath);
    const bundleRelativePath = `docs/${docKey}.md`;

    try {
      const st = await fs.stat(absPath);
      if (!st.isFile()) {
        skipped++;
        errors.push({ path: absPath, error: 'not a file' });
        continue;
      }

      if (!isParseableDocument(absPath)) {
        skipped++;
        errors.push({ path: absPath, error: 'unsupported document format' });
        continue;
      }

      const prev = manifest.entries[docKey];
      const signature = { size: st.size, mtimeMs: st.mtimeMs };
      const unchanged = !!prev && prev.size === signature.size && prev.mtimeMs === signature.mtimeMs;

      if (unchanged) {
        entries.push({ sourcePath: absPath, docKey, bundleRelativePath: prev.bundleRelativePath, signature });
        continue;
      }

      const parse = await ingestDocument(absPath, {
        extractImages: false,
        extractTables: false,
        extractEquations: false,
        maxPagesPerDocument: options?.maxPages,
      });

      if (!parse.success || !parse.fullText) {
        skipped++;
        errors.push({ path: absPath, error: parse.error ?? 'failed to extract text' });
        continue;
      }

      const header = [
        '<!-- preflight-doc -->',
        `<!-- source: ${absPath} -->`,
        `<!-- extracted_at: ${nowIso()} -->`,
        '',
      ].join('\n');

      const outPath = path.join(repoDir, bundleRelativePath);
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, header + parse.fullText.trim() + '\n', 'utf8');

      manifest.entries[docKey] = {
        sourcePath: absPath,
        size: signature.size,
        mtimeMs: signature.mtimeMs,
        bundleRelativePath,
        updatedAt: nowIso(),
      };

      changed = true;
      updated++;
      entries.push({ sourcePath: absPath, docKey, bundleRelativePath, signature });
    } catch (err) {
      skipped++;
      errors.push({ path: absPath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (changed) {
    await writeManifest(manifestPath, manifest);
  }

  return {
    repoDir,
    docsDir,
    manifestPath,
    changed,
    processed,
    updated,
    skipped,
    errors,
    entries,
  };
}
