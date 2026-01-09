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
  const trimmed = relativePath.trim();
  
  // Early rejection of obviously malicious patterns
  if (!trimmed || trimmed.length > 4096) {
    throw new Error('Invalid path: empty or too long');
  }
  
  // Block UNC paths (\\server\share or \\?\C:\path)
  if (trimmed.startsWith('\\\\')) {
    throw new Error('Unsafe path traversal attempt: UNC path not allowed');
  }
  
  // Block Windows device paths (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
  const devicePattern = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
  const baseName = path.basename(trimmed);
  if (devicePattern.test(baseName)) {
    throw new Error('Unsafe path: Windows device name not allowed');
  }
  
  // Normalize FIRST to canonicalize the path
  const norm = normalizeRelativePath(relativePath);
  
  // After normalization, check for absolute path indicators
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) {
    throw new Error('Unsafe path traversal attempt: absolute path after normalization');
  }
  
  // Check for null bytes (path injection)
  if (norm.includes('\0')) {
    throw new Error('Unsafe path: null byte not allowed');
  }
  
  // Resolve and validate containment
  const joined = path.resolve(rootDir, norm.split('/').join(path.sep));
  const rootResolved = path.resolve(rootDir);
  
  // Ensure normalized form of joined path starts with root
  const joinedNorm = path.normalize(joined);
  const rootNorm = path.normalize(rootResolved);
  
  if (!joinedNorm.startsWith(rootNorm + path.sep) && joinedNorm !== rootNorm) {
    throw new Error('Unsafe path traversal attempt: path escapes root directory');
  }
  
  return joined;
}
