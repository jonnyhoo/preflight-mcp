import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockCallLLM = jest.fn();
const mockGetVerifierLLMConfig = jest.fn(() => ({
  apiBase: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'test-model',
  enabled: true,
}));

jest.unstable_mockModule('../../src/distill/llm-client.js', () => ({
  callLLM: mockCallLLM,
  getVerifierLLMConfig: mockGetVerifierLLMConfig,
}));

const { NUCalculator } = await import('../../src/rag/pruning/nu-calculator.js');

describe('NUCalculator (local)', () => {
  beforeEach(() => {
    mockCallLLM.mockReset();
    mockGetVerifierLLMConfig.mockClear();
  });

  it('computes normalized uncertainty from mocked logprobs', async () => {
    mockCallLLM.mockResolvedValue({
      content: '42',
      model: 'test-model',
      logprobs: [
        {
          token: '4',
          logprob: Math.log(0.8),
          topAlternatives: [{ token: '5', logprob: Math.log(0.2) }],
        },
        {
          token: '2',
          logprob: Math.log(0.8),
          topAlternatives: [{ token: '3', logprob: Math.log(0.2) }],
        },
      ],
    });

    const result = await new NUCalculator().computeNU('What is 40 + 2?', {
      topK: 2,
      maxTokens: 2,
    });

    expect(result.tokenCount).toBe(2);
    expect(result.generatedText).toBe('42');
    expect(result.nu).toBeCloseTo(0.72, 2);
    expect(result.avgEntropy).toBeCloseTo(0.5, 1);
  });

  it('ignores special control tokens when scoring entropy', async () => {
    mockCallLLM.mockResolvedValue({
      content: '',
      model: 'test-model',
      logprobs: [
        {
          token: '<|channel|>',
          logprob: 0,
          topAlternatives: [],
        },
        {
          token: 'answer',
          logprob: Math.log(0.9),
          topAlternatives: [{ token: 'guess', logprob: Math.log(0.1) }],
        },
      ],
    });

    const result = await new NUCalculator().computeNU('Answer briefly', {
      topK: 2,
      maxTokens: 2,
    });

    expect(result.tokenCount).toBe(1);
    expect(result.generatedText).toBe('answer');
  });

  it('falls back to heuristic NU for transient rate-limit errors', async () => {
    mockCallLLM.mockRejectedValue(new Error('LLM API error: 429'));

    const result = await new NUCalculator().computeNU('Pick a random number', {
      topK: 5,
      maxTokens: 4,
    });

    expect(result.generatedText).toBe('[heuristic-fallback]');
    expect(result.tokenCount).toBeGreaterThan(0);
    expect(result.nu).toBeGreaterThanOrEqual(0);
    expect(result.nu).toBeLessThanOrEqual(1);
  });

  it('still throws on non-transient failures', async () => {
    mockCallLLM.mockRejectedValue(new Error('LLM response does not contain logprobs'));

    await expect(
      new NUCalculator().computeNU('test', { topK: 5, maxTokens: 2 })
    ).rejects.toThrow('logprobs');
  });
});
