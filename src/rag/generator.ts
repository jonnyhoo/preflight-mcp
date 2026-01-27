/**
 * RAG Generator - Generate answers from retrieved context.
 * 
 * @module rag/generator
 * 
 * ## 可选增强功能 (MiRAGE 论文)
 * 
 * 1. 答案验证 Verifier (enableVerification)
 *    - 功能: 用 LLM 验证答案是否忠实于检索内容，检测幻觉
 *    - 效果: Faithfulness 0.74 → 0.97 (论文数据)
 *    - 启用: options.enableVerification = true (默认 false)
 *    - 成本: 每次查询额外 1 次 LLM 调用
 * 
 * 2. 低置信度重试 (retryOnLowFaithfulness)
 *    - 功能: faithfulness < 0.7 时用改进的 prompt 重新生成
 *    - 启用: options.retryOnLowFaithfulness = true (默认 false)
 */

import type { ChunkDocument } from '../vectordb/types.js';
import type { 
  RetrieveResult, 
  GenerateResult, 
  SourceEvidence,
  VerificationResult,
  RAGConfig,
} from './types.js';
import { createModuleLogger } from '../logging/logger.js';

const logger = createModuleLogger('rag-generator');

// ============================================================================
// RAG Generator
// ============================================================================

export class RAGGenerator {
  private llm: RAGConfig['llm'];

  constructor(llm?: RAGConfig['llm']) {
    this.llm = llm;
  }

  /**
   * Generate answer from retrieved context.
   */
  async generate(
    query: string,
    context: RetrieveResult,
    options?: {
      enableVerification?: boolean;
      retryOnLowFaithfulness?: boolean;
    }
  ): Promise<GenerateResult> {
    const chunks = context.chunks;

    // Build sources evidence
    const sources: SourceEvidence[] = chunks.map(chunk => ({
      chunkId: chunk.id,
      content: chunk.content.slice(0, 500), // Truncate for response
      sourceType: chunk.metadata.sourceType,
      filePath: chunk.metadata.filePath,
      repoId: chunk.metadata.repoId,
      pageIndex: chunk.metadata.pageIndex, // Page number (1-indexed)
    }));

    // If no LLM configured, return a simple concatenated answer
    if (!this.llm) {
      const answer = this.buildSimpleAnswer(query, chunks);
      return {
        answer,
        sources,
        relatedEntities: context.expandedTypes,
      };
    }

    // Build prompt for LLM
    const prompt = this.buildRAGPrompt(query, chunks);

    // Generate answer
    const answer = await this.llm.complete(prompt);

    // Optional verification
    let verification: VerificationResult | undefined;
    let faithfulnessScore: number | undefined;

    if (options?.enableVerification) {
      verification = await this.verifyAnswer(query, answer, chunks);
      faithfulnessScore = verification.faithfulnessScore;

      // Retry if low faithfulness
      if (faithfulnessScore < 0.7 && options?.retryOnLowFaithfulness) {
        logger.info(`Low faithfulness (${faithfulnessScore}), retrying with refined prompt`);
        const refinedPrompt = this.buildRefinedPrompt(query, answer, verification.issues, chunks);
        const refinedAnswer = await this.llm.complete(refinedPrompt);
        return {
          answer: refinedAnswer,
          sources,
          relatedEntities: context.expandedTypes,
          faithfulnessScore,
          verification,
        };
      }
    }

    return {
      answer,
      sources,
      relatedEntities: context.expandedTypes,
      faithfulnessScore,
      verification,
    };
  }

  // --------------------------------------------------------------------------
  // Prompt Building
  // --------------------------------------------------------------------------

  /**
   * Build RAG prompt for LLM.
   * Supports papers, PDFs, documentation, and code repositories uniformly.
   * Requires citations for all factual claims.
   */
  private buildRAGPrompt(
    query: string,
    chunks: Array<ChunkDocument & { score: number }>
  ): string {
    const contextText = chunks
      .map((chunk, i) => {
        // Build comprehensive source reference
        const meta = chunk.metadata;
        const sourceType = meta.sourceType ?? 'unknown';
        const repoId = meta.repoId ?? '';
        const section = meta.sectionHeading ?? '';
        const headingPath = meta.headingPath ?? '';
        const chunkId = chunk.id;
        
        // Format: [idx][sourceType][repoId|section]
        let sourceLabel = `[${i + 1}]`;
        if (sourceType.startsWith('pdf_')) {
          // PDF content: include section info
          const sectionInfo = section || headingPath || repoId;
          sourceLabel = `[${i + 1}][${sourceType}][${sectionInfo}]`;
        } else if (repoId) {
          sourceLabel = `[${i + 1}][${sourceType}][${repoId}]`;
        } else {
          sourceLabel = `[${i + 1}][${sourceType}]`;
        }
        
        // Include chunkId in context for precise reference
        return `--- Context ${sourceLabel} (chunkId: ${chunkId}) ---\n${chunk.content}`;
      })
      .join('\n\n');

    return `You are a knowledgeable assistant answering questions about documents, research papers, and code repositories.

IMPORTANT RULES:
1. Use ONLY the provided context to answer. Do NOT use external knowledge.
2. For EVERY factual claim, include a citation in the format [N] where N is the context number.
3. If information comes from a specific table/figure/formula, mention it explicitly (e.g., "According to Table 1 [3]...").
4. If the context doesn't contain enough information, say so clearly.
5. For numerical data or experimental results, quote the exact values from context with citation.
6. Be concise but complete.

Context:
${contextText}

Question: ${query}

Provide a well-cited answer:`;
  }

  /**
   * Build refined prompt after low faithfulness.
   */
  private buildRefinedPrompt(
    query: string,
    previousAnswer: string,
    issues: string[],
    chunks: Array<ChunkDocument & { score: number }>
  ): string {
    const contextText = chunks
      .map((chunk, i) => `--- Context ${i + 1} ---\n${chunk.content}`)
      .join('\n\n');

    const issuesList = issues.map(i => `- ${i}`).join('\n');

    return `You are a helpful assistant. Your previous answer had some issues:
${issuesList}

Please answer the question again using ONLY the provided context. Be more careful to:
1. Only state facts that are directly supported by the context
2. Cite specific parts of the context when possible
3. If unsure, say "I don't have enough information"

Context:
${contextText}

Question: ${query}

Previous answer (needs improvement): ${previousAnswer}

Improved answer:`;
  }

  /**
   * Build simple answer without LLM (for testing).
   */
  private buildSimpleAnswer(
    query: string,
    chunks: Array<ChunkDocument & { score: number }>
  ): string {
    if (chunks.length === 0) {
      return 'No relevant information found.';
    }

    // Return top 3 chunks as context
    const topChunks = chunks.slice(0, 3);
    const summaries = topChunks.map((chunk, i) => {
      const source = chunk.metadata.repoId ?? chunk.metadata.sourceType;
      return `[${source}] ${chunk.content.slice(0, 300)}...`;
    });

    return `Based on the retrieved context for "${query}":\n\n${summaries.join('\n\n')}`;
  }

  // --------------------------------------------------------------------------
  // Answer Verification
  // --------------------------------------------------------------------------

  /**
   * Verify answer faithfulness using LLM.
   */
  private async verifyAnswer(
    query: string,
    answer: string,
    chunks: Array<ChunkDocument & { score: number }>
  ): Promise<VerificationResult> {
    if (!this.llm) {
      return {
        answerCorrect: true,
        requiresContent: false,
        faithfulnessScore: 1.0,
        issues: [],
      };
    }

    const contextText = chunks
      .map((chunk, i) => `[${i + 1}] ${chunk.content}`)
      .join('\n\n');

    const prompt = `You are verifying if an answer is faithful to the given context.

Context:
${contextText}

Question: ${query}
Answer: ${answer}

Analyze the answer and respond in JSON format:
{
  "answerCorrect": true/false,
  "requiresContent": true/false (does the question need context to answer?),
  "faithfulnessScore": 0.0-1.0 (how well the answer is supported by context),
  "issues": ["list", "of", "issues"]
}

Response:`;

    try {
      const response = await this.llm.complete(prompt);
      const json = this.parseJSON(response);
      
      return {
        answerCorrect: (json.answerCorrect as boolean) ?? true,
        requiresContent: (json.requiresContent as boolean) ?? true,
        faithfulnessScore: (json.faithfulnessScore as number) ?? 0.8,
        issues: (json.issues as string[]) ?? [],
      };
    } catch (err) {
      logger.warn(`Failed to parse verification response: ${err}`);
      return {
        answerCorrect: true,
        requiresContent: true,
        faithfulnessScore: 0.8,
        issues: [],
      };
    }
  }

  /**
   * Parse JSON from LLM response.
   */
  private parseJSON(text: string): Record<string, unknown> {
    // Try to extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return {};
  }
}
