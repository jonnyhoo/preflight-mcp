export type PreflightErrorKind =
  | 'bundle_not_found'
  | 'file_not_found'
  | 'invalid_path'
  | 'permission_denied'
  | 'index_missing_or_corrupt'
  | 'deprecated_parameter'
  | 'unknown';

type ErrnoLike = { code?: string };

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function codeOf(err: unknown): string | undefined {
  const anyErr = err as ErrnoLike | null | undefined;
  const code = anyErr?.code;
  return typeof code === 'string' ? code : undefined;
}

function isLikelyIndexProblemMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    (m.includes('sqlite') || m.includes('fts') || m.includes('database')) &&
    (m.includes('unable to open database file') ||
      m.includes('cannot open') ||
      m.includes('cantopen') ||
      m.includes('no such table') ||
      m.includes('malformed') ||
      m.includes('file is not a database') ||
      m.includes('disk i/o'))
  );
}

export function classifyPreflightErrorKind(err: unknown): PreflightErrorKind {
  const message = msgOf(err);
  const m = message.toLowerCase();
  const code = codeOf(err);

  if (m.includes('bundle not found')) return 'bundle_not_found';

  // Path traversal attempts from safeJoin.
  if (m.includes('unsafe path traversal attempt')) return 'invalid_path';

  // Filesystem errors.
  if (code === 'ENOENT') return 'file_not_found';
  if (code === 'EACCES' || code === 'EPERM') return 'permission_denied';

  // Common string forms when error.code is not preserved.
  if (m.includes('enoent') && m.includes('no such file or directory')) return 'file_not_found';
  if ((m.includes('eacces') || m.includes('eperm')) && m.includes('permission')) return 'permission_denied';

  if (m.includes('deprecated') && (m.includes('ensurefresh') || m.includes('autorepairindex'))) {
    return 'deprecated_parameter';
  }
  if (isLikelyIndexProblemMessage(message)) return 'index_missing_or_corrupt';

  return 'unknown';
}

/**
 * LLM-friendly recovery hints for each error kind.
 * These help AI agents self-correct without user intervention.
 */
const LLM_RECOVERY_HINTS: Record<PreflightErrorKind, string> = {
  bundle_not_found: `💡 Recovery steps:
1. Run preflight_list_bundles to find available bundles
2. Use the exact bundleId (UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
3. If no bundles exist, create one with preflight_create_bundle`,

  file_not_found: `💡 Recovery steps:
1. Run preflight_repo_tree to see available files in the bundle
2. Check the file path format: repos/{owner}/{repo}/norm/{path}
3. Verify the file exists in the repository`,

  invalid_path: `💡 Recovery steps:
1. Do NOT use ".." or absolute paths - only bundle-relative paths allowed
2. Correct format: repos/{owner}/{repo}/norm/{path}
3. Example: repos/facebook/react/norm/src/index.js`,

  permission_denied: `💡 Recovery steps:
1. Check if the storage directory is writable
2. Verify file permissions on the bundle directory
3. If on Windows, check if another process has locked the file`,

  index_missing_or_corrupt: `💡 Recovery steps:
1. Run preflight_repair_bundle with rebuildIndex=true
2. If repair fails, delete and recreate the bundle
3. Check disk space - SQLite needs room for write-ahead log`,

  deprecated_parameter: `💡 Note:
This parameter is deprecated. The tool is now strictly read-only.
- For updates: use preflight_update_bundle first, then retry
- For repairs: use preflight_repair_bundle first, then retry`,

  unknown: `💡 If this error persists:
1. Check the error message for specific details
2. Verify your input parameters match the tool's schema
3. Try preflight_list_bundles to confirm bundle availability`,
};

export function formatPreflightError(kind: PreflightErrorKind, message: string): string {
  const hint = LLM_RECOVERY_HINTS[kind];
  // Stable, machine-parseable prefix + human-readable hint
  return `[preflight_error kind=${kind}]\n\n${message}\n\n${hint}`;
}

export function wrapPreflightError(err: unknown): Error {
  const message = msgOf(err);
  const kind = classifyPreflightErrorKind(err);
  return new Error(formatPreflightError(kind, message));
}
