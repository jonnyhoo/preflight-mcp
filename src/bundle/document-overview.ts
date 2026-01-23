/**
 * Document overview generator for PDF/document bundles.
 *
 * Generates OVERVIEW.md for document bundles to provide LLM-friendly
 * navigation similar to code repository bundles.
 *
 * @module bundle/document-overview
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('document-overview');

// ============================================================================
// Types
// ============================================================================

/**
 * Extracted document metadata for overview generation.
 */
export interface DocumentMetadataExtract {
  /** Document title */
  title?: string;
  /** Authors (if detected) */
  authors?: string[];
  /** Abstract or summary text */
  abstract?: string;
  /** Source file path or URL */
  source?: string;
  /** Page count */
  pageCount?: number;
  /** Table of contents entries */
  toc: TocEntry[];
  /** Figure references */
  figures: FigureEntry[];
  /** Table references */
  tables: TableEntry[];
}

/**
 * Table of contents entry.
 */
interface TocEntry {
  level: number;
  title: string;
}

/**
 * Figure reference entry.
 */
interface FigureEntry {
  id: string;
  caption?: string;
}

/**
 * Table reference entry.
 */
interface TableEntry {
  id: string;
  caption?: string;
}

// ============================================================================
// Metadata Extraction
// ============================================================================

/**
 * Extract metadata from parsed document markdown.
 */
export function extractDocumentMetadata(
  markdown: string,
  options?: {
    source?: string;
    pageCount?: number;
  }
): DocumentMetadataExtract {
  const lines = markdown.split('\n');
  
  const result: DocumentMetadataExtract = {
    source: options?.source,
    pageCount: options?.pageCount,
    toc: [],
    figures: [],
    tables: [],
  };

  // Extract title (first H1)
  for (const line of lines) {
    const titleMatch = line.match(/^#\s+(.+)$/);
    if (titleMatch && titleMatch[1]) {
      result.title = titleMatch[1].trim();
      break;
    }
  }

  // Extract authors (look for common patterns)
  // Pattern 1: Lines with multiple names and affiliations
  // Pattern 2: Lines containing @ (email indicators)
  const authorPatterns = [
    /^([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s*,\s*[A-Z][a-z]+\s+[A-Z][a-z]+)+)/,
    /^(.+@.+\..+)$/,
  ];
  
  for (let i = 0; i < Math.min(50, lines.length); i++) {
    const line = lines[i];
    // Look for author-like patterns (names with superscripts, commas, "and")
    if (line && /^[A-Z][a-z]+.*(\$\^|\*|†|‡)/.test(line)) {
      // Clean up LaTeX superscripts and extract names
      const cleaned = line
        .replace(/\$\^?\{?\d+,?\}?\$\s*/g, ' ')
        .replace(/\s*[*†‡]\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned.length > 10 && cleaned.length < 500) {
        result.authors = [cleaned];
        break;
      }
    }
  }

  // Extract abstract
  let inAbstract = false;
  let abstractLines: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    
    // Start of abstract section
    if (/^#+\s*Abstract\s*$/i.test(line)) {
      inAbstract = true;
      continue;
    }
    
    // End of abstract (next heading)
    if (inAbstract && /^#+\s/.test(line)) {
      break;
    }
    
    if (inAbstract && line.trim()) {
      abstractLines.push(line);
    }
  }
  
  if (abstractLines.length > 0) {
    result.abstract = abstractLines.join('\n').trim();
    // Truncate if too long
    if (result.abstract.length > 2000) {
      result.abstract = result.abstract.slice(0, 2000) + '...';
    }
  }

  // Extract table of contents (all headings)
  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch && headingMatch[1] && headingMatch[2]) {
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();
      // Skip very short or metadata-like headings
      if (title.length > 1 && !/^(Abstract|References|Bibliography)$/i.test(title)) {
        result.toc.push({ level, title });
      }
    }
  }

  // Extract figure references
  const figurePattern = /Figure\s+(\d+)[:\s]*([^.\n]*)/gi;
  let figureMatch;
  const seenFigures = new Set<string>();
  
  while ((figureMatch = figurePattern.exec(markdown)) !== null) {
    const id = `Figure ${figureMatch[1]}`;
    if (!seenFigures.has(id)) {
      seenFigures.add(id);
      result.figures.push({
        id,
        caption: figureMatch[2]?.trim() || undefined,
      });
    }
  }

  // Extract table references
  const tablePattern = /Table\s+(\d+)[:\s]*([^.\n]*)/gi;
  let tableMatch;
  const seenTables = new Set<string>();
  
  while ((tableMatch = tablePattern.exec(markdown)) !== null) {
    const id = `Table ${tableMatch[1]}`;
    if (!seenTables.has(id)) {
      seenTables.add(id);
      result.tables.push({
        id,
        caption: tableMatch[2]?.trim() || undefined,
      });
    }
  }

  return result;
}

// ============================================================================
// Overview Generation
// ============================================================================

/**
 * Generate OVERVIEW.md content for a document bundle.
 */
export function generateOverviewContent(metadata: DocumentMetadataExtract): string {
  const sections: string[] = [];

  // Header
  sections.push('# Document Overview');
  sections.push('');

  // Metadata section
  sections.push('## Metadata');
  if (metadata.title) {
    sections.push(`- **Title**: ${metadata.title}`);
  }
  if (metadata.authors && metadata.authors.length > 0) {
    sections.push(`- **Authors**: ${metadata.authors.join('; ')}`);
  }
  if (metadata.source) {
    sections.push(`- **Source**: ${metadata.source}`);
  }
  if (metadata.pageCount) {
    sections.push(`- **Pages**: ${metadata.pageCount}`);
  }
  sections.push('');

  // Abstract section
  if (metadata.abstract) {
    sections.push('## Abstract');
    sections.push(metadata.abstract);
    sections.push('');
  }

  // Table of contents
  if (metadata.toc.length > 0) {
    sections.push('## Table of Contents');
    
    // Filter to show only top-level sections (H1, H2)
    const mainSections = metadata.toc.filter(e => e.level <= 2);
    
    if (mainSections.length > 0) {
      for (const entry of mainSections) {
        const indent = entry.level === 1 ? '' : '  ';
        const prefix = entry.level === 1 ? '###' : '-';
        if (entry.level === 1) {
          sections.push(`${prefix} ${entry.title}`);
        } else {
          sections.push(`${indent}${prefix} ${entry.title}`);
        }
      }
    } else {
      // Fallback to all sections if no H1/H2
      for (const entry of metadata.toc.slice(0, 20)) {
        const indent = '  '.repeat(Math.max(0, entry.level - 1));
        sections.push(`${indent}- ${entry.title}`);
      }
    }
    sections.push('');
  }

  // Figures
  if (metadata.figures.length > 0) {
    sections.push('## Figures');
    for (const fig of metadata.figures.slice(0, 20)) {
      const caption = fig.caption ? `: ${fig.caption}` : '';
      sections.push(`- **${fig.id}**${caption}`);
    }
    sections.push('');
  }

  // Tables
  if (metadata.tables.length > 0) {
    sections.push('## Tables');
    for (const tbl of metadata.tables.slice(0, 20)) {
      const caption = tbl.caption ? `: ${tbl.caption}` : '';
      sections.push(`- **${tbl.id}**${caption}`);
    }
    sections.push('');
  }

  return sections.join('\n');
}

// ============================================================================
// Main API
// ============================================================================

/**
 * Generate and write OVERVIEW.md for a document bundle.
 *
 * @param bundleDir - Bundle root directory
 * @param markdownContent - Parsed document markdown content
 * @param options - Additional metadata options
 */
export async function generateDocumentOverview(
  bundleDir: string,
  markdownContent: string,
  options?: {
    source?: string;
    pageCount?: number;
  }
): Promise<void> {
  logger.info(`Generating document overview for bundle: ${bundleDir}`);

  // Extract metadata from markdown
  const metadata = extractDocumentMetadata(markdownContent, options);

  // Generate overview content
  const overviewContent = generateOverviewContent(metadata);

  // Write OVERVIEW.md
  const overviewPath = path.join(bundleDir, 'OVERVIEW.md');
  await fs.writeFile(overviewPath, overviewContent, 'utf8');

  logger.info(`Document overview generated: ${overviewPath}`);
}
