import path from 'node:path';

export type BundleFileRef = {
  bundleId: string;
  relativePath: string; // always forward-slash
};

export const PREFLIGHT_URI_PREFIX = 'preflight://bundle/';

export function toBundleFileUri(ref: BundleFileRef): string {
  // encodedPath must not contain slashes so it can live as a single path segment
  const encodedPath = encodeURIComponent(ref.relativePath);
  return `${PREFLIGHT_URI_PREFIX}${ref.bundleId}/file/${encodedPath}`;
}

export function parseBundleFileUri(uri: string): BundleFileRef | null {
  if (!uri.startsWith(PREFLIGHT_URI_PREFIX)) return null;
  const rest = uri.slice(PREFLIGHT_URI_PREFIX.length);
  // rest = <bundleId>/file/<encodedPath>
  const parts = rest.split('/');
  if (parts.length !== 3) return null;
  const [bundleId, fileLiteral, encodedPath] = parts;
  if (!bundleId || fileLiteral !== 'file' || !encodedPath) return null;
  const relativePath = decodeURIComponent(encodedPath);
  return {
    bundleId,
    relativePath,
  };
}

export function normalizeRelativePath(p: string): string {
  // Ensure forward slashes and no leading slash.
  return p.replaceAll('\\', '/').replace(/^\/+/, '');
}

export function safeJoin(rootDir: string, relativePath: string): string {
  // Block absolute paths BEFORE normalization.
  // This catches Unix-style /etc/passwd and Windows-style C:\path.
  const trimmed = relativePath.trim();
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-zA-Z]:/.test(trimmed)) {
    throw new Error('Unsafe path traversal attempt');
  }

  // Convert to platform separator for join, but validate containment by resolving.
  const norm = normalizeRelativePath(relativePath);

  const joined = path.resolve(rootDir, norm.split('/').join(path.sep));
  const rootResolved = path.resolve(rootDir);
  const rel = path.relative(rootResolved, joined);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Unsafe path traversal attempt');
  }
  return joined;
}
