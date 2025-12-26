/**
 * Path redaction utilities for RFC v2.
 * 
 * Provides functions to sanitize paths before returning them to LLM clients,
 * removing sensitive information like usernames, home directories, etc.
 */

export interface PathRedactionOptions {
  /** Whether to redact the username in home directory paths */
  redactUsername?: boolean;
  /** Whether to redact absolute path prefix */
  redactAbsolutePrefix?: boolean;
  /** Custom patterns to redact (regex patterns) */
  customPatterns?: Array<{ pattern: RegExp; replacement: string }>;
  /** Keep last N path segments (0 = keep full path) */
  keepLastSegments?: number;
}

const DEFAULT_OPTIONS: PathRedactionOptions = {
  redactUsername: true,
  redactAbsolutePrefix: false,
  customPatterns: [],
  keepLastSegments: 0,
};

/**
 * Common home directory patterns across platforms.
 */
const HOME_DIR_PATTERNS = [
  // Windows: C:\Users\username\...
  /^[A-Za-z]:\\Users\\[^\\]+\\/i,
  // Linux/macOS: /home/username/... or /Users/username/...
  /^\/(?:home|Users)\/[^/]+\//,
  // WSL: /mnt/c/Users/username/...
  /^\/mnt\/[a-z]\/Users\/[^/]+\//i,
];

/**
 * Redact sensitive information from a file path.
 * 
 * @param path - The file path to redact
 * @param options - Redaction options
 * @returns The redacted path
 * 
 * @example
 * redactPath('/Users/john/projects/myapp/src/main.ts')
 * // Returns: '~/projects/myapp/src/main.ts'
 * 
 * redactPath('C:\\Users\\john\\projects\\myapp\\src\\main.ts')
 * // Returns: '~\\projects\\myapp\\src\\main.ts'
 */
export function redactPath(path: string, options: PathRedactionOptions = {}): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let result = path;

  // Apply username redaction
  if (opts.redactUsername) {
    for (const pattern of HOME_DIR_PATTERNS) {
      result = result.replace(pattern, (match) => {
        // Preserve the path separator style
        return match.includes('\\') ? '~\\' : '~/';
      });
    }
  }

  // Apply absolute prefix redaction
  if (opts.redactAbsolutePrefix) {
    // Remove drive letters on Windows
    result = result.replace(/^[A-Za-z]:/, '');
    // Remove leading slash on Unix
    result = result.replace(/^\//, '');
  }

  // Apply custom patterns
  for (const { pattern, replacement } of opts.customPatterns ?? []) {
    result = result.replace(pattern, replacement);
  }

  // Keep only last N segments
  if (opts.keepLastSegments && opts.keepLastSegments > 0) {
    const separator = result.includes('\\') ? '\\' : '/';
    const segments = result.split(/[/\\]/);
    if (segments.length > opts.keepLastSegments) {
      result = '...' + separator + segments.slice(-opts.keepLastSegments).join(separator);
    }
  }

  return result;
}

/**
 * Redact paths in an object recursively.
 * Looks for common path-like keys: path, file, filePath, dir, directory, uri, etc.
 * 
 * @param obj - Object to redact paths in
 * @param options - Redaction options
 * @returns New object with redacted paths
 */
export function redactPathsInObject<T>(obj: T, options: PathRedactionOptions = {}): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    // Check if it looks like a path
    if (isLikelyPath(obj)) {
      return redactPath(obj, options) as unknown as T;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => redactPathsInObject(item, options)) as unknown as T;
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (isPathKey(key) && typeof value === 'string') {
        result[key] = redactPath(value, options);
      } else {
        result[key] = redactPathsInObject(value, options);
      }
    }
    return result as unknown as T;
  }

  return obj;
}

/**
 * Check if a key name typically contains a path value.
 */
function isPathKey(key: string): boolean {
  const pathKeys = [
    'path',
    'file',
    'filePath',
    'filepath',
    'dir',
    'directory',
    'folder',
    'rootDir',
    'rootPath',
    'absPath',
    'absolutePath',
    'relativePath',
    'relPath',
    'bundleRoot',
    'storageDir',
    'configPath',
  ];
  const lowerKey = key.toLowerCase();
  return pathKeys.some(pk => lowerKey === pk.toLowerCase() || lowerKey.endsWith(pk.toLowerCase()));
}

/**
 * Check if a string looks like a file path.
 */
function isLikelyPath(str: string): boolean {
  // Check for common path patterns
  return (
    // Windows path: C:\...
    /^[A-Za-z]:[/\\]/.test(str) ||
    // Unix absolute path: /...
    str.startsWith('/') ||
    // Contains multiple path separators
    (str.includes('/') && str.split('/').length > 2) ||
    (str.includes('\\') && str.split('\\').length > 2)
  );
}

/**
 * Create a redaction function with preset options.
 * 
 * @param options - Default options for the redactor
 * @returns A redactPath function with the given options preset
 */
export function createRedactor(options: PathRedactionOptions): (path: string) => string {
  return (path: string) => redactPath(path, options);
}

/**
 * Check if a path appears to contain sensitive information.
 * 
 * @param path - Path to check
 * @returns True if the path might contain sensitive info
 */
export function containsSensitiveInfo(path: string): boolean {
  // Check for home directory patterns
  for (const pattern of HOME_DIR_PATTERNS) {
    if (pattern.test(path)) {
      return true;
    }
  }

  // Check for other potentially sensitive patterns
  const sensitivePatterns = [
    /\.ssh\//i,
    /\.gnupg\//i,
    /\.aws\//i,
    /\.azure\//i,
    /credentials/i,
    /secrets?/i,
    /private/i,
    /\.env$/i,
  ];

  return sensitivePatterns.some(p => p.test(path));
}
