import { describe, it, expect } from '@jest/globals';

import {
  classifyPreflightErrorKind,
  formatPreflightError,
  wrapPreflightError,
} from '../../src/mcp/errorKinds.js';

describe('preflight error kinds', () => {
  it('classifies bundle not found', () => {
    const kind = classifyPreflightErrorKind(new Error('Bundle not found: abc'));
    expect(kind).toBe('bundle_not_found');
  });

  it('classifies file not found via errno code', () => {
    const err = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    const kind = classifyPreflightErrorKind(err);
    expect(kind).toBe('file_not_found');
  });

  it('classifies invalid path traversal attempts', () => {
    const kind = classifyPreflightErrorKind(new Error('Unsafe path traversal attempt'));
    expect(kind).toBe('invalid_path');
  });

  it('classifies permission denied via errno code', () => {
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const kind = classifyPreflightErrorKind(err);
    expect(kind).toBe('permission_denied');
  });

  it('classifies likely index problems', () => {
    const kind = classifyPreflightErrorKind(new Error('SqliteError: SQLITE_CANTOPEN: unable to open database file'));
    expect(kind).toBe('index_missing_or_corrupt');
  });

  it('classifies deprecated parameter errors', () => {
    const kind = classifyPreflightErrorKind(new Error('ensureFresh is deprecated and not supported in this tool.'));
    expect(kind).toBe('deprecated_parameter');
  });

  it('formats errors with stable prefix', () => {
    const msg = formatPreflightError('unknown', 'boom');
    expect(msg.startsWith('[preflight_error kind=unknown] ')).toBe(true);
  });

  it('wrapPreflightError preserves message and adds kind prefix', () => {
    const e = wrapPreflightError(new Error('Bundle not found: xyz'));
    expect(e.message).toContain('[preflight_error kind=bundle_not_found]');
    expect(e.message).toContain('Bundle not found: xyz');
  });
});
