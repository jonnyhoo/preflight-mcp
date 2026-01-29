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

// ============================================================================
// arXiv Category Extraction
// ============================================================================

/**
 * arXiv category patterns found in PDF first page:
 * - "[cs.AI] 9 Jan 2026"
 * - "arXiv:2601.14287v1 [cs.AI]"
 * - "cs.AI, cs.CL, stat.ML"
 * 
 * Common arXiv categories:
 * - cs.* (Computer Science): AI, CL, CV, LG, NE, etc.
 * - stat.* (Statistics): ML, TH, etc.
 * - math.* (Mathematics): OC, ST, etc.
 * - physics.* (Physics): various subcategories
 * - q-bio.* (Quantitative Biology)
 * - econ.* (Economics)
 */
const ARXIV_CATEGORY_PATTERN = /\[([a-z]+-?[a-zA-Z]{1,4}(?:\.[A-Z]{2,4})?)\]/g;
const ARXIV_CATEGORY_INLINE = /\b(cs|stat|math|physics|q-bio|econ|cond-mat|astro-ph|hep|gr-qc|nucl|quant-ph)\.([A-Z]{2,4})\b/g;

/**
 * Extract arXiv categories from PDF markdown content.
 * 
 * Searches the first ~2000 characters (first page) for category patterns.
 * Returns the primary category (first found) and all categories.
 * 
 * @param markdown - PDF markdown content
 * @returns Primary category and all categories found
 * 
 * @example
 * ```typescript
 * extractArxivCategory('arXiv:2601.14287v1 [cs.AI] 9 Jan 2026\n...')
 * // => { primary: 'cs.AI', all: ['cs.AI'] }
 * 
 * extractArxivCategory('Categories: cs.CL, cs.AI, stat.ML\n...')
 * // => { primary: 'cs.CL', all: ['cs.CL', 'cs.AI', 'stat.ML'] }
 * ```
 */
export function extractArxivCategory(markdown: string): {
  primary?: string;
  all: string[];
} {
  if (!markdown) return { all: [] };
  
  // Only search first ~2000 chars (first page)
  const firstPage = markdown.slice(0, 2000);
  const categories = new Set<string>();
  
  // Pattern 1: Bracketed format [cs.AI]
  const bracketMatches = firstPage.matchAll(ARXIV_CATEGORY_PATTERN);
  for (const match of bracketMatches) {
    const cat = match[1];
    if (cat && isValidArxivCategory(cat)) {
      categories.add(cat);
    }
  }
  
  // Pattern 2: Inline format cs.AI, stat.ML
  const inlineMatches = firstPage.matchAll(ARXIV_CATEGORY_INLINE);
  for (const match of inlineMatches) {
    const cat = `${match[1]}.${match[2]}`;
    if (isValidArxivCategory(cat)) {
      categories.add(cat);
    }
  }
  
  const all = [...categories];
  return {
    primary: all[0],
    all,
  };
}

/**
 * Validate if a string is a valid arXiv category.
 * 
 * Valid formats:
 * - cs.AI, cs.CL, cs.CV, cs.LG, cs.NE, etc.
 * - stat.ML, stat.TH
 * - math.OC, math.ST
 * - physics.comp-ph
 * - q-bio.BM
 */
function isValidArxivCategory(cat: string): boolean {
  // Must have format: prefix.suffix or prefix-prefix.suffix
  const pattern = /^[a-z]+(-[a-z]+)?\.[A-Z]{2,4}$/;
  return pattern.test(cat);
}

// ============================================================================
// Paper Title Extraction
// ============================================================================

/**
 * Extract paper title from PDF markdown content.
 * 
 * Searches for the first meaningful H1 heading (# Title).
 * Skips generic headings like "PDF Document" or "Abstract".
 * 
 * @param markdown - PDF markdown content
 * @returns Paper title or undefined if not found
 * 
 * @example
 * ```typescript
 * extractPaperTitle('# PDF Document\n> Source: ...\n---\n# VERI-SURE: A Framework...\n...')
 * // => 'VERI-SURE: A Framework...'
 * ```
 */
export function extractPaperTitle(markdown: string): string | undefined {
  if (!markdown) return undefined;
  
  // Search first ~3000 chars for title
  const firstPart = markdown.slice(0, 3000);
  
  // Find all H1 headings
  const h1Matches = firstPart.matchAll(/^# (.+)$/gm);
  
  // Skip generic headings
  const skipPatterns = [
    /^PDF Document$/i,
    /^Abstract$/i,
    /^Summary$/i,
    /^Overview$/i,
    /^Table of Contents$/i,
    /^Contents$/i,
  ];
  
  for (const match of h1Matches) {
    const title = match[1]?.trim();
    if (!title) continue;
    
    // Skip generic headings
    const isGeneric = skipPatterns.some(p => p.test(title));
    if (isGeneric) continue;
    
    // Found a real title
    return title;
  }
  
  return undefined;
}
