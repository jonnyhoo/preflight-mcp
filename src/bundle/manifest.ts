import fs from 'node:fs/promises';
import path from 'node:path';

export type RepoInput =
  | {
      kind: 'github';
      repo: string; // owner/repo
      ref?: string; // optional branch/tag/sha
    }
  | {
      /**
       * Import a repository from a local directory (e.g., extracted ZIP).
       * `repo` is the logical identifier in owner/repo form (used for storage layout and dedup).
       */
      kind: 'local';
      repo: string; // owner/repo (logical id)
      path: string; // local directory path
      ref?: string; // optional label for the local snapshot
    };

export type BundleIndexConfig = {
  backend: 'sqlite-fts5-lines';
  includeDocs: boolean;
  includeCode: boolean;
};

export type BundleRepo = {
  kind: 'github' | 'local';
  id: string; // owner/repo
  /**
   * Source of the snapshot for this repo.
   * - github: git shallow clone or GitHub archive (zipball) fallback
   * - local: local directory import
   */
  source?: 'git' | 'archive' | 'local';
  headSha?: string;
  fetchedAt: string; // ISO
  notes?: string[];
};

export type BundleLibrary = {
  kind: 'context7';
  input: string;
  id?: string;
  fetchedAt: string;
  notes?: string[];
  files?: string[];
};

/**
 * Skipped file entry - records files that were not indexed during bundle creation.
 * Used for transparency when search returns 0 results.
 */
export type SkippedFileEntry = {
  /** File path (relative to repo root) */
  path: string;
  /** Reason for skipping */
  reason: 'too_large' | 'binary' | 'non_utf8' | 'max_total_reached';
  /** File size in bytes (if known) */
  size?: number;
};

export type BundleManifestV1 = {
  schemaVersion: 1;
  bundleId: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Stable input fingerprint used for de-duplication.
   * When present, two bundles with the same fingerprint were created from the same normalized inputs.
   */
  fingerprint?: string;
  // NEW: Human-readable metadata
  displayName?: string; // e.g., "React Framework"
  description?: string; // Brief description of the bundle
  tags?: string[];      // Auto-detected or manual tags for categorization
  primaryLanguage?: string; // Primary programming language
  inputs: {
    repos: RepoInput[];
    libraries?: string[];
    topics?: string[];
  };
  repos: BundleRepo[];
  libraries?: BundleLibrary[];
  index: BundleIndexConfig;
  /**
   * Files that were skipped during indexing.
   * Stored for transparency - helps explain why search might miss certain content.
   */
  skippedFiles?: SkippedFileEntry[];
};

export async function readManifest(manifestPath: string): Promise<BundleManifestV1> {
  const raw = await fs.readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as BundleManifestV1;
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported manifest schemaVersion: ${String((parsed as any).schemaVersion)}`);
  }
  return parsed;
}

export async function writeManifest(manifestPath: string, manifest: BundleManifestV1): Promise<void> {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}
