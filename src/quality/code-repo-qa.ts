/**
 * Code Repository Quality Assurance.
 * 
 * Performs quality checks for code repository indexing:
 * 1. CARD.json field completeness
 * 2. Code symbol count (classes, functions, methods)
 * 3. README presence
 * 4. relatedPaperId linkage
 * 
 * @module quality/code-repo-qa
 */

import { createModuleLogger } from '../logging/logger.js';
import type { ChunkDocument } from '../vectordb/types.js';
import type { RepoCard } from '../distill/types.js';

const logger = createModuleLogger('code-repo-qa');

// ============================================================================
// Types
// ============================================================================

export interface CardQAResult {
  /** Whether CARD.json exists */
  exists: boolean;
  /** Field completeness score (0-100) */
  completenessScore: number;
  /** Missing required fields */
  missingFields: string[];
  /** Empty optional fields (warnings) */
  emptyOptionalFields: string[];
  /** Whether the CARD is valid */
  isValid: boolean;
  /** Issues found */
  issues: string[];
}

export interface CodeQAResult {
  /** Total code chunks */
  totalCodeChunks: number;
  /** Number of classes */
  classCount: number;
  /** Number of functions */
  functionCount: number;
  /** Number of methods */
  methodCount: number;
  /** Number of other symbols (enums, types, etc.) */
  otherCount: number;
  /** Whether code indexing is valid */
  isValid: boolean;
  /** Issues found */
  issues: string[];
}

export interface DocsQAResult {
  /** Whether README was indexed */
  hasReadme: boolean;
  /** README chunk count */
  readmeChunks: number;
  /** Overview chunk count */
  overviewChunks: number;
  /** Whether relatedPaperId is set */
  hasRelatedPaper: boolean;
  /** The related paper ID */
  relatedPaperId?: string;
  /** Whether docs are valid */
  isValid: boolean;
  /** Issues found */
  issues: string[];
}

export interface CodeRepoQAReport {
  /** Unique report ID */
  reportId: string;
  /** Bundle ID */
  bundleId: string;
  /** Repo ID */
  repoId?: string;
  /** Content hash */
  contentHash?: string;
  /** Timestamp */
  timestamp: string;
  /** Strategy version */
  strategyVersion: string;
  /** CARD.json QA result */
  cardQA: CardQAResult;
  /** Code QA result */
  codeQA: CodeQAResult;
  /** Documentation QA result */
  docsQA: DocsQAResult;
  /** Overall pass/fail */
  passed: boolean;
  /** Quality score (0-100) */
  qualityScore: number;
  /** Summary of all issues */
  allIssues: string[];
}

// Strategy version for tracking
const STRATEGY_VERSION = '1.0.0-code';

// Required CARD fields
const REQUIRED_CARD_FIELDS = ['name', 'oneLiner', 'problemSolved', 'language'];
// Optional but recommended fields
const OPTIONAL_CARD_FIELDS = ['useCases', 'keyAPIs', 'quickStart', 'designHighlights'];

// ============================================================================
// CARD.json QA
// ============================================================================

/**
 * Analyze CARD.json for completeness.
 */
export function runCardQA(card: RepoCard | null): CardQAResult {
  const issues: string[] = [];
  const missingFields: string[] = [];
  const emptyOptionalFields: string[] = [];

  if (!card) {
    return {
      exists: false,
      completenessScore: 0,
      missingFields: REQUIRED_CARD_FIELDS,
      emptyOptionalFields: [],
      isValid: false,
      issues: ['CARD.json not found or invalid'],
    };
  }

  // Check required fields
  for (const field of REQUIRED_CARD_FIELDS) {
    const value = (card as unknown as Record<string, unknown>)[field];
    if (!value || (typeof value === 'string' && value.trim() === '')) {
      missingFields.push(field);
      issues.push(`Missing required field: ${field}`);
    }
  }

  // Check optional fields (warnings only)
  for (const field of OPTIONAL_CARD_FIELDS) {
    const value = (card as unknown as Record<string, unknown>)[field];
    if (!value || (Array.isArray(value) && value.length === 0)) {
      emptyOptionalFields.push(field);
    }
  }

  // Calculate completeness score
  const requiredScore = ((REQUIRED_CARD_FIELDS.length - missingFields.length) / REQUIRED_CARD_FIELDS.length) * 70;
  const optionalScore = ((OPTIONAL_CARD_FIELDS.length - emptyOptionalFields.length) / OPTIONAL_CARD_FIELDS.length) * 30;
  const completenessScore = Math.round(requiredScore + optionalScore);

  const isValid = missingFields.length === 0;

  return {
    exists: true,
    completenessScore,
    missingFields,
    emptyOptionalFields,
    isValid,
    issues,
  };
}

// ============================================================================
// Code Symbols QA
// ============================================================================

/**
 * Analyze code chunks for symbol coverage.
 */
export function runCodeQA(chunks: ChunkDocument[]): CodeQAResult {
  const issues: string[] = [];

  // Filter code chunks
  const codeChunks = chunks.filter(c => c.metadata.sourceType === 'code');

  // Count by symbol kind
  let classCount = 0;
  let functionCount = 0;
  let methodCount = 0;
  let otherCount = 0;

  for (const chunk of codeChunks) {
    const kind = (chunk.metadata as unknown as Record<string, unknown>).symbolKind as string | undefined;
    switch (kind) {
      case 'class':
      case 'interface':
        classCount++;
        break;
      case 'function':
        functionCount++;
        break;
      case 'method':
        methodCount++;
        break;
      default:
        otherCount++;
    }
  }

  // Check for issues
  if (codeChunks.length === 0) {
    issues.push('No code chunks indexed');
  } else if (codeChunks.length < 5) {
    issues.push(`Very few code chunks (${codeChunks.length}) - possible parsing issue`);
  }

  if (classCount === 0 && functionCount === 0) {
    issues.push('No classes or functions found - check if code parsing worked');
  }

  const isValid = codeChunks.length >= 5 && (classCount > 0 || functionCount > 0);

  return {
    totalCodeChunks: codeChunks.length,
    classCount,
    functionCount,
    methodCount,
    otherCount,
    isValid,
    issues,
  };
}

// ============================================================================
// Documentation QA
// ============================================================================

/**
 * Analyze documentation chunks.
 */
export function runDocsQA(chunks: ChunkDocument[]): DocsQAResult {
  const issues: string[] = [];

  // Find README chunks
  const readmeChunks = chunks.filter(c => c.metadata.sourceType === 'readme');
  const overviewChunks = chunks.filter(c => c.metadata.sourceType === 'overview');

  // Check for relatedPaperId
  let relatedPaperId: string | undefined;
  for (const chunk of chunks) {
    const rpId = (chunk.metadata as unknown as Record<string, unknown>).relatedPaperId as string | undefined;
    if (rpId) {
      relatedPaperId = rpId;
      break;
    }
  }

  // Check issues
  if (readmeChunks.length === 0 && overviewChunks.length === 0) {
    issues.push('No README or OVERVIEW documentation indexed');
  }

  const hasReadme = readmeChunks.length > 0;
  const hasRelatedPaper = !!relatedPaperId;

  // Not having relatedPaperId is not an error, just info
  const isValid = hasReadme || overviewChunks.length > 0;

  return {
    hasReadme,
    readmeChunks: readmeChunks.length,
    overviewChunks: overviewChunks.length,
    hasRelatedPaper,
    relatedPaperId,
    isValid,
    issues,
  };
}

// ============================================================================
// Full QA Pipeline
// ============================================================================

/**
 * Calculate quality score from QA results.
 */
function calculateQualityScore(
  cardQA: CardQAResult,
  codeQA: CodeQAResult,
  docsQA: DocsQAResult
): number {
  // Weights: CARD 30%, Code 50%, Docs 20%
  let score = 0;

  // CARD score (30 points max)
  if (cardQA.exists) {
    score += (cardQA.completenessScore / 100) * 30;
  }

  // Code score (50 points max)
  if (codeQA.totalCodeChunks > 0) {
    // Base: have code chunks (30 points)
    score += 30;
    // Bonus for variety (20 points)
    const hasClasses = codeQA.classCount > 0 ? 7 : 0;
    const hasFunctions = codeQA.functionCount > 0 ? 7 : 0;
    const hasMethods = codeQA.methodCount > 0 ? 6 : 0;
    score += hasClasses + hasFunctions + hasMethods;
  }

  // Docs score (20 points max)
  if (docsQA.hasReadme) {
    score += 15;
  }
  if (docsQA.hasRelatedPaper) {
    score += 5; // Bonus for paper linkage
  }

  return Math.min(100, Math.round(score));
}

/**
 * Run full code repository QA pipeline.
 */
export function runCodeRepoQA(
  chunks: ChunkDocument[],
  bundleId: string,
  card: RepoCard | null,
  contentHash?: string
): CodeRepoQAReport {
  const reportId = `qa_code_${bundleId.slice(0, 12)}_${Date.now()}`;

  // Get repoId from chunks
  const repoId = chunks[0]?.metadata.repoId;

  // Run CARD QA
  const cardQA = runCardQA(card);
  logger.info(`CARD QA: ${cardQA.isValid ? 'PASS' : 'FAIL'} (completeness: ${cardQA.completenessScore}%)`);

  // Run Code QA
  const codeQA = runCodeQA(chunks);
  logger.info(`Code QA: ${codeQA.isValid ? 'PASS' : 'FAIL'} (${codeQA.totalCodeChunks} chunks, ${codeQA.classCount} classes, ${codeQA.functionCount} functions)`);

  // Run Docs QA
  const docsQA = runDocsQA(chunks);
  logger.info(`Docs QA: ${docsQA.isValid ? 'PASS' : 'FAIL'} (readme: ${docsQA.readmeChunks}, related: ${docsQA.relatedPaperId ?? 'none'})`);

  // Calculate quality score
  const qualityScore = calculateQualityScore(cardQA, codeQA, docsQA);

  // Collect all issues
  const allIssues = [
    ...cardQA.issues,
    ...codeQA.issues,
    ...docsQA.issues,
  ];

  // Overall pass/fail
  const passed = cardQA.isValid && codeQA.isValid && docsQA.isValid;

  return {
    reportId,
    bundleId,
    repoId,
    contentHash,
    timestamp: new Date().toISOString(),
    strategyVersion: STRATEGY_VERSION,
    cardQA,
    codeQA,
    docsQA,
    passed,
    qualityScore,
    allIssues,
  };
}
