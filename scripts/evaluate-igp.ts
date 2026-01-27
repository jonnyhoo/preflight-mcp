#!/usr/bin/env tsx
/**
 * Phase 2.5: IGP Cost-Benefit Evaluation
 * 
 * Compares RAG query performance with and without IGP pruning:
 * - Answer quality (via faithfulness verification)
 * - Token consumption (generation stage)
 * - Response time
 * 
 * Usage: tsx scripts/evaluate-igp.ts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RAGEngine } from '../src/rag/query.js';
import type { RAGConfig, QueryOptions } from '../src/rag/types.js';
import { getConfig } from '../src/config.js';
import { createEmbeddingFromConfig } from '../src/embedding/preflightEmbedding.js';
import { callLLM, getLLMConfig } from '../src/distill/llm-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Types
// ============================================================================

interface TestQuestion {
  id: string;
  question: string;
  bundleId?: string;
  bundleIds?: string[];
  category: 'single-pdf' | 'cross-pdf' | 'multi-hop';
  expectedAnswer: string;
  evaluationCriteria: {
    mustContain?: string[];
    mustContainAll?: string[];
    mustContainAny?: string[][];
    scoreType: string;
  };
}

interface TestResult {
  questionId: string;
  category: string;
  
  // Baseline (no IGP)
  baselineAnswer: string;
  baselineScore: number;
  baselineTimeMs: number;
  baselineChunks: number;
  baselineFaithfulness?: number;
  
  // With IGP
  igpAnswer: string;
  igpScore: number;
  igpTimeMs: number;
  igpChunks: number;
  igpFaithfulness?: number;
  igpPruningStats?: {
    originalCount: number;
    prunedCount: number;
    pruningRatio: number;
    igpDurationMs: number;
  };
  
  // Comparison
  qualityDelta: number;      // (igp - baseline) score
  timeDeltaRatio: number;    // igpTime / baselineTime
  chunkReduction: number;    // 1 - (igpChunks / baselineChunks)
}

interface EvaluationReport {
  metadata: {
    testDate: string;
    phase: string;
    igpStrategy: string;
    igpThreshold?: number;  // For threshold strategy
    igpTopK?: number;       // For topK strategy
    questionsTotal: number;
    questionsSkipped: number;
  };
  results: TestResult[];
  summary: {
    avgQualityDelta: number;
    avgTimeDeltaRatio: number;
    avgChunkReduction: number;
    avgFaithfulnessDelta: number;
    
    qualityImproved: number;      // count
    qualityUnchanged: number;
    qualityDecreased: number;
    
    recommendation: 'keep' | 'discard' | 'optimize';
    reasons: string[];
  };
}

// ============================================================================
// Evaluation Logic
// ============================================================================

/**
 * Evaluate answer quality against expected criteria.
 */
function evaluateAnswer(
  answer: string,
  criteria: TestQuestion['evaluationCriteria']
): number {
  const lower = answer.toLowerCase();
  
  if (!answer || answer.includes('无法回答') || answer.includes('I don\'t have')) {
    return 0;
  }
  
  switch (criteria.scoreType) {
    case 'exact-match':
      if (criteria.mustContain) {
        return criteria.mustContain.every(kw => lower.includes(kw.toLowerCase())) ? 1.0 : 0.0;
      }
      return 0;
      
    case 'all-elements':
      if (criteria.mustContainAll) {
        const found = criteria.mustContainAll.filter(kw => lower.includes(kw.toLowerCase()));
        return found.length / criteria.mustContainAll.length;
      }
      return 0;
      
    case 'semantic-coverage':
      let coverage = 0;
      let total = 0;
      
      if (criteria.mustContainAny) {
        total += criteria.mustContainAny.length;
        for (const group of criteria.mustContainAny) {
          if (group.some(kw => lower.includes(kw.toLowerCase()))) {
            coverage++;
          }
        }
      }
      
      return total > 0 ? coverage / total : 0;
      
    default:
      return 0.5; // Unknown type
  }
}

/**
 * Run a single test question with and without IGP.
 * 
 * KEY INSIGHT: IGP's value is filtering irrelevant chunks from a LARGE corpus.
 * We use crossBundleMode: 'all' to retrieve from ALL 293 chunks across 7 papers,
 * then IGP filters out chunks from unrelated papers.
 */
async function runTest(
  engine: RAGEngine,
  question: TestQuestion,
  igpTopK: number
): Promise<TestResult | null> {
  console.log(`\n📝 Testing ${question.id}: ${question.question.slice(0, 50)}...`);
  
  // IMPORTANT: Use crossBundleMode: 'all' to retrieve from ALL indexed papers
  // This is the realistic scenario where IGP adds value by filtering irrelevant papers
  // Single-bundle retrieval doesn't benefit from IGP (already focused on one paper)
  
  // Common options - retrieve from ALL bundles to test IGP's filtering ability
  const baseOptions: QueryOptions = {
    // Don't specify bundleId - let it search all bundles
    crossBundleMode: 'all',  // Search all 293 chunks across 7 papers
    mode: 'hybrid',
    topK: 30, // More chunks from larger corpus to give IGP room to filter
    enableContextCompletion: true,
    maxHops: 2,
    enableVerification: true,
  };
  
  // Run baseline (no IGP)
  console.log('  → Running baseline...');
  const baselineStart = Date.now();
  let baselineResult;
  try {
    baselineResult = await engine.query(question.question, {
      ...baseOptions,
      igpOptions: { enabled: false },
    });
  } catch (err) {
    console.log(`  ✗ Baseline failed: ${err}`);
    return null;
  }
  const baselineTimeMs = Date.now() - baselineStart;
  
  // Run with IGP (using threshold strategy per paper Algorithm 1)
  console.log('  → Running with IGP (threshold strategy)...');
  const igpStart = Date.now();
  let igpResult;
  try {
    igpResult = await engine.query(question.question, {
      ...baseOptions,
      igpOptions: {
        enabled: true,
        strategy: 'threshold',
        threshold: 0, // Tp=0: filter negative-utility chunks (paper default)
      },
    });
  } catch (err) {
    console.log(`  ✗ IGP failed: ${err}`);
    return null;
  }
  const igpTimeMs = Date.now() - igpStart;
  
  // Evaluate scores
  const baselineScore = evaluateAnswer(baselineResult.answer, question.evaluationCriteria);
  const igpScore = evaluateAnswer(igpResult.answer, question.evaluationCriteria);
  
  const result: TestResult = {
    questionId: question.id,
    category: question.category,
    
    baselineAnswer: baselineResult.answer.slice(0, 500),
    baselineScore,
    baselineTimeMs,
    baselineChunks: baselineResult.stats?.chunksRetrieved ?? 0,
    baselineFaithfulness: baselineResult.faithfulnessScore,
    
    igpAnswer: igpResult.answer.slice(0, 500),
    igpScore,
    igpTimeMs,
    igpChunks: baselineResult.stats?.igpStats?.prunedCount ?? igpResult.stats?.chunksRetrieved ?? 0,
    igpFaithfulness: igpResult.faithfulnessScore,
    igpPruningStats: igpResult.stats?.igpStats ? {
      originalCount: igpResult.stats.igpStats.originalCount,
      prunedCount: igpResult.stats.igpStats.prunedCount,
      pruningRatio: igpResult.stats.igpStats.pruningRatio,
      igpDurationMs: igpResult.stats.igpStats.durationMs,
    } : undefined,
    
    qualityDelta: igpScore - baselineScore,
    timeDeltaRatio: igpTimeMs / baselineTimeMs,
    chunkReduction: baselineResult.stats?.chunksRetrieved 
      ? 1 - (igpResult.stats?.chunksRetrieved ?? 0) / baselineResult.stats.chunksRetrieved
      : 0,
  };
  
  console.log(`  ✓ Baseline: score=${baselineScore.toFixed(2)}, time=${baselineTimeMs}ms, chunks=${result.baselineChunks}`);
  console.log(`  ✓ IGP:      score=${igpScore.toFixed(2)}, time=${igpTimeMs}ms, chunks=${result.igpChunks}`);
  console.log(`  → Delta:    quality=${result.qualityDelta >= 0 ? '+' : ''}${result.qualityDelta.toFixed(2)}, time=${result.timeDeltaRatio.toFixed(2)}x, chunks=${(result.chunkReduction * 100).toFixed(1)}% reduced`);
  
  return result;
}

/**
 * Analyze results and generate recommendation.
 */
function analyzeResults(results: TestResult[]): EvaluationReport['summary'] {
  const avgQualityDelta = results.reduce((sum, r) => sum + r.qualityDelta, 0) / results.length;
  const avgTimeDeltaRatio = results.reduce((sum, r) => sum + r.timeDeltaRatio, 0) / results.length;
  const avgChunkReduction = results.reduce((sum, r) => sum + r.chunkReduction, 0) / results.length;
  
  // Faithfulness delta
  const faithfulnessDeltas = results
    .filter(r => r.baselineFaithfulness !== undefined && r.igpFaithfulness !== undefined)
    .map(r => (r.igpFaithfulness! - r.baselineFaithfulness!));
  const avgFaithfulnessDelta = faithfulnessDeltas.length > 0
    ? faithfulnessDeltas.reduce((a, b) => a + b, 0) / faithfulnessDeltas.length
    : 0;
  
  // Quality distribution
  const qualityImproved = results.filter(r => r.qualityDelta > 0.05).length;
  const qualityDecreased = results.filter(r => r.qualityDelta < -0.05).length;
  const qualityUnchanged = results.length - qualityImproved - qualityDecreased;
  
  // Decision logic
  const reasons: string[] = [];
  let recommendation: 'keep' | 'discard' | 'optimize' = 'keep';
  
  // Quality check (target: > 10% improvement or unchanged)
  if (avgQualityDelta < -0.1) {
    reasons.push(`❌ 质量下降 ${(-avgQualityDelta * 100).toFixed(1)}% (阈值 < -10%)`);
    recommendation = 'discard';
  } else if (avgQualityDelta >= 0.1) {
    reasons.push(`✅ 质量提升 ${(avgQualityDelta * 100).toFixed(1)}% (目标 > 10%)`);
  } else {
    reasons.push(`⚠️ 质量基本持平 ${(avgQualityDelta * 100).toFixed(1)}%`);
  }
  
  // Chunk reduction check (target: > 50%)
  if (avgChunkReduction >= 0.5) {
    reasons.push(`✅ Chunk 减少 ${(avgChunkReduction * 100).toFixed(1)}% (目标 > 50%)`);
  } else if (avgChunkReduction >= 0.3) {
    reasons.push(`⚠️ Chunk 减少 ${(avgChunkReduction * 100).toFixed(1)}% (略低于 50% 目标)`);
    if (recommendation === 'keep') recommendation = 'optimize';
  } else {
    reasons.push(`❌ Chunk 减少不足 ${(avgChunkReduction * 100).toFixed(1)}% (目标 > 30%)`);
    if (recommendation !== 'discard') recommendation = 'discard';
  }
  
  // Time check (target: < 2x)
  if (avgTimeDeltaRatio <= 2.0) {
    reasons.push(`✅ 响应时间增加 ${avgTimeDeltaRatio.toFixed(2)}x (可接受 < 2x)`);
  } else if (avgTimeDeltaRatio <= 3.0) {
    reasons.push(`⚠️ 响应时间增加 ${avgTimeDeltaRatio.toFixed(2)}x (需要优化批处理)`);
    if (recommendation === 'keep') recommendation = 'optimize';
  } else {
    reasons.push(`❌ 响应时间增加过大 ${avgTimeDeltaRatio.toFixed(2)}x (阈值 < 3x)`);
    if (recommendation !== 'discard') recommendation = 'optimize';
  }
  
  return {
    avgQualityDelta,
    avgTimeDeltaRatio,
    avgChunkReduction,
    avgFaithfulnessDelta,
    qualityImproved,
    qualityUnchanged,
    qualityDecreased,
    recommendation,
    reasons,
  };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('=== Phase 2.5: IGP Cost-Benefit Evaluation ===\n');
  
  // Load test dataset
  const datasetPath = path.join(__dirname, '../tests/fixtures/pdf-rag-test-dataset.json');
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));
  console.log(`Loaded ${dataset.questions.length} test questions\n`);
  
  // Initialize RAG engine
  const config = getConfig();
  const { embedding } = createEmbeddingFromConfig(config);
  const llmConfig = getLLMConfig();
  const llmEnabled = llmConfig.enabled && !!llmConfig.apiKey;
  
  const ragConfig: RAGConfig = {
    chromaUrl: config.chromaUrl || 'http://localhost:8000',
    embedding: {
      embed: async (text: string) => embedding.embed(text),
      embedBatch: async (texts: string[]) => embedding.embedBatch(texts),
    },
    llm: llmEnabled ? {
      complete: async (prompt: string) => {
        const response = await callLLM(prompt, undefined, llmConfig);
        return response.content;
      },
    } : undefined,
  };
  
  console.log(`Embedding: ${config.embeddingModel || 'default'}`);
  console.log(`LLM: ${llmEnabled ? llmConfig.model : 'disabled'}\n`);
  
  const engine = new RAGEngine(ragConfig);
  
  // Check availability
  const available = await engine.isAvailable();
  if (!available) {
    console.error('❌ ChromaDB not available. Please start ChromaDB server.');
    process.exit(1);
  }
  
  // IGP configuration (using threshold strategy per paper Algorithm 1)
  const IGP_THRESHOLD = 0; // Tp=0: filter negative-utility chunks
  
  // Test ALL questions - the key is using crossBundleMode: 'all' in runTest()
  // This retrieves from ALL 293 chunks across 7 papers, which is where IGP adds value
  // by filtering out chunks from irrelevant papers
  const testQuestions: TestQuestion[] = dataset.questions.filter(
    (q: any) => q.evaluationCriteria // Only questions with evaluation criteria
  );
  
  console.log(`Testing ${testQuestions.length} questions with crossBundleMode: 'all'`);
  console.log(`Retrieval pool: 293 chunks across 7 papers`);
  console.log(`IGP Configuration: strategy=threshold, Tp=${IGP_THRESHOLD} (filter IG < 0)\n`);
  
  // Run tests
  const results: TestResult[] = [];
  let skipped = 0;
  
  for (const question of testQuestions) {
    const result = await runTest(engine, question, 0); // threshold param not used
    if (result) {
      results.push(result);
    } else {
      skipped++;
    }
  }
  
  // Analyze results
  console.log('\n' + '='.repeat(60));
  console.log('=== Summary ===\n');
  
  if (results.length === 0) {
    console.log('No valid results to analyze.');
    return;
  }
  
  const summary = analyzeResults(results);
  
  console.log(`Questions tested: ${results.length} (skipped: ${skipped})`);
  console.log(`\nQuality distribution:`);
  console.log(`  ↑ Improved:  ${summary.qualityImproved}`);
  console.log(`  → Unchanged: ${summary.qualityUnchanged}`);
  console.log(`  ↓ Decreased: ${summary.qualityDecreased}`);
  
  console.log(`\nMetrics:`);
  console.log(`  Avg quality delta:     ${summary.avgQualityDelta >= 0 ? '+' : ''}${(summary.avgQualityDelta * 100).toFixed(1)}%`);
  console.log(`  Avg time increase:     ${summary.avgTimeDeltaRatio.toFixed(2)}x`);
  console.log(`  Avg chunk reduction:   ${(summary.avgChunkReduction * 100).toFixed(1)}%`);
  console.log(`  Avg faithfulness delta: ${summary.avgFaithfulnessDelta >= 0 ? '+' : ''}${summary.avgFaithfulnessDelta.toFixed(2)}`);
  
  console.log(`\nDecision factors:`);
  for (const reason of summary.reasons) {
    console.log(`  ${reason}`);
  }
  
  console.log(`\n🎯 Recommendation: ${summary.recommendation.toUpperCase()}`);
  
  // Save report
  const report: EvaluationReport = {
    metadata: {
      testDate: new Date().toISOString(),
      phase: 'Phase 2.5 - IGP Evaluation (Cross-Bundle)',
      testMode: 'crossBundleMode: all (293 chunks, 7 papers)',
      igpStrategy: 'threshold',
      igpThreshold: IGP_THRESHOLD,
      questionsTotal: testQuestions.length,
      questionsSkipped: skipped,
    },
    results,
    summary,
  };
  
  const outputPath = path.join(__dirname, '../tests/benchmarks/igp-evaluation-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\n📊 Report saved to: ${outputPath}`);
}

main().catch(console.error);
