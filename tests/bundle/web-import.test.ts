/**
 * Web Source Import Tests
 *
 * Tests the web crawling integration with bundle creation.
 * Note: Uses fingerprint/dedup tests that don't require actual crawling
 * to avoid ESM compatibility issues with jsdom in Jest.
 */

import { describe, it, expect } from '@jest/globals';
import { computeCreateInputFingerprint } from '../../src/bundle/deduplicator.js';

// ============================================================================
// Fingerprint Tests (Unit tests - no crawling needed)
// ============================================================================

describe('web source fingerprint', () => {
  it('computes same fingerprint for same URL', () => {
    const fp1 = computeCreateInputFingerprint({
      repos: [{ kind: 'web', url: 'https://docs.example.com' }],
    });

    const fp2 = computeCreateInputFingerprint({
      repos: [{ kind: 'web', url: 'https://docs.example.com/' }], // trailing slash
    });

    const fp3 = computeCreateInputFingerprint({
      repos: [{ kind: 'web', url: 'https://DOCS.EXAMPLE.COM' }], // uppercase
    });

    // All should produce same fingerprint due to normalization
    expect(fp1).toBe(fp2);
    expect(fp1).toBe(fp3);
  });

  it('computes different fingerprint for different URLs', () => {
    const fp1 = computeCreateInputFingerprint({
      repos: [{ kind: 'web', url: 'https://docs.example.com' }],
    });

    const fp2 = computeCreateInputFingerprint({
      repos: [{ kind: 'web', url: 'https://docs.other.com' }],
    });

    expect(fp1).not.toBe(fp2);
  });

  it('computes different fingerprint for different configs', () => {
    const fp1 = computeCreateInputFingerprint({
      repos: [{ kind: 'web', url: 'https://docs.example.com' }],
    });

    const fp2 = computeCreateInputFingerprint({
      repos: [
        {
          kind: 'web',
          url: 'https://docs.example.com',
          config: { maxPages: 100 },
        },
      ],
    });

    // Different configs should produce different fingerprints
    expect(fp1).not.toBe(fp2);
  });

  it('computes same fingerprint with sorted includePatterns', () => {
    const fp1 = computeCreateInputFingerprint({
      repos: [
        {
          kind: 'web',
          url: 'https://docs.example.com',
          config: { includePatterns: ['/api/', '/docs/'] },
        },
      ],
    });

    const fp2 = computeCreateInputFingerprint({
      repos: [
        {
          kind: 'web',
          url: 'https://docs.example.com',
          config: { includePatterns: ['/docs/', '/api/'] }, // different order
        },
      ],
    });

    // Sorted patterns should produce same fingerprint
    expect(fp1).toBe(fp2);
  });

  it('treats web and github repos differently', () => {
    const fpWeb = computeCreateInputFingerprint({
      repos: [{ kind: 'web', url: 'https://github.com/owner/repo' }],
    });

    const fpGitHub = computeCreateInputFingerprint({
      repos: [{ kind: 'github', repo: 'owner/repo' }],
    });

    // Web crawl vs GitHub clone should be different
    expect(fpWeb).not.toBe(fpGitHub);
  });

  it('normalizes URL port correctly', () => {
    const fp1 = computeCreateInputFingerprint({
      repos: [{ kind: 'web', url: 'https://docs.example.com' }],
    });

    const fp2 = computeCreateInputFingerprint({
      repos: [{ kind: 'web', url: 'https://docs.example.com:443' }], // default HTTPS port
    });

    const fp3 = computeCreateInputFingerprint({
      repos: [{ kind: 'web', url: 'https://docs.example.com:8443' }], // custom port
    });

    expect(fp1).toBe(fp2); // Default port should be normalized
    expect(fp1).not.toBe(fp3); // Custom port should be different
  });

  it('supports mixed repo types in single bundle', () => {
    const fp = computeCreateInputFingerprint({
      repos: [
        { kind: 'github', repo: 'owner/repo' },
        { kind: 'web', url: 'https://docs.example.com' },
        { kind: 'local', repo: 'local/project', path: '/path/to/local' },
      ],
    });

    expect(fp).toBeTruthy();
    expect(typeof fp).toBe('string');
    expect(fp.length).toBe(64); // SHA256 hex
  });
});

// ============================================================================
// Integration Tests
// Note: Full crawl tests are skipped due to ESM compatibility issues with jsdom.
// Run manual tests via: npm run test:integration (if configured)
// ============================================================================

describe('web source integration', () => {
  it.skip('creates a bundle from a web source (requires jsdom)', () => {
    // This test requires jsdom which has ESM compatibility issues in Jest.
    // The functionality is tested manually or via integration test scripts.
  });
});
