/**
 * Repository Classifier - Detect repository type for intelligent indexing routing.
 * 
 * Classifies repos into:
 * - code: Traditional code repositories (L1_repo + L2_code)
 * - documentation: Markdown-heavy repos like Claude Skills, awesome-xxx (L1_doc + L2_section)
 * - hybrid: Mixed repositories
 * 
 * @module bundle/repo-classifier
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { languageForFile } from '../ast/parser.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('repo-classifier');

// ============================================================================
// Types
// ============================================================================

export type RepoType = 'code' | 'documentation' | 'hybrid';

export interface RepoClassification {
  /** Classified repo type */
  type: RepoType;
  /** Ratio of code files to total files (0-1) */
  codeRatio: number;
  /** Primary programming language (if code repo) */
  primaryLanguage?: string;
  /** Whether repo has entry point files (main.*, index.*, etc.) */
  hasEntryPoint: boolean;
  /** Whether this appears to be a Claude Skills style repo */
  isSkillsRepo: boolean;
  /** Whether this appears to be an awesome-xxx style list */
  isAwesomeRepo: boolean;
  /** File statistics */
  stats: {
    totalFiles: number;
    codeFiles: number;
    markdownFiles: number;
    otherFiles: number;
  };
}

// ============================================================================
// Constants
// ============================================================================

/** Threshold for classifying as code repo */
const CODE_REPO_THRESHOLD = 0.3;

/** Threshold for classifying as documentation repo */
const DOC_REPO_THRESHOLD = 0.1;

/** Entry point file patterns */
const ENTRY_POINT_PATTERNS = [
  /^main\.[^.]+$/i,
  /^index\.[^.]+$/i,
  /^app\.[^.]+$/i,
  /^server\.[^.]+$/i,
  /^cli\.[^.]+$/i,
  /^mod\.rs$/i,
  /^lib\.rs$/i,
  /^__main__\.py$/i,
];

/** Claude Skills repo indicators */
const SKILLS_INDICATORS = [
  'CLAUDE.md',
  'claude.md',
  '.claude',
  'skills/',
  'skill/',
  'prompts/',
  'prompt/',
];

/** Awesome repo indicators */
const AWESOME_INDICATORS = [
  'awesome',
  'curated',
  'list',
];

/** Directories to skip when analyzing */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '__pycache__',
  '.pytest_cache',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'venv',
  '.venv',
  'coverage',
]);

/** Code file extensions (supported by tree-sitter) */
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi',
  '.go',
  '.rs',
  '.java',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.kt', '.kts',
  '.scala',
  '.lua',
]);

/** Documentation file extensions */
const DOC_EXTENSIONS = new Set([
  '.md', '.mdx',
  '.rst',
  '.txt',
  '.adoc',
]);

// ============================================================================
// File Analysis
// ============================================================================

interface FileStats {
  codeFiles: string[];
  markdownFiles: string[];
  otherFiles: string[];
  hasEntryPoint: boolean;
  hasSkillsIndicator: boolean;
  languageCounts: Map<string, number>;
}

/**
 * Analyze files in a directory to gather statistics.
 */
async function analyzeFiles(
  dirPath: string,
  maxFiles = 1000
): Promise<FileStats> {
  const stats: FileStats = {
    codeFiles: [],
    markdownFiles: [],
    otherFiles: [],
    hasEntryPoint: false,
    hasSkillsIndicator: false,
    languageCounts: new Map(),
  };
  
  let fileCount = 0;

  async function walk(dir: string, depth = 0): Promise<void> {
    if (fileCount >= maxFiles || depth > 10) return;

    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Skip inaccessible directories
    }

    for (const entry of entries) {
      if (fileCount >= maxFiles) return;

      const name = entry.name;
      const fullPath = path.join(dir, name);
      const relativePath = path.relative(dirPath, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        // Skip common non-code directories
        if (SKIP_DIRS.has(name)) continue;
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        fileCount++;
        const ext = path.extname(name).toLowerCase();

        // Check for skills indicators
        if (SKILLS_INDICATORS.some(ind => relativePath.includes(ind))) {
          stats.hasSkillsIndicator = true;
        }

        // Check for entry points
        if (ENTRY_POINT_PATTERNS.some(p => p.test(name))) {
          stats.hasEntryPoint = true;
        }

        // Categorize file
        if (CODE_EXTENSIONS.has(ext)) {
          stats.codeFiles.push(relativePath);
          
          // Track language
          const lang = languageForFile(fullPath);
          if (lang) {
            stats.languageCounts.set(lang, (stats.languageCounts.get(lang) || 0) + 1);
          }
        } else if (DOC_EXTENSIONS.has(ext)) {
          stats.markdownFiles.push(relativePath);
        } else {
          stats.otherFiles.push(relativePath);
        }
      }
    }
  }

  await walk(dirPath);
  return stats;
}

/**
 * Determine primary programming language from file counts.
 */
function getPrimaryLanguage(languageCounts: Map<string, number>): string | undefined {
  if (languageCounts.size === 0) return undefined;
  
  let maxCount = 0;
  let primary: string | undefined;
  
  for (const [lang, count] of languageCounts) {
    if (count > maxCount) {
      maxCount = count;
      primary = lang;
    }
  }
  
  return primary;
}

/**
 * Check if repo name indicates an awesome-list style repo.
 */
function isAwesomeStyleRepo(repoPath: string): boolean {
  const dirName = path.basename(repoPath).toLowerCase();
  return AWESOME_INDICATORS.some(ind => dirName.includes(ind));
}

// ============================================================================
// Main Classification
// ============================================================================

/**
 * Classify a repository to determine optimal indexing strategy.
 * 
 * Classification rules:
 * - code_ratio >= 0.3: Code repository → L1_repo + L2_code
 * - code_ratio < 0.1: Documentation repository → L1_doc + L2_section  
 * - Otherwise: Hybrid → Both indexing strategies
 * 
 * Special cases:
 * - Claude Skills repos (CLAUDE.md, skills/) → Always documentation
 * - awesome-xxx repos → Always documentation
 * 
 * @param repoPath - Path to the repository or bundle
 * @returns Repository classification result
 */
export async function classifyRepo(repoPath: string): Promise<RepoClassification> {
  logger.info(`Classifying repo: ${repoPath}`);
  
  // Analyze files
  const fileStats = await analyzeFiles(repoPath);
  
  const totalFiles = 
    fileStats.codeFiles.length + 
    fileStats.markdownFiles.length + 
    fileStats.otherFiles.length;
  
  if (totalFiles === 0) {
    logger.warn(`No files found in ${repoPath}`);
    return {
      type: 'documentation',
      codeRatio: 0,
      hasEntryPoint: false,
      isSkillsRepo: false,
      isAwesomeRepo: false,
      stats: {
        totalFiles: 0,
        codeFiles: 0,
        markdownFiles: 0,
        otherFiles: 0,
      },
    };
  }
  
  // Calculate code ratio
  const codeRatio = fileStats.codeFiles.length / totalFiles;
  
  // Determine primary language
  const primaryLanguage = getPrimaryLanguage(fileStats.languageCounts);
  
  // Check for special repo types
  const isSkillsRepo = fileStats.hasSkillsIndicator;
  const isAwesomeRepo = isAwesomeStyleRepo(repoPath);
  
  // Classification logic
  let type: RepoType;
  
  if (isSkillsRepo || isAwesomeRepo) {
    // Special repos are always treated as documentation
    type = 'documentation';
    logger.info(`Classified as documentation (special: skills=${isSkillsRepo}, awesome=${isAwesomeRepo})`);
  } else if (codeRatio >= CODE_REPO_THRESHOLD) {
    type = 'code';
    logger.info(`Classified as code (ratio=${codeRatio.toFixed(2)})`);
  } else if (codeRatio < DOC_REPO_THRESHOLD) {
    type = 'documentation';
    logger.info(`Classified as documentation (ratio=${codeRatio.toFixed(2)})`);
  } else {
    type = 'hybrid';
    logger.info(`Classified as hybrid (ratio=${codeRatio.toFixed(2)})`);
  }
  
  return {
    type,
    codeRatio,
    primaryLanguage,
    hasEntryPoint: fileStats.hasEntryPoint,
    isSkillsRepo,
    isAwesomeRepo,
    stats: {
      totalFiles,
      codeFiles: fileStats.codeFiles.length,
      markdownFiles: fileStats.markdownFiles.length,
      otherFiles: fileStats.otherFiles.length,
    },
  };
}

/**
 * Classify a repository from a bundle path.
 * Looks for repo content in the standard bundle structure.
 * Handles both direct repo layout and norm/ subdirectory layout.
 * 
 * @param bundlePath - Path to the bundle root
 * @param repoId - Repository ID within the bundle
 * @returns Repository classification result
 */
export async function classifyBundleRepo(
  bundlePath: string,
  repoId: string
): Promise<RepoClassification> {
  // Try standard repo location
  const baseRepoPath = path.join(bundlePath, 'repos', repoId);
  const normPath = path.join(baseRepoPath, 'norm');
  
  // Prefer norm/ subdirectory if exists (bundle structure)
  try {
    await fs.access(normPath);
    logger.debug(`Classifying norm path: ${normPath}`);
    return classifyRepo(normPath);
  } catch {
    // Fallback to repo root
  }
  
  try {
    await fs.access(baseRepoPath);
    return classifyRepo(baseRepoPath);
  } catch {
    // Repo path doesn't exist, classify the bundle itself
    logger.warn(`Repo path ${baseRepoPath} not found, classifying bundle`);
    return classifyRepo(bundlePath);
  }
}

/**
 * Quick check if a bundle appears to be a code repository.
 * Faster than full classification - useful for filtering.
 * 
 * @param bundlePath - Path to the bundle root
 * @returns true if bundle appears to contain code
 */
export async function isCodeBundle(bundlePath: string): Promise<boolean> {
  const classification = await classifyRepo(bundlePath);
  return classification.type === 'code' || classification.type === 'hybrid';
}

/**
 * Quick check if a bundle appears to be a documentation repository.
 * 
 * @param bundlePath - Path to the bundle root
 * @returns true if bundle appears to be documentation-focused
 */
export async function isDocumentationBundle(bundlePath: string): Promise<boolean> {
  const classification = await classifyRepo(bundlePath);
  return classification.type === 'documentation' || classification.type === 'hybrid';
}
