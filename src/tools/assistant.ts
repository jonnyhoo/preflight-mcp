/**
 * preflight_assistant: single natural-language entry point.
 *
 * Orchestrates:
 * - optional docs ingestion for docPaths (cached)
 * - bundle repair/update (best-effort)
 * - hybrid retrieval (FTS + optional semantic)
 *
 * This tool is designed to be the only exposed tool in PREFLIGHT_TOOLSET=minimal.
 */

import fs from 'node:fs/promises';
import * as z from 'zod';

import type { PreflightConfig } from '../config.js';
import {
  assertBundleComplete,
  createBundle,
  findBundleStorageDir,
  getBundlePathsForId,
  getEffectiveStorageDir,
  listBundles,
  repairBundle,
  updateBundle,
} from '../bundle/service.js';
import { scanBundleIndexableFiles } from '../bundle/analysis-helpers.js';
import { readManifest } from '../bundle/manifest.js';
import { safeJoin, toBundleFileUri } from '../mcp/uris.js';
import { searchIndex, type SearchHit, type SearchScope } from '../search/sqliteFts.js';
import { SemanticSearchIndex } from '../search/semanticSearch.js';
import { createEmbeddingFromConfig, describeEmbeddingEndpoint, type EmbeddingOverride } from '../embedding/preflightEmbedding.js';
import { buildSemanticIndexForBundle } from '../search/semanticBuild.js';
import { upsertDocsRepo } from '../assistant/docsRepo.js';

// ============================================================================
// Input schema
// ============================================================================

const EmbeddingOverrideSchema = z.union([
  z.object({
    provider: z.literal('ollama'),
    host: z.string().optional(),
    model: z.string().optional(),
    keepAlive: z.string().optional(),
  }),
  z.object({
    provider: z.literal('openai'),
    apiKey: z.string().optional(),
    model: z.string().optional(),
    baseUrl: z.string().optional(),
    embeddingsUrl: z.string().optional(),
    url: z.string().optional(),
    authMode: z.enum(['auto', 'bearer', 'api-key']).optional(),
  }),
]);

const RepoInputSchema = z.union([
  z.object({
    kind: z.literal('github'),
    repo: z.string().describe('GitHub repo in owner/repo form (or github.com/owner/repo URL).'),
    ref: z.string().optional().describe('Optional git ref (branch/tag).'),
  }),
  z.object({
    kind: z.literal('local'),
    repo: z.string().describe('Logical repo id in owner/repo form (used for storage layout and de-dup).'),
    path: z.string().describe('Local directory path containing the repository files.'),
    ref: z.string().optional().describe('Optional label/ref for the local snapshot.'),
  }),
]);

export const AssistantInputSchema = {
  question: z.string().describe('Natural-language question or task.'),
  intent: z
    .enum(['auto', 'project', 'paper', 'pair'])
    .default('auto')
    .describe('auto=infer from sources. project=code bundle(s). paper=docPaths only. pair=paper+code together.'),
  sources: z
    .object({
      repos: z.array(RepoInputSchema).optional().describe('Repos to ingest into a new (or existing) bundle.'),
      bundleIds: z.array(z.string()).optional().describe('Existing bundle IDs to use as sources.'),
      docPaths: z.array(z.string()).optional().describe('Absolute paths to external documents (PDF/DOCX/HTML) to ingest + search.'),
    })
    .default({})
    .describe('Source selection for the assistant.'),
  target: z
    .object({
      bundleId: z.string().optional().describe('Optional target bundleId ("B project") for reuse mapping.'),
      description: z.string().optional().describe('Optional target description if no bundleId is available.'),
    })
    .optional(),
  fresh: z
    .enum(['auto', 'never', 'check', 'force'])
    .default('auto')
    .describe('Bundle freshness policy. auto=repair if broken; never=no update; check=update if changed; force=force update/reindex.'),
  limits: z
    .object({
      maxBundles: z.number().int().min(1).max(50).default(10),
      maxEvidence: z.number().int().min(1).max(50).default(12),
      ftsLimit: z.number().int().min(1).max(50).default(8),
      semanticLimit: z.number().int().min(1).max(50).default(8),
      contextLines: z.number().int().min(5).max(100).default(30),
      maxBytesPerEvidence: z.number().int().min(500).max(10_000).default(2000),
      includeOverviewFiles: z.boolean().default(true),
      overviewMaxLines: z.number().int().min(20).max(400).default(160),
    })
    .optional(),
  embedding: EmbeddingOverrideSchema.optional().describe('Optional embedding override for semantic search/indexing.'),
  docOptions: z
    .object({
      maxPages: z.number().int().min(1).max(500).optional().describe('Max pages to parse per document.'),
    })
    .optional(),
};

export type AssistantInput = z.infer<z.ZodObject<typeof AssistantInputSchema>>;

// ============================================================================
// Output types
// ============================================================================

type EvidenceItem = {
  source: 'overview' | 'fts' | 'semantic';
  bundleId: string;
  repo: string;
  kind: 'doc' | 'code';
  path: string;
  matchRange: { startLine: number; endLine: number };
  excerptRange: { startLine: number; endLine: number };
  excerpt: string;
  score?: number;
  uri: string;
};

// ============================================================================
// Helpers
// ============================================================================

async function readLinesWithContext(params: {
  bundleRootDir: string;
  relativePath: string;
  matchRange: { startLine: number; endLine: number };
  contextLines: number;
  withLineNumbers: boolean;
  maxBytes: number;
}): Promise<{ excerpt: string; excerptRange: { startLine: number; endLine: number } } | null> {
  try {
    const absPath = safeJoin(params.bundleRootDir, params.relativePath);
    const content = await fs.readFile(absPath, 'utf8');
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const totalLines = lines.length;

    const halfContext = Math.floor(params.contextLines / 2);
    let startLine = Math.max(1, params.matchRange.startLine - halfContext);
    let endLine = Math.min(totalLines, params.matchRange.endLine + halfContext);

    if (endLine - startLine + 1 < params.contextLines) {
      if (startLine === 1) {
        endLine = Math.min(totalLines, startLine + params.contextLines - 1);
      } else if (endLine === totalLines) {
        startLine = Math.max(1, endLine - params.contextLines + 1);
      }
    }

    const excerptLines: string[] = [];
    let byteCount = 0;

    for (let i = startLine; i <= endLine; i++) {
      const line = lines[i - 1] ?? '';
      const formatted = params.withLineNumbers ? `${i}|${line}` : line;
      const lineBytes = Buffer.byteLength(formatted, 'utf8') + 1;
      if (byteCount + lineBytes > params.maxBytes && excerptLines.length > 0) {
        endLine = i - 1;
        break;
      }
      excerptLines.push(formatted);
      byteCount += lineBytes;
    }

    return {
      excerpt: excerptLines.join('\n'),
      excerptRange: { startLine, endLine },
    };
  } catch {
    return null;
  }
}

async function readHeadLines(params: {
  bundleRootDir: string;
  relativePath: string;
  maxLines: number;
  withLineNumbers: boolean;
  maxBytes: number;
}): Promise<{ excerpt: string; excerptRange: { startLine: number; endLine: number } } | null> {
  try {
    const absPath = safeJoin(params.bundleRootDir, params.relativePath);
    const content = await fs.readFile(absPath, 'utf8');
    const lines = content.replace(/\r\n/g, '\n').split('\n');

    const endLine = Math.min(lines.length, params.maxLines);
    const excerptLines: string[] = [];
    let byteCount = 0;

    for (let i = 1; i <= endLine; i++) {
      const line = lines[i - 1] ?? '';
      const formatted = params.withLineNumbers ? `${i}|${line}` : line;
      const lineBytes = Buffer.byteLength(formatted, 'utf8') + 1;
      if (byteCount + lineBytes > params.maxBytes && excerptLines.length > 0) {
        return { excerpt: excerptLines.join('\n'), excerptRange: { startLine: 1, endLine: i - 1 } };
      }
      excerptLines.push(formatted);
      byteCount += lineBytes;
    }

    return { excerpt: excerptLines.join('\n'), excerptRange: { startLine: 1, endLine } };
  } catch {
    return null;
  }
}

function inferIntent(input: AssistantInput): 'project' | 'paper' | 'pair' {
  if (input.intent !== 'auto') return input.intent;
  const repos = input.sources.repos ?? [];
  const bundleIds = input.sources.bundleIds ?? [];
  const docPaths = input.sources.docPaths ?? [];

  const hasCode = repos.length > 0 || bundleIds.length > 0;
  const hasDocs = docPaths.length > 0;

  if (hasCode && hasDocs) return 'pair';
  if (hasDocs && !hasCode) return 'paper';
  return 'project';
}

// ============================================================================
// Handler
// ============================================================================

export function createAssistantHandler(deps: { cfg: PreflightConfig; onResourcesChanged?: () => void }) {
  const TOOL_NAME = 'preflight_assistant';

  return async (args: AssistantInput): Promise<{ text: string; structuredContent: Record<string, unknown> }> => {
    const startedAt = Date.now();

    const limits = {
      maxBundles: args.limits?.maxBundles ?? 10,
      maxEvidence: args.limits?.maxEvidence ?? 12,
      ftsLimit: args.limits?.ftsLimit ?? 8,
      semanticLimit: args.limits?.semanticLimit ?? 8,
      contextLines: args.limits?.contextLines ?? deps.cfg.defaultSearchContextLines,
      maxBytesPerEvidence: args.limits?.maxBytesPerEvidence ?? 2000,
      includeOverviewFiles: args.limits?.includeOverviewFiles ?? true,
      overviewMaxLines: args.limits?.overviewMaxLines ?? 160,
    };

    const resolvedIntent = inferIntent(args);

    const requestedRepos = args.sources.repos ?? [];
    const requestedBundleIdsRaw = args.sources.bundleIds ?? [];
    const requestedDocPaths = args.sources.docPaths ?? [];

    // If no bundle IDs AND no repos provided, fall back to all bundles (capped).
    const requestedBundleIds = requestedBundleIdsRaw.length > 0
      ? requestedBundleIdsRaw
      : requestedRepos.length > 0
        ? []
        : (await listBundles(await getEffectiveStorageDir(deps.cfg))).slice(0, limits.maxBundles);

    const operations: {
      docs?: unknown;
      bundlesRepaired: string[];
      bundlesUpdated: string[];
      semanticIndex?: unknown;
    } = {
      bundlesRepaired: [],
      bundlesUpdated: [],
    };

    const usedBundleIds: string[] = [];
    const targetBundleId = args.target?.bundleId;

    // 0) Repos ingestion (optional): create (or reuse) a bundle from repos.
    let repoBundleId: string | undefined;
    if (requestedRepos.length > 0) {
      const summary = await createBundle(
        deps.cfg,
        {
          repos: requestedRepos as any,
        },
        { ifExists: 'returnExisting' }
      );

      repoBundleId = summary.bundleId;

      // Freshness policy for repo bundle.
      if (args.fresh === 'force') {
        await updateBundle(deps.cfg, repoBundleId, { force: true });
        operations.bundlesUpdated.push(repoBundleId);
        deps.onResourcesChanged?.();
      } else if (args.fresh === 'check') {
        // For repo bundles, 'check' maps to a non-forced update attempt.
        try {
          await updateBundle(deps.cfg, repoBundleId);
          operations.bundlesUpdated.push(repoBundleId);
          deps.onResourcesChanged?.();
        } catch {
          // ignore update failures
        }
      }

      usedBundleIds.push(repoBundleId);
    }

    // 1) Docs ingestion (optional): create/update a local docs bundle.
    let docsBundleId: string | undefined;
    if (requestedDocPaths.length > 0) {
      const docsUpsert = await upsertDocsRepo(deps.cfg, requestedDocPaths, { maxPages: args.docOptions?.maxPages });
      operations.docs = {
        changed: docsUpsert.changed,
        processed: docsUpsert.processed,
        updated: docsUpsert.updated,
        skipped: docsUpsert.skipped,
        errors: docsUpsert.errors.slice(0, 20),
        repoDir: docsUpsert.repoDir,
        entries: docsUpsert.entries.map((e) => ({
          sourcePath: e.sourcePath,
          bundleRelativePath: e.bundleRelativePath,
          signature: e.signature,
        })),
      };

      // Create (or reuse) a persistent bundle for the docs repo.
      const docsSummary = await createBundle(
        deps.cfg,
        {
          repos: [
            {
              kind: 'local',
              repo: 'assistant/docs',
              path: docsUpsert.repoDir,
            },
          ],
        },
        { ifExists: 'returnExisting' }
      );

      docsBundleId = docsSummary.bundleId;
      if (docsUpsert.changed || args.fresh === 'force') {
        await updateBundle(deps.cfg, docsBundleId, { force: true });
        operations.bundlesUpdated.push(docsBundleId);
        deps.onResourcesChanged?.();
      }

      usedBundleIds.push(docsBundleId);
    }

    // 2) Ensure requested bundles are complete, and optionally update.
    for (const bundleId of requestedBundleIds) {
      if (!bundleId) continue;

      // Avoid duplicates with docs bundle.
      if (bundleId === docsBundleId) continue;
      // Avoid adding target twice.
      if (targetBundleId && bundleId === targetBundleId) continue;

      // Best-effort: repair if incomplete.
      try {
        await assertBundleComplete(deps.cfg, bundleId);
      } catch {
        await repairBundle(deps.cfg, bundleId, {
          mode: 'repair',
          rebuildIndex: true,
        });
        operations.bundlesRepaired.push(bundleId);
        deps.onResourcesChanged?.();
      }

      // Optional freshness policy.
      if (args.fresh === 'force') {
        await updateBundle(deps.cfg, bundleId, { force: true });
        operations.bundlesUpdated.push(bundleId);
        deps.onResourcesChanged?.();
      } else if (args.fresh === 'check') {
        // Lightweight check: update only if manifest is older than defaultMaxAgeHours.
        try {
          const storageDir = await findBundleStorageDir(deps.cfg.storageDirs, bundleId);
          if (storageDir) {
            const paths = getBundlePathsForId(storageDir, bundleId);
            const manifest = await readManifest(paths.manifestPath);
            const updatedAt = new Date(manifest.updatedAt).getTime();
            const ageMs = Date.now() - updatedAt;
            if (ageMs > deps.cfg.defaultMaxAgeHours * 60 * 60 * 1000) {
              await updateBundle(deps.cfg, bundleId);
              operations.bundlesUpdated.push(bundleId);
              deps.onResourcesChanged?.();
            }
          }
        } catch {
          // ignore update failures
        }
      }

      usedBundleIds.push(bundleId);
    }

    // 2.1) Optionally include target bundle ("B project") as an additional context lane.
    if (targetBundleId && targetBundleId !== docsBundleId && !usedBundleIds.includes(targetBundleId)) {
      try {
        await assertBundleComplete(deps.cfg, targetBundleId);
      } catch {
        await repairBundle(deps.cfg, targetBundleId, {
          mode: 'repair',
          rebuildIndex: true,
        });
        operations.bundlesRepaired.push(targetBundleId);
        deps.onResourcesChanged?.();
      }

      if (args.fresh === 'force') {
        await updateBundle(deps.cfg, targetBundleId, { force: true });
        operations.bundlesUpdated.push(targetBundleId);
        deps.onResourcesChanged?.();
      }

      usedBundleIds.push(targetBundleId);
    }

    // 3) Hybrid retrieval.
    const evidence: EvidenceItem[] = [];

    // 3.1) Include overview files for project/pair.
    if (limits.includeOverviewFiles && (resolvedIntent === 'project' || resolvedIntent === 'pair')) {
      const overviewFiles = ['OVERVIEW.md', 'START_HERE.md'];
      for (const bundleId of usedBundleIds) {
        if (bundleId === docsBundleId) continue;
        const storageDir = await findBundleStorageDir(deps.cfg.storageDirs, bundleId);
        if (!storageDir) continue;
        const paths = getBundlePathsForId(storageDir, bundleId);

        for (const rel of overviewFiles) {
          const head = await readHeadLines({
            bundleRootDir: paths.rootDir,
            relativePath: rel,
            maxLines: limits.overviewMaxLines,
            withLineNumbers: true,
            maxBytes: limits.maxBytesPerEvidence,
          });
          if (!head) continue;

          evidence.push({
            source: 'overview',
            bundleId,
            repo: '(bundle)',
            kind: 'doc',
            path: rel,
            matchRange: { startLine: 1, endLine: 1 },
            excerptRange: head.excerptRange,
            excerpt: head.excerpt,
            uri: toBundleFileUri({ bundleId, relativePath: rel }),
          });
        }
      }
    }

    // 3.2) FTS retrieval
    const ftsScopeForIntent = (intent: 'project' | 'paper' | 'pair'): SearchScope => {
      if (intent === 'paper') return 'docs';
      if (intent === 'pair') return 'all';
      return 'code';
    };

    const ftsScope = ftsScopeForIntent(resolvedIntent);

    const ftsHits: Array<{ bundleId: string; hit: SearchHit }> = [];

    for (const bundleId of usedBundleIds) {
      const storageDir = await findBundleStorageDir(deps.cfg.storageDirs, bundleId);
      if (!storageDir) continue;
      const paths = getBundlePathsForId(storageDir, bundleId);

      const hits = searchIndex(paths.searchDbPath, args.question, ftsScope, limits.ftsLimit, paths.rootDir);
      for (const h of hits) {
        ftsHits.push({ bundleId, hit: h });
      }
    }

    for (const { bundleId, hit } of ftsHits) {
      const storageDir = await findBundleStorageDir(deps.cfg.storageDirs, bundleId);
      if (!storageDir) continue;
      const paths = getBundlePathsForId(storageDir, bundleId);

      const excerptResult = await readLinesWithContext({
        bundleRootDir: paths.rootDir,
        relativePath: hit.path,
        matchRange: { startLine: hit.lineNo, endLine: hit.lineNo },
        contextLines: limits.contextLines,
        withLineNumbers: true,
        maxBytes: limits.maxBytesPerEvidence,
      });

      if (!excerptResult) continue;

      evidence.push({
        source: 'fts',
        bundleId,
        repo: hit.repo,
        kind: hit.kind,
        path: hit.path,
        matchRange: { startLine: hit.lineNo, endLine: hit.lineNo },
        excerptRange: excerptResult.excerptRange,
        excerpt: excerptResult.excerpt,
        score: hit.score,
        uri: toBundleFileUri({ bundleId, relativePath: hit.path }),
      });

      if (evidence.length >= limits.maxEvidence) break;
    }

    // 3.3) Semantic retrieval (optional)
    const semanticOps: {
      enabled: boolean;
      built: Array<{ bundleId: string; result: unknown }>;
      searched: Array<{ bundleId: string; hits: number }>;
      warnings: string[];
    } = {
      enabled: false,
      built: [],
      searched: [],
      warnings: [],
    };

    if (deps.cfg.semanticSearchEnabled) {
      semanticOps.enabled = true;

      const { embedding, embeddingConfig } = createEmbeddingFromConfig(deps.cfg, args.embedding as EmbeddingOverride | undefined);
      const endpoint = describeEmbeddingEndpoint(embeddingConfig);

      // Validate embedding service (best-effort).
      try {
        const ok = await embedding.isAvailable();
        if (!ok) {
          semanticOps.warnings.push('Embedding provider is not available; semantic search skipped');
        } else {
          for (const bundleId of usedBundleIds) {
            const storageDir = await findBundleStorageDir(deps.cfg.storageDirs, bundleId);
            if (!storageDir) continue;
            const paths = getBundlePathsForId(storageDir, bundleId);

            // Ensure semantic index exists / updated.
            const scanned = await scanBundleIndexableFiles({
              cfg: deps.cfg,
              bundleRootDir: paths.rootDir,
              reposDir: paths.reposDir,
              librariesDir: paths.librariesDir,
            });

            const scope: 'docs' | 'code' | 'all' = bundleId === docsBundleId ? 'docs' : 'code';

            const built = await buildSemanticIndexForBundle({
              bundleRootDir: paths.rootDir,
              files: scanned.files,
              embedding,
              embeddingMeta: {
                endpoint,
                authMode: embeddingConfig.provider === 'openai' ? embeddingConfig.authMode : undefined,
              },
              options: {
                scope,
                chunkLines: 40,
                overlapLines: 10,
                maxChunkChars: 8000,
                rebuild: false,
              },
            });

            semanticOps.built.push({ bundleId, result: built });
          }

          for (const bundleId of usedBundleIds) {
            const storageDir = await findBundleStorageDir(deps.cfg.storageDirs, bundleId);
            if (!storageDir) continue;
            const paths = getBundlePathsForId(storageDir, bundleId);

            const index = new SemanticSearchIndex(paths.rootDir);
            const opened = await index.open({ readonly: true });
            if (!opened) {
              semanticOps.warnings.push(`No semantic index for bundle ${bundleId}`);
              continue;
            }

            const kind: 'doc' | 'code' | 'all' =
              resolvedIntent === 'paper' ? 'doc' : resolvedIntent === 'project' ? 'code' : 'all';

            const hits = await index.search(args.question, embedding, {
              limit: limits.semanticLimit,
              kind,
            });

            semanticOps.searched.push({ bundleId, hits: hits.length });

            for (const h of hits) {
              const excerptResult = await readLinesWithContext({
                bundleRootDir: paths.rootDir,
                relativePath: h.path,
                matchRange: { startLine: h.startLine, endLine: h.endLine },
                contextLines: limits.contextLines,
                withLineNumbers: true,
                maxBytes: limits.maxBytesPerEvidence,
              });

              if (!excerptResult) continue;

              evidence.push({
                source: 'semantic',
                bundleId,
                repo: h.repo,
                kind: h.kind,
                path: h.path,
                matchRange: { startLine: h.startLine, endLine: h.endLine },
                excerptRange: excerptResult.excerptRange,
                excerpt: excerptResult.excerpt,
                score: h.score,
                uri: toBundleFileUri({ bundleId, relativePath: h.path }),
              });

              if (evidence.length >= limits.maxEvidence) break;
            }

            index.close();

            if (evidence.length >= limits.maxEvidence) break;
          }
        }
      } catch (err) {
        semanticOps.warnings.push(err instanceof Error ? err.message : String(err));
      }
    }

    operations.semanticIndex = semanticOps;

    // 4) Deduplicate evidence conservatively.
    const seen = new Set<string>();
    const deduped: EvidenceItem[] = [];
    for (const e of evidence) {
      const key = `${e.bundleId}|${e.path}|${e.excerptRange.startLine}|${e.excerptRange.endLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(e);
    }

    // 5) Heuristic reuse candidates (for mapping to an optional target project).
    // This is intentionally shallow: it helps an LLM quickly spot likely reusable files/modules.
    const reuseCandidates = (() => {
      const counts = new Map<string, { path: string; repo: string; kind: 'doc' | 'code'; bundleId: string; sources: Set<string>; mentions: number }>();
      for (const e of deduped) {
        // Prefer code evidence from non-target bundles.
        if (e.kind !== 'code') continue;
        if (targetBundleId && e.bundleId === targetBundleId) continue;
        if (docsBundleId && e.bundleId === docsBundleId) continue;

        const key = `${e.bundleId}|${e.path}`;
        const existing = counts.get(key);
        if (existing) {
          existing.mentions += 1;
          existing.sources.add(e.source);
        } else {
          counts.set(key, {
            bundleId: e.bundleId,
            path: e.path,
            repo: e.repo,
            kind: e.kind,
            sources: new Set([e.source]),
            mentions: 1,
          });
        }
      }

      return Array.from(counts.values())
        .sort((a, b) => b.mentions - a.mentions)
        .slice(0, 10)
        .map((c) => ({
          bundleId: c.bundleId,
          path: c.path,
          repo: c.repo,
          kind: c.kind,
          mentions: c.mentions,
          sources: Array.from(c.sources.values()).sort(),
        }));
    })();

    (operations as any).reuse = {
      target: args.target,
      targetBundleId,
      candidates: reuseCandidates,
      note:
        'Heuristic candidates derived from evidence frequency. Validate by reading excerpts and checking dependencies before reuse/adaptation.',
    };

    const out: Record<string, unknown> = {
      ok: true,
      meta: {
        tool: TOOL_NAME,
        schemaVersion: '1',
        timeMs: Date.now() - startedAt,
      },
      intent: resolvedIntent,
      question: args.question,
      sources: {
        repos: requestedRepos,
        bundleIds: requestedBundleIdsRaw,
        docPaths: requestedDocPaths,
      },
      resolved: {
        usedBundleIds,
        repoBundleId,
        docsBundleId,
        targetBundleId,
      },
      operations,
      evidence: deduped.slice(0, limits.maxEvidence),
      target: args.target,
    };

    return {
      text: JSON.stringify(out, null, 2),
      structuredContent: out,
    };
  };
}

export const assistantToolDescription = {
  title: 'Preflight assistant (one tool)',
  description:
    'Single natural-language entry point for Preflight. ' +
    'Orchestrates bundle repair/update, optional paper ingestion (docPaths), and hybrid retrieval (FTS + semantic). ' +
    'Designed for PREFLIGHT_TOOLSET=minimal (only tool exposed).',
};
