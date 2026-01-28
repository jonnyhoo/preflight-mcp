#!/usr/bin/env tsx
/**
 * IGP Diagnostic Script
 * 
 * Analyzes NU values to understand IGP behavior:
 * - Baseline NU (uncertainty without context)
 * - NU with relevant context
 * - NU with noise context
 * 
 * Also includes per-token entropy analysis to understand model behavior.
 * 
 * Usage: npx tsx scripts/diagnose-igp.ts
 */

import { NUCalculator } from '../src/rag/pruning/nu-calculator.js';
import { callLLM, getVerifierLLMConfig, type TokenLogprob } from '../src/distill/llm-client.js';

/**
 * Compute per-token entropy for visualization.
 */
function computeTokenEntropy(tokenData: TokenLogprob, topK: number): number {
  const logprobs: number[] = [tokenData.logprob];
  if (tokenData.topAlternatives) {
    const altLogprobs = tokenData.topAlternatives
      .filter(alt => alt.token !== tokenData.token)
      .map(alt => alt.logprob);
    logprobs.push(...altLogprobs);
  }
  if (logprobs.length < 2) return Math.log(topK);
  
  const expLogprobs = logprobs.map(lp => Math.exp(lp));
  const sumExp = expLogprobs.reduce((sum, e) => sum + e, 0);
  const probs = expLogprobs.map(e => e / sumExp);
  
  let entropy = 0;
  for (const p of probs) {
    if (p > 0) entropy -= p * Math.log(p);
  }
  return entropy;
}

async function analyzeTokenEntropies(prompt: string, label: string): Promise<void> {
  const llmConfig = getVerifierLLMConfig();
  const response = await callLLM(prompt, undefined, llmConfig, {
    logprobs: true,
    topLogprobs: 5,
    maxTokens: 30,
    temperature: 0,
  });
  
  if (!response.logprobs) {
    console.log(`  No logprobs for ${label}`);
    return;
  }
  
  console.log(`\n${label} - Token Entropy Breakdown:`);
  console.log(`${'Token'.padEnd(25)} ${'Entropy'.padStart(8)} ${'LogProb'.padStart(10)}`);
  console.log('-'.repeat(50));
  
  const logK = Math.log(5);
  let totalEntropy = 0;
  
  for (const token of response.logprobs.slice(0, 15)) {
    const entropy = computeTokenEntropy(token, 5);
    const nu = entropy / logK;
    totalEntropy += entropy;
    const displayToken = token.token.replace(/\n/g, '\\n').slice(0, 22);
    console.log(
      `${displayToken.padEnd(25)} ${nu.toFixed(4).padStart(8)} ${token.logprob.toFixed(4).padStart(10)}`
    );
  }
  
  const avgNU = (totalEntropy / response.logprobs.length) / logK;
  console.log('-'.repeat(50));
  console.log(`Average NU: ${avgNU.toFixed(4)} (${response.logprobs.length} tokens)`);
  console.log(`Generated: ${response.content?.slice(0, 60)}...`);
}

async function main() {
  console.log('=== IGP Diagnostic Test (Extended) ===\n');
  
  const calculator = new NUCalculator();
  
  // Test query - English for cleaner token analysis
  const query = 'What is the F1 improvement percentage of SimpleMem over Mem0 on LoCoMo?';
  
  // Simpler prompt format to avoid "analysis" prefix
  const queryOnlyPrompt = `${query}\nAnswer in one sentence:`;
  
  // Relevant context (from SimpleMem paper)
  const relevantContext = `SimpleMem achieves state-of-the-art performance on the LoCoMo benchmark, achieving an average F1 improvement of 26.4% compared to Mem0.`;
  const relevantPrompt = `Context: ${relevantContext}\n\n${query}\nAnswer in one sentence:`;
  
  // Noise context (completely irrelevant)
  const noiseContext = `The weather in Tokyo is expected to be sunny with temperatures around 25 degrees Celsius.`;
  const noisePrompt = `Context: ${noiseContext}\n\n${query}\nAnswer in one sentence:`;
  
  console.log(`Query: ${query}\n`);
  
  // Detailed token-level analysis
  console.log('=== Token-Level Analysis ===');
  
  try {
    await analyzeTokenEntropies(queryOnlyPrompt, '1. NO CONTEXT');
    await analyzeTokenEntropies(relevantPrompt, '2. RELEVANT CONTEXT');
    await analyzeTokenEntropies(noisePrompt, '3. NOISE CONTEXT');
    
    // Summary comparison
    console.log('\n\n=== NU Summary ===\n');
    const nuOptions = { topK: 5, maxTokens: 30 };
    
    const baseline = await calculator.computeNU(queryOnlyPrompt, nuOptions);
    const relevant = await calculator.computeNU(relevantPrompt, nuOptions);
    const noise = await calculator.computeNU(noisePrompt, nuOptions);
    
    console.log(`Baseline NU:         ${baseline.nu.toFixed(4)}`);
    console.log(`Relevant context NU: ${relevant.nu.toFixed(4)}`);
    console.log(`Noise context NU:    ${noise.nu.toFixed(4)}`);
    console.log();
    console.log(`Relevant IG: ${(baseline.nu - relevant.nu).toFixed(4)} (expect positive)`);
    console.log(`Noise IG:    ${(baseline.nu - noise.nu).toFixed(4)} (expect negative)`);
    
    const relevantIG = baseline.nu - relevant.nu;
    const noiseIG = baseline.nu - noise.nu;
    
    console.log();
    if (relevantIG > noiseIG && relevantIG > 0) {
      console.log('✅ IGP works: relevant context reduces uncertainty more than noise');
    } else if (relevantIG > noiseIG) {
      console.log('⚠️ IGP partial: relative ordering correct, but absolute values unexpected');
    } else {
      console.log('❌ IGP fails: noise has higher/equal IG than relevant context');
    }
    
  } catch (err) {
    console.error('Error:', err);
  }
}

main().catch(console.error);
