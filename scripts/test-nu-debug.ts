/**
 * Debug script to test NU calculator.
 */

import { NUCalculator } from '../src/rag/pruning/nu-calculator.js';
import { getVerifierLLMConfig } from '../src/distill/llm-client.js';

async function main() {
  console.log('Testing NU Calculator...\n');

  const config = getVerifierLLMConfig();
  console.log('Config:', {
    apiBase: config.apiBase,
    model: config.model,
    enabled: config.enabled,
  });

  const calculator = new NUCalculator();

  // Test 1: Deterministic prompt
  console.log('\n=== Test 1: Deterministic Prompt ===');
  try {
    const result1 = await calculator.computeNU(
      'What is 1+1? Answer in one word: ',
      { maxTokens: 5, topK: 5 }
    );
    console.log('Result:', JSON.stringify(result1, null, 2));
  } catch (err) {
    console.error('Error:', err);
  }

  // Test 2: Uncertain prompt
  console.log('\n=== Test 2: Uncertain Prompt ===');
  try {
    const result2 = await calculator.computeNU(
      'Pick a random number between 1 and 100: ',
      { maxTokens: 5, topK: 5 }
    );
    console.log('Result:', JSON.stringify(result2, null, 2));
  } catch (err) {
    console.error('Error:', err);
  }

  // Test 3: Simple completion
  console.log('\n=== Test 3: Simple Completion ===');
  try {
    const result3 = await calculator.computeNU(
      'The sky is ',
      { maxTokens: 3, topK: 5 }
    );
    console.log('Result:', JSON.stringify(result3, null, 2));
  } catch (err) {
    console.error('Error:', err);
  }
}

main().catch(console.error);
