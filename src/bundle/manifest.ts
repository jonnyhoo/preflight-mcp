import fs from 'node:fs/promises';
import path from 'node:path';

export type RepoInput =
  | {
      kind: 'github';
      repo: string; // owner/repo
      ref?: string; // optional branch/tag/sha
    }
  | {
      kind: 'deepwiki';
      url: string;
    };

export type BundleIndexConfig = {
  backend: 'sqlite-fts5-lines';
  includeDocs: boolean;
  includeCode: boolean;
};

export type BundleRepo = {
  kind: 'github' | 'deepwiki';
  id: string; // owner/repo or URL
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

export type BundleManifestV1 = {
  schemaVersion: 1;
  bundleId: string;
  createdAt: string;
  updatedAt: string;
  inputs: {
    repos: RepoInput[];
    libraries?: string[];
    topics?: string[];
  };
  repos: BundleRepo[];
  libraries?: BundleLibrary[];
  index: BundleIndexConfig;
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
