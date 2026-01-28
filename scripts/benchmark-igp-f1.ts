#!/usr/bin/env tsx
/**
 * IGP F1 Benchmark
 * 
 * Based on "Less is More" paper (arXiv:2601.17532) experimental methodology.
 * 
 * Key insight from paper:
 * - TOPM=1: IGP improves accuracy by selecting utility-maximizing evidence
 * - TOPM=5: IGP's admission control (threshold pruning) is the MAIN driver
 *   - Reranking alone provides minimal benefit
 *   - Threshold-based pruning significantly improves F1 while reducing TK
 * 
 * This benchmark measures:
 * - F1: Token-level Precision/Recall/F1 against ground truth
 * - TK: Average input tokens (context cost)
 * - NTE: Normalized Token Efficiency = (F1/TK) / (baseline F1/TK)
 * 
 * Usage: npx tsx scripts/benchmark-igp-f1.ts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ChromaVectorDB } from '../src/vectordb/chroma-client.js';
import { getConfig } from '../src/config.js';
import { createEmbeddingFromConfig } from '../src/embedding/preflightEmbedding.js';
import { callLLM, getLLMConfig, type LLMConfig } from '../src/distill/llm-client.js';
import { RAGEngine } from '../src/rag/query.js';
import type { QueryOptions, QueryResult, RAGConfig } from '../src/rag/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Types
// ============================================================================

interface TestQuestion {
  id: string;
  question: string;
  expectedAnswer: string;
  acceptableVariants?: string[];
  bundleId?: string;
  bundleIds?: string[];
  category: string;
  evaluationCriteria?: {
    mustContain?: string[];
    mustContainAll?: string[];
    mustContainAny?: string[][];
    scoreType: string;
  };
}

interface F1Result {
  precision: number;
  recall: number;
  f1: number;
}

interface BenchmarkResult {
  questionId: string;
  question: string;
  expectedAnswer: string;
  
  // Method results
  methods: {
    [method: string]: {
      answer: string;
      f1: number;
      precision: number;
      recall: number;
      inputTokens: number;
      chunksUsed: number;
      igpStats?: {
        originalCount: number;
        prunedCount: number;
        pruningRatio: number;
      };
      durationMs: number;
    };
  };
}

interface BenchmarkSummary {
  testDate: string;
  totalQuestions: number;
  methods: {
    [method: string]: {
      avgF1: number;
      avgPrecision: number;
      avgRecall: number;
      avgInputTokens: number;
      avgChunks: number;
      nte: number; // Normalized Token Efficiency
    };
  };
  conclusion: string;
}

// ============================================================================
// Token-level F1 Calculation (per paper Section 4.1.6)
// ============================================================================

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')  // Remove punctuation
    .replace(/\s+/g, ' ')       // Normalize whitespace
    .trim();
}

function tokenize(text: string): string[] {
  return normalizeText(text).split(' ').filter(t => t.length > 0);
}

function calculateTokenF1(predicted: string, references: string[]): F1Result {
  const predTokens = tokenize(predicted);
  if (predTokens.length === 0) {
    return { precision: 0, recall: 0, f1: 0 };
  }
  
  // Calculate F1 against each reference, take best
  let bestF1: F1Result = { precision: 0, recall: 0, f1: 0 };
  
  for (const ref of references) {
    const refTokens = tokenize(ref);
    if (refTokens.length === 0) continue;
    
    // Count token overlap (multiset intersection)
    const predCounts = new Map<string, number>();
    for (const t of predTokens) {
      predCounts.set(t, (predCounts.get(t) || 0) + 1);
    }
    
    const refCounts = new Map<string, number>();
    for (const t of refTokens) {
      refCounts.set(t, (refCounts.get(t) || 0) + 1);
    }
    
    let overlap = 0;
    for (const [token, predCount] of predCounts) {
      const refCount = refCounts.get(token) || 0;
      overlap += Math.min(predCount, refCount);
    }
    
    const precision = overlap / predTokens.length;
    const recall = overlap / refTokens.length;
    const f1 = (precision + recall > 0)
      ? (2 * precision * recall) / (precision + recall)
      : 0;
    
    if (f1 > bestF1.f1) {
      bestF1 = { precision, recall, f1 };
    }
  }
  
  return bestF1;
}

// ============================================================================
// Benchmark Logic
// ============================================================================

async function runQuery(
  engine: RAGEngine,
  question: TestQuestion,
  options: QueryOptions
): Promise<QueryResult> {
  const queryOptions: QueryOptions = {
    ...options,
    crossBundleMode: question.bundleIds ? 'specified' : 'single',
    bundleId: question.bundleId,
    bundleIds: question.bundleIds,
  };
  
  return engine.query(question.question, queryOptions);
}

function estimateInputTokens(chunks: number, avgChunkTokens = 150, promptOverhead = 100): number {
  // Rough estimate: prompt + chunks
  return promptOverhead + (chunks * avgChunkTokens);
}

async function benchmarkQuestion(
  engine: RAGEngine,
  question: TestQuestion,
  methods: { name: string; options: QueryOptions }[]
): Promise<BenchmarkResult | null> {
  console.log(`\n📝 ${question.id}: ${question.question.slice(0, 50)}...`);
  
  const result: BenchmarkResult = {
    questionId: question.id,
    question: question.question,
    expectedAnswer: question.expectedAnswer,
    methods: {},
  };
  
  // Prepare references for F1 calculation
  const references = [
    question.expectedAnswer,
    ...(question.acceptableVariants || []),
  ];
  
  for (const method of methods) {
    try {
      console.log(`  → ${method.name}...`);
      const startTime = Date.now();
      
      const queryResult = await runQuery(engine, question, method.options);
      
      const durationMs = Date.now() - startTime;
      const chunksUsed = queryResult.stats.chunksRetrieved;
      const inputTokens = estimateInputTokens(chunksUsed);
      
      // Calculate F1
      const f1Result = calculateTokenF1(queryResult.answer, references);
      
      result.methods[method.name] = {
        answer: queryResult.answer,
        f1: f1Result.f1,
        precision: f1Result.precision,
        recall: f1Result.recall,
        inputTokens,
        chunksUsed,
        igpStats: queryResult.stats.igpStats,
        durationMs,
      };
      
      console.log(`    F1=${f1Result.f1.toFixed(3)}, chunks=${chunksUsed}, tokens≈${inputTokens}`);
      if (queryResult.stats.igpStats) {
        console.log(`    IGP: ${queryResult.stats.igpStats.originalCount}→${queryResult.stats.igpStats.prunedCount} chunks`);
      }
    } catch (err) {
      console.log(`    ✗ Error: ${err}`);
    }
  }
  
  return Object.keys(result.methods).length > 0 ? result : null;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('=== IGP F1 Benchmark ===');
  console.log('Based on "Less is More" paper methodology\n');
  
  // Load test dataset
  const datasetPath = path.join(__dirname, '../tests/fixtures/pdf-rag-test-dataset.json');
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));
  
  // Initialize components
  const config = getConfig();
  const { embedding } = createEmbeddingFromConfig(config);
  const chromaUrl = config.chromaUrl || 'http://localhost:8000';
  
  // Setup LLM (same pattern as ragTools.ts)
  const llmConfig: LLMConfig = getLLMConfig();
  const llmEnabled = llmConfig.enabled && !!llmConfig.apiKey;
  
  const ragConfig: RAGConfig = {
    chromaUrl,
    embedding: {
      embed: async (text: string) => embedding.embed(text),
      embedBatch: async (texts: string[]) => embedding.embedBatch(texts),
    },
    llm: llmEnabled
      ? {
          complete: async (prompt: string) => {
            const response = await callLLM(prompt, undefined, llmConfig);
            return response.content;
          },
        }
      : undefined,
  };
  
  const engine = new RAGEngine(ragConfig);
  
  // Check availability
  const chromaDB = new ChromaVectorDB({ url: chromaUrl });
  const available = await chromaDB.isAvailable();
  if (!available) {
    console.error(`❌ ChromaDB not available at ${chromaUrl}`);
    process.exit(1);
  }
  
  console.log(`ChromaDB: ${chromaUrl}`);
  console.log(`LLM: ${llmEnabled ? llmConfig.model : 'disabled'}`);
  console.log(`Embedding: ${config.embeddingModel || 'default'}\n`);
  
  // Define methods to compare (per paper Table 4)
  // Paper uses TOPM=1 and TOPM=5; we use topK as proxy
  const methods = [
    // Baseline: No IGP
    {
      name: 'baseline-topK5',
      options: {
        topK: 5,
        enableContextCompletion: false,
        igpOptions: { enabled: false },
      } as QueryOptions,
    },
    // IGP with threshold=0 (filter negative-utility)
    {
      name: 'IGP-Tp0-topK5',
      options: {
        topK: 5,
        enableContextCompletion: false,
        igpOptions: {
          enabled: true,
          strategy: 'threshold' as const,
          threshold: 0,
        },
      } as QueryOptions,
    },
    // IGP with threshold=0.05 (paper's recommended)
    {
      name: 'IGP-Tp0.05-topK5',
      options: {
        topK: 5,
        enableContextCompletion: false,
        igpOptions: {
          enabled: true,
          strategy: 'threshold' as const,
          threshold: 0.05,
        },
      } as QueryOptions,
    },
    // Higher topK to introduce more noise (simulates TOPM=5 with larger candidate pool)
    {
      name: 'baseline-topK15',
      options: {
        topK: 15,
        enableContextCompletion: false,
        igpOptions: { enabled: false },
      } as QueryOptions,
    },
    {
      name: 'IGP-Tp0.05-topK15',
      options: {
        topK: 15,
        enableContextCompletion: false,
        igpOptions: {
          enabled: true,
          strategy: 'threshold' as const,
          threshold: 0.05,
        },
      } as QueryOptions,
    },
  ];
  
  // Filter questions with ground truth
  const testQuestions: TestQuestion[] = dataset.questions.filter(
    (q: any) => q.expectedAnswer && (q.bundleId || q.bundleIds)
  );
  
  console.log(`Testing ${testQuestions.length} questions with ${methods.length} methods\n`);
  console.log('Methods:');
  for (const m of methods) {
    console.log(`  - ${m.name}: topK=${m.options.topK}, IGP=${m.options.igpOptions?.enabled ? `Tp=${m.options.igpOptions.threshold}` : 'off'}`);
  }
  
  // Run benchmark
  const results: BenchmarkResult[] = [];
  
  for (const question of testQuestions) {
    try {
      const result = await benchmarkQuestion(engine, question, methods);
      if (result) {
        results.push(result);
      }
    } catch (err) {
      console.error(`  ✗ Error: ${err}`);
    }
  }
  
  // Calculate summary
  console.log('\n' + '='.repeat(70));
  console.log('=== Summary ===\n');
  
  if (results.length === 0) {
    console.log('No valid results.');
    return;
  }
  
  const summary: BenchmarkSummary = {
    testDate: new Date().toISOString(),
    totalQuestions: results.length,
    methods: {},
    conclusion: '',
  };
  
  // Aggregate per method
  for (const method of methods) {
    const methodResults = results
      .map(r => r.methods[method.name])
      .filter(m => m !== undefined);
    
    if (methodResults.length === 0) continue;
    
    const avgF1 = methodResults.reduce((s, r) => s + r.f1, 0) / methodResults.length;
    const avgPrecision = methodResults.reduce((s, r) => s + r.precision, 0) / methodResults.length;
    const avgRecall = methodResults.reduce((s, r) => s + r.recall, 0) / methodResults.length;
    const avgInputTokens = methodResults.reduce((s, r) => s + r.inputTokens, 0) / methodResults.length;
    const avgChunks = methodResults.reduce((s, r) => s + r.chunksUsed, 0) / methodResults.length;
    
    summary.methods[method.name] = {
      avgF1,
      avgPrecision,
      avgRecall,
      avgInputTokens,
      avgChunks,
      nte: 0, // Calculate after baseline
    };
  }
  
  // Calculate NTE (relative to baseline-topK5)
  const baselineKey = 'baseline-topK5';
  const baseline = summary.methods[baselineKey];
  if (baseline && baseline.avgF1 > 0 && baseline.avgInputTokens > 0) {
    const baselineEfficiency = baseline.avgF1 / baseline.avgInputTokens;
    for (const methodName of Object.keys(summary.methods)) {
      const method = summary.methods[methodName]!;
      const methodEfficiency = method.avgF1 / method.avgInputTokens;
      method.nte = methodEfficiency / baselineEfficiency;
    }
  }
  
  // Print summary table
  console.log('Method'.padEnd(20) + 'F1'.padStart(8) + 'Prec'.padStart(8) + 'Rec'.padStart(8) + 'Tokens'.padStart(8) + 'Chunks'.padStart(8) + 'NTE'.padStart(8));
  console.log('-'.repeat(68));
  
  for (const [name, stats] of Object.entries(summary.methods)) {
    console.log(
      name.padEnd(20) +
      stats.avgF1.toFixed(3).padStart(8) +
      stats.avgPrecision.toFixed(3).padStart(8) +
      stats.avgRecall.toFixed(3).padStart(8) +
      stats.avgInputTokens.toFixed(0).padStart(8) +
      stats.avgChunks.toFixed(1).padStart(8) +
      stats.nte.toFixed(2).padStart(8)
    );
  }
  
  // Conclusion
  const baselineF1 = summary.methods[baselineKey]?.avgF1 || 0;
  const igpF1 = summary.methods['IGP-Tp0.05-topK15']?.avgF1 || 0;
  const igpNTE = summary.methods['IGP-Tp0.05-topK15']?.nte || 0;
  
  if (igpF1 > baselineF1 && igpNTE > 1.2) {
    summary.conclusion = '✅ IGP EFFECTIVE: Higher F1 with better token efficiency';
  } else if (igpNTE > 1.0) {
    summary.conclusion = '⚠️ IGP PARTIAL: Better efficiency but similar or lower F1';
  } else {
    summary.conclusion = '❌ IGP NOT BENEFICIAL: No clear advantage in this dataset';
  }
  
  console.log(`\n🎯 ${summary.conclusion}`);
  
  // Per-question breakdown
  console.log('\n📊 Per-question F1 (baseline-topK5 vs IGP-Tp0.05-topK15):');
  console.log('ID'.padEnd(6) + 'Baseline'.padStart(10) + 'IGP'.padStart(10) + 'Δ'.padStart(8));
  console.log('-'.repeat(34));
  
  for (const r of results) {
    const bl = r.methods['baseline-topK5']?.f1 || 0;
    const igp = r.methods['IGP-Tp0.05-topK15']?.f1 || 0;
    const delta = igp - bl;
    const sign = delta >= 0 ? '+' : '';
    console.log(
      r.questionId.padEnd(6) +
      bl.toFixed(3).padStart(10) +
      igp.toFixed(3).padStart(10) +
      `${sign}${delta.toFixed(3)}`.padStart(8)
    );
  }
  
  // Save results
  const outputPath = path.join(__dirname, '../tests/benchmarks/igp-f1-benchmark-results.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({ summary, results }, null, 2), 'utf-8');
  console.log(`\n📊 Results saved to: ${outputPath}`);
}

main().catch(console.error);
