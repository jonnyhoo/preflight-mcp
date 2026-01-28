/**
 * Index-Time Quality Assurance for PDF RAG Pipeline.
 * 
 * Performs quality checks at index time (before bundle deletion) and persists
 * QA reports to the vector database for post-deletion auditing.
 * 
 * QA Levels:
 * 1. Parse QA: Page count consistency, hyphenation ratio, garbled text ratio, coverage
 * 2. Chunk QA: Orphan chunks, parentChunkId consistency, page marker pollution
 * 3. RAG QA: Fixed question set verification, faithfulness check
 * 
 * @module quality/index-qa
 */

import { createModuleLogger } from '../logging/logger.js';
import type { ChunkDocument, ChunkMetadata } from '../vectordb/types.js';
import type { ChromaVectorDB } from '../vectordb/chroma-client.js';

const logger = createModuleLogger('index-qa');

// ============================================================================
// Types
// ============================================================================

export interface ParseQAResult {
  /** Estimated page count from markers/content */
  pageCount: number;
  /** Ratio of hyphenated words (0-1) */
  hyphenationRatio: number;
  /** Ratio of garbled/unreadable text (0-1) */
  garbledRatio: number;
  /** Number of tables detected */
  tablesDetected: number;
  /** Number of figures detected */
  figuresDetected: number;
  /** Number of formulas detected */
  formulasDetected: number;
  /** Whether the parse is considered valid */
  isValid: boolean;
  /** Issues found */
  issues: string[];
}

export interface ChunkQAResult {
  /** Total number of chunks */
  totalChunks: number;
  /** Number of orphan chunks (no parentChunkId when expected) */
  orphanChunks: number;
  /** Number of chunks with invalid parentChunkId */
  invalidParentRefs: number;
  /** Number of page marker pollution (chunks with "Page N" in heading) */
  pageMarkerPollution: number;
  /** Chunks by granularity */
  byGranularity: Record<string, number>;
  /** Chunks by type */
  byType: Record<string, number>;
  /** Whether chunks are valid */
  isValid: boolean;
  /** Issues found */
  issues: string[];
}

export interface RAGQAResult {
  /** Number of test questions */
  testQuestionCount: number;
  /** Number passed (faithfulness >= threshold) */
  passedCount: number;
  /** Average faithfulness score */
  avgFaithfulness: number;
  /** Whether RAG QA passed */
  isValid: boolean;
  /** Details per question */
  details: Array<{
    question: string;
    hasAnswer: boolean;
    hasCitations: boolean;
    faithfulness: number;
    passed: boolean;
  }>;
  /** Issues found */
  issues: string[];
}

export interface QAReport {
  /** Unique report ID */
  reportId: string;
  /** Content hash of the source PDF */
  contentHash: string;
  /** Paper ID if available */
  paperId?: string;
  /** Timestamp */
  timestamp: string;
  /** Strategy version for regression tracking */
  strategyVersion: string;
  /** Parse QA result */
  parseQA: ParseQAResult;
  /** Chunk QA result */
  chunkQA: ChunkQAResult;
  /** RAG QA result (optional, requires LLM) */
  ragQA?: RAGQAResult;
  /** Overall pass/fail */
  passed: boolean;
  /** Summary of all issues */
  allIssues: string[];
}

// Strategy version for tracking changes
const STRATEGY_VERSION = '1.0.0-multiscale';

// ============================================================================
// Parse QA
// ============================================================================

/**
 * Analyze markdown content for parse quality.
 */
export function runParseQA(markdown: string): ParseQAResult {
  const issues: string[] = [];
  
  // Count pages (look for page markers or estimate from content)
  const pageMarkers = markdown.match(/page\s+\d+/gi) ?? [];
  const pageCount = pageMarkers.length || Math.ceil(markdown.length / 3000); // Rough estimate
  
  // Hyphenation ratio: count word-\n patterns
  const words = markdown.split(/\s+/).length;
  const hyphenatedWords = (markdown.match(/\w+-\n\w+/g) ?? []).length;
  const hyphenationRatio = words > 0 ? hyphenatedWords / words : 0;
  if (hyphenationRatio > 0.05) {
    issues.push(`High hyphenation ratio: ${(hyphenationRatio * 100).toFixed(1)}%`);
  }
  
  // Garbled text: look for unusual character sequences
  const garbledPatterns = markdown.match(/[^\x00-\x7F]{3,}|[\x00-\x08\x0B\x0C\x0E-\x1F]/g) ?? [];
  const garbledRatio = markdown.length > 0 ? garbledPatterns.join('').length / markdown.length : 0;
  if (garbledRatio > 0.02) {
    issues.push(`High garbled text ratio: ${(garbledRatio * 100).toFixed(1)}%`);
  }
  
  // Count tables, figures, formulas
  const tablesDetected = (markdown.match(/\|.*\|.*\|/g) ?? []).length / 2; // Each table has multiple rows
  const figuresDetected = (markdown.match(/!\[.*?\]\(.*?\)|^\[Figure:/gim) ?? []).length;
  const formulasDetected = (markdown.match(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]/g) ?? []).length;
  
  const isValid = issues.length === 0;
  
  return {
    pageCount,
    hyphenationRatio,
    garbledRatio,
    tablesDetected: Math.floor(tablesDetected),
    figuresDetected,
    formulasDetected,
    isValid,
    issues,
  };
}

// ============================================================================
// Chunk QA
// ============================================================================

/**
 * Analyze chunks for quality issues.
 */
export function runChunkQA(chunks: ChunkDocument[]): ChunkQAResult {
  const issues: string[] = [];
  
  // Build set of chunk IDs
  const chunkIds = new Set(chunks.map(c => c.id));
  
  // Count by granularity and type
  const byGranularity: Record<string, number> = {};
  const byType: Record<string, number> = {};
  
  let orphanChunks = 0;
  let invalidParentRefs = 0;
  let pageMarkerPollution = 0;
  
  for (const chunk of chunks) {
    const meta = chunk.metadata;
    
    // Count by granularity
    const granularity = meta.granularity ?? 'unknown';
    byGranularity[granularity] = (byGranularity[granularity] ?? 0) + 1;
    
    // Count by type
    const chunkType = meta.chunkType ?? 'unknown';
    byType[chunkType] = (byType[chunkType] ?? 0) + 1;
    
    // Check for orphan chunks (element granularity should have parentChunkId)
    if (granularity === 'element' && !meta.parentChunkId) {
      orphanChunks++;
    }
    
    // Check for invalid parent references
    // A parentChunkId is invalid if it's set but the referenced chunk doesn't exist
    if (meta.parentChunkId && !chunkIds.has(meta.parentChunkId)) {
      invalidParentRefs++;
    }
    
    // Check for page marker pollution
    const heading = meta.sectionHeading ?? '';
    if (/^page\s+\d+$/i.test(heading.trim())) {
      pageMarkerPollution++;
    }
  }
  
  // Generate issues
  if (orphanChunks > 0) {
    issues.push(`${orphanChunks} orphan element chunks without parentChunkId`);
  }
  if (invalidParentRefs > 0) {
    issues.push(`${invalidParentRefs} chunks with invalid parentChunkId references`);
  }
  if (pageMarkerPollution > 0) {
    issues.push(`${pageMarkerPollution} chunks with page marker pollution in heading`);
  }
  
  const isValid = issues.length === 0;
  
  return {
    totalChunks: chunks.length,
    orphanChunks,
    invalidParentRefs,
    pageMarkerPollution,
    byGranularity,
    byType,
    isValid,
    issues,
  };
}

// ============================================================================
// RAG QA (requires LLM)
// ============================================================================

/**
 * Test questions for RAG QA.
 * These are generic questions that should work for most academic papers.
 */
const RAG_TEST_QUESTIONS = [
  'What is the main contribution of this paper?',
  'What methodology or approach does this paper use?',
  'What are the key experimental results?',
];

/**
 * Run RAG QA with test questions.
 * Requires a query function that returns answer + faithfulness score.
 */
export async function runRAGQA(
  queryFn: (question: string) => Promise<{ answer: string; faithfulness?: number }>,
  faithfulnessThreshold = 0.9
): Promise<RAGQAResult> {
  const details: RAGQAResult['details'] = [];
  const issues: string[] = [];
  
  let passedCount = 0;
  let totalFaithfulness = 0;
  
  for (const question of RAG_TEST_QUESTIONS) {
    try {
      const result = await queryFn(question);
      const hasAnswer = result.answer.length > 20;
      const hasCitations = /\[\d+\]/.test(result.answer);
      const faithfulness = result.faithfulness ?? 0.5;
      const passed = faithfulness >= faithfulnessThreshold && hasAnswer;
      
      if (passed) passedCount++;
      totalFaithfulness += faithfulness;
      
      details.push({
        question,
        hasAnswer,
        hasCitations,
        faithfulness,
        passed,
      });
      
      if (!passed) {
        issues.push(`Question "${question.slice(0, 30)}..." failed (faithfulness: ${faithfulness.toFixed(2)})`);
      }
    } catch (err) {
      details.push({
        question,
        hasAnswer: false,
        hasCitations: false,
        faithfulness: 0,
        passed: false,
      });
      issues.push(`Question "${question.slice(0, 30)}..." threw error: ${err}`);
    }
  }
  
  const avgFaithfulness = RAG_TEST_QUESTIONS.length > 0 
    ? totalFaithfulness / RAG_TEST_QUESTIONS.length 
    : 0;
  
  const isValid = passedCount === RAG_TEST_QUESTIONS.length;
  
  return {
    testQuestionCount: RAG_TEST_QUESTIONS.length,
    passedCount,
    avgFaithfulness,
    isValid,
    details,
    issues,
  };
}

// ============================================================================
// Full QA Pipeline
// ============================================================================

/**
 * Run full QA pipeline and generate report.
 */
export async function runFullQA(
  markdown: string,
  chunks: ChunkDocument[],
  contentHash: string,
  paperId?: string,
  queryFn?: (question: string) => Promise<{ answer: string; faithfulness?: number }>
): Promise<QAReport> {
  const reportId = `qa_${contentHash.slice(0, 12)}_${Date.now()}`;
  
  // Run Parse QA
  const parseQA = runParseQA(markdown);
  logger.info(`Parse QA: ${parseQA.isValid ? 'PASS' : 'FAIL'} (${parseQA.issues.length} issues)`);
  
  // Run Chunk QA
  const chunkQA = runChunkQA(chunks);
  logger.info(`Chunk QA: ${chunkQA.isValid ? 'PASS' : 'FAIL'} (${chunkQA.issues.length} issues)`);
  
  // Run RAG QA if query function provided
  let ragQA: RAGQAResult | undefined;
  if (queryFn) {
    ragQA = await runRAGQA(queryFn);
    logger.info(`RAG QA: ${ragQA.isValid ? 'PASS' : 'FAIL'} (${ragQA.passedCount}/${ragQA.testQuestionCount})`);
  }
  
  // Collect all issues
  const allIssues = [
    ...parseQA.issues,
    ...chunkQA.issues,
    ...(ragQA?.issues ?? []),
  ];
  
  // Overall pass/fail
  const passed = parseQA.isValid && chunkQA.isValid && (ragQA?.isValid ?? true);
  
  return {
    reportId,
    contentHash,
    paperId,
    timestamp: new Date().toISOString(),
    strategyVersion: STRATEGY_VERSION,
    parseQA,
    chunkQA,
    ragQA,
    passed,
    allIssues,
  };
}

// ============================================================================
// Persist QA Report to VectorDB
// ============================================================================

/**
 * Persist QA report to ChromaDB as a special document.
 * This allows auditing even after the bundle is deleted.
 */
export async function persistQAReport(
  chromaDB: ChromaVectorDB,
  report: QAReport,
  embedding: { embed: (text: string) => Promise<{ vector: number[] }> }
): Promise<void> {
  // Create a searchable summary (embed this, not the full JSON)
  const summary = [
    `QA Report for ${report.paperId ?? report.contentHash.slice(0, 12)}`,
    `Status: ${report.passed ? 'PASSED' : 'FAILED'}`,
    `Strategy: ${report.strategyVersion}`,
    `Parse: ${report.parseQA.isValid ? 'OK' : 'FAIL'} (${report.parseQA.tablesDetected} tables, ${report.parseQA.figuresDetected} figures)`,
    `Chunks: ${report.chunkQA.totalChunks} total, ${report.chunkQA.orphanChunks} orphan`,
    report.ragQA ? `RAG: ${report.ragQA.passedCount}/${report.ragQA.testQuestionCount} passed (avg faith: ${report.ragQA.avgFaithfulness.toFixed(2)})` : '',
    report.allIssues.length > 0 ? `Issues: ${report.allIssues.slice(0, 3).join('; ')}` : 'No issues',
  ].filter(Boolean).join('\n');

  // Store full report JSON in content (not metadata) to avoid metadata size limits
  const reportJson = JSON.stringify(report);
  const content = `${summary}\n\n---\nQA_REPORT_JSON:\n${reportJson}`;

  // Generate embedding for the summary
  const embeddingResult = await embedding.embed(summary);

  // Create chunk document for the QA report
  const qaChunk: ChunkDocument = {
    id: report.reportId,
    content,
    metadata: {
      sourceType: 'overview',
      // Use contentHash as pseudo-bundleId for lookup/audit after bundle deletion
      bundleId: report.contentHash,
      chunkIndex: 0,
      chunkType: 'summary',
      contentHash: report.contentHash,
      paperId: report.paperId,
      fieldName: 'quality_report_json',
    },
    embedding: embeddingResult.vector,
  };

  // Store QA report in L1_pdf collection (Phase 3 hierarchical)
  await chromaDB.upsertHierarchicalChunks('l1_pdf', [qaChunk]);
  logger.info(`Persisted QA report: ${report.reportId} (${report.passed ? 'PASSED' : 'FAILED'})`);
}
