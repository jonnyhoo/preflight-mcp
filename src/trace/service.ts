import path from 'node:path';

import * as z from 'zod';

import { type PreflightConfig } from '../config.js';
import { findBundleStorageDir, getBundlePathsForId, listBundlesMulti } from '../bundle/service.js';

import { ensureTraceDb, queryTraceEdges, upsertTraceEdges, listAllSourceIds, type TraceEdgeInput, type TraceEntityRef } from './store.js';
import { createMetaBuilder, createDidYouMeanNextActions, WarningCodes, type ResponseMeta, type NextAction } from '../mcp/responseMeta.js';

export const TraceUpsertInputSchema = {
  bundleId: z.string().describe('Bundle ID to attach trace links to.'),
  // RFC v2: Safety default - dryRun=true prevents accidental writes
  dryRun: z.boolean().optional().default(true).describe(
    'If true (default), preview the changes without writing to database. ' +
    'Set to false to actually persist the trace links.'
  ),
  edges: z
    .array(
      z.object({
        id: z.string().optional(),
        source: z.object({ type: z.string(), id: z.string() }),
        target: z.object({ type: z.string(), id: z.string() }),
        type: z.string().describe('Edge type, e.g. tested_by/documents/implements/relates_to/entrypoint_of'),
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
          .optional()
          .describe('Evidence sources. REQUIRED for tested_by/documents/implements edge types.'),
      })
    )
    .min(1)
    .describe('Trace edges to upsert.'),
};

/** Edge types that require non-empty sources for data quality */
const EDGE_TYPES_REQUIRING_SOURCES = ['tested_by', 'documents', 'implements'];

export const TraceQueryInputSchema = {
  // When omitted, the query may scan across bundles (best-effort, capped).
  bundleId: z.string().optional().describe('Optional bundleId. If omitted, scans across bundles (capped).'),

  source_type: z.string().describe('Entity type (e.g., "file", "symbol", "test").'),
  source_id: z.string().describe(
    'Entity ID. Supports two formats: ' +
    '(1) repo-relative path: "mcp_sequential_thinking/server.py" ' +
    '(2) bundle-full path: "repos/{owner}/{repo}/norm/{path}". ' +
    'Both formats are normalized internally.'
  ),

  target_type: z.string().optional(),
  target_id: z.string().optional(),

  edge_type: z.string().optional(),

  limit: z.number().int().min(1).max(500).default(50),
  timeBudgetMs: z.number().int().min(500).max(30_000).default(5_000),
  maxBundles: z.number().int().min(1).max(200).default(50),
  // RFC v2: cursor pagination
  cursor: z.string().optional().describe('Pagination cursor from previous call. Use to fetch next page of results.'),
};

function traceDbPathForBundleRoot(bundleRoot: string): string {
  return path.join(bundleRoot, 'trace', 'trace.sqlite3');
}

/**
 * Normalize source_id to handle both formats:
 * - repo-relative: "mcp_sequential_thinking/server.py"
 * - bundle-full: "repos/owner/repo/norm/mcp_sequential_thinking/server.py"
 * 
 * Returns an array of possible normalized forms to try.
 */
function normalizeSourceId(sourceId: string): string[] {
  const normalized: string[] = [sourceId];
  
  // Pattern to match bundle-full path: repos/{owner}/{repo}/norm/{path}
  const bundleFullPattern = /^repos\/[^/]+\/[^/]+\/norm\/(.+)$/;
  const match = sourceId.match(bundleFullPattern);
  
  if (match) {
    // Extract the repo-relative path from bundle-full path
    const repoRelative = match[1]!;
    if (!normalized.includes(repoRelative)) {
      normalized.push(repoRelative);
    }
  } else {
    // Try to construct bundle-full patterns from repo-relative path
    // We can't know the exact owner/repo, but we can try common patterns
    // The actual matching will be done via LIKE query in the store
  }
  
  return normalized;
}

/**
 * Find candidate source_ids that are similar to the given one.
 * Used for "did you mean" suggestions.
 */
function findSimilarSourceIds(
  allSourceIds: string[],
  targetId: string,
  maxSuggestions: number = 5
): string[] {
  const targetLower = targetId.toLowerCase();
  const targetParts = targetId.split(/[\/\\]/);
  const targetFileName = targetParts[targetParts.length - 1] || '';
  const targetFileNameLower = targetFileName.toLowerCase();
  
  // Score each source_id based on similarity
  const scored = allSourceIds.map((id) => {
    let score = 0;
    const idLower = id.toLowerCase();
    const idParts = id.split(/[\/\\]/);
    const idFileName = idParts[idParts.length - 1] || '';
    const idFileNameLower = idFileName.toLowerCase();
    
    // Exact match (shouldn't happen if we're looking for suggestions)
    if (id === targetId) return { id, score: 1000 };
    
    // Case-insensitive exact match
    if (idLower === targetLower) return { id, score: 900 };
    
    // File name exact match
    if (idFileName === targetFileName) score += 100;
    else if (idFileNameLower === targetFileNameLower) score += 80;
    
    // File name contains
    if (idFileNameLower.includes(targetFileNameLower)) score += 50;
    if (targetFileNameLower.includes(idFileNameLower)) score += 30;
    
    // Path contains parts
    for (const part of targetParts) {
      if (part && idLower.includes(part.toLowerCase())) score += 10;
    }
    
    // Levenshtein-like: common prefix/suffix
    const minLen = Math.min(idLower.length, targetLower.length);
    let commonPrefix = 0;
    for (let i = 0; i < minLen && idLower[i] === targetLower[i]; i++) commonPrefix++;
    score += commonPrefix * 2;
    
    return { id, score };
  });
  
  // Sort by score descending and take top N
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSuggestions)
    .map((s) => s.id);
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

export type TraceUpsertResult = {
  bundleId: string;
  dryRun: boolean;
  upserted: number;
  ids: string[];
  /** Validation warnings (non-blocking) */
  warnings?: Array<{
    edgeIndex: number;
    code: string;
    message: string;
  }>;
  /** Edges that were blocked due to validation errors */
  blocked?: Array<{
    edgeIndex: number;
    code: string;
    message: string;
    nextAction: {
      toolName: string;
      why: string;
    };
  }>;
  /** Preview of edges (only in dryRun mode) */
  preview?: Array<{
    id: string;
    source: TraceEntityRef;
    target: TraceEntityRef;
    type: string;
    confidence: number;
    method: 'exact' | 'heuristic';
    sourcesCount: number;
  }>;
  meta?: ResponseMeta;
};

export async function traceUpsert(cfg: PreflightConfig, rawArgs: unknown): Promise<TraceUpsertResult> {
  const metaBuilder = createMetaBuilder();
  
  const args = z.object(TraceUpsertInputSchema).parse(rawArgs) as {
    bundleId: string;
    dryRun?: boolean;
    edges: TraceEdgeInput[];
  };
  
  const dryRun = args.dryRun ?? false;
  const warnings: TraceUpsertResult['warnings'] = [];
  const blocked: TraceUpsertResult['blocked'] = [];
  
  // Validate edges - check for missing sources on high-value edge types
  const validEdges: TraceEdgeInput[] = [];
  
  for (let i = 0; i < args.edges.length; i++) {
    const edge = args.edges[i]!;
    const edgeType = edge.type.toLowerCase();
    
    // Check if this edge type requires sources
    if (EDGE_TYPES_REQUIRING_SOURCES.includes(edgeType)) {
      const hasSources = edge.sources && edge.sources.length > 0;
      
      if (!hasSources) {
        // Block this edge - require evidence
        blocked.push({
          edgeIndex: i,
          code: WarningCodes.SOURCES_MISSING,
          message: `Edge type "${edge.type}" requires evidence sources. ` +
            `Add sources: [{ file: "path/to/file", range: {...} }] or sources: [{ note: "explanation" }].`,
          nextAction: {
            toolName: 'preflight_read_file',
            why: `Use preflight_read_file with withLineNumbers=true to gather evidence for ${edge.source.id} → ${edge.target.id}.`,
          },
        });
        metaBuilder.addWarning(
          WarningCodes.SOURCES_MISSING,
          `Edge ${i}: "${edge.type}" requires sources (evidence). Blocked.`,
          true
        );
        continue;
      }
    }
    
    // Warn if confidence is very high but method is heuristic
    if ((edge.confidence ?? 0.5) >= 0.9 && edge.method === 'heuristic') {
      warnings.push({
        edgeIndex: i,
        code: 'HIGH_CONFIDENCE_HEURISTIC',
        message: `Edge ${i} has high confidence (${edge.confidence}) but method="heuristic". Consider using method="exact" or lowering confidence.`,
      });
    }
    
    validEdges.push(edge);
  }
  
  // If all edges are blocked, return early with helpful message
  if (validEdges.length === 0 && blocked.length > 0) {
    metaBuilder.addNextAction({
      toolName: 'preflight_read_file',
      paramsTemplate: {
        bundleId: args.bundleId,
        file: args.edges[0]?.source.id,
        withLineNumbers: true,
      },
      why: 'Gather evidence for your trace links by reading source files with line numbers.',
    });
    
    return {
      bundleId: args.bundleId,
      dryRun,
      upserted: 0,
      ids: [],
      blocked,
      meta: metaBuilder.build(),
    };
  }
  
  // Dry run mode: preview without writing
  if (dryRun) {
    const preview = validEdges.map((edge) => ({
      id: edge.id || `tr_${edge.source.type}_${edge.source.id}_${edge.type}_${edge.target.type}_${edge.target.id}`.slice(0, 40),
      source: edge.source,
      target: edge.target,
      type: edge.type,
      confidence: edge.confidence ?? 0.5,
      method: (edge.method ?? 'heuristic') as 'exact' | 'heuristic',
      sourcesCount: edge.sources?.length ?? 0,
    }));
    
    return {
      bundleId: args.bundleId,
      dryRun: true,
      upserted: 0,
      ids: [],
      preview,
      warnings: warnings.length > 0 ? warnings : undefined,
      blocked: blocked.length > 0 ? blocked : undefined,
      meta: metaBuilder.build(),
    };
  }
  
  // Actually upsert
  const traceDbPath = await getTraceDbPathForBundleId(cfg, args.bundleId);
  const res = await upsertTraceEdges(traceDbPath, validEdges);
  
  return {
    bundleId: args.bundleId,
    dryRun: false,
    upserted: res.upserted,
    ids: res.ids,
    warnings: warnings.length > 0 ? warnings : undefined,
    blocked: blocked.length > 0 ? blocked : undefined,
    meta: metaBuilder.build(),
  };
}

export type TraceQueryResultReason = 'no_edges' | 'no_matching_edges' | 'not_initialized' | 'no_matching_bundle';

export type TraceQueryResult = {
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
  /** Reason for empty results (only present when edges is empty) */
  reason?: TraceQueryResultReason;
  /** Actionable next steps when edges is empty */
  nextSteps?: string[];
  /** Did-you-mean suggestions when source_id doesn't match */
  didYouMean?: string[];
  /** Response metadata for LLM routing */
  meta?: ResponseMeta;
};

export async function traceQuery(cfg: PreflightConfig, rawArgs: unknown): Promise<TraceQueryResult> {
  const metaBuilder = createMetaBuilder();
  
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

  // Normalize source_id to support both repo-relative and bundle-full paths
  const sourceIdVariants = normalizeSourceId(args.source_id);
  const source: TraceEntityRef = { type: args.source_type, id: args.source_id };
  const target: TraceEntityRef | undefined =
    args.target_type && args.target_id ? { type: args.target_type, id: args.target_id } : undefined;

  // Fast path: single bundle
  if (args.bundleId) {
    const dbPath = await getTraceDbPathForBundleId(cfg, args.bundleId);
    
    // Try flexible matching with all source_id variants
    const { queryTraceEdgesFlexible } = await import('./store.js');
    const rows = queryTraceEdgesFlexible(dbPath, {
      source,
      sourceIdVariants,
      target,
      edgeType: args.edge_type,
      limit: args.limit,
    });
    
    // Add reason and nextSteps for empty results
    if (rows.length === 0) {
      // Check if trace DB has any edges at all
      const allEdges = queryTraceEdges(dbPath, { limit: 1 });
      const hasAnyEdges = allEdges.length > 0;
      
      // Get all source_ids for did-you-mean suggestions
      let didYouMean: string[] | undefined;
      if (hasAnyEdges) {
        const allSourceIds = listAllSourceIds(dbPath, args.source_type);
        const candidates = findSimilarSourceIds(allSourceIds, args.source_id, 5);
        if (candidates.length > 0) {
          didYouMean = candidates;
          metaBuilder.addWarning(
            WarningCodes.SOURCE_ID_MISMATCH,
            `source_id "${args.source_id}" not found. Similar IDs: ${candidates.slice(0, 3).join(', ')}`,
            true
          );
          // Add nextActions for the suggestions
          for (const candidate of candidates.slice(0, 3)) {
            metaBuilder.addNextAction({
              toolName: 'preflight_trace_query',
              paramsTemplate: {
                bundleId: args.bundleId,
                source_type: args.source_type,
                source_id: candidate,
                edge_type: args.edge_type,
              },
              why: `Try "${candidate}" instead of "${args.source_id}"`,
            });
          }
        }
      }
      
      return {
        bundleId: args.bundleId,
        edges: [],
        reason: hasAnyEdges ? 'no_matching_edges' : 'not_initialized',
        didYouMean,
        nextSteps: hasAnyEdges
          ? [
              ...(didYouMean ? [`Try one of these source_ids: ${didYouMean.slice(0, 3).join(', ')}`] : []),
              'Use preflight_search_bundle to find related files first',
              'Both formats supported: "path/to/file.ts" or "repos/{owner}/{repo}/norm/path/to/file.ts"',
            ]
          : [
              'Use preflight_trace_upsert to create trace links',
              'Trace links record relationships: code↔test (tested_by), code↔doc (documents), module↔requirement (implements)',
              'Example: { edges: [{ type: "tested_by", source: { type: "file", id: "repos/.../src/main.ts" }, target: { type: "file", id: "repos/.../tests/main.test.ts" }, method: "exact", confidence: 0.9 }] }',
            ],
        meta: metaBuilder.build(),
      };
    }
    
    return { bundleId: args.bundleId, edges: rows, meta: metaBuilder.build() };
  }

  // Slow path: scan across bundles (best-effort, capped)
  const startedAt = Date.now();
  const timeLeft = () => args.timeBudgetMs - (Date.now() - startedAt);
  let truncated = false;

  const bundleIds = (await listBundlesMulti(cfg.storageDirs)).slice(0, args.maxBundles);
  const { queryTraceEdgesFlexible } = await import('./store.js');

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
      metaBuilder.setTruncated('Time budget exceeded');
      break;
    }

    try {
      const dbPath = await getTraceDbPathForBundleId(cfg, bundleId);
      // Use flexible matching with all source_id variants
      const rows = queryTraceEdgesFlexible(dbPath, {
        source,
        sourceIdVariants,
        target,
        edgeType: args.edge_type,
        limit: Math.min(50, args.limit),
      });
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

  const result: TraceQueryResult = {
    scannedBundles: bundleIds.length,
    truncated: truncated ? true : undefined,
    edges: collected.slice(0, args.limit),
    meta: metaBuilder.build(),
  };

  // Add reason and nextSteps for empty results
  if (collected.length === 0) {
    result.reason = bundleIds.length === 0 ? 'no_matching_bundle' : 'no_edges';
    result.nextSteps = bundleIds.length === 0
      ? [
          'No bundles found. Create a bundle first using preflight_create_bundle.',
        ]
      : [
          'No trace links found across any bundle.',
          'Use preflight_trace_upsert with a specific bundleId to create trace links.',
          'Both formats supported: "path/to/file.ts" or "repos/{owner}/{repo}/norm/path/to/file.ts"',
        ];
  }

  return result;
}
