import path from 'node:path';

import * as z from 'zod';

import { type PreflightConfig } from '../config.js';
import { findBundleStorageDir, getBundlePathsForId, listBundlesMulti } from '../bundle/service.js';

import { ensureTraceDb, queryTraceEdges, upsertTraceEdges, type TraceEdgeInput, type TraceEntityRef } from './store.js';

export const TraceUpsertInputSchema = {
  bundleId: z.string().describe('Bundle ID to attach trace links to.'),
  edges: z
    .array(
      z.object({
        id: z.string().optional(),
        source: z.object({ type: z.string(), id: z.string() }),
        target: z.object({ type: z.string(), id: z.string() }),
        type: z.string().describe('Edge type, e.g. mentions/tests/implements/relates_to'),
        confidence: z.number().min(0).max(1).optional(),
        method: z.enum(['exact', 'heuristic']).optional(),
        sources: z
          .array(
            z.object({
              file: z.string().optional(),
              range: z
                .object({
                  startLine: z.number().int().min(1),
                  startCol: z.number().int().min(1),
                  endLine: z.number().int().min(1),
                  endCol: z.number().int().min(1),
                })
                .optional(),
              externalUrl: z.string().optional(),
              note: z.string().optional(),
            })
          )
          .optional(),
      })
    )
    .min(1)
    .describe('Trace edges to upsert.'),
};

export const TraceQueryInputSchema = {
  // When omitted, the query may scan across bundles (best-effort, capped).
  bundleId: z.string().optional().describe('Optional bundleId. If omitted, scans across bundles (capped).'),

  source_type: z.string(),
  source_id: z.string(),

  target_type: z.string().optional(),
  target_id: z.string().optional(),

  edge_type: z.string().optional(),

  limit: z.number().int().min(1).max(500).default(50),
  timeBudgetMs: z.number().int().min(500).max(30_000).default(5_000),
  maxBundles: z.number().int().min(1).max(200).default(50),
};

function traceDbPathForBundleRoot(bundleRoot: string): string {
  return path.join(bundleRoot, 'trace', 'trace.sqlite3');
}

async function getTraceDbPathForBundleId(cfg: PreflightConfig, bundleId: string): Promise<string> {
  const storageDir = await findBundleStorageDir(cfg.storageDirs, bundleId);
  if (!storageDir) {
    throw new Error(`Bundle not found: ${bundleId}`);
  }
  const paths = getBundlePathsForId(storageDir, bundleId);
  const traceDbPath = traceDbPathForBundleRoot(paths.rootDir);
  await ensureTraceDb(traceDbPath);
  return traceDbPath;
}

export async function traceUpsert(cfg: PreflightConfig, rawArgs: unknown): Promise<{ bundleId: string; upserted: number; ids: string[] }> {
  const args = z.object(TraceUpsertInputSchema).parse(rawArgs) as { bundleId: string; edges: TraceEdgeInput[] };

  const traceDbPath = await getTraceDbPathForBundleId(cfg, args.bundleId);
  const res = await upsertTraceEdges(traceDbPath, args.edges);
  return { bundleId: args.bundleId, ...res };
}

export async function traceQuery(cfg: PreflightConfig, rawArgs: unknown): Promise<{
  bundleId?: string;
  scannedBundles?: number;
  truncated?: boolean;
  edges: Array<{
    id: string;
    source: TraceEntityRef;
    target: TraceEntityRef;
    type: string;
    confidence: number;
    method: 'exact' | 'heuristic';
    sources: any[];
    createdAt: string;
    updatedAt: string;
    bundleId?: string;
  }>;
}> {
  const args = z.object(TraceQueryInputSchema).parse(rawArgs) as {
    bundleId?: string;
    source_type: string;
    source_id: string;
    target_type?: string;
    target_id?: string;
    edge_type?: string;
    limit: number;
    timeBudgetMs: number;
    maxBundles: number;
  };

  const source: TraceEntityRef = { type: args.source_type, id: args.source_id };
  const target: TraceEntityRef | undefined =
    args.target_type && args.target_id ? { type: args.target_type, id: args.target_id } : undefined;

  // Fast path: single bundle
  if (args.bundleId) {
    const dbPath = await getTraceDbPathForBundleId(cfg, args.bundleId);
    const rows = queryTraceEdges(dbPath, { source, target, edgeType: args.edge_type, limit: args.limit });
    return { bundleId: args.bundleId, edges: rows };
  }

  // Slow path: scan across bundles (best-effort, capped)
  const startedAt = Date.now();
  const timeLeft = () => args.timeBudgetMs - (Date.now() - startedAt);
  let truncated = false;

  const bundleIds = (await listBundlesMulti(cfg.storageDirs)).slice(0, args.maxBundles);

  const collected: Array<{
    id: string;
    source: TraceEntityRef;
    target: TraceEntityRef;
    type: string;
    confidence: number;
    method: 'exact' | 'heuristic';
    sources: any[];
    createdAt: string;
    updatedAt: string;
    bundleId?: string;
  }> = [];

  for (const bundleId of bundleIds) {
    if (timeLeft() <= 0) {
      truncated = true;
      break;
    }

    try {
      const dbPath = await getTraceDbPathForBundleId(cfg, bundleId);
      const rows = queryTraceEdges(dbPath, { source, target, edgeType: args.edge_type, limit: Math.min(50, args.limit) });
      for (const r of rows) {
        collected.push({ ...r, bundleId });
        if (collected.length >= args.limit) break;
      }
    } catch {
      // ignore bundles without trace
    }

    if (collected.length >= args.limit) break;
  }

  // Sort by updatedAt desc across bundles
  collected.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return {
    scannedBundles: bundleIds.length,
    truncated: truncated ? true : undefined,
    edges: collected.slice(0, args.limit),
  };
}
