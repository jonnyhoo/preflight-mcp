/**
 * Bundle input fingerprint calculation.
 * Used for deduplication of bundle creation requests.
 */

import crypto from 'node:crypto';
import { type RepoInput } from '../manifest.js';
import { parseOwnerRepo } from '../github.js';

export type CreateBundleInput = {
  repos: RepoInput[];
  libraries?: string[];
  topics?: string[];
};

/**
 * Compute SHA256 hash of a string.
 */
export function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Normalize a list of strings (trim, filter empty, lowercase, sort).
 */
function normalizeList(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toLowerCase())
    .sort();
}

/**
 * Canonicalize create input for fingerprint calculation.
 * Ensures consistent fingerprints regardless of input order or formatting.
 */
export function canonicalizeCreateInput(input: CreateBundleInput): {
  schemaVersion: 1;
  repos: Array<{ kind: 'github'; repo: string; ref?: string }>;
  libraries: string[];
  topics: string[];
} {
  const repos = input.repos
    .map((r) => {
      // For de-duplication, treat local imports as equivalent to github imports of the same logical repo/ref.
      const { owner, repo } = parseOwnerRepo(r.repo);
      return {
        kind: 'github' as const,
        repo: `${owner.toLowerCase()}/${repo.toLowerCase()}`,
        ref: (r.ref ?? '').trim() || undefined,
      };
    })
    .sort((a, b) => {
      const ka = `github:${a.repo}:${a.ref ?? ''}`;
      const kb = `github:${b.repo}:${b.ref ?? ''}`;
      return ka.localeCompare(kb);
    });

  return {
    schemaVersion: 1,
    repos,
    libraries: normalizeList(input.libraries),
    topics: normalizeList(input.topics),
  };
}

/**
 * Compute a deterministic fingerprint for bundle creation inputs.
 * Used for deduplication to avoid recreating identical bundles.
 */
export function computeCreateInputFingerprint(input: CreateBundleInput): string {
  const canonical = canonicalizeCreateInput(input);
  return sha256Hex(JSON.stringify(canonical));
}
