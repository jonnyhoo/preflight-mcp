/**
 * Shared evidence types for EDDA (Evidence-Driven Deep Analysis).
 * These types are the foundation for LLM-first auditable outputs.
 */

/**
 * Source range within a file.
 * All positions are 1-indexed.
 */
export type SourceRange = {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
};

/**
 * Evidence reference - the atomic unit of proof.
 * Every load-bearing claim must be traceable to one or more EvidenceRefs.
 */
export type EvidenceRef = {
  /** Bundle-relative posix path (e.g., "repos/owner/repo/norm/src/index.ts") */
  file: string;
  /** Source range within the file */
  range: SourceRange;
  /** Optional URI for direct access (e.g., "preflight://bundle/xxx/file/...") */
  uri?: string;
  /** Optional short snippet (<= 500 chars recommended) for quote-ready citations */
  snippet?: string;
  /** SHA256 of snippet for integrity verification */
  snippetSha256?: string;
  /** Optional human-readable explanation of why this evidence supports the claim */
  note?: string;
};

/**
 * Claim kind - categorizes the type of assertion.
 */
export type ClaimKind =
  | 'feature'
  | 'entrypoint'
  | 'module'
  | 'dependency'
  | 'test_coverage'
  | 'behavior'
  | 'architecture'
  | 'unknown';

/**
 * Claim status - indicates the evidence strength.
 * - supported: Strong evidence directly supports the claim
 * - inferred: Indirect evidence suggests the claim (requires disclosure)
 * - unknown: No evidence found (must include whyUnknown)
 */
export type ClaimStatus = 'supported' | 'inferred' | 'unknown';

/**
 * A verifiable claim with evidence chain.
 * Core data structure for anti-hallucination auditing.
 */
export type Claim = {
  /** Unique identifier (e.g., "claim_abc123") */
  id: string;
  /** The assertion text */
  text: string;
  /** Confidence score (0.0 - 1.0) */
  confidence: number;
  /** Category of the claim */
  kind: ClaimKind;
  /** Evidence strength indicator */
  status: ClaimStatus;
  /** Supporting evidence references */
  evidence: EvidenceRef[];
  /** Required when status is 'inferred' or 'unknown' */
  whyInferred?: string;
};

/**
 * Skipped file entry in coverage report.
 */
export type SkippedFile = {
  /** File path */
  path: string;
  /** File size in bytes (if known) */
  size?: number;
  /** Reason for skipping */
  reason: 'too_large' | 'parse_error' | 'excluded' | 'timeout' | 'binary' | 'unsupported_lang';
};

/**
 * Per-language statistics in coverage report.
 */
export type LanguageStats = {
  lang: string;
  scanned: number;
  parsed: number;
  edges?: number;
};

/**
 * Per-directory statistics in coverage report.
 */
export type DirStats = {
  dir: string;
  fileCount: number;
};

/**
 * Coverage report - explains what was analyzed and what was skipped.
 * MUST be included in any static analysis output for transparency.
 */
export type CoverageReport = {
  /** Number of files discovered */
  scannedFilesCount: number;
  /** Number of files successfully parsed/analyzed */
  parsedFilesCount: number;
  /** Statistics per programming language */
  perLanguage: LanguageStats[];
  /** File counts per top-level directory */
  perDir: DirStats[];
  /** Files that were skipped with reasons */
  skippedFiles: SkippedFile[];
  /** Whether the analysis was truncated due to limits */
  truncated: boolean;
  /** Reason for truncation if applicable */
  truncatedReason?: 'maxFiles' | 'maxNodes' | 'timeBudgetMs' | 'maxEdges';
  /** Applied limits for reference */
  limits?: {
    maxFiles?: number;
    maxNodes?: number;
    maxEdges?: number;
    timeBudgetMs?: number;
  };
};

/**
 * Evidence method - how the evidence was obtained.
 */
export type EvidenceMethod = 'exact' | 'heuristic';

/**
 * Helper to create an empty coverage report (for error cases).
 */
export function createEmptyCoverageReport(): CoverageReport {
  return {
    scannedFilesCount: 0,
    parsedFilesCount: 0,
    perLanguage: [],
    perDir: [],
    skippedFiles: [],
    truncated: false,
  };
}

/**
 * Helper to check if coverage is sufficient (>= threshold).
 * Default threshold is 60% (0.6).
 */
export function isCoverageSufficient(
  report: CoverageReport,
  threshold: number = 0.6
): boolean {
  if (report.scannedFilesCount === 0) return false;
  const ratio = report.parsedFilesCount / report.scannedFilesCount;
  return ratio >= threshold && !report.truncated;
}

/**
 * Deep analysis checklist status.
 * All steps must be either true or explicitly false with reason.
 */
export type ChecklistStatus = {
  read_overview: boolean;
  repo_tree: boolean;
  search_focus: boolean;
  dependency_graph_global: boolean;
  entrypoints_identified: boolean;
  core_modules_identified: boolean;
  one_deep_dive_done: boolean;
  tests_or_trace_checked: boolean;
};

/**
 * Open question when analysis is incomplete.
 */
export type OpenQuestion = {
  question: string;
  whyUnknown: string;
  nextEvidenceToFetch: string[];
};
