#!/usr/bin/env tsx
/**
 * Phase 2.5: IGP Noise Injection Test
 * 
 * Tests IGP's ability to filter irrelevant (noise) chunks from retrieval results.
 * 
 * Key insight: In small datasets, vector retrieval is already accurate.
 * IGP's value is filtering noise when retrieval includes irrelevant content.
 * 
 * Test procedure:
 * 1. Retrieve relevant chunks for a question (from correct bundle)
 * 2. Retrieve noise chunks from unrelated topics (different bundles)
 * 3. Mix relevant + noise chunks
 * 4. Apply IGP and verify it filters noise correctly
 * 
 * Usage: npx tsx scripts/test-igp-with-noise.ts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ChromaVectorDB } from '../src/vectordb/chroma-client.js';
import { getConfig } from '../src/config.js';
import { createEmbeddingFromConfig } from '../src/embedding/preflightEmbedding.js';
import { IGPPruner, type IGPOptions } from '../src/rag/pruning/igp-pruner.js';
import type { ChunkWithScore, RankedChunk } from '../src/rag/pruning/ig-ranker.js';

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
}

interface NoiseTestResult {
  questionId: string;
  question: string;
  
  // Chunk composition
  relevantChunks: number;
  noiseChunks: number;
  totalChunks: number;
  
  // IG score analysis
  relevantIGScores: number[];
  noiseIGScores: number[];
  avgRelevantIG: number;
  avgNoiseIG: number;
  
  // Filtering accuracy
  relevantKeptCount: number;      // Relevant chunks with IG >= 0
  noiseFilteredCount: number;     // Noise chunks with IG < 0
  relevantKeptRatio: number;      // relevantKeptCount / relevantChunks
  noiseFilteredRatio: number;     // noiseFilteredCount / noiseChunks
  
  // Overall score (higher = better)
  filteringAccuracy: number;      // (relevantKept + noiseFiltered) / total
  
  // Timing
  igpDurationMs: number;
}

interface NoiseTestSummary {
  testDate: string;
  totalTests: number;
  avgRelevantIG: number;
  avgNoiseIG: number;
  avgRelevantKeptRatio: number;
  avgNoiseFilteredRatio: number;
  avgFilteringAccuracy: number;
  conclusion: string;
}

// ============================================================================
// Test Logic
// ============================================================================

/**
 * Retrieve chunks from a specific bundle using L3 (chunk) collection.
 */
async function retrieveFromBundle(
  chromaDB: ChromaVectorDB,
  embedding: { embed: (text: string) => Promise<{ vector: number[] }> },
  bundleId: string,
  query: string,
  topK: number
): Promise<ChunkWithScore[]> {
  try {
    const queryResult = await embedding.embed(query);
    const queryEmbedding = queryResult.vector;
    
    // Query L3 chunk collection with bundle filter
    const results = await chromaDB.queryHierarchical(
      'l3_chunk',
      queryEmbedding,
      topK,
      { bundleId }
    );
    
    return results.chunks.map(chunk => ({
      id: chunk.id,
      content: chunk.content,
      metadata: chunk.metadata,
      score: chunk.score,
    }));
  } catch (err) {
    console.warn(`  Warning: Could not retrieve from bundle ${bundleId}: ${err}`);
    return [];
  }
}

/**
 * Get noise chunks from unrelated bundles.
 */
async function getNoiseChunks(
  chromaDB: ChromaVectorDB,
  embedding: { embed: (text: string) => Promise<{ vector: number[] }> },
  bundles: string[],
  excludeBundleId: string,
  noiseQuery: string,
  topKPerBundle: number
): Promise<ChunkWithScore[]> {
  const noiseChunks: ChunkWithScore[] = [];
  
  for (const bundleId of bundles) {
    if (bundleId === excludeBundleId) continue;
    
    const chunks = await retrieveFromBundle(
      chromaDB,
      embedding,
      bundleId,
      noiseQuery,
      topKPerBundle
    );
    noiseChunks.push(...chunks);
  }
  
  return noiseChunks;
}

/**
 * Run noise injection test for a single question.
 */
async function runNoiseTest(
  chromaDB: ChromaVectorDB,
  embedding: { embed: (text: string) => Promise<{ vector: number[] }> },
  pruner: IGPPruner,
  question: TestQuestion,
  allBundles: string[],
  noiseQuery: string
): Promise<NoiseTestResult | null> {
  console.log(`\n📝 Testing ${question.id}: ${question.question.slice(0, 60)}...`);
  
  const bundleId = question.bundleId || question.bundleIds?.[0];
  if (!bundleId) {
    console.log(`  ✗ Skipped: No bundleId`);
    return null;
  }
  
  // Step 1: Retrieve relevant chunks (from correct bundle)
  console.log(`  → Retrieving relevant chunks from bundle...`);
  const relevantChunks = await retrieveFromBundle(
    chromaDB,
    embedding,
    bundleId,
    question.question,
    10 // Top 10 relevant chunks
  );
  
  if (relevantChunks.length === 0) {
    console.log(`  ✗ Skipped: No relevant chunks found`);
    return null;
  }
  
  // Step 2: Get noise chunks from OTHER bundles using unrelated query
  console.log(`  → Retrieving noise chunks from other bundles...`);
  const noiseChunks = await getNoiseChunks(
    chromaDB,
    embedding,
    allBundles,
    bundleId,
    noiseQuery,
    10 // 10 noise chunks per other bundle
  );
  
  if (noiseChunks.length === 0) {
    console.log(`  ✗ Skipped: No noise chunks found`);
    return null;
  }
  
  // Mark chunks for tracking
  const relevantSet = new Set(relevantChunks.map(c => c.id));
  
  // Step 3: Mix relevant and noise chunks (shuffle)
  const mixedChunks = [...relevantChunks, ...noiseChunks]
    .sort(() => Math.random() - 0.5);
  
  console.log(`  → Mixed: ${relevantChunks.length} relevant + ${noiseChunks.length} noise = ${mixedChunks.length} total`);
  
  // Step 4: Apply IGP
  console.log(`  → Running IGP (threshold=0)...`);
  const igpOptions: IGPOptions = {
    enabled: true,
    strategy: 'threshold',
    threshold: 0, // Filter negative-utility (IG < 0)
    nuOptions: { topK: 5, maxTokens: 20 },
    batchSize: 5,
  };
  
  const igpResult = await pruner.prune(question.question, mixedChunks, igpOptions);
  
  // Step 5: Analyze results
  // We need IG scores for ALL chunks, not just the pruned ones
  // So we run ranking without pruning first
  const allRankedChunks = igpResult.chunks.length === mixedChunks.length
    ? igpResult.chunks
    : await runRankingOnly(pruner, question.question, mixedChunks, igpOptions);
  
  // Separate IG scores by chunk type
  const relevantIGScores: number[] = [];
  const noiseIGScores: number[] = [];
  
  for (const chunk of allRankedChunks) {
    if (relevantSet.has(chunk.id)) {
      relevantIGScores.push(chunk.igScore);
    } else {
      noiseIGScores.push(chunk.igScore);
    }
  }
  
  const avgRelevantIG = relevantIGScores.length > 0
    ? relevantIGScores.reduce((a, b) => a + b, 0) / relevantIGScores.length
    : 0;
  const avgNoiseIG = noiseIGScores.length > 0
    ? noiseIGScores.reduce((a, b) => a + b, 0) / noiseIGScores.length
    : 0;
  
  // Filtering accuracy
  const relevantKeptCount = relevantIGScores.filter(ig => ig >= 0).length;
  const noiseFilteredCount = noiseIGScores.filter(ig => ig < 0).length;
  
  const relevantKeptRatio = relevantIGScores.length > 0
    ? relevantKeptCount / relevantIGScores.length
    : 0;
  const noiseFilteredRatio = noiseIGScores.length > 0
    ? noiseFilteredCount / noiseIGScores.length
    : 0;
  
  const filteringAccuracy = (relevantKeptCount + noiseFilteredCount) / 
    (relevantIGScores.length + noiseIGScores.length);
  
  // Log results
  console.log(`  ✓ IG scores: relevant avg=${avgRelevantIG.toFixed(4)}, noise avg=${avgNoiseIG.toFixed(4)}`);
  console.log(`  ✓ Filtering: ${(relevantKeptRatio * 100).toFixed(1)}% relevant kept, ${(noiseFilteredRatio * 100).toFixed(1)}% noise filtered`);
  console.log(`  ✓ Accuracy: ${(filteringAccuracy * 100).toFixed(1)}%`);
  
  return {
    questionId: question.id,
    question: question.question,
    relevantChunks: relevantChunks.length,
    noiseChunks: noiseChunks.length,
    totalChunks: mixedChunks.length,
    relevantIGScores,
    noiseIGScores,
    avgRelevantIG,
    avgNoiseIG,
    relevantKeptCount,
    noiseFilteredCount,
    relevantKeptRatio,
    noiseFilteredRatio,
    filteringAccuracy,
    igpDurationMs: igpResult.durationMs,
  };
}

/**
 * Run IG ranking without pruning to get all scores.
 */
async function runRankingOnly(
  pruner: IGPPruner,
  query: string,
  chunks: ChunkWithScore[],
  options: IGPOptions
): Promise<RankedChunk[]> {
  // Use ratio=1.0 to keep all chunks but still compute IG scores
  const result = await pruner.prune(query, chunks, {
    ...options,
    strategy: 'ratio',
    keepRatio: 1.0, // Keep all, but score them
  });
  return result.chunks;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('=== Phase 2.5: IGP Noise Injection Test ===\n');
  
  // Load test dataset
  const datasetPath = path.join(__dirname, '../tests/fixtures/pdf-rag-test-dataset.json');
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));
  
  // Initialize components
  const config = getConfig();
  const { embedding } = createEmbeddingFromConfig(config);
  const chromaUrl = config.chromaUrl || 'http://localhost:8000';
  const chromaDB = new ChromaVectorDB({ url: chromaUrl });
  const pruner = new IGPPruner();
  
  // Check ChromaDB availability
  const available = await chromaDB.isAvailable();
  if (!available) {
    console.error(`❌ ChromaDB not available at ${chromaUrl}`);
    process.exit(1);
  }
  
  console.log(`ChromaDB: ${chromaUrl}`);
  console.log(`Embedding: ${config.embeddingModel || 'default'}`);
  
  // Get ALL indexed bundle IDs from ChromaDB (not just from test dataset)
  const indexedContent = await chromaDB.listHierarchicalContent();
  const allBundles: string[] = indexedContent
    .map(p => p.bundleId)
    .filter((id): id is string => !!id);
  
  // Deduplicate
  const uniqueBundles = [...new Set(allBundles)];
  console.log(`Total indexed bundles: ${uniqueBundles.length}`);
  console.log(`Test dataset bundles: ${dataset.bundles.length}\n`);
  
  // Use single-pdf questions (they have clear bundleId)
  const testQuestions: TestQuestion[] = dataset.questions.filter(
    (q: any) => q.category === 'single-pdf' && q.bundleId
  );
  
  console.log(`Testing ${testQuestions.length} single-PDF questions\n`);
  
  // Noise query - completely unrelated to the test papers
  // Using a generic technical query that would match something in any CS paper
  const noiseQueries = [
    'implementation details and evaluation results',
    'related work and comparison with baselines',
    'experimental setup and metrics',
  ];
  
  // Run tests
  const results: NoiseTestResult[] = [];
  
  for (let i = 0; i < testQuestions.length; i++) {
    const question = testQuestions[i]!;
    const noiseQuery = noiseQueries[i % noiseQueries.length]!;
    
    try {
      const result = await runNoiseTest(
        chromaDB,
        embedding,
        pruner,
        question,
        uniqueBundles,
        noiseQuery
      );
      
      if (result) {
        results.push(result);
      }
    } catch (err) {
      console.error(`  ✗ Error: ${err}`);
    }
  }
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('=== Summary ===\n');
  
  if (results.length === 0) {
    console.log('No valid results to analyze.');
    return;
  }
  
  const avgRelevantIG = results.reduce((s, r) => s + r.avgRelevantIG, 0) / results.length;
  const avgNoiseIG = results.reduce((s, r) => s + r.avgNoiseIG, 0) / results.length;
  const avgRelevantKeptRatio = results.reduce((s, r) => s + r.relevantKeptRatio, 0) / results.length;
  const avgNoiseFilteredRatio = results.reduce((s, r) => s + r.noiseFilteredRatio, 0) / results.length;
  const avgFilteringAccuracy = results.reduce((s, r) => s + r.filteringAccuracy, 0) / results.length;
  
  console.log(`Tests completed: ${results.length}`);
  console.log(`\nIG Score Distribution:`);
  console.log(`  Relevant chunks avg IG: ${avgRelevantIG.toFixed(4)}`);
  console.log(`  Noise chunks avg IG:    ${avgNoiseIG.toFixed(4)}`);
  console.log(`  IG difference:          ${(avgRelevantIG - avgNoiseIG).toFixed(4)}`);
  
  console.log(`\nFiltering Performance (threshold=0):`);
  console.log(`  Relevant kept ratio:    ${(avgRelevantKeptRatio * 100).toFixed(1)}%`);
  console.log(`  Noise filtered ratio:   ${(avgNoiseFilteredRatio * 100).toFixed(1)}%`);
  console.log(`  Overall accuracy:       ${(avgFilteringAccuracy * 100).toFixed(1)}%`);
  
  // Conclusion
  let conclusion: string;
  if (avgRelevantIG > avgNoiseIG && avgFilteringAccuracy >= 0.7) {
    conclusion = '✅ IGP EFFECTIVE: Successfully distinguishes relevant from noise chunks';
  } else if (avgRelevantIG > avgNoiseIG) {
    conclusion = '⚠️ IGP PARTIAL: IG scores differentiate, but filtering accuracy < 70%';
  } else {
    conclusion = '❌ IGP INEFFECTIVE: Cannot distinguish relevant from noise chunks';
  }
  
  console.log(`\n🎯 Conclusion: ${conclusion}`);
  
  // Detailed analysis
  console.log(`\n📊 Per-question breakdown:`);
  console.log(`${'ID'.padEnd(6)} ${'Rel'.padStart(4)} ${'Noise'.padStart(5)} ${'RelIG'.padStart(8)} ${'NoiseIG'.padStart(8)} ${'Kept%'.padStart(6)} ${'Filt%'.padStart(6)} ${'Acc%'.padStart(6)}`);
  console.log('-'.repeat(60));
  for (const r of results) {
    console.log(
      `${r.questionId.padEnd(6)} ` +
      `${r.relevantChunks.toString().padStart(4)} ` +
      `${r.noiseChunks.toString().padStart(5)} ` +
      `${r.avgRelevantIG.toFixed(3).padStart(8)} ` +
      `${r.avgNoiseIG.toFixed(3).padStart(8)} ` +
      `${(r.relevantKeptRatio * 100).toFixed(0).padStart(5)}% ` +
      `${(r.noiseFilteredRatio * 100).toFixed(0).padStart(5)}% ` +
      `${(r.filteringAccuracy * 100).toFixed(0).padStart(5)}%`
    );
  }
  
  // Save detailed results
  const summary: NoiseTestSummary = {
    testDate: new Date().toISOString(),
    totalTests: results.length,
    avgRelevantIG,
    avgNoiseIG,
    avgRelevantKeptRatio,
    avgNoiseFilteredRatio,
    avgFilteringAccuracy,
    conclusion,
  };
  
  const report = {
    summary,
    results,
  };
  
  const outputPath = path.join(__dirname, '../tests/benchmarks/igp-noise-test-results.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\n📊 Results saved to: ${outputPath}`);
}

main().catch(console.error);
