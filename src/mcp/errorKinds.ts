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

export function formatPreflightError(kind: PreflightErrorKind, message: string): string {
  // Stable, machine-parseable prefix for UIs.
  return `[preflight_error kind=${kind}] ${message}`;
}

export function wrapPreflightError(err: unknown): Error {
  const message = msgOf(err);
  const kind = classifyPreflightErrorKind(err);
  return new Error(formatPreflightError(kind, message));
}
