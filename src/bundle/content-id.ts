/**
 * Content ID Extraction Module
 *
 * Extracts paper identifiers (arXiv ID, DOI) from URLs and filenames.
 * Used for semantic deduplication of academic papers in RAG indexing.
 *
 * @module bundle/content-id
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Result of paper ID extraction.
 */
export interface PaperIdResult {
  /** Paper identifier (e.g., 'arxiv:2601.14287', 'doi:10.1234/xxx') */
  paperId?: string;
  /** Version number (e.g., 'v1', 'v2') - only for arXiv */
  version?: string;
}

// ============================================================================
// Patterns
// ============================================================================

/**
 * arXiv ID patterns:
 * - New format (2007+): YYMM.NNNNN (e.g., 2601.14287)
 * - Old format (pre-2007): subject-class/YYMMNNN (e.g., hep-th/9901001)
 * - Version suffix: vN (e.g., v1, v2)
 * - User-friendly format: arxiv-YYMM.NNNNN-vN (for manual naming)
 */
const ARXIV_NEW_PATTERN = /(\d{4}\.\d{4,5})(v\d+)?/;
const ARXIV_OLD_PATTERN = /([a-z-]+\/\d{7})(v\d+)?/;
// User-friendly format: arxiv-2601.14287-v1 or arxiv-2601.14287v1
const ARXIV_USER_PATTERN = /arxiv[\-_]?(\d{4}\.\d{4,5})[\-_]?(v\d+)?/i;

/**
 * DOI pattern (simplified):
 * - Starts with 10.NNNN/
 * - Followed by suffix (alphanumeric, dots, dashes, underscores)
 */
const DOI_PATTERN = /(10\.\d{4,}\/[^\s"'<>]+)/;

// ============================================================================
// Extraction Functions
// ============================================================================

/**
 * Extract paper identifier from a URL or string.
 *
 * Supported formats:
 * - arXiv URLs: arxiv.org/abs/2601.14287, arxiv.org/pdf/2601.14287v1
 * - DOI URLs: doi.org/10.1234/xxx
 * - User-friendly names: arxiv-2601.14287-v1, arxiv_2601.14287_v2
 * - Direct patterns in any string
 *
 * @param input - URL or string that may contain a paper identifier
 * @returns Extracted paper ID and version, or empty object if not found
 *
 * @example
 * ```typescript
 * extractPaperId('https://arxiv.org/pdf/2601.14287v1')
 * // => { paperId: 'arxiv:2601.14287', version: 'v1' }
 *
 * extractPaperId('arxiv-2601.14287-v1')  // Manual naming
 * // => { paperId: 'arxiv:2601.14287', version: 'v1' }
 *
 * extractPaperId('https://doi.org/10.1038/nature12373')
 * // => { paperId: 'doi:10.1038/nature12373' }
 * ```
 */
export function extractPaperId(input: string): PaperIdResult {
  if (!input) return {};

  // Normalize: decode URL encoding, lowercase for matching
  const normalized = decodeURIComponent(input);

  // Try user-friendly format first (arxiv-2601.14287-v1)
  // This allows users to manually name bundles with arXiv IDs
  const arxivUserMatch = normalized.match(ARXIV_USER_PATTERN);
  if (arxivUserMatch) {
    const [, id, version] = arxivUserMatch;
    return {
      paperId: `arxiv:${id}`,
      version: version?.toLowerCase(),
    };
  }

  // Try arXiv new format (most common in URLs)
  const arxivNewMatch = normalized.match(ARXIV_NEW_PATTERN);
  if (arxivNewMatch) {
    const [, id, version] = arxivNewMatch;
    return {
      paperId: `arxiv:${id}`,
      version: version?.toLowerCase(),
    };
  }

  // Try arXiv old format
  const arxivOldMatch = normalized.match(ARXIV_OLD_PATTERN);
  if (arxivOldMatch) {
    const [, id, version] = arxivOldMatch;
    return {
      paperId: `arxiv:${id}`,
      version: version?.toLowerCase(),
    };
  }

  // Try DOI
  const doiMatch = normalized.match(DOI_PATTERN);
  if (doiMatch) {
    const [, doi] = doiMatch;
    // Clean up trailing punctuation that might have been captured
    const cleanDoi = doi?.replace(/[.,;:)\]]+$/, '');
    return {
      paperId: cleanDoi ? `doi:${cleanDoi}` : undefined,
    };
  }

  return {};
}

/**
 * Check if a paper ID represents the same paper as another (ignoring version).
 *
 * @param id1 - First paper ID
 * @param id2 - Second paper ID
 * @returns True if they refer to the same paper (possibly different versions)
 */
export function isSamePaper(id1: string | undefined, id2: string | undefined): boolean {
  if (!id1 || !id2) return false;
  
  // Normalize: remove version suffix from arXiv IDs
  const normalize = (id: string) => {
    if (id.startsWith('arxiv:')) {
      // Remove version suffix (v1, v2, etc.)
      return id.replace(/v\d+$/, '');
    }
    return id;
  };

  return normalize(id1) === normalize(id2);
}

/**
 * Extract version number from a paper ID or URL.
 *
 * @param input - Paper ID or URL
 * @returns Version string (e.g., 'v1') or undefined
 */
export function extractVersion(input: string): string | undefined {
  const versionMatch = input.match(/v(\d+)/i);
  return versionMatch ? `v${versionMatch[1]}` : undefined;
}
