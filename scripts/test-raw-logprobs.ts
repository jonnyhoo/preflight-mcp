/**
 * Debug raw LLM API response to understand logprobs format.
 */

import { getVerifierLLMConfig } from '../src/distill/llm-client.js';

async function main() {
  const config = getVerifierLLMConfig();
  console.log('Config:', {
    apiBase: config.apiBase,
    model: config.model,
  });

  const url = `${config.apiBase.replace(/\/$/, '')}/chat/completions`;
  
  const requestBody = {
    model: config.model,
    messages: [
      { role: 'user', content: 'What is 1+1? Answer in one word: ' }
    ],
    max_tokens: 5,
    temperature: 0,
    logprobs: true,
    top_logprobs: 5,
  };

  console.log('\nRequest:', JSON.stringify(requestBody, null, 2));

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  const data = await response.json();
  console.log('\nRaw Response:');
  console.log(JSON.stringify(data, null, 2));
}

main().catch(console.error);
