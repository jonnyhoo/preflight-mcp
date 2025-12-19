import path from 'node:path';

/**
 * Validate bundle ID to prevent path traversal attacks.
 * Only allows: alphanumeric, hyphens, underscores
 */
export function validateBundleId(bundleId: string): void {
  if (!bundleId || bundleId.length === 0) {
    throw new Error('Bundle ID cannot be empty');
  }
  
  if (bundleId.length > 128) {
    throw new Error('Bundle ID too long (max 128 characters)');
  }
  
  // Allow only alphanumeric, hyphen, and underscore (no dots or slashes)
  const safeIdPattern = /^[a-zA-Z0-9_-]+$/;
  if (!safeIdPattern.test(bundleId)) {
    throw new Error(`Invalid bundle ID: contains unsafe characters. ID: ${bundleId}`);
  }
  
  // Prevent IDs starting with dot (hidden files)
  if (bundleId.startsWith('.')) {
    throw new Error('Invalid bundle ID: cannot start with dot');
  }
}

export type BundlePaths = {
  bundleId: string;
  rootDir: string;
  manifestPath: string;
  startHerePath: string;
  agentsPath: string;
  overviewPath: string;
  indexesDir: string;
  searchDbPath: string;
  reposDir: string;
  librariesDir: string;
};

export function getBundlePaths(storageDir: string, bundleId: string): BundlePaths {
  // Validate bundle ID to prevent path traversal
  validateBundleId(bundleId);
  
  const rootDir = path.join(storageDir, bundleId);
  const indexesDir = path.join(rootDir, 'indexes');
  return {
    bundleId,
    rootDir,
    manifestPath: path.join(rootDir, 'manifest.json'),
    startHerePath: path.join(rootDir, 'START_HERE.md'),
    agentsPath: path.join(rootDir, 'AGENTS.md'),
    overviewPath: path.join(rootDir, 'OVERVIEW.md'),
    indexesDir,
    searchDbPath: path.join(indexesDir, 'search.sqlite3'),
    reposDir: path.join(rootDir, 'repos'),
    librariesDir: path.join(rootDir, 'libraries'),
  };
}

export function repoRootDir(paths: BundlePaths, owner: string, repo: string): string {
  return path.join(paths.reposDir, owner, repo);
}

export function repoRawDir(paths: BundlePaths, owner: string, repo: string): string {
  return path.join(repoRootDir(paths, owner, repo), 'raw');
}

export function repoNormDir(paths: BundlePaths, owner: string, repo: string): string {
  return path.join(repoRootDir(paths, owner, repo), 'norm');
}

export function repoMetaPath(paths: BundlePaths, owner: string, repo: string): string {
  return path.join(repoRootDir(paths, owner, repo), 'meta.json');
}
