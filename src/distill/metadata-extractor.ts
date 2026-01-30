/**
 * Universal Metadata Extraction - extracts common metadata from README and config files.
 * 
 * These rules are highly generalizable across all project types:
 * - arXiv/DOI paper references
 * - GitHub/GitLab repository URLs
 * - Dependencies with versions
 * - License information
 * - Authors from various sources
 * 
 * @module distill/metadata-extractor
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('metadata-extractor');

// ============================================================================
// Types
// ============================================================================

export interface ExtractedMetadata {
  /** arXiv paper ID (e.g., "arxiv:2601.20852") */
  arxivId?: string;
  /** DOI (e.g., "doi:10.1234/xxx") */
  doi?: string;
  /** GitHub repository URL */
  githubUrl?: string;
  /** GitLab repository URL */
  gitlabUrl?: string;
  /** License identifier (e.g., "MIT", "Apache-2.0") */
  license?: string;
  /** Authors extracted from various sources */
  authors?: string[];
  /** Dependencies with versions */
  dependencies?: Array<{ name: string; version?: string }>;
}

// ============================================================================
// Extraction Patterns
// ============================================================================

// arXiv patterns
const ARXIV_URL_PATTERN = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/gi;
const ARXIV_ID_PATTERN = /arXiv[:\s]*(\d{4}\.\d{4,5})/gi;

// DOI patterns
const DOI_PATTERN = /(?:doi\.org\/|DOI[:\s]*)(10\.\d{4,}\/[^\s"'<>\]]+)/gi;

// GitHub/GitLab patterns
const GITHUB_URL_PATTERN = /github\.com\/([\w-]+\/[\w.-]+)/gi;
const GITLAB_URL_PATTERN = /gitlab\.com\/([\w-]+\/[\w.-]+)/gi;

// License patterns (common SPDX identifiers)
const LICENSE_PATTERNS = [
  /license[:\s]*["']?(MIT|Apache-2\.0|GPL-[23]\.0|BSD-[23]-Clause|ISC|MPL-2\.0|LGPL-[23]\.0|AGPL-3\.0|Unlicense)["']?/i,
  /"license"[:\s]*["']([^"']+)["']/i,
];

// Author patterns (from BibTeX)
const BIBTEX_AUTHOR_PATTERN = /author\s*=\s*\{([^}]+)\}/gi;

// ============================================================================
// Extraction Functions
// ============================================================================

/**
 * Extract arXiv ID from text (README, etc.)
 */
export function extractArxivId(text: string): string | undefined {
  // Try URL pattern first
  const urlMatch = text.match(ARXIV_URL_PATTERN);
  if (urlMatch) {
    const idMatch = urlMatch[0].match(/(\d{4}\.\d{4,5})/);
    if (idMatch) return `arxiv:${idMatch[1]}`;
  }
  
  // Try inline pattern
  const inlineMatch = text.match(ARXIV_ID_PATTERN);
  if (inlineMatch) {
    const idMatch = inlineMatch[0].match(/(\d{4}\.\d{4,5})/);
    if (idMatch) return `arxiv:${idMatch[1]}`;
  }
  
  return undefined;
}

/**
 * Extract DOI from text.
 */
export function extractDoi(text: string): string | undefined {
  const match = text.match(DOI_PATTERN);
  if (match) {
    const doiMatch = match[0].match(/(10\.\d{4,}\/[^\s"'<>\]]+)/);
    if (doiMatch?.[1]) {
      // Clean trailing punctuation
      const cleaned = doiMatch[1].replace(/[.,;:)\]]+$/, '');
      return `doi:${cleaned}`;
    }
  }
  return undefined;
}

/**
 * Extract GitHub URL from text.
 */
export function extractGithubUrl(text: string): string | undefined {
  const match = text.match(GITHUB_URL_PATTERN);
  if (match) {
    const repoMatch = match[0].match(/github\.com\/([\w-]+\/[\w.-]+)/i);
    if (repoMatch?.[1]) {
      // Clean .git suffix
      const repo = repoMatch[1].replace(/\.git$/, '');
      return `https://github.com/${repo}`;
    }
  }
  return undefined;
}

/**
 * Extract GitLab URL from text.
 */
export function extractGitlabUrl(text: string): string | undefined {
  const match = text.match(GITLAB_URL_PATTERN);
  if (match) {
    const repoMatch = match[0].match(/gitlab\.com\/([\w-]+\/[\w.-]+)/i);
    if (repoMatch?.[1]) {
      const repo = repoMatch[1].replace(/\.git$/, '');
      return `https://gitlab.com/${repo}`;
    }
  }
  return undefined;
}

/**
 * Extract license from package.json or text.
 */
export function extractLicense(text: string): string | undefined {
  for (const pattern of LICENSE_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return undefined;
}

/**
 * Extract authors from BibTeX citation.
 */
export function extractAuthorsFromBibtex(text: string): string[] {
  const authors: string[] = [];
  const matches = text.matchAll(BIBTEX_AUTHOR_PATTERN);
  
  for (const match of matches) {
    if (match[1]) {
      // Split by " and " (BibTeX convention)
      const names = match[1].split(/\s+and\s+/i);
      for (const name of names) {
        const cleaned = name.trim().replace(/\s+/g, ' ');
        if (cleaned && !authors.includes(cleaned)) {
          authors.push(cleaned);
        }
      }
    }
  }
  
  return authors;
}

/**
 * Extract dependencies from requirements.txt content.
 */
export function extractPythonDependencies(content: string): Array<{ name: string; version?: string }> {
  const deps: Array<{ name: string; version?: string }> = [];
  const lines = content.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
    
    // Parse package==version, package>=version, package~=version, or just package
    const match = trimmed.match(/^([a-zA-Z0-9_-]+)(?:\[.*?\])?(?:([=<>~!]+)(.+))?$/);
    if (match?.[1]) {
      deps.push({
        name: match[1],
        version: match[3]?.trim(),
      });
    }
  }
  
  return deps;
}

/**
 * Extract dependencies from package.json content.
 */
export function extractNpmDependencies(content: string): Array<{ name: string; version?: string }> {
  const deps: Array<{ name: string; version?: string }> = [];
  
  try {
    const pkg = JSON.parse(content);
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    
    for (const [name, version] of Object.entries(allDeps)) {
      if (typeof version === 'string') {
        deps.push({ name, version: version.replace(/^[\^~]/, '') });
      }
    }
  } catch {
    // Invalid JSON
  }
  
  return deps;
}

// ============================================================================
// Main Extractor
// ============================================================================

/**
 * Extract universal metadata from a bundle directory.
 * 
 * @param bundleDir - Root directory of the bundle
 * @param repoDir - Directory of the specific repo within the bundle
 * @returns Extracted metadata
 */
export async function extractUniversalMetadata(
  bundleDir: string,
  repoDir: string
): Promise<ExtractedMetadata> {
  const metadata: ExtractedMetadata = {};
  
  // Read README
  let readme = '';
  for (const name of ['README.md', 'readme.md', 'README.rst', 'README.txt']) {
    try {
      readme = await fs.readFile(path.join(repoDir, name), 'utf8');
      break;
    } catch {
      // Try next
    }
  }
  
  if (readme) {
    // Extract from README
    metadata.arxivId = extractArxivId(readme);
    metadata.doi = extractDoi(readme);
    metadata.githubUrl = extractGithubUrl(readme);
    metadata.gitlabUrl = extractGitlabUrl(readme);
    metadata.license = extractLicense(readme);
    metadata.authors = extractAuthorsFromBibtex(readme);
    if (metadata.authors.length === 0) delete metadata.authors;
  }
  
  // Read package.json for license and dependencies
  try {
    const pkgContent = await fs.readFile(path.join(repoDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgContent);
    
    if (!metadata.license && pkg.license) {
      metadata.license = pkg.license;
    }
    if (pkg.author) {
      const authorStr = typeof pkg.author === 'string' ? pkg.author : pkg.author.name;
      if (authorStr && (!metadata.authors || !metadata.authors.includes(authorStr))) {
        metadata.authors = metadata.authors || [];
        metadata.authors.push(authorStr);
      }
    }
    if (pkg.repository?.url) {
      const url = pkg.repository.url;
      if (!metadata.githubUrl && url.includes('github.com')) {
        metadata.githubUrl = extractGithubUrl(url);
      }
    }
    
    // Extract npm dependencies
    const npmDeps = extractNpmDependencies(pkgContent);
    if (npmDeps.length > 0) {
      metadata.dependencies = npmDeps;
    }
  } catch {
    // No package.json
  }
  
  // Read requirements.txt for Python dependencies
  try {
    const reqContent = await fs.readFile(path.join(repoDir, 'requirements.txt'), 'utf8');
    const pyDeps = extractPythonDependencies(reqContent);
    if (pyDeps.length > 0) {
      metadata.dependencies = metadata.dependencies || [];
      metadata.dependencies.push(...pyDeps);
    }
  } catch {
    // No requirements.txt
  }
  
  // Read setup.py or pyproject.toml for license
  if (!metadata.license) {
    try {
      const setupContent = await fs.readFile(path.join(repoDir, 'setup.py'), 'utf8');
      const licMatch = setupContent.match(/license\s*=\s*["']([^"']+)["']/i);
      if (licMatch) metadata.license = licMatch[1];
    } catch {
      // No setup.py
    }
  }
  
  if (!metadata.license) {
    try {
      const tomlContent = await fs.readFile(path.join(repoDir, 'pyproject.toml'), 'utf8');
      const licMatch = tomlContent.match(/license\s*=\s*(?:\{[^}]*text\s*=\s*)?["']([^"']+)["']/i);
      if (licMatch) metadata.license = licMatch[1];
    } catch {
      // No pyproject.toml
    }
  }
  
  // Read LICENSE file to detect license type
  if (!metadata.license) {
    try {
      const licContent = await fs.readFile(path.join(repoDir, 'LICENSE'), 'utf8');
      if (licContent.includes('MIT License')) metadata.license = 'MIT';
      else if (licContent.includes('Apache License')) metadata.license = 'Apache-2.0';
      else if (licContent.includes('GNU GENERAL PUBLIC LICENSE')) metadata.license = 'GPL-3.0';
    } catch {
      // No LICENSE file
    }
  }
  
  logger.debug(`Extracted metadata: ${JSON.stringify(metadata)}`);
  return metadata;
}
