/**
 * Semantic search tools (optional).
 */

import fs from 'node:fs/promises';

import * as z from 'zod';

import type { ToolDependencies } from './types.js';
import { assertBundleComplete, findBundleStorageDir, getBundlePathsForId } from '../../bundle/service.js';
import { scanBundleIndexableFiles } from '../../bundle/analysis-helpers.js';
import { toBundleFileUri, safeJoin } from '../../mcp/uris.js';
import { SemanticSearchIndex } from '../../search/semanticSearch.js';
import { buildSemanticIndexForBundle } from '../../search/semanticBuild.js';
import { searchIndex, type SearchScope } from '../../search/sqliteFts.js';
import { createEmbeddingFromConfig, describeEmbeddingEndpoint, type EmbeddingOverride } from '../../embedding/preflightEmbedding.js';

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

    return { excerpt: excerptLines.join('\n'), excerptRange: { startLine, endLine } };
  } catch {
    return null;
  }
}

export function registerSemanticTools({ server, cfg }: ToolDependencies): void {
  // ============================================================================
  // preflight_build_semantic_index
  // ============================================================================
  server.registerTool(
    'preflight_build_semantic_index',
    {
      title: 'Build semantic index',
      description: 'Build or incrementally update the semantic (vector) index for a bundle.',
      inputSchema: {
        bundleId: z.string(),
        scope: z.enum(['docs', 'code', 'all']).default('code'),
        fileTypeFilters: z.array(z.string()).optional(),
        chunkLines: z.number().int().min(5).max(200).default(40),
        overlapLines: z.number().int().min(0).max(100).default(10),
        maxChunkChars: z.number().int().min(200).max(20000).default(8000),
        maxFiles: z.number().int().min(1).max(200000).optional(),
        maxChunks: z.number().int().min(1).max(2000000).optional(),
        rebuild: z.boolean().default(false),
        embedding: EmbeddingOverrideSchema.optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        bundleId: z.string(),
        result: z.any(),
      },
      annotations: { openWorldHint: true },
    },
    async (args) => {
      await assertBundleComplete(cfg, args.bundleId);

      const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
      if (!storageDir) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, bundleId: args.bundleId, error: 'bundle not found' }, null, 2) }],
          structuredContent: { ok: false, bundleId: args.bundleId, error: 'bundle not found' },
        };
      }

      const paths = getBundlePathsForId(storageDir, args.bundleId);
      const scanned = await scanBundleIndexableFiles({
        cfg,
        bundleRootDir: paths.rootDir,
        reposDir: paths.reposDir,
        librariesDir: paths.librariesDir,
      });

      const { embedding, embeddingConfig } = createEmbeddingFromConfig(cfg, args.embedding as EmbeddingOverride | undefined);
      const endpoint = describeEmbeddingEndpoint(embeddingConfig);

      const built = await buildSemanticIndexForBundle({
        bundleRootDir: paths.rootDir,
        files: scanned.files,
        embedding,
        embeddingMeta: {
          endpoint,
          authMode: embeddingConfig.provider === 'openai' ? embeddingConfig.authMode : undefined,
        },
        options: {
          scope: args.scope,
          fileTypeFilters: args.fileTypeFilters,
          chunkLines: args.chunkLines,
          overlapLines: args.overlapLines,
          maxChunkChars: args.maxChunkChars,
          maxFiles: args.maxFiles,
          maxChunks: args.maxChunks,
          rebuild: args.rebuild,
        },
      });

      const out = { ok: built.ok, bundleId: args.bundleId, result: built };
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    }
  );

  // ============================================================================
  // preflight_semantic_search_and_read
  // ============================================================================
  server.registerTool(
    'preflight_semantic_search_and_read',
    {
      title: 'Semantic search and read',
      description: 'Vector semantic search over a bundle. Requires a semantic index (build first).',
      inputSchema: {
        bundleId: z.string(),
        query: z.string(),
        kind: z.enum(['doc', 'code', 'all']).default('code'),
        limit: z.number().int().min(1).max(50).default(10),
        threshold: z.number().min(0).max(1).optional(),
        contextLines: z.number().int().min(5).max(100).default(30),
        withLineNumbers: z.boolean().default(true),
        maxBytesPerHit: z.number().int().min(500).max(10000).default(2000),
        embedding: EmbeddingOverrideSchema.optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        bundleId: z.string(),
        query: z.string(),
        hits: z.array(
          z.object({
            path: z.string(),
            repo: z.string(),
            kind: z.enum(['doc', 'code']),
            matchRange: z.object({ startLine: z.number(), endLine: z.number() }),
            excerptRange: z.object({ startLine: z.number(), endLine: z.number() }),
            excerpt: z.string(),
            score: z.number(),
            uri: z.string(),
          })
        ),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      await assertBundleComplete(cfg, args.bundleId);
      const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
      if (!storageDir) {
        const out = { ok: false, bundleId: args.bundleId, query: args.query, hits: [] };
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
      }

      const paths = getBundlePathsForId(storageDir, args.bundleId);
      const index = new SemanticSearchIndex(paths.rootDir);
      const opened = await index.open({ readonly: true });
      if (!opened) {
        const out = { ok: false, bundleId: args.bundleId, query: args.query, hits: [] as any[], error: 'semantic index missing' };
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
      }

      // Use index config to avoid mismatched provider/model when possible.
      const cfgOverride: EmbeddingOverride | undefined = index.getConfig()
        ? ({ provider: index.getConfig()!.provider as any, model: index.getConfig()!.model } as any)
        : (args.embedding as any);

      const { embedding } = createEmbeddingFromConfig(cfg, cfgOverride ?? (args.embedding as EmbeddingOverride | undefined));

      const semanticHits = await index.search(args.query, embedding, {
        limit: args.limit,
        threshold: args.threshold,
        kind: args.kind,
      });

      const hitsOut: any[] = [];
      for (const h of semanticHits) {
        const excerpt = await readLinesWithContext({
          bundleRootDir: paths.rootDir,
          relativePath: h.path,
          matchRange: { startLine: h.startLine, endLine: h.endLine },
          contextLines: args.contextLines,
          withLineNumbers: args.withLineNumbers,
          maxBytes: args.maxBytesPerHit,
        });
        if (!excerpt) continue;

        hitsOut.push({
          path: h.path,
          repo: h.repo,
          kind: h.kind,
          matchRange: { startLine: h.startLine, endLine: h.endLine },
          excerptRange: excerpt.excerptRange,
          excerpt: excerpt.excerpt,
          score: h.score,
          uri: toBundleFileUri({ bundleId: args.bundleId, relativePath: h.path }),
        });
      }

      const out = { ok: true, bundleId: args.bundleId, query: args.query, hits: hitsOut };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
    }
  );

  // ============================================================================
  // preflight_hybrid_search_and_read
  // ============================================================================
  server.registerTool(
    'preflight_hybrid_search_and_read',
    {
      title: 'Hybrid search and read',
      description: 'Combine FTS and semantic search and return merged excerpts.',
      inputSchema: {
        bundleId: z.string(),
        query: z.string(),
        scope: z.enum(['docs', 'code', 'all']).default('code'),
        limit: z.number().int().min(1).max(50).default(10),
        ftsLimit: z.number().int().min(1).max(100).default(10),
        semanticLimit: z.number().int().min(1).max(100).default(10),
        contextLines: z.number().int().min(5).max(100).default(30),
        withLineNumbers: z.boolean().default(true),
        maxBytesPerHit: z.number().int().min(500).max(10000).default(2000),
        embedding: EmbeddingOverrideSchema.optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        bundleId: z.string(),
        query: z.string(),
        hits: z.array(
          z.object({
            source: z.enum(['fts', 'semantic']),
            path: z.string(),
            repo: z.string(),
            kind: z.enum(['doc', 'code']),
            matchRange: z.object({ startLine: z.number(), endLine: z.number() }),
            excerptRange: z.object({ startLine: z.number(), endLine: z.number() }),
            excerpt: z.string(),
            score: z.number().optional(),
            uri: z.string(),
          })
        ),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      await assertBundleComplete(cfg, args.bundleId);
      const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
      if (!storageDir) {
        const out = { ok: false, bundleId: args.bundleId, query: args.query, hits: [] };
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
      }

      const paths = getBundlePathsForId(storageDir, args.bundleId);
      const scope = args.scope as SearchScope;

      const ftsHits = searchIndex(paths.searchDbPath, args.query, scope, args.ftsLimit, paths.rootDir);

      const merged: any[] = [];
      for (const h of ftsHits.slice(0, args.limit)) {
        const excerpt = await readLinesWithContext({
          bundleRootDir: paths.rootDir,
          relativePath: h.path,
          matchRange: { startLine: h.lineNo, endLine: h.lineNo },
          contextLines: args.contextLines,
          withLineNumbers: args.withLineNumbers,
          maxBytes: args.maxBytesPerHit,
        });
        if (!excerpt) continue;
        merged.push({
          source: 'fts',
          path: h.path,
          repo: h.repo,
          kind: h.kind,
          matchRange: { startLine: h.lineNo, endLine: h.lineNo },
          excerptRange: excerpt.excerptRange,
          excerpt: excerpt.excerpt,
          score: h.score,
          uri: toBundleFileUri({ bundleId: args.bundleId, relativePath: h.path }),
        });
      }

      // Semantic lane (best-effort)
      const index = new SemanticSearchIndex(paths.rootDir);
      const opened = await index.open({ readonly: true });
      if (opened) {
        const kind: 'doc' | 'code' | 'all' = scope === 'docs' ? 'doc' : scope === 'code' ? 'code' : 'all';
        const cfgOverride: EmbeddingOverride | undefined = index.getConfig()
          ? ({ provider: index.getConfig()!.provider as any, model: index.getConfig()!.model } as any)
          : (args.embedding as any);

        const { embedding } = createEmbeddingFromConfig(cfg, cfgOverride ?? (args.embedding as EmbeddingOverride | undefined));
        const semanticHits = await index.search(args.query, embedding, { limit: args.semanticLimit, kind });

        for (const h of semanticHits) {
          if (merged.length >= args.limit) break;
          const excerpt = await readLinesWithContext({
            bundleRootDir: paths.rootDir,
            relativePath: h.path,
            matchRange: { startLine: h.startLine, endLine: h.endLine },
            contextLines: args.contextLines,
            withLineNumbers: args.withLineNumbers,
            maxBytes: args.maxBytesPerHit,
          });
          if (!excerpt) continue;
          merged.push({
            source: 'semantic',
            path: h.path,
            repo: h.repo,
            kind: h.kind,
            matchRange: { startLine: h.startLine, endLine: h.endLine },
            excerptRange: excerpt.excerptRange,
            excerpt: excerpt.excerpt,
            score: h.score,
            uri: toBundleFileUri({ bundleId: args.bundleId, relativePath: h.path }),
          });
        }
      }

      // Dedup by range.
      const seen = new Set<string>();
      const deduped: any[] = [];
      for (const h of merged) {
        const key = `${h.path}|${h.excerptRange.startLine}|${h.excerptRange.endLine}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(h);
      }

      const out = { ok: true, bundleId: args.bundleId, query: args.query, hits: deduped.slice(0, args.limit) };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
    }
  );
}
