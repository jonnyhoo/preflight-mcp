import path from 'node:path';

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
