import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import * as z from 'zod';

import { type PreflightConfig } from '../config.js';
import { extractImportRefsWasm } from '../ast/treeSitter.js';
import { findBundleStorageDir, getBundlePathsForId } from '../bundle/service.js';
import { readManifest } from '../bundle/manifest.js';
import { searchIndex } from '../search/sqliteFts.js';
import { safeJoin, toBundleFileUri } from '../mcp/uris.js';
import {
  type EvidenceRef,
  type SourceRange,
  type EvidenceMethod,
  createEmptyCoverageReport,
} from '../types/evidence.js';

// Re-export shared types for backward compatibility
export type { EvidenceRef, SourceRange, EvidenceMethod } from '../types/evidence.js';

/**
 * @deprecated Use EvidenceRef instead. SourceRef is kept for backward compatibility.
 */
export type SourceRef = EvidenceRef;

export type EvidenceItem = {
  evidenceId: string;
  kind: 'edge' | 'metric' | 'finding';
  type: string;
  from?: string;
  to?: string;
  value?: number;
  unit?: string;
  method: EvidenceMethod;
  confidence: number; // 0..1
  sources: SourceRef[];
  notes?: string[];
};

export type GraphNode = {
  id: string;
  kind: 'file' | 'symbol' | 'module';
  name: string;
  file?: string;
  range?: SourceRange;
  attrs?: Record<string, unknown>;
};

/**
 * Coverage report explaining what was analyzed and what was skipped.
 * Helps LLMs understand the completeness of the dependency graph.
 */
export type CoverageReport = {
  /** Number of code files discovered in the bundle */
  scannedFilesCount: number;
  /** Number of files successfully parsed for imports */
  parsedFilesCount: number;
  /** Statistics per programming language */
  perLanguage: Record<string, {
    scanned: number;
    parsed: number;
    edges: number;
  }>;
  /** File counts per top-level directory */
  perDir: Record<string, number>;
  /** Files that were skipped with reasons */
  skippedFiles: Array<{
    path: string;
    size?: number;
    reason: string;
  }>;
  /** Whether the graph was truncated due to limits */
  truncated: boolean;
  /** Reason for truncation if applicable */
  truncatedReason?: string;
  /** Applied limits */
  limits: {
    maxFiles: number;
    maxNodes: number;
    maxEdges: number;
    timeBudgetMs: number;
  };
};

/**
 * High-value module identification - modules that are critical to understand.
 */
export type HighValueModule = {
  file: string;
  reason: 'high_coupling' | 'hub' | 'large_file' | 'many_exports' | 'entry_point';
  metric: number;
  description: string;
};

export type DependencyGraphResult = {
  meta: {
    requestId: string;
    generatedAt: string;
    timeMs: number;
    repo: {
      bundleId: string;
      headSha?: string;
    };
    budget: {
      timeBudgetMs: number;
      truncated: boolean;
      truncatedReason?: string;
      limits: {
        maxFiles: number;
        maxNodes: number;
        maxEdges: number;
      };
    };
    /** Cache information for transparency */
    cacheInfo?: {
      fromCache: boolean;
      generatedAt?: string;
      cacheAgeMs?: number;
      hint?: string;
    };
  };
  facts: {
    nodes: GraphNode[];
    edges: EvidenceItem[];
  };
  signals: {
    stats: {
      filesRead: number;
      searchHits: number;
      /** @deprecated Use referenceEdges instead */
      callEdges: number;
      /** FTS-based reference edges (name matching, may include false positives) */
      referenceEdges: number;
      /** AST-based import edges (high confidence) */
      importEdges: number;
    };
    warnings: Array<{ code: string; message: string; evidenceIds?: string[] }>;
    /** High-value modules that deserve attention */
    highValueModules?: HighValueModule[];
  };
  /** Coverage report explaining what was analyzed and what was skipped */
  coverageReport?: CoverageReport;
  /** Mermaid diagram representation of the dependency graph */
  mermaid?: string;
};

export const DependencyGraphInputSchema = {
  bundleId: z.string().describe('Bundle ID to analyze.'),
  target: z.object({
    file: z
      .string()
      .describe(
        'Bundle-relative file path (NOT absolute path). Format: repos/{owner}/{repo}/norm/{path}. ' +
        'Example: repos/owner/repo/norm/src/index.ts or repos/jonnyhoo/langextract/norm/langextract/__init__.py. ' +
        'Use preflight_search_and_read to discover the correct path if unsure.'
      ),
    symbol: z
      .string()
      .optional()
      .describe('Optional symbol name (function/class). If omitted, graph is file-level.'),
  }).optional().describe(
    'Target file/symbol to analyze. If omitted, generates a GLOBAL dependency graph of all code files in the bundle. ' +
    'Global mode shows import relationships between all files but may be truncated for large projects.'
  ),
  force: z.boolean().default(false).describe(
    'If true, regenerate the dependency graph even if cached. ' +
    'Global mode results are cached in the bundle; use force=true to refresh.'
  ),
  /** Edge types to include in the result. Default: only imports (AST-based, high confidence). */
  edgeTypes: z.enum(['imports', 'all']).default('imports').describe(
    'Edge types to include. "imports": only AST-based import edges (high confidence, recommended). ' +
    '"all": include FTS-based reference edges (name matching, may have false positives). ' +
    'Default: "imports" for accuracy. Use "all" only when you need to find callers/references.'
  ),
  options: z
    .object({
      maxFiles: z.number().int().min(1).max(500).default(200),
      maxNodes: z.number().int().min(10).max(2000).default(300),
      maxEdges: z.number().int().min(10).max(5000).default(800),
      timeBudgetMs: z.number().int().min(1000).max(30_000).default(25_000),
      /** Maximum file size in bytes. Files larger than this are skipped. Default 1MB. */
      maxFileSizeBytes: z.number().int().min(10_000).max(50_000_000).default(1_000_000)
        .describe('Max file size in bytes. Default 1MB. Increase if important large files are skipped.'),
      /** Strategy for handling large files */
      largeFileStrategy: z.enum(['skip', 'truncate']).default('skip')
        .describe('How to handle files exceeding maxFileSizeBytes. skip=ignore entirely, truncate=read first N lines.'),
      /** If largeFileStrategy=truncate, how many lines to read */
      truncateLines: z.number().int().min(100).max(5000).default(500)
        .describe('When largeFileStrategy=truncate, read this many lines. Default 500.'),
      /** File extensions to exclude from reference search (FTS). Helps reduce false positives. */
      excludeExtensions: z.array(z.string()).default(['.json', '.md', '.txt', '.yml', '.yaml', '.toml', '.lock'])
        .describe('File extensions to exclude from reference/caller search. Default excludes non-code files.'),
    })
    .default({ maxFiles: 200, maxNodes: 300, maxEdges: 800, timeBudgetMs: 25_000, maxFileSizeBytes: 1_000_000, largeFileStrategy: 'skip', truncateLines: 500, excludeExtensions: ['.json', '.md', '.txt', '.yml', '.yaml', '.toml', '.lock'] }),
};

export type DependencyGraphInput = z.infer<z.ZodObject<typeof DependencyGraphInputSchema>>;

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeEvidenceId(parts: string[]): string {
  return `e_${sha256Hex(parts.join('|')).slice(0, 24)}`;
}

function clampSnippet(s: string, maxLen: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, Math.max(0, maxLen - 1)) + '…';
}

function normalizeExt(p: string): string {
  return path.extname(p).toLowerCase();
}

/**
 * Generate a Mermaid flowchart from dependency graph edges.
 * Limited to top N nodes to keep output readable.
 */
function generateMermaidDiagram(
  edges: EvidenceItem[],
  maxNodes: number = 20
): string {
  // Count imports per file (both as importer and imported)
  const importerCounts = new Map<string, number>();
  const importedCounts = new Map<string, number>();
  
  for (const e of edges) {
    if (e.type === 'imports' && e.from && e.to) {
      importerCounts.set(e.from, (importerCounts.get(e.from) ?? 0) + 1);
      importedCounts.set(e.to, (importedCounts.get(e.to) ?? 0) + 1);
    }
  }
  
  // Get top nodes by total connections
  const allNodes = new Set([...importerCounts.keys(), ...importedCounts.keys()]);
  const nodeScores = Array.from(allNodes).map(n => ({
    node: n,
    score: (importerCounts.get(n) ?? 0) + (importedCounts.get(n) ?? 0),
  })).sort((a, b) => b.score - a.score).slice(0, maxNodes);
  
  const topNodes = new Set(nodeScores.map(n => n.node));
  
  // Filter edges to only include top nodes
  const filteredEdges = edges.filter(e => 
    e.type === 'imports' && e.from && e.to && 
    topNodes.has(e.from) && topNodes.has(e.to)
  );
  
  if (filteredEdges.length === 0) {
    return '```mermaid\nflowchart LR\n  A[No edges to display]\n```';
  }
  
  // Generate Mermaid syntax
  const lines: string[] = ['```mermaid', 'flowchart LR'];
  
  // Create node IDs (sanitize file names)
  const nodeIds = new Map<string, string>();
  let idCounter = 0;
  const getNodeId = (name: string): string => {
    if (!nodeIds.has(name)) {
      nodeIds.set(name, `N${idCounter++}`);
    }
    return nodeIds.get(name)!;
  };
  
  // Add edges
  const addedEdges = new Set<string>();
  for (const e of filteredEdges) {
    const fromId = getNodeId(e.from!);
    const toId = getNodeId(e.to!);
    const edgeKey = `${fromId}->${toId}`;
    if (!addedEdges.has(edgeKey)) {
      addedEdges.add(edgeKey);
      lines.push(`  ${fromId} --> ${toId}`);
    }
  }
  
  // Add node labels
  for (const [name, id] of nodeIds) {
    // Extract just the filename for readability
    const shortName = name.split('/').pop() ?? name;
    const safeName = shortName.replace(/["]/g, "'").slice(0, 30);
    lines.push(`  ${id}["${safeName}"]`);
  }
  
  lines.push('```');
  return lines.join('\n');
}

/**
 * Identify high-value modules from dependency graph.
 */
function identifyHighValueModules(
  edges: EvidenceItem[],
  nodes: GraphNode[]
): HighValueModule[] {
  const modules: HighValueModule[] = [];
  
  // Count imports (as importer and as imported)
  const importerCounts = new Map<string, number>();
  const importedCounts = new Map<string, number>();
  
  for (const e of edges) {
    if (e.type === 'imports' && e.from && e.to) {
      importerCounts.set(e.from, (importerCounts.get(e.from) ?? 0) + 1);
      importedCounts.set(e.to, (importedCounts.get(e.to) ?? 0) + 1);
    }
  }
  
  // High coupling: files imported by many others (>10)
  for (const [file, count] of importedCounts) {
    if (count >= 10) {
      modules.push({
        file,
        reason: 'high_coupling',
        metric: count,
        description: `Imported by ${count} files - core module, changes affect many dependents`,
      });
    }
  }
  
  // Hub modules: files that import many others (>15)
  for (const [file, count] of importerCounts) {
    if (count >= 15) {
      modules.push({
        file,
        reason: 'hub',
        metric: count,
        description: `Imports ${count} modules - orchestrator/entry point, understand dependencies first`,
      });
    }
  }
  
  // Entry points: high importer count but low imported count
  for (const [file, importCount] of importerCounts) {
    const importedCount = importedCounts.get(file) ?? 0;
    if (importCount >= 8 && importedCount <= 2) {
      // Avoid duplicates
      if (!modules.some(m => m.file === file && m.reason === 'entry_point')) {
        modules.push({
          file,
          reason: 'entry_point',
          metric: importCount,
          description: `Likely entry point: imports ${importCount} modules but only imported by ${importedCount}`,
        });
      }
    }
  }
  
  // Sort by metric descending, limit to top 10
  return modules.sort((a, b) => b.metric - a.metric).slice(0, 10);
}

type RepoNormPathParts = {
  repoId: string; // owner/repo
  repoRoot: string; // repos/owner/repo/norm
  repoRelativePath: string; // path inside repo root
};

function parseRepoNormPath(bundleRelativePath: string): RepoNormPathParts | null {
  const p = bundleRelativePath.replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = p.split('/').filter(Boolean);
  if (parts.length < 5) return null;
  if (parts[0] !== 'repos') return null;
  const owner = parts[1];
  const repo = parts[2];
  if (!owner || !repo) return null;
  if (parts[3] !== 'norm') return null;

  const repoRelativePath = parts.slice(4).join('/');
  if (!repoRelativePath) return null;

  return {
    repoId: `${owner}/${repo}`,
    repoRoot: `repos/${owner}/${repo}/norm`,
    repoRelativePath,
  };
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

type ImportHit = {
  module: string;
  range: SourceRange;
  method: EvidenceMethod;
  confidence: number;
  notes: string[];
};


function extractImportsFromLinesHeuristic(filePath: string, lines: string[]): ImportHit[] {
  const ext = normalizeExt(filePath);
  const isJs = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext);
  const isPy = ext === '.py';
  const isGo = ext === '.go';

  const out: ImportHit[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;

    const mk = (module: string, startCol: number, endCol: number): ImportHit => ({
      module,
      range: { startLine: lineNo, startCol, endLine: lineNo, endCol },
      method: 'heuristic',
      confidence: 0.7,
      notes: ['import extraction is regex-based; module resolution (if any) is best-effort and separate'],
    });

    if (isJs) {
      // import ... from 'x' / export ... from 'x'
      const m1 = line.match(/\bfrom\s+['"]([^'"]+)['"]/);
      if (m1?.[1]) {
        const idx = line.indexOf(m1[1]);
        out.push(mk(m1[1], Math.max(1, idx + 1), Math.max(1, idx + 1 + m1[1].length)));
        continue;
      }
      // import 'x'
      const m2 = line.match(/\bimport\s+['"]([^'"]+)['"]/);
      if (m2?.[1]) {
        const idx = line.indexOf(m2[1]);
        out.push(mk(m2[1], Math.max(1, idx + 1), Math.max(1, idx + 1 + m2[1].length)));
        continue;
      }
      // require('x')
      const m3 = line.match(/\brequire\s*\(\s*['"]([^'"]+)['"]/);
      if (m3?.[1]) {
        const idx = line.indexOf(m3[1]);
        out.push(mk(m3[1], Math.max(1, idx + 1), Math.max(1, idx + 1 + m3[1].length)));
        continue;
      }
    }

    if (isPy) {
      // import x
      const m1 = line.match(/^\s*import\s+([a-zA-Z_][\w.]*)/);
      if (m1?.[1]) {
        const mod = m1[1].split('.')[0] ?? m1[1];
        const idx = line.indexOf(m1[1]);
        out.push(mk(mod, Math.max(1, idx + 1), Math.max(1, idx + 1 + mod.length)));
        continue;
      }
      // from x import y
      const m2 = line.match(/^\s*from\s+([a-zA-Z_][\w.]*)\s+import\b/);
      if (m2?.[1]) {
        const mod = m2[1].split('.')[0] ?? m2[1];
        const idx = line.indexOf(m2[1]);
        out.push(mk(mod, Math.max(1, idx + 1), Math.max(1, idx + 1 + mod.length)));
        continue;
      }
    }

    if (isGo) {
      // import "x"
      const m = line.match(/\bimport\s+['"]([^'"]+)['"]/);
      if (m?.[1]) {
        const idx = line.indexOf(m[1]);
        out.push(mk(m[1], Math.max(1, idx + 1), Math.max(1, idx + 1 + m[1].length)));
      }
    }
  }

  return out;
}

async function extractImportsForFile(
  cfg: PreflightConfig,
  filePath: string,
  normalizedContent: string,
  lines: string[],
  warnings: Array<{ code: string; message: string; evidenceIds?: string[] }>
): Promise<{ imports: ImportHit[]; usedAst: boolean; usedFallback: boolean }> {
  const astEngine = cfg.astEngine ?? 'wasm';

  if (astEngine !== 'wasm') {
    return { imports: extractImportsFromLinesHeuristic(filePath, lines), usedAst: false, usedFallback: true };
  }

  try {
    const parsed = await extractImportRefsWasm(filePath, normalizedContent);
    if (!parsed) {
      return { imports: extractImportsFromLinesHeuristic(filePath, lines), usedAst: false, usedFallback: true };
    }

    const imports: ImportHit[] = [];
    for (const imp of parsed.imports) {
      if (imp.range.startLine !== imp.range.endLine) continue; // module specifiers should be single-line

      imports.push({
        module: imp.module,
        range: imp.range,
        method: 'exact',
        confidence: 0.9,
        notes: [`import extraction is parser-backed (tree-sitter:${imp.language}:${imp.kind}); module resolution (if any) is best-effort and separate`],
      });
    }

    return { imports, usedAst: true, usedFallback: false };
  } catch (err) {
    warnings.push({
      code: 'ast_import_extraction_failed',
      message: `AST/WASM import extraction failed; falling back to regex: ${err instanceof Error ? err.message : String(err)}`,
    });

    return { imports: extractImportsFromLinesHeuristic(filePath, lines), usedAst: false, usedFallback: true };
  }
}

function isLikelyCallSite(line: string, symbol: string): { startCol: number; endCol: number } | null {
  // Avoid regex DoS by escaping symbol.
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\s*\\(`);
  const m = line.match(re);
  if (!m || m.index === undefined) return null;
  const startCol = m.index + 1;
  const endCol = startCol + Math.max(1, symbol.length);
  return { startCol, endCol };
}

export async function generateDependencyGraph(cfg: PreflightConfig, rawArgs: unknown): Promise<DependencyGraphResult> {
  const args = z.object(DependencyGraphInputSchema).parse(rawArgs);

  const startedAt = Date.now();
  const requestId = crypto.randomUUID();

  const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
  if (!storageDir) {
    throw new Error(`Bundle not found: ${args.bundleId}`);
  }

  const paths = getBundlePathsForId(storageDir, args.bundleId);
  const manifest = await readManifest(paths.manifestPath);

  // Global mode: check for cached result (unless force=true)
  const isGlobalMode = !args.target;
  if (isGlobalMode && !args.force) {
    try {
      const cached = await fs.readFile(paths.depsGraphPath, 'utf8');
      const parsed = JSON.parse(cached) as DependencyGraphResult;
      const cachedAt = parsed.meta.generatedAt ? new Date(parsed.meta.generatedAt).getTime() : 0;
      const cacheAgeMs = cachedAt ? Date.now() - cachedAt : 0;
      
      // Add cacheInfo to meta
      parsed.meta.cacheInfo = {
        fromCache: true,
        generatedAt: parsed.meta.generatedAt,
        cacheAgeMs,
        hint: 'Use force=true to regenerate the graph.',
      };
      
      // Add note that this is from cache
      parsed.signals.warnings = parsed.signals.warnings || [];
      parsed.signals.warnings.unshift({
        code: 'from_cache',
        message: `Loaded from cache (generated at ${parsed.meta.generatedAt}, age: ${Math.round(cacheAgeMs / 1000)}s). Use force=true to regenerate.`,
      });
      return parsed;
    } catch {
      // Cache miss - generate fresh
    }
  }

  const limits = {
    maxFiles: args.options.maxFiles,
    maxNodes: args.options.maxNodes,
    maxEdges: args.options.maxEdges,
  };

  const nodes = new Map<string, GraphNode>();
  const edges: EvidenceItem[] = [];
  const warnings: Array<{ code: string; message: string; evidenceIds?: string[] }> = [];

  let truncated = false;
  let truncatedReason: string | undefined;

  const timeBudgetMs = args.options.timeBudgetMs;
  const timeLeft = () => timeBudgetMs - (Date.now() - startedAt);
  const checkBudget = (reason: string) => {
    if (truncated) return true;
    if (timeLeft() <= 0) {
      truncated = true;
      truncatedReason = reason;
      return true;
    }
    if (edges.length >= limits.maxEdges) {
      truncated = true;
      truncatedReason = 'maxEdges reached';
      return true;
    }
    if (nodes.size >= limits.maxNodes) {
      truncated = true;
      truncatedReason = 'maxNodes reached';
      return true;
    }
    return false;
  };

  const addNode = (n: GraphNode) => {
    if (nodes.has(n.id)) return;
    nodes.set(n.id, n);
  };

  const addEdge = (e: EvidenceItem) => {
    if (edges.length >= limits.maxEdges) {
      truncated = true;
      truncatedReason = 'maxEdges reached';
      return;
    }
    edges.push(e);
  };

  const bundleFileUri = (p: string) => toBundleFileUri({ bundleId: args.bundleId, relativePath: p });

  // Global mode: no target specified
  if (!args.target) {
    const result = await generateGlobalDependencyGraph({
      cfg,
      args,
      paths,
      manifest,
      limits,
      nodes,
      edges,
      warnings,
      startedAt,
      requestId,
      timeBudgetMs,
      checkBudget,
      addNode,
      addEdge,
      bundleFileUri,
    });

    // Save to cache
    try {
      await fs.mkdir(paths.depsDir, { recursive: true });
      await fs.writeFile(paths.depsGraphPath, JSON.stringify(result, null, 2));
    } catch (err) {
      // Log but don't fail
      console.error('[preflight] Failed to cache dependency graph:', err);
    }

    return result;
  }

  const targetFile = args.target.file.replaceAll('\\', '/');
  const targetRepo = parseRepoNormPath(targetFile);

  const targetFileId = `file:${targetFile}`;
  addNode({ id: targetFileId, kind: 'file', name: targetFile, file: targetFile });

  const targetSymbol = args.target.symbol?.trim();
  const targetSymbolId = targetSymbol ? `symbol:${targetSymbol}@${targetFile}` : targetFileId;
  if (targetSymbol) {
    addNode({
      id: targetSymbolId,
      kind: 'symbol',
      name: targetSymbol,
      file: targetFile,
      attrs: { role: 'target' },
    });
  }

  // 1) Downstream: imports from target file
  let usedAstForImports = false;
  try {
    const absTarget = safeJoin(paths.rootDir, targetFile);
    const raw = await fs.readFile(absTarget, 'utf8');
    const normalized = raw.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');

    const extracted = await extractImportsForFile(cfg, targetFile, normalized, lines, warnings);
    usedAstForImports = extracted.usedAst;

    const resolvedCache = new Map<string, string | null>(); // module -> bundle-relative file path
    const goModuleCache = new Map<string, { moduleRootDir: string; modulePath: string } | null>(); // dir -> go.mod info
    let rustCrateRoot:
      | { crateRootDir: string; crateRootFileRel: string }
      | null
      | undefined;

    const normalizeDir = (d: string): string => (d === '.' ? '' : d);

    const resolveImportToFile = async (module: string): Promise<string | null> => {
      const cached = resolvedCache.get(module);
      if (cached !== undefined) return cached;

      if (!targetRepo) {
        resolvedCache.set(module, null);
        return null;
      }

      const importerRel = targetRepo.repoRelativePath;
      const ext = normalizeExt(importerRel);
      const cleaned = (module.split(/[?#]/, 1)[0] ?? '').trim();
      if (!cleaned) {
        resolvedCache.set(module, null);
        return null;
      }

      const bundlePathForRepoRel = (repoRel: string): string =>
        `${targetRepo.repoRoot}/${repoRel.replaceAll('\\', '/')}`;

      const isJs = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext);
      if (isJs) {
        if (!cleaned.startsWith('.') && !cleaned.startsWith('/')) {
          resolvedCache.set(module, null);
          return null;
        }

        const importerDir = normalizeDir(path.posix.dirname(importerRel));
        const base = cleaned.startsWith('/')
          ? path.posix.normalize(cleaned.slice(1))
          : path.posix.normalize(path.posix.join(importerDir, cleaned));

        const candidates: string[] = [];
        const baseExt = path.posix.extname(base).toLowerCase();

        const add = (repoRel: string) => {
          candidates.push(repoRel);
        };

        if (baseExt) {
          add(base);

          // TS projects sometimes import './x.js' but source is './x.ts'
          if (baseExt === '.js' || baseExt === '.mjs' || baseExt === '.cjs') {
            const stem = base.slice(0, -baseExt.length);
            add(`${stem}.ts`);
            add(`${stem}.tsx`);
            add(`${stem}.jsx`);
          }
          if (baseExt === '.jsx') {
            const stem = base.slice(0, -baseExt.length);
            add(`${stem}.tsx`);
            add(`${stem}.ts`);
          }
        } else {
          const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
          for (const e of exts) add(`${base}${e}`);
          for (const e of exts) add(path.posix.join(base, `index${e}`));
        }

        for (const repoRel of candidates) {
          const bundleRel = bundlePathForRepoRel(repoRel);
          const abs = safeJoin(paths.rootDir, bundleRel);
          if (await fileExists(abs)) {
            resolvedCache.set(module, bundleRel);
            return bundleRel;
          }
        }

        resolvedCache.set(module, null);
        return null;
      }

      if (ext === '.py') {
        // Best-effort Python module resolution (deterministic, file-existence based).
        // - Relative imports: .foo / ..foo.bar
        // - Absolute imports: pkg.sub (tries repo root + src/ + importer top-level dir)

        // Relative imports
        if (cleaned.startsWith('.')) {
          const m = cleaned.match(/^(\.+)(.*)$/);
          if (!m) {
            resolvedCache.set(module, null);
            return null;
          }

          const dotCount = m[1]?.length ?? 0;
          const rest = (m[2] ?? '').replace(/^\.+/, '');

          let baseDir = normalizeDir(path.posix.dirname(importerRel));
          for (let i = 1; i < dotCount; i++) {
            baseDir = normalizeDir(path.posix.dirname(baseDir));
          }

          const restPath = rest ? rest.replace(/\./g, '/') : '';
          const candidatesRepoRel: string[] = [];

          if (restPath) {
            candidatesRepoRel.push(normalizeDir(path.posix.join(baseDir, `${restPath}.py`)));
            candidatesRepoRel.push(normalizeDir(path.posix.join(baseDir, restPath, '__init__.py')));
          } else {
            candidatesRepoRel.push(normalizeDir(path.posix.join(baseDir, '__init__.py')));
          }

          for (const repoRel of candidatesRepoRel) {
            const bundleRel = bundlePathForRepoRel(repoRel);
            const abs = safeJoin(paths.rootDir, bundleRel);
            if (await fileExists(abs)) {
              resolvedCache.set(module, bundleRel);
              return bundleRel;
            }
          }

          resolvedCache.set(module, null);
          return null;
        }

        // Absolute imports
        const modulePath = cleaned.replace(/\./g, '/');
        const topLevelDir = importerRel.includes('/') ? importerRel.split('/')[0] ?? '' : '';

        // Candidate roots in deterministic order (prefer the importer's layout if possible).
        const roots: string[] = [];

        if (importerRel.startsWith('src/')) roots.push('src');
        const moduleStartsWithTop = topLevelDir ? modulePath === topLevelDir || modulePath.startsWith(`${topLevelDir}/`) : false;
        if (topLevelDir && topLevelDir !== 'src' && !moduleStartsWithTop) roots.push(topLevelDir);
        roots.push('');
        if (!roots.includes('src')) roots.push('src');

        const matches: Array<{ root: string; repoRel: string; bundleRel: string }> = [];

        for (const root of roots) {
          const base = root ? `${root}/${modulePath}` : modulePath;

          const repoRelFile = `${base}.py`;
          const bundleRelFile = bundlePathForRepoRel(repoRelFile);
          const absFile = safeJoin(paths.rootDir, bundleRelFile);
          if (await fileExists(absFile)) {
            matches.push({ root, repoRel: repoRelFile, bundleRel: bundleRelFile });
            continue;
          }

          const repoRelInit = `${base}/__init__.py`;
          const bundleRelInit = bundlePathForRepoRel(repoRelInit);
          const absInit = safeJoin(paths.rootDir, bundleRelInit);
          if (await fileExists(absInit)) {
            matches.push({ root, repoRel: repoRelInit, bundleRel: bundleRelInit });
          }
        }

        if (matches.length === 0) {
          resolvedCache.set(module, null);
          return null;
        }

        if (matches.length === 1) {
          const only = matches[0]!.bundleRel;
          resolvedCache.set(module, only);
          return only;
        }

        // If multiple matches exist, pick the one in the importer's own root (if any).
        const preferred = matches.filter((m) => m.root && importerRel.startsWith(`${m.root}/`));
        if (preferred.length === 1) {
          const only = preferred[0]!.bundleRel;
          resolvedCache.set(module, only);
          return only;
        }

        // Ambiguous.
        resolvedCache.set(module, null);
        return null;
      }

      if (ext === '.go') {
        // Best-effort: resolve in-module imports using nearest go.mod's module path.
        const importerDir = normalizeDir(path.posix.dirname(importerRel));

        const findGoModule = async (): Promise<{ moduleRootDir: string; modulePath: string } | null> => {
          let cur = importerDir;
          while (true) {
            const cached = goModuleCache.get(cur);
            if (cached !== undefined) return cached;

            const goModRepoRel = cur ? `${cur}/go.mod` : 'go.mod';
            const goModBundleRel = bundlePathForRepoRel(goModRepoRel);

            let mod: { moduleRootDir: string; modulePath: string } | null = null;
            const abs = safeJoin(paths.rootDir, goModBundleRel);
            if (await fileExists(abs)) {
              try {
                const raw = await fs.readFile(abs, 'utf8');
                const content = raw.replace(/\r\n/g, '\n');
                for (const line of content.split('\n')) {
                  const t = line.trim();
                  if (!t || t.startsWith('//')) continue;
                  const m = t.match(/^module\s+(\S+)/);
                  if (m?.[1]) {
                    mod = { moduleRootDir: cur, modulePath: m[1] };
                    break;
                  }
                }
              } catch {
                // ignore
              }
            }

            goModuleCache.set(cur, mod);
            if (mod) return mod;

            if (!cur) return null;
            cur = normalizeDir(path.posix.dirname(cur));
          }
        };

        const mod = await findGoModule();
        if (!mod) {
          resolvedCache.set(module, null);
          return null;
        }

        if (cleaned !== mod.modulePath && !cleaned.startsWith(`${mod.modulePath}/`)) {
          resolvedCache.set(module, null);
          return null;
        }

        const sub = cleaned === mod.modulePath ? '' : cleaned.slice(mod.modulePath.length + 1);
        const pkgDirRepoRel = normalizeDir(path.posix.join(mod.moduleRootDir, sub));
        const pkgDirBundleRel = pkgDirRepoRel
          ? `${targetRepo.repoRoot}/${pkgDirRepoRel}`
          : targetRepo.repoRoot;

        try {
          const absDir = safeJoin(paths.rootDir, pkgDirBundleRel);
          const entries = await fs.readdir(absDir, { withFileTypes: true });
          const goFiles = entries
            .filter((e) => e.isFile() && e.name.endsWith('.go'))
            .map((e) => e.name)
            .sort();

          const picked = goFiles.find((n) => !n.endsWith('_test.go')) ?? goFiles[0];
          if (!picked) {
            resolvedCache.set(module, null);
            return null;
          }

          const bundleRel = `${pkgDirBundleRel}/${picked}`;
          resolvedCache.set(module, bundleRel);
          return bundleRel;
        } catch {
          resolvedCache.set(module, null);
          return null;
        }
      }

      if (ext === '.rs') {
        // Resolve crate/self/super imports to actual module files (best-effort).
        const importerDir = normalizeDir(path.posix.dirname(importerRel));

        const repoRelFileExists = async (repoRel: string): Promise<boolean> => {
          const bundleRel = bundlePathForRepoRel(repoRel);
          const abs = safeJoin(paths.rootDir, bundleRel);
          return fileExists(abs);
        };

        const findRustCrateRoot = async (): Promise<{ crateRootDir: string; crateRootFileRel: string } | null> => {
          if (rustCrateRoot !== undefined) return rustCrateRoot;

          let cur = importerDir;
          while (true) {
            // try <cur>/lib.rs or <cur>/main.rs
            if (cur) {
              const lib = `${cur}/lib.rs`;
              if (await repoRelFileExists(lib)) {
                rustCrateRoot = { crateRootDir: cur, crateRootFileRel: lib };
                return rustCrateRoot;
              }

              const main = `${cur}/main.rs`;
              if (await repoRelFileExists(main)) {
                rustCrateRoot = { crateRootDir: cur, crateRootFileRel: main };
                return rustCrateRoot;
              }
            }

            // try <cur>/src/lib.rs or <cur>/src/main.rs
            const lib2 = `${cur ? cur + '/' : ''}src/lib.rs`;
            if (await repoRelFileExists(lib2)) {
              const crateDir = normalizeDir(path.posix.dirname(lib2));
              rustCrateRoot = { crateRootDir: crateDir, crateRootFileRel: lib2 };
              return rustCrateRoot;
            }

            const main2 = `${cur ? cur + '/' : ''}src/main.rs`;
            if (await repoRelFileExists(main2)) {
              const crateDir = normalizeDir(path.posix.dirname(main2));
              rustCrateRoot = { crateRootDir: crateDir, crateRootFileRel: main2 };
              return rustCrateRoot;
            }

            if (!cur) break;
            cur = normalizeDir(path.posix.dirname(cur));
          }

          rustCrateRoot = null;
          return null;
        };

        const crate = await findRustCrateRoot();
        if (!crate) {
          resolvedCache.set(module, null);
          return null;
        }

        const moduleDirForFile = (fileRepoRel: string): string => {
          const dir = normalizeDir(path.posix.dirname(fileRepoRel));
          if (fileRepoRel === crate.crateRootFileRel) return crate.crateRootDir;

          const base = path.posix.basename(fileRepoRel);
          if (base === 'mod.rs') return dir;

          const stem = path.posix.basename(fileRepoRel, '.rs');
          return normalizeDir(path.posix.join(dir, stem));
        };

        let t = cleaned;
        t = t.replace(/;$/, '');
        t = t.replace(/^::+/, '');
        if (!t) {
          resolvedCache.set(module, null);
          return null;
        }

        const segs = t.split('::').filter(Boolean);
        if (segs.length === 0) {
          resolvedCache.set(module, null);
          return null;
        }

        let baseDir: string;
        let i = 0;

        if (segs[0] === 'crate') {
          baseDir = crate.crateRootDir;
          i = 1;
        } else if (segs[0] === 'self') {
          baseDir = moduleDirForFile(importerRel);
          i = 1;
        } else if (segs[0] === 'super') {
          baseDir = moduleDirForFile(importerRel);
          while (i < segs.length && segs[i] === 'super') {
            baseDir = normalizeDir(path.posix.dirname(baseDir));
            i++;
          }
        } else {
          resolvedCache.set(module, null);
          return null;
        }

        if (i >= segs.length) {
          resolvedCache.set(module, null);
          return null;
        }

        let curDir = baseDir;
        let lastResolvedRepoRel: string | null = null;

        for (let j = i; j < segs.length; j++) {
          const name = segs[j]!;
          const cand1 = normalizeDir(path.posix.join(curDir, `${name}.rs`));
          const cand2 = normalizeDir(path.posix.join(curDir, name, 'mod.rs'));

          let found: string | null = null;
          if (await repoRelFileExists(cand1)) found = cand1;
          else if (await repoRelFileExists(cand2)) found = cand2;

          if (!found) break;

          lastResolvedRepoRel = found;
          curDir = moduleDirForFile(found);
        }

        if (!lastResolvedRepoRel) {
          resolvedCache.set(module, null);
          return null;
        }

        const bundleRel = bundlePathForRepoRel(lastResolvedRepoRel);
        resolvedCache.set(module, bundleRel);
        return bundleRel;
      }

      resolvedCache.set(module, null);
      return null;
    };

    for (const imp of extracted.imports) {
      if (checkBudget('timeBudget exceeded during import extraction')) break;

      const modId = `module:${imp.module}`;
      addNode({ id: modId, kind: 'module', name: imp.module });

      const source: SourceRef = {
        file: targetFile,
        range: imp.range,
        uri: bundleFileUri(targetFile),
        snippet: clampSnippet(lines[imp.range.startLine - 1] ?? '', 200),
      };
      source.snippetSha256 = sha256Hex(source.snippet ?? '');

      addEdge({
        evidenceId: makeEvidenceId([
          'imports',
          targetFileId,
          modId,
          String(imp.range.startLine),
          String(imp.range.startCol),
        ]),
        kind: 'edge',
        type: 'imports',
        from: targetFileId,
        to: modId,
        method: imp.method,
        confidence: imp.confidence,
        sources: [source],
        notes: imp.notes,
      });

      const resolvedFile = await resolveImportToFile(imp.module);
      if (!resolvedFile) continue;
      if (checkBudget('timeBudget exceeded during import resolution')) break;

      const fileId = `file:${resolvedFile}`;
      addNode({ id: fileId, kind: 'file', name: resolvedFile, file: resolvedFile, attrs: { role: 'internal' } });

      addEdge({
        evidenceId: makeEvidenceId([
          'imports_resolved',
          targetFileId,
          fileId,
          String(imp.range.startLine),
          String(imp.range.startCol),
        ]),
        kind: 'edge',
        type: 'imports_resolved',
        from: targetFileId,
        to: fileId,
        method: 'heuristic',
        confidence: Math.min(0.85, imp.confidence),
        sources: [source],
        notes: [...imp.notes, `resolved import to bundle file: ${resolvedFile}`],
      });
    }
  } catch (err) {
    // If target file not found, throw a helpful error instead of just warning
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Detect if path looks like an absolute filesystem path (wrong format)
      const looksLikeAbsolutePath = /^[A-Za-z]:[\\/]|^\/(?:home|Users|var|tmp|etc)\//i.test(targetFile);
      // Detect if path looks like correct bundle-relative format
      const looksLikeBundleRelative = /^repos\/[^/]+\/[^/]+\/norm\//i.test(targetFile);

      if (looksLikeAbsolutePath) {
        throw new Error(
          `Target file not found: ${targetFile}\n\n` +
          `ERROR: You provided an absolute filesystem path, but file paths must be bundle-relative.\n` +
          `Correct format: repos/{owner}/{repo}/norm/{path/to/file}\n` +
          `Example: repos/owner/myrepo/norm/src/main.py\n\n` +
          `Use preflight_search_and_read to find the correct file path.`
        );
      } else if (looksLikeBundleRelative) {
        throw new Error(
          `Target file not found: ${targetFile}\n\n` +
          `The path format looks correct, but the file does not exist in the bundle.\n` +
          `Possible causes:\n` +
          `1. The bundle may be incomplete (download timed out or failed)\n` +
          `2. The file path may have a typo\n\n` +
          `Suggested actions:\n` +
          `- Use preflight_search_and_read to verify available files\n` +
          `- Use preflight_update_bundle with updateExisting:true to re-download\n` +
          `- Check if repair shows "indexed 0 file(s)" which indicates incomplete bundle`
        );
      } else {
        throw new Error(
          `Target file not found: ${targetFile}\n\n` +
          `File paths must be bundle-relative, NOT absolute filesystem paths.\n` +
          `Correct format: repos/{owner}/{repo}/norm/{path/to/file}\n` +
          `Example: repos/owner/myrepo/norm/src/main.py\n\n` +
          `Use preflight_search_and_read to find the correct file path.`
        );
      }
    }
    warnings.push({
      code: 'target_file_unreadable',
      message: `Failed to read target file for import extraction: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 2) Upstream: find references via FTS hits (only if edgeTypes='all')
  let searchHits = 0;
  let filesRead = 0;
  let referenceEdges = 0;
  let importEdges = edges.filter((e) => e.type === 'imports').length;
  
  const includeReferences = args.edgeTypes === 'all';
  const excludeExtensions = new Set(args.options.excludeExtensions ?? ['.json', '.md', '.txt', '.yml', '.yaml', '.toml', '.lock']);

  if (includeReferences && targetSymbol && targetSymbol.length >= 2) {
    const maxHits = Math.min(500, limits.maxFiles * 5);
    const hits = searchIndex(paths.searchDbPath, targetSymbol, 'code', maxHits, paths.rootDir);
    searchHits = hits.length;

    const fileLineCache = new Map<string, string[]>();

    for (const hit of hits) {
      if (checkBudget('timeBudget exceeded during reference scan')) break;
      if (edges.length >= limits.maxEdges) break;

      const hitPath = hit.path;
      if (!hitPath || hit.kind !== 'code') continue;
      
      // P3: Filter out non-code files by extension
      const hitExt = path.extname(hitPath).toLowerCase();
      if (excludeExtensions.has(hitExt)) continue;

      // Skip obvious self-reference in the same file if no symbol boundary detection.
      // We still allow references within the same file (but avoid exploding edges).

      // Read file lines (cache)
      let lines = fileLineCache.get(hitPath);
      if (!lines) {
        try {
          const abs = safeJoin(paths.rootDir, hitPath);
          const content = await fs.readFile(abs, 'utf8');
          lines = content.replace(/\r\n/g, '\n').split('\n');
          fileLineCache.set(hitPath, lines);
          filesRead++;
        } catch {
          continue;
        }
      }

      const line = lines[hit.lineNo - 1] ?? '';
      const call = isLikelyCallSite(line, targetSymbol);
      if (!call) continue;

      const callerId = hit.context?.functionName
        ? `symbol:${hit.context.functionName}@${hitPath}#${hit.context.startLine}`
        : `file:${hitPath}`;

      if (callerId === targetSymbolId) continue;

      if (hit.context?.functionName) {
        addNode({
          id: callerId,
          kind: 'symbol',
          name: hit.context.functionName,
          file: hitPath,
          range: {
            startLine: hit.context.startLine,
            startCol: 1,
            endLine: hit.context.endLine,
            endCol: 1,
          },
          attrs: hit.context.className ? { className: hit.context.className } : undefined,
        });
      } else {
        addNode({ id: callerId, kind: 'file', name: hitPath, file: hitPath });
      }

      const src: SourceRef = {
        file: hitPath,
        range: { startLine: hit.lineNo, startCol: call.startCol, endLine: hit.lineNo, endCol: call.endCol },
        uri: bundleFileUri(hitPath),
        snippet: clampSnippet(line, 200),
      };
      src.snippetSha256 = sha256Hex(src.snippet ?? '');

      const evidenceId = makeEvidenceId(['references', callerId, targetSymbolId, hitPath, String(hit.lineNo), String(call.startCol)]);
      addEdge({
        evidenceId,
        kind: 'edge',
        type: 'references',
        from: callerId,
        to: targetSymbolId,
        method: 'heuristic',
        confidence: 0.5,
        sources: [src],
        notes: ['reference edge is FTS name-based (may include false positives from comments/strings/docs)'],
      });

      referenceEdges++;

      if (nodes.size >= limits.maxNodes) {
        truncated = true;
        truncatedReason = 'maxNodes reached';
        break;
      }
    }

    if (searchHits === maxHits) {
      warnings.push({
        code: 'search_hits_capped',
        message: `Search hits were capped at ${maxHits}; graph may be incomplete.`,
      });
    }
  } else if (!includeReferences && targetSymbol && targetSymbol.length >= 2) {
    warnings.push({
      code: 'references_skipped',
      message:
        'Reference/caller search was skipped (edgeTypes="imports"). Use edgeTypes="all" to include FTS-based reference edges (may have false positives).',
    });
  } else {
    warnings.push({
      code: 'symbol_missing_or_too_short',
      message:
        'No symbol provided (or symbol too short). Reference graph was skipped; only imports were extracted from the target file.',
    });
  }

  // Post-process warnings
  warnings.push({
    code: 'limitations',
    message: usedAstForImports
      ? 'This dependency graph uses deterministic parsing for imports (Tree-sitter WASM syntax AST). Reference edges (if enabled) use FTS + name-based heuristics and may have false positives. Each edge includes method/confidence/sources for auditability.'
      : 'This dependency graph uses regex-based import extraction. Reference edges (if enabled) use FTS + name-based heuristics. Each edge includes method/confidence/sources for auditability.',
  });

  // Stats
  importEdges = edges.filter((e) => e.type === 'imports' || e.type === 'imports_resolved').length;

  // Build minimal coverageReport for target mode (EDDA requirement)
  const targetExt = path.extname(targetFile).toLowerCase();
  const targetLang = targetExt.replace('.', '') || 'unknown';
  const targetCoverageReport: CoverageReport = {
    scannedFilesCount: 1,
    parsedFilesCount: 1,
    perLanguage: {
      [targetLang]: {
        scanned: 1,
        parsed: 1,
        edges: importEdges,
      },
    },
    perDir: {},
    skippedFiles: [],
    truncated,
    truncatedReason,
    limits: {
      maxFiles: limits.maxFiles,
      maxNodes: limits.maxNodes,
      maxEdges: limits.maxEdges,
      timeBudgetMs,
    },
  };

  const out: DependencyGraphResult = {
    meta: {
      requestId,
      generatedAt: nowIso(),
      timeMs: Date.now() - startedAt,
      repo: {
        bundleId: args.bundleId,
        headSha: manifest.repos?.[0]?.headSha,
      },
      budget: {
        timeBudgetMs,
        truncated,
        truncatedReason,
        limits,
      },
      cacheInfo: {
        fromCache: false,
      },
    },
    facts: {
      nodes: Array.from(nodes.values()),
      edges,
    },
    signals: {
      stats: {
        filesRead,
        searchHits,
        callEdges: referenceEdges, // deprecated, use referenceEdges
        referenceEdges,
        importEdges,
      },
      warnings,
    },
    coverageReport: targetCoverageReport,
  };

  return out;
}

/**
 * Global dependency graph mode: analyze all code files in the bundle.
 * Generates import relationships between all files.
 */
async function generateGlobalDependencyGraph(ctx: {
  cfg: PreflightConfig;
  args: { bundleId: string; options: { maxFiles: number; maxNodes: number; maxEdges: number; timeBudgetMs: number; maxFileSizeBytes?: number; largeFileStrategy?: 'skip' | 'truncate'; truncateLines?: number } };
  paths: { rootDir: string; reposDir: string; searchDbPath: string; manifestPath: string };
  manifest: any;
  limits: { maxFiles: number; maxNodes: number; maxEdges: number };
  nodes: Map<string, GraphNode>;
  edges: EvidenceItem[];
  warnings: Array<{ code: string; message: string; evidenceIds?: string[] }>;
  startedAt: number;
  requestId: string;
  timeBudgetMs: number;
  checkBudget: (reason: string) => boolean;
  addNode: (n: GraphNode) => void;
  addEdge: (e: EvidenceItem) => void;
  bundleFileUri: (p: string) => string;
}): Promise<DependencyGraphResult> {
  const {
    cfg,
    args,
    paths,
    manifest,
    limits,
    nodes,
    edges,
    warnings,
    startedAt,
    requestId,
    timeBudgetMs,
    checkBudget,
    addNode,
    addEdge,
    bundleFileUri,
  } = ctx;

  let truncated = false;
  let truncatedReason: string | undefined;
  let filesProcessed = 0;
  let usedAstCount = 0;

  // Coverage tracking
  const perLanguage: Record<string, { scanned: number; parsed: number; edges: number }> = {};
  const perDir: Record<string, number> = {};
  const skippedFiles: Array<{ path: string; size?: number; reason: string }> = [];
  let scannedFilesCount = 0;

  // Helper to get language from extension
  const extToLang: Record<string, string> = {
    '.ts': 'TypeScript', '.tsx': 'TypeScript',
    '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
    '.py': 'Python',
    '.go': 'Go',
    '.rs': 'Rust',
    '.java': 'Java',
    '.rb': 'Ruby',
    '.php': 'PHP',
  };

  const getLang = (filePath: string): string => {
    const ext = path.extname(filePath).toLowerCase();
    return extToLang[ext] ?? 'Other';
  };

  const getTopDir = (filePath: string): string => {
    // Extract the top-level directory under repos/owner/repo/norm/
    const parts = filePath.split('/');
    // repos/owner/repo/norm/[topDir]/...
    if (parts.length > 4 && parts[0] === 'repos' && parts[3] === 'norm') {
      return parts[4] ?? '(root)';
    }
    return parts[0] ?? '(root)';
  };

  // Collect all code files
  const codeExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.rb', '.php']);
  const codeFiles: string[] = [];

  async function* walkDir(dir: string, prefix: string): AsyncGenerator<string> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (checkBudget('timeBudget exceeded during file discovery')) return;
        const relPath = prefix ? `${prefix}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          yield* walkDir(path.join(dir, ent.name), relPath);
        } else if (ent.isFile()) {
          const ext = path.extname(ent.name).toLowerCase();
          if (codeExtensions.has(ext)) {
            yield relPath;
          }
        }
      }
    } catch {
      // ignore unreadable directories
    }
  }

  // Walk repos directory
  for await (const relPath of walkDir(paths.reposDir, 'repos')) {
    scannedFilesCount++;
    
    // Track per-directory stats
    const topDir = getTopDir(relPath);
    perDir[topDir] = (perDir[topDir] ?? 0) + 1;

    // Track per-language stats
    const lang = getLang(relPath);
    if (!perLanguage[lang]) {
      perLanguage[lang] = { scanned: 0, parsed: 0, edges: 0 };
    }
    perLanguage[lang]!.scanned++;

    if (codeFiles.length >= limits.maxFiles) {
      truncated = true;
      truncatedReason = 'maxFiles reached during discovery';
      skippedFiles.push({ path: relPath, reason: 'maxFiles limit reached' });
      continue;
    }
    // Only include files under norm/ directories
    if (relPath.includes('/norm/')) {
      codeFiles.push(relPath);
    } else {
      skippedFiles.push({ path: relPath, reason: 'not in norm/ directory' });
    }
  }

  warnings.push({
    code: 'global_mode',
    message: `Global dependency graph mode: analyzing ${codeFiles.length} code file(s). Results show import relationships between files.`,
  });

  // Process each file
  const resolvedImportsCache = new Map<string, Map<string, string | null>>();

  for (const filePath of codeFiles) {
    if (checkBudget('timeBudget exceeded during file processing')) {
      truncated = true;
      truncatedReason = 'timeBudget exceeded';
      break;
    }

    const fileId = `file:${filePath}`;
    addNode({ id: fileId, kind: 'file', name: filePath, file: filePath });

    // Read and extract imports
    const lang = getLang(filePath);
    try {
      const absPath = safeJoin(paths.rootDir, filePath);
      const stat = await fs.stat(absPath);
      
      // Handle large files based on strategy
      const maxSize = args.options.maxFileSizeBytes ?? 1_000_000;
      const strategy = args.options.largeFileStrategy ?? 'skip';
      const truncateLines = args.options.truncateLines ?? 500;
      
      if (stat.size > maxSize) {
        if (strategy === 'skip') {
          skippedFiles.push({ 
            path: filePath, 
            size: stat.size, 
            reason: `file too large (>${Math.round(maxSize / 1024)}KB). Use largeFileStrategy='truncate' or increase maxFileSizeBytes to include.` 
          });
          continue;
        }
        // strategy === 'truncate': read first N lines only
      }
      
      let raw: string;
      if (stat.size > maxSize && strategy === 'truncate') {
        // Read file and take first N lines
        const fullContent = await fs.readFile(absPath, 'utf8');
        const allLines = fullContent.replace(/\r\n/g, '\n').split('\n');
        raw = allLines.slice(0, truncateLines).join('\n');
        warnings.push({
          code: 'file_truncated',
          message: `${filePath}: truncated to first ${truncateLines} lines (file size ${Math.round(stat.size / 1024)}KB exceeds ${Math.round(maxSize / 1024)}KB limit)`,
        });
      } else {
        raw = await fs.readFile(absPath, 'utf8');
      }
      const normalized = raw.replace(/\r\n/g, '\n');
      const lines = normalized.split('\n');

      const extracted = await extractImportsForFile(cfg, filePath, normalized, lines, warnings);
      if (extracted.usedAst) usedAstCount++;
      filesProcessed++;
      
      // Track parsed count per language
      if (perLanguage[lang]) {
        perLanguage[lang]!.parsed++;
      }

      const fileRepo = parseRepoNormPath(filePath);
      if (!fileRepo) continue;

      // Resolve imports to files in the bundle
      for (const imp of extracted.imports) {
        if (checkBudget('timeBudget exceeded during import resolution')) break;

        // Try to resolve the import to a file in the same repo
        const resolvedFile = await resolveImportInRepo({
          rootDir: paths.rootDir,
          repoRoot: fileRepo.repoRoot,
          importerRepoRel: fileRepo.repoRelativePath,
          module: imp.module,
          cache: resolvedImportsCache,
        });

        if (resolvedFile) {
          const targetId = `file:${resolvedFile}`;
          addNode({ id: targetId, kind: 'file', name: resolvedFile, file: resolvedFile });

          const source: SourceRef = {
            file: filePath,
            range: imp.range,
            uri: bundleFileUri(filePath),
            snippet: clampSnippet(lines[imp.range.startLine - 1] ?? '', 200),
          };
          source.snippetSha256 = sha256Hex(source.snippet ?? '');

          addEdge({
            evidenceId: makeEvidenceId(['imports_resolved', fileId, targetId, String(imp.range.startLine)]),
            kind: 'edge',
            type: 'imports_resolved',
            from: fileId,
            to: targetId,
            method: imp.method,
            confidence: Math.min(0.85, imp.confidence),
            sources: [source],
            notes: [...imp.notes, `resolved import "${imp.module}" to ${resolvedFile}`],
          });
          
          // Track edges per language
          if (perLanguage[lang]) {
            perLanguage[lang]!.edges++;
          }
        }
      }
    } catch (err) {
      // Track skipped files with reason
      const reason = err instanceof Error ? err.message : 'unknown error';
      skippedFiles.push({ path: filePath, reason: `read error: ${reason.slice(0, 100)}` });
    }
  }

  // Post-process warnings
  warnings.push({
    code: 'limitations',
    message: usedAstCount > 0
      ? `Global graph used AST parsing for ${usedAstCount}/${filesProcessed} files. Import resolution is best-effort. Only internal imports (resolved to files in the bundle) are shown.`
      : 'Global graph used regex-based import extraction. Import resolution is best-effort. Only internal imports (resolved to files in the bundle) are shown.',
  });

  const importEdges = edges.filter((e) => e.type === 'imports_resolved').length;

  // Build coverage report
  const coverageReport: CoverageReport = {
    scannedFilesCount,
    parsedFilesCount: filesProcessed,
    perLanguage,
    perDir,
    skippedFiles: skippedFiles.slice(0, 50), // Limit to first 50 for output size
    truncated,
    truncatedReason,
    limits: {
      maxFiles: limits.maxFiles,
      maxNodes: limits.maxNodes,
      maxEdges: limits.maxEdges,
      timeBudgetMs,
    },
  };

  // Generate high-value modules and Mermaid diagram
  const nodesArray = Array.from(nodes.values());
  const highValueModules = identifyHighValueModules(edges, nodesArray);
  const mermaid = edges.length > 0 ? generateMermaidDiagram(edges, 15) : undefined;

  return {
    meta: {
      requestId,
      generatedAt: nowIso(),
      timeMs: Date.now() - startedAt,
      repo: {
        bundleId: args.bundleId,
        headSha: manifest.repos?.[0]?.headSha,
      },
      budget: {
        timeBudgetMs,
        truncated,
        truncatedReason,
        limits,
      },
      cacheInfo: {
        fromCache: false,
      },
    },
    facts: {
      nodes: nodesArray,
      edges,
    },
    signals: {
      stats: {
        filesRead: filesProcessed,
        searchHits: 0,
        callEdges: 0, // deprecated
        referenceEdges: 0,
        importEdges,
      },
      warnings,
      highValueModules: highValueModules.length > 0 ? highValueModules : undefined,
    },
    coverageReport,
    mermaid,
  };
}

/**
 * Resolve an import to a file path within the same repo.
 */
async function resolveImportInRepo(ctx: {
  rootDir: string;
  repoRoot: string; // e.g. repos/owner/repo/norm
  importerRepoRel: string; // path relative to repoRoot
  module: string;
  cache: Map<string, Map<string, string | null>>;
}): Promise<string | null> {
  const { rootDir, repoRoot, importerRepoRel, module, cache } = ctx;

  // Get or create cache for this repo
  let repoCache = cache.get(repoRoot);
  if (!repoCache) {
    repoCache = new Map();
    cache.set(repoRoot, repoCache);
  }

  const cacheKey = `${importerRepoRel}:${module}`;
  const cached = repoCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const ext = path.extname(importerRepoRel).toLowerCase();
  const cleaned = (module.split(/[?#]/, 1)[0] ?? '').trim();
  if (!cleaned) {
    repoCache.set(cacheKey, null);
    return null;
  }

  const bundlePathForRepoRel = (repoRel: string): string =>
    `${repoRoot}/${repoRel.replaceAll('\\', '/')}`;

  const normalizeDir = (d: string): string => (d === '.' ? '' : d);

  // JS/TS resolution
  const isJs = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext);
  if (isJs) {
    if (!cleaned.startsWith('.') && !cleaned.startsWith('/')) {
      repoCache.set(cacheKey, null);
      return null;
    }

    const importerDir = normalizeDir(path.posix.dirname(importerRepoRel));
    const base = cleaned.startsWith('/')
      ? path.posix.normalize(cleaned.slice(1))
      : path.posix.normalize(path.posix.join(importerDir, cleaned));

    const candidates: string[] = [];
    const baseExt = path.posix.extname(base).toLowerCase();

    if (baseExt) {
      candidates.push(base);
      if (['.js', '.mjs', '.cjs'].includes(baseExt)) {
        const stem = base.slice(0, -baseExt.length);
        candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.jsx`);
      }
    } else {
      const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
      for (const e of exts) candidates.push(`${base}${e}`);
      for (const e of exts) candidates.push(path.posix.join(base, `index${e}`));
    }

    for (const repoRel of candidates) {
      const bundleRel = bundlePathForRepoRel(repoRel);
      const abs = safeJoin(rootDir, bundleRel);
      if (await fileExists(abs)) {
        repoCache.set(cacheKey, bundleRel);
        return bundleRel;
      }
    }
  }

  // Python resolution
  if (ext === '.py') {
    if (cleaned.startsWith('.')) {
      // Relative import
      const m = cleaned.match(/^(\.+)(.*)$/);
      if (m) {
        const dotCount = m[1]?.length ?? 0;
        const rest = (m[2] ?? '').replace(/^\.+/, '');
        let baseDir = normalizeDir(path.posix.dirname(importerRepoRel));
        for (let i = 1; i < dotCount; i++) {
          baseDir = normalizeDir(path.posix.dirname(baseDir));
        }
        const restPath = rest ? rest.replace(/\./g, '/') : '';
        const candidates = restPath
          ? [path.posix.join(baseDir, `${restPath}.py`), path.posix.join(baseDir, restPath, '__init__.py')]
          : [path.posix.join(baseDir, '__init__.py')];

        for (const repoRel of candidates) {
          const bundleRel = bundlePathForRepoRel(repoRel);
          const abs = safeJoin(rootDir, bundleRel);
          if (await fileExists(abs)) {
            repoCache.set(cacheKey, bundleRel);
            return bundleRel;
          }
        }
      }
    } else {
      // Absolute import - try common patterns
      const modPath = cleaned.replace(/\./g, '/');
      const candidates = [`${modPath}.py`, path.posix.join(modPath, '__init__.py')];
      for (const repoRel of candidates) {
        const bundleRel = bundlePathForRepoRel(repoRel);
        const abs = safeJoin(rootDir, bundleRel);
        if (await fileExists(abs)) {
          repoCache.set(cacheKey, bundleRel);
          return bundleRel;
        }
      }
    }
  }

  repoCache.set(cacheKey, null);
  return null;
}
