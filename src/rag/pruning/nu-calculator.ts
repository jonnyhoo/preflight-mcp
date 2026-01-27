/**
 * NU Calculator - Normalized Uncertainty computation for IGP pruning.
 * 
 * Based on "Less is More" paper (arXiv:2410.XXXXX):
 * NU(q; φ, K) = (1 / (T log K)) Σ_t H_t(q; φ, K)
 * 
 * where:
 * - H_t = -Σ_k p_k log(p_k)  # Entropy of top-K tokens at step t
 * - p_k = softmax of top-K logprobs
 * - T = number of generated tokens (maxTokens)
 * - K = size of top-K (topK)
 * 
 * @module rag/pruning/nu-calculator
 */

import { callLLM, getVerifierLLMConfig, type TokenLogprob } from '../../distill/llm-client.js';
import { createModuleLogger } from '../../logging/logger.js';

const logger = createModuleLogger('nu-calculator');

// ============================================================================
// Types
// ============================================================================

/**
 * Options for NU computation.
 */
export interface NUOptions {
  /** Size of top-K alternatives (default: 5) */
  topK?: number;
  /** Max tokens to generate for NU computation (default: 50) */
  maxTokens?: number;
  /** Temperature for generation (default: 0 for greedy) */
  temperature?: number;
}

/**
 * Result of NU computation with detailed statistics.
 */
export interface NUResult {
  /** Normalized uncertainty value (0-1, lower = more certain) */
  nu: number;
  /** Number of tokens generated */
  tokenCount: number;
  /** Average entropy per token */
  avgEntropy: number;
  /** Per-token entropies (for debugging) */
  tokenEntropies?: number[];
  /** Generated text (for verification) */
  generatedText: string;
}

// ============================================================================
// NUCalculator Class
// ============================================================================

/**
 * Normalized Uncertainty Calculator.
 * 
 * Computes NU using LLM logprobs for Information Gain Pruning (IGP).
 */
export class NUCalculator {
  /**
   * Compute normalized uncertainty for a prompt.
   * 
   * @param prompt - The prompt to compute NU for
   * @param options - NU computation options
   * @returns NU result with value and statistics
   * 
   * @example
   * ```typescript
   * const calculator = new NUCalculator();
   * 
   * // Deterministic prompt (low NU)
   * const certain = await calculator.computeNU("What is 1+1? Answer: ", { maxTokens: 5 });
   * console.log(certain.nu); // ~0.0
   * 
   * // Uncertain prompt (high NU)
   * const uncertain = await calculator.computeNU("Guess a random number: ", { maxTokens: 10 });
   * console.log(uncertain.nu); // > 0.5
   * ```
   */
  async computeNU(prompt: string, options?: NUOptions): Promise<NUResult> {
    const topK = options?.topK ?? 5;
    const maxTokens = options?.maxTokens ?? 50;
    const temperature = options?.temperature ?? 0; // Greedy for IGP

    logger.debug(`Computing NU: K=${topK}, MT=${maxTokens}, prompt="${prompt.slice(0, 50)}..."`);

    // Get verifier LLM config (NVIDIA NIM supports logprobs)
    const llmConfig = getVerifierLLMConfig();

    try {
      // Call LLM with logprobs enabled
      const response = await callLLM(
        prompt,
        undefined, // No system prompt needed for NU computation
        llmConfig,
        {
          logprobs: true,
          topLogprobs: topK,
          maxTokens,
          temperature,
        }
      );

      if (!response.logprobs || response.logprobs.length === 0) {
        throw new Error('LLM response does not contain logprobs (provider may not support it)');
      }

      // Filter out special tokens (like <|channel|>, <|message|>) which have 0 entropy
      // These are control tokens used by some models (e.g., NVIDIA NIM)
      const contentTokens = response.logprobs.filter(token => {
        // Keep tokens that are not special control tokens
        // Special tokens typically have logprob = 0 and token names with <| |> format
        const isSpecialToken = token.token.startsWith('<|') && token.token.endsWith('|>');
        return !isSpecialToken;
      });

      if (contentTokens.length === 0) {
        logger.warn('All tokens filtered out as special tokens, using all tokens');
        // Fallback: use all tokens if filtering removed everything
      }

      const tokensToScore = contentTokens.length > 0 ? contentTokens : response.logprobs;

      // Compute entropy for each token
      const tokenEntropies = tokensToScore.map((tokenData) => 
        this.computeTokenEntropy(tokenData, topK)
      );

      const tokenCount = tokenEntropies.length;
      const avgEntropy = tokenEntropies.reduce((sum, h) => sum + h, 0) / tokenCount;

      // Normalized Uncertainty: NU = (1 / (T * log(K))) * Σ H_t
      // Note: Math.log is natural log (ln), which is what we need
      const logK = Math.log(topK);
      const nu = avgEntropy / logK; // avgEntropy already divided by T

      // Reconstruct text from tokens (handle null content)
      const generatedText = response.content || tokensToScore.map(t => t.token).join('');

      logger.debug(`NU computed: ${nu.toFixed(4)} (tokens=${tokenCount}, avgH=${avgEntropy.toFixed(4)})`);

      return {
        nu,
        tokenCount,
        avgEntropy,
        tokenEntropies,
        generatedText,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`NU computation failed: ${errMsg}`);
      throw new Error(`NU computation failed: ${errMsg}`);
    }
  }

  /**
   * Compute entropy H_t for a single token.
   * 
   * H_t = -Σ_k p_k log(p_k)
   * 
   * where p_k = softmax of top-K logprobs.
   * 
   * @param tokenData - Token with logprob and top alternatives
   * @param topK - Expected number of alternatives (for validation)
   * @returns Entropy value for this token
   */
  private computeTokenEntropy(tokenData: TokenLogprob, topK: number): number {
    // Collect all logprobs (selected token + alternatives)
    const logprobs: number[] = [tokenData.logprob];
    
    if (tokenData.topAlternatives) {
      // Top alternatives include the selected token, so we need to deduplicate
      const altLogprobs = tokenData.topAlternatives
        .filter(alt => alt.token !== tokenData.token) // Exclude duplicate
        .map(alt => alt.logprob);
      logprobs.push(...altLogprobs);
    }

    // Validate we have enough alternatives
    if (logprobs.length < 2) {
      logger.warn(`Token "${tokenData.token}" has no alternatives, using uniform entropy`);
      // Fallback: assume uniform distribution over K tokens
      return Math.log(topK);
    }

    // Convert log probabilities to probabilities (softmax)
    // p_k = exp(logprob_k) / Σ exp(logprob_j)
    const expLogprobs = logprobs.map(lp => Math.exp(lp));
    const sumExp = expLogprobs.reduce((sum, e) => sum + e, 0);
    const probs = expLogprobs.map(e => e / sumExp);

    // Compute entropy: H = -Σ p_k log(p_k)
    let entropy = 0;
    for (const p of probs) {
      if (p > 0) {
        entropy -= p * Math.log(p); // Natural log
      }
    }

    return entropy;
  }

  /**
   * Check if a specific LLM config supports logprobs.
   * 
   * This is a heuristic based on known API endpoints.
   * 
   * @param apiBase - LLM API base URL
   * @returns True if logprobs are likely supported
   */
  static supportsLogprobs(apiBase: string): boolean {
    const base = apiBase.toLowerCase();
    const supportedProviders = [
      'api.openai.com',
      'integrate.api.nvidia.com', // NVIDIA NIM
      'api.groq.com',
      'api.together.xyz',
      // Add vLLM deployments if detected
    ];

    return supportedProviders.some(provider => base.includes(provider));
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Compute NU for a prompt (convenience function).
 * 
 * @param prompt - Prompt to compute NU for
 * @param options - NU options
 * @returns NU result
 */
export async function computeNU(prompt: string, options?: NUOptions): Promise<NUResult> {
  const calculator = new NUCalculator();
  return calculator.computeNU(prompt, options);
}
