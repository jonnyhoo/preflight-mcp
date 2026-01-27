/**
 * Test script to verify LLM logprobs support.
 * 
 * Usage: npx tsx scripts/test-logprobs.ts
 * 
 * Tests:
 * 1. OpenAI-compatible API (configured in config.json)
 * 2. NVIDIA NIM API (verifier LLM)
 * 3. Ollama (if available locally)
 */

import { getConfig } from '../src/config.js';

interface LogprobToken {
  token: string;
  logprob: number;
  bytes?: number[] | null;
}

interface LogprobContent {
  token: string;
  logprob: number;
  bytes?: number[] | null;
  top_logprobs?: LogprobToken[];
}

interface LogprobsResult {
  content: LogprobContent[];
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    logprobs: LogprobsResult | null;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface TestResult {
  provider: string;
  model: string;
  apiBase: string;
  supportsLogprobs: boolean;
  supportsTopLogprobs: boolean;
  topK?: number;
  sampleLogprobs?: Array<{ token: string; logprob: number }>;
  error?: string;
  rawResponse?: unknown;
}

async function testLogprobs(
  apiBase: string,
  apiKey: string,
  model: string,
  providerName: string
): Promise<TestResult> {
  const url = `${apiBase.replace(/\/$/, '')}/chat/completions`;
  
  console.log(`\nTesting ${providerName}:`);
  console.log(`  API: ${apiBase}`);
  console.log(`  Model: ${model}`);
  
  try {
    // Test with logprobs enabled and top_logprobs=5
    const requestBody = {
      model,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is 2+2? Answer in one word.' }
      ],
      max_tokens: 10,
      temperature: 0,
      logprobs: true,
      top_logprobs: 5, // Request top-5 alternative tokens
    };

    console.log(`  Request body: ${JSON.stringify(requestBody, null, 2).slice(0, 200)}...`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    const responseText = await response.text();
    
    if (!response.ok) {
      console.log(`  HTTP Error: ${response.status}`);
      console.log(`  Response: ${responseText.slice(0, 500)}`);
      
      // Check if error is specifically about logprobs not being supported
      const isLogprobsUnsupported = 
        responseText.includes('logprobs') ||
        responseText.includes('not supported') ||
        responseText.includes('invalid parameter');
        
      return {
        provider: providerName,
        model,
        apiBase,
        supportsLogprobs: false,
        supportsTopLogprobs: false,
        error: `HTTP ${response.status}: ${responseText.slice(0, 200)}`,
      };
    }

    const data = JSON.parse(responseText) as ChatCompletionResponse;
    console.log(`  Response received successfully`);
    
    const choice = data.choices?.[0];
    const logprobs = choice?.logprobs;

    if (!logprobs || !logprobs.content || logprobs.content.length === 0) {
      console.log(`  ⚠️ No logprobs in response`);
      console.log(`  Choice logprobs field: ${JSON.stringify(choice?.logprobs)}`);
      return {
        provider: providerName,
        model,
        apiBase,
        supportsLogprobs: false,
        supportsTopLogprobs: false,
        error: 'No logprobs in response (field is null or empty)',
        rawResponse: data,
      };
    }

    // Extract sample logprobs
    const sampleLogprobs = logprobs.content.slice(0, 5).map(item => ({
      token: item.token,
      logprob: item.logprob,
    }));

    // Check if top_logprobs are available
    const hasTopLogprobs = logprobs.content.some(
      item => item.top_logprobs && item.top_logprobs.length > 0
    );
    
    const topK = hasTopLogprobs 
      ? Math.max(...logprobs.content.map(item => item.top_logprobs?.length ?? 0))
      : 0;

    console.log(`  ✅ Logprobs supported!`);
    console.log(`  ✅ Top-K logprobs: ${hasTopLogprobs ? `Yes (K=${topK})` : 'No'}`);
    console.log(`  Sample tokens:`, sampleLogprobs.slice(0, 3));

    if (hasTopLogprobs && logprobs.content[0]?.top_logprobs) {
      console.log(`  Top-5 alternatives for first token:`, 
        logprobs.content[0].top_logprobs.map(t => `${t.token}(${t.logprob.toFixed(3)})`).join(', ')
      );
    }

    return {
      provider: providerName,
      model,
      apiBase,
      supportsLogprobs: true,
      supportsTopLogprobs: hasTopLogprobs,
      topK,
      sampleLogprobs,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log(`  ❌ Error: ${errMsg}`);
    return {
      provider: providerName,
      model,
      apiBase,
      supportsLogprobs: false,
      supportsTopLogprobs: false,
      error: errMsg,
    };
  }
}

async function testOllamaLogprobs(): Promise<TestResult> {
  const ollamaHost = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  const model = process.env.OLLAMA_MODEL ?? 'llama3.2';
  
  console.log(`\nTesting Ollama:`);
  console.log(`  Host: ${ollamaHost}`);
  console.log(`  Model: ${model}`);
  
  try {
    // First check if Ollama is available
    const healthCheck = await fetch(`${ollamaHost}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    }).catch(() => null);
    
    if (!healthCheck || !healthCheck.ok) {
      console.log(`  ⚠️ Ollama not available at ${ollamaHost}`);
      return {
        provider: 'Ollama',
        model,
        apiBase: ollamaHost,
        supportsLogprobs: false,
        supportsTopLogprobs: false,
        error: 'Ollama server not available',
      };
    }

    // Ollama uses different endpoint for chat completions
    // Note: Ollama's OpenAI-compatible endpoint may not support logprobs
    // Try the native /api/generate endpoint which has better logprobs support
    const response = await fetch(`${ollamaHost}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: 'What is 2+2? Answer in one word.',
        stream: false,
        options: {
          num_predict: 10,
          temperature: 0,
        },
        // Ollama's native API doesn't have logprobs parameter
        // It returns raw logits only in specific modes
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.log(`  HTTP Error: ${response.status}`);
      return {
        provider: 'Ollama',
        model,
        apiBase: ollamaHost,
        supportsLogprobs: false,
        supportsTopLogprobs: false,
        error: `HTTP ${response.status}: ${text.slice(0, 200)}`,
      };
    }

    const data = await response.json();
    console.log(`  Response: ${JSON.stringify(data).slice(0, 300)}...`);
    
    // Ollama native API doesn't return logprobs by default
    // As of 2024, Ollama's OpenAI-compatible /v1/chat/completions does NOT support logprobs
    console.log(`  ⚠️ Ollama native API does not return logprobs`);
    console.log(`  Note: Ollama's OpenAI-compatible endpoint also lacks logprobs support`);
    
    return {
      provider: 'Ollama',
      model,
      apiBase: ollamaHost,
      supportsLogprobs: false,
      supportsTopLogprobs: false,
      error: 'Ollama does not support logprobs in API responses',
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log(`  ❌ Error: ${errMsg}`);
    return {
      provider: 'Ollama',
      model,
      apiBase: 'http://localhost:11434',
      supportsLogprobs: false,
      supportsTopLogprobs: false,
      error: errMsg,
    };
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('LLM Logprobs Support Test');
  console.log('='.repeat(60));

  const config = getConfig();
  const results: TestResult[] = [];

  // Test 1: Main LLM (LongCat)
  if (config.llmApiBase && config.llmApiKey) {
    const result = await testLogprobs(
      config.llmApiBase,
      config.llmApiKey,
      config.llmModel,
      'Main LLM (LongCat)'
    );
    results.push(result);
  }

  // Test 2: Verifier LLM (NVIDIA NIM)
  if (config.verifierLlmApiBase && config.verifierLlmApiKey && config.verifierLlmModel) {
    const result = await testLogprobs(
      config.verifierLlmApiBase,
      config.verifierLlmApiKey,
      config.verifierLlmModel,
      'Verifier LLM (NVIDIA NIM)'
    );
    results.push(result);
  }

  // Test 3: Ollama (local)
  const ollamaResult = await testOllamaLogprobs();
  results.push(ollamaResult);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  const supportsLogprobs = results.filter(r => r.supportsLogprobs);
  const supportsTopK = results.filter(r => r.supportsTopLogprobs);

  console.log(`\nProviders tested: ${results.length}`);
  console.log(`Logprobs supported: ${supportsLogprobs.length}`);
  console.log(`Top-K logprobs supported: ${supportsTopK.length}`);

  console.log('\nDetailed Results:');
  for (const result of results) {
    console.log(`\n  ${result.provider}:`);
    console.log(`    Model: ${result.model}`);
    console.log(`    Logprobs: ${result.supportsLogprobs ? '✅ Yes' : '❌ No'}`);
    console.log(`    Top-K: ${result.supportsTopLogprobs ? `✅ Yes (K=${result.topK})` : '❌ No'}`);
    if (result.error) {
      console.log(`    Error: ${result.error.slice(0, 100)}`);
    }
  }

  // Recommendation
  console.log('\n' + '='.repeat(60));
  console.log('RECOMMENDATION');
  console.log('='.repeat(60));

  if (supportsTopK.length > 0) {
    console.log('\n✅ IGP can use logprobs-based scoring with:');
    for (const r of supportsTopK) {
      console.log(`   - ${r.provider} (${r.model}, top-${r.topK})`);
    }
  } else if (supportsLogprobs.length > 0) {
    console.log('\n⚠️ IGP can use basic logprobs (without top-K alternatives) with:');
    for (const r of supportsLogprobs) {
      console.log(`   - ${r.provider} (${r.model})`);
    }
    console.log('\nNote: Full IGP requires top-K logprobs for entropy calculation.');
    console.log('Fallback to embedding similarity recommended.');
  } else {
    console.log('\n❌ No LLM provider supports logprobs.');
    console.log('IGP will use embedding similarity fallback for relevance scoring.');
  }

  // Return results for programmatic use
  return results;
}

main().catch(console.error);
