/**
 * preflight_rag - Index bundle to vector DB and perform RAG queries.
 * @module server/tools/ragQueryTool
 */

import * as z from 'zod';

import type { ToolDependencies } from './types.js';
import type { QueryMode } from '../../rag/types.js';
import { findBundleStorageDir } from '../../bundle/service.js';
import { getBundlePaths } from '../../bundle/paths.js';
import { wrapPreflightError } from '../../mcp/errorKinds.js';
import { checkChromaAvailability, getOrCreateEngine, logger } from './ragCommon.js';

// ============================================================================
// preflight_rag Tool
// ============================================================================

export function registerRagQueryTool({ server, cfg }: ToolDependencies): void {
  server.registerTool(
    'preflight_rag',
    {
      title: 'RAG index and query',
      description:
        'Index bundle to vector DB and/or answer questions via RAG retrieval.\n' +
        'Supports: code repos (README + code), documentation repos (all .md files), PDFs, web docs.\n' +
        'Example: `{"bundleId": "<id>", "index": true}` or `{"bundleId": "<id>", "question": "..."}`.\n' +
        'Cross-bundle: `{"crossBundleMode": "all", "question": "..."}`.\n' +
        'Use when: "RAG", "向量检索", "index", "语义问答", "索引文档仓库".',
      inputSchema: {
        bundleId: z.string().optional().describe('Bundle ID to index or query (single mode, backward compatible)'),
        bundleIds: z.array(z.string()).optional().describe('Multiple bundle IDs to query (Phase 1: cross-bundle retrieval)'),
        crossBundleMode: z.enum(['single', 'specified', 'all']).optional().describe('Cross-bundle mode: single (default), specified (use bundleIds), all (query everything)'),
        index: z.boolean().optional().describe('Index bundle to vector DB (default: false). Skips if content already indexed.'),
        force: z.boolean().optional().describe('Force replace existing content with same hash. Use when: switching parser (MinerU→VLM), updating paper version, or re-indexing after bundle changes. Deletes old chunks before indexing new ones.'),
        qualityThreshold: z.number().optional().describe(
          'Minimum QA score (0-100) for indexing acceptance. ' +
          'If QA score < threshold, indexing is rejected and chunks are rolled back. ' +
          'Recommended: 60 for production quality assurance. ' +
          'Example: {"bundleId": "xxx", "index": true, "qualityThreshold": 60}'
        ),
        question: z.string().optional().describe('Question to ask about the bundle'),
        mode: z.enum(['naive', 'local', 'hybrid']).optional().describe('Query mode (default: hybrid)'),
        topK: z.number().optional().describe('Number of chunks to retrieve (default: 10)'),
        repoId: z.string().optional().describe('Filter by repo ID'),
        expandToParent: z.boolean().optional().describe('Expand to parent chunks for more context (default: true)'),
        expandToSiblings: z.boolean().optional().describe('Expand to sibling chunks at same level (default: true)'),
        useVerifierLlm: z.boolean().optional().describe('Use verifier LLM instead of default LLM for cross-validation. Configure verifierLlm* in config.json. Call twice (once without, once with this flag) and compare answers for reliability.'),
        confirmLargeDocIndex: z.boolean().optional().describe('Confirm indexing for documentation repos with 200+ markdown files. When large doc count detected, indexing pauses and returns file count. Set this to true to proceed.'),
      },
      outputSchema: {
        // Config info
        chromaUrl: z.string().optional().describe('ChromaDB server URL used'),
        embeddingEndpoint: z.string().optional().describe('Embedding API endpoint used'),
        // Index result
        indexed: z.boolean().optional(),
        skipped: z.boolean().optional().describe('Whether indexing was skipped due to duplicate content'),
        chunksWritten: z.number().optional(),
        entitiesCount: z.number().optional(),
        relationsCount: z.number().optional(),
        indexDurationMs: z.number().optional(),
        indexErrors: z.array(z.string()).optional(),
        // Deduplication info
        contentHash: z.string().optional().describe('Source file SHA256 hash'),
        paperId: z.string().optional().describe('Paper identifier (e.g., arxiv:2601.14287)'),
        paperVersion: z.string().optional().describe('Paper version (e.g., v1)'),
        existingChunks: z.number().optional().describe('Number of existing chunks (when skipped)'),
        deletedChunks: z.number().optional().describe('Number of chunks deleted (when force=true)'),
        // QA info
        qualityScore: z.number().optional().describe('QA quality score (0-100)'),
        rejected: z.boolean().optional().describe('Whether indexing was rejected due to low quality'),
        rejectionReason: z.string().optional().describe('Reason for rejection'),
        qaSummary: z.object({
          passed: z.boolean(),
          parseOk: z.boolean(),
          chunkOk: z.boolean(),
          ragOk: z.boolean().optional(),
          tablesDetected: z.number(),
          figuresDetected: z.number(),
          totalChunks: z.number(),
          orphanChunks: z.number(),
          ragPassedCount: z.number().optional(),
          ragTotalCount: z.number().optional(),
          avgFaithfulness: z.number().optional(),
          issues: z.array(z.string()),
          // Code repo specific fields
          isCodeRepo: z.boolean().optional(),
          cardScore: z.number().optional(),
          classCount: z.number().optional(),
          functionCount: z.number().optional(),
          hasReadme: z.boolean().optional(),
          relatedPaperId: z.string().optional(),
        }).optional().describe('QA summary with parse/chunk/RAG results (PDF) or CARD/Code/Docs (code repo)'),
        // Query result
        answer: z.string().optional(),
        sources: z
          .array(
            z.object({
              chunkId: z.string(),
              content: z.string(),
              sourceType: z.string(),
              filePath: z.string().optional(),
              repoId: z.string().optional(),
              pageIndex: z.number().optional().describe('Page number (1-indexed) in PDF'),
              sectionHeading: z.string().optional().describe('Section heading (e.g., "3.2 Method", "Abstract")'),
              bundleId: z.string().optional().describe('Bundle ID this evidence came from'),
              paperId: z.string().optional().describe('Paper identifier (e.g., arXiv:2601.02553)'),
            })
          )
          .optional(),
        relatedEntities: z.array(z.string()).optional(),
        stats: z
          .object({
            chunksRetrieved: z.number(),
            entitiesFound: z.number().optional(),
            graphExpansion: z.number().optional(),
            contextCompletionHops: z.number().optional(),
            igpStats: z
              .object({
                originalCount: z.number(),
                prunedCount: z.number(),
                pruningRatio: z.number(),
                iterations: z.number(),
                durationMs: z.number(),
              })
              .optional(),
            hierarchicalStats: z
              .object({
                l1ByType: z.record(z.string(), z.number()),
                l1TotalFound: z.number(),
                l2l3ChunksFound: z.number(),
                durationMs: z.number(),
              })
              .optional(),
            durationMs: z.number(),
          })
          .optional(),
      },
      annotations: { openWorldHint: true },
    },
    async (args) => {
      try {
        const { bundleId, bundleIds, crossBundleMode, index, force, qualityThreshold, question, mode, topK, repoId, expandToParent, expandToSiblings, useVerifierLlm, confirmLargeDocIndex } = args;

        // Validate: at least one action
        if (!index && !question) {
          throw new Error(
            'Must specify `index: true` or `question`. ' +
            'Example: {"bundleId": "xxx", "index": true} or {"bundleId": "xxx", "question": "How to use?"}'
          );
        }

        // Validate cross-bundle parameters
        if (crossBundleMode === 'specified' && (!bundleIds || bundleIds.length === 0)) {
          throw new Error(
            'crossBundleMode="specified" requires bundleIds array. ' +
            'Example: {"crossBundleMode": "specified", "bundleIds": ["id1", "id2"], "question": "..."}'
          );
        }

        // Check embedding configuration
        if (!cfg.semanticSearchEnabled && !cfg.openaiApiKey && cfg.embeddingProvider !== 'ollama') {
          throw new Error(
            'Embedding not configured. Set `embeddingEnabled: true` and `embeddingApiKey` in ~/.preflight/config.json'
          );
        }

        // Check ChromaDB availability
        const chromaCheck = await checkChromaAvailability(cfg.chromaUrl);
        if (!chromaCheck.available) {
          throw new Error(
            `ChromaDB not available at ${cfg.chromaUrl}. ${chromaCheck.error}\n` +
            'Set `chromaUrl` in ~/.preflight/config.json or PREFLIGHT_CHROMA_URL env var.'
          );
        }

        // Find bundle path (only needed for indexing)
        let bundlePath: string | undefined;
        if (index) {
          if (!bundleId) {
            throw new Error('bundleId is required for indexing');
          }
          const storageDir = await findBundleStorageDir(cfg.storageDirs, bundleId);
          if (!storageDir) {
            throw new Error(`Bundle not found: ${bundleId}`);
          }
          const paths = getBundlePaths(storageDir, bundleId);
          bundlePath = paths.rootDir;
        }

        // Get RAG engine (use verifier LLM if requested for cross-validation)
        // For cross-bundle queries, use first bundleId or a placeholder
        const engineKey = bundleId ?? bundleIds?.[0] ?? 'shared';
        const { engine, embeddingEndpoint, llmEnabled, llmModel } = await getOrCreateEngine(engineKey, cfg, { useVerifierLlm });

        let indexResult: {
          chunksWritten: number;
          entitiesCount?: number;
          relationsCount?: number;
          durationMs: number;
          errors: string[];
          skipped?: boolean;
          contentHash?: string;
          paperId?: string;
          paperVersion?: string;
          existingChunks?: number;
          deletedChunks?: number;
          qualityScore?: number;
          qaSummary?: {
            passed: boolean;
            parseOk: boolean;
            chunkOk: boolean;
            ragOk?: boolean;
            tablesDetected: number;
            figuresDetected: number;
            totalChunks: number;
            orphanChunks: number;
            ragPassedCount?: number;
            ragTotalCount?: number;
            avgFaithfulness?: number;
            issues: string[];
            // Code repo specific fields
            isCodeRepo?: boolean;
            cardScore?: number;
            classCount?: number;
            functionCount?: number;
            hasReadme?: boolean;
            relatedPaperId?: string;
          };
          rejected?: boolean;
          rejectionReason?: string;
          pendingConfirmation?: {
            reason: 'large_doc_count';
            docFileCount: number;
            estimatedTimeMinutes: number;
            message: string;
          };
        } | null = null;

        let queryResult: {
          answer: string;
          sources: Array<{
            chunkId: string;
            content: string;
            sourceType: string;
            filePath?: string;
            repoId?: string;
            pageIndex?: number;
            sectionHeading?: string;
            bundleId?: string;
            paperId?: string;
          }>;
          relatedEntities?: string[];
          stats: {
            chunksRetrieved: number;
            graphExpansion?: number;
            durationMs: number;
          };
        } | null = null;

        // Index if requested
        if (index) {
          if (!bundleId || !bundlePath) {
            throw new Error('bundleId and bundlePath required for indexing');
          }
          logger.info(`Indexing bundle: ${bundleId}${force ? ' (force)' : ''}${qualityThreshold ? ` (threshold=${qualityThreshold})` : ''}`);
          const result = await engine.indexBundle(bundlePath, bundleId, { force, qualityThreshold, confirmLargeDocIndex });
          indexResult = {
            chunksWritten: result.chunksWritten,
            entitiesCount: result.entitiesCount,
            relationsCount: result.relationsCount,
            durationMs: result.durationMs,
            errors: result.errors,
            skipped: result.skipped,
            contentHash: result.contentHash,
            paperId: result.paperId,
            paperVersion: result.paperVersion,
            existingChunks: result.existingChunks,
            deletedChunks: result.deletedChunks,
            qualityScore: result.qualityScore,
            qaSummary: result.qaSummary,
            rejected: result.rejected,
            rejectionReason: result.rejectionReason,
            pendingConfirmation: result.pendingConfirmation,
          };
          if (result.skipped) {
            logger.info(`Skipped indexing: content already exists (${result.existingChunks} chunks)`);
          } else {
            logger.info(
              `Indexed ${result.chunksWritten} chunks, ${result.entitiesCount ?? 0} entities in ${result.durationMs}ms`
            );
          }
        }

        // Query if requested
        if (question) {
          const llmType = useVerifierLlm ? 'verifier' : 'main';
          logger.info(`Querying: "${question}" (mode: ${mode ?? 'hybrid'}, llm: ${llmType}/${llmModel})`);

          // High-quality defaults (as per plan - don't add new config items, just use best quality)
          const result = await engine.query(question, {
            mode: (mode as QueryMode) ?? 'hybrid',
            topK: topK ?? 10,
            // Phase 1: Cross-bundle parameters
            bundleId,
            bundleIds,
            crossBundleMode: crossBundleMode as 'single' | 'specified' | 'all' | undefined,
            repoId,
            // Ultra quality: always enable verification and retry when LLM is available
            enableVerification: llmEnabled,
            retryOnLowFaithfulness: llmEnabled,
            enableContextCompletion: true,
            maxHops: 3, // Multi-hop for complete context
            // Hierarchical expansion (default: true)
            expandToParent: expandToParent ?? true,
            expandToSiblings: expandToSiblings ?? true,
          });

          queryResult = {
            answer: result.answer,
            sources: result.sources,
            relatedEntities: result.relatedEntities,
            stats: result.stats,
          };
          logger.info(
            `Retrieved ${result.stats.chunksRetrieved} chunks, expanded ${result.stats.graphExpansion ?? 0} types`
          );
        }

        // Build response text
        let textResponse = '';

        // Show config info
        const llmInfo = useVerifierLlm ? `VerifierLLM=${llmModel}` : `LLM=${llmModel}`;
        textResponse += `🔧 Config: ChromaDB=${cfg.chromaUrl} | Embedding=${embeddingEndpoint} | ${llmInfo}\n\n`;

        if (indexResult) {
          // Handle pending confirmation (large doc count)
          if (indexResult.pendingConfirmation) {
            const pc = indexResult.pendingConfirmation;
            textResponse += `⏸️ **Confirmation Required**\n`;
            textResponse += `   Found ${pc.docFileCount} markdown files in documentation repo.\n`;
            textResponse += `   Estimated indexing time: ~${pc.estimatedTimeMinutes} minutes.\n`;
            textResponse += `   To proceed, call again with \`confirmLargeDocIndex: true\`.\n`;
            
            return {
              content: [{ type: 'text', text: textResponse }],
              structuredContent: {
                pendingConfirmation: pc,
                bundleId,
              },
            };
          }
          
          if (indexResult.rejected) {
            // Rejected due to low quality
            textResponse += `❌ Rejected: ${indexResult.rejectionReason}\n`;
            textResponse += `   contentHash: ${indexResult.contentHash?.slice(0, 12)}...\n`;
            if (indexResult.paperId) {
              textResponse += `   paperId: ${indexResult.paperId}${indexResult.paperVersion ? ` (${indexResult.paperVersion})` : ''}\n`;
            }
            textResponse += `   Rolled back: ${indexResult.deletedChunks} chunks\n`;
            // Show QA summary for rejected
            if (indexResult.qaSummary) {
              const qa = indexResult.qaSummary;
              textResponse += `   📊 QA: FAILED (score: ${indexResult.qualityScore})\n`;
              
              if (qa.isCodeRepo) {
                // Code repo specific display format
                textResponse += `      CARD: ${qa.parseOk ? 'OK' : 'FAIL'} (completeness: ${qa.cardScore ?? 0}%)\n`;
                textResponse += `      Code: ${qa.chunkOk ? 'OK' : 'FAIL'} (${qa.classCount ?? 0} classes, ${qa.functionCount ?? 0} functions)\n`;
                textResponse += `      Docs: ${qa.hasReadme ? 'README ✓' : 'README ✗'}${qa.relatedPaperId ? `, linked: ${qa.relatedPaperId}` : ''}\n`;
              } else {
                // PDF display format
                textResponse += `      Parse: ${qa.parseOk ? 'OK' : 'FAIL'} (${qa.tablesDetected} tables, ${qa.figuresDetected} figures)\n`;
                textResponse += `      Chunks: ${qa.totalChunks} total, ${qa.orphanChunks} orphan\n`;
                if (qa.ragOk !== undefined) {
                  textResponse += `      RAG: ${qa.ragPassedCount}/${qa.ragTotalCount} passed (avg faith: ${qa.avgFaithfulness?.toFixed(2) ?? 'N/A'})\n`;
                }
              }
              if (qa.issues.length > 0) {
                textResponse += `      Issues: ${qa.issues.slice(0, 3).join('; ')}\n`;
              }
            }
          } else if (indexResult.skipped) {
            textResponse += `⚠️ Skipped: content already indexed\n`;
            textResponse += `   contentHash: ${indexResult.contentHash?.slice(0, 12)}...\n`;
            if (indexResult.paperId) {
              textResponse += `   paperId: ${indexResult.paperId}${indexResult.paperVersion ? ` (${indexResult.paperVersion})` : ''}\n`;
            }
            textResponse += `   existingChunks: ${indexResult.existingChunks}\n`;
            textResponse += `   Hint: Use force=true to replace.\n`;
          } else {
            if (indexResult.deletedChunks && !indexResult.rejected) {
              textResponse += `🔄 Replaced: ${indexResult.contentHash?.slice(0, 12)}...\n`;
              textResponse += `   Deleted: ${indexResult.deletedChunks} chunks\n`;
            } else {
              textResponse += `✅ Indexed bundle: ${bundleId}\n`;
            }
            textResponse += `   Chunks: ${indexResult.chunksWritten}\n`;
            // Show QA summary for successful index
            if (indexResult.qaSummary) {
              const qa = indexResult.qaSummary;
              const statusEmoji = qa.passed ? 'PASSED' : 'WARNING';
              textResponse += `   📊 QA: ${statusEmoji} (score: ${indexResult.qualityScore})\n`;
              
              if (qa.isCodeRepo) {
                // Code repo specific display format
                textResponse += `      CARD: ${qa.parseOk ? 'OK' : 'FAIL'} (completeness: ${qa.cardScore ?? 0}%)\n`;
                textResponse += `      Code: ${qa.chunkOk ? 'OK' : 'FAIL'} (${qa.classCount ?? 0} classes, ${qa.functionCount ?? 0} functions)\n`;
                textResponse += `      Docs: ${qa.hasReadme ? 'README ✓' : 'README ✗'}${qa.relatedPaperId ? `, linked: ${qa.relatedPaperId}` : ''}\n`;
              } else {
                // PDF display format
                textResponse += `      Parse: ${qa.parseOk ? 'OK' : 'FAIL'} (${qa.tablesDetected} tables, ${qa.figuresDetected} figures)\n`;
                textResponse += `      Chunks: ${qa.totalChunks} total, ${qa.orphanChunks} orphan\n`;
                if (qa.ragOk !== undefined) {
                  textResponse += `      RAG: ${qa.ragPassedCount}/${qa.ragTotalCount} passed (avg faith: ${qa.avgFaithfulness?.toFixed(2) ?? 'N/A'})\n`;
                }
              }
            }
            if (indexResult.contentHash) {
              textResponse += `   contentHash: ${indexResult.contentHash.slice(0, 12)}...\n`;
            }
            if (indexResult.paperId) {
              textResponse += `   paperId: ${indexResult.paperId}${indexResult.paperVersion ? ` (${indexResult.paperVersion})` : ''}\n`;
            }
            textResponse += `   Duration: ${indexResult.durationMs}ms\n`;
          }
          if (indexResult.errors.length > 0) {
            textResponse += `   ⚠️ Errors: ${indexResult.errors.length}\n`;
            indexResult.errors.slice(0, 3).forEach((e) => {
              textResponse += `      - ${e}\n`;
            });
          }
        }

        if (queryResult) {
          if (indexResult) textResponse += '\n---\n\n';
          textResponse += `📝 Question: ${question}\n\n`;
          textResponse += `💬 Answer:\n${queryResult.answer}\n`;

          if (queryResult.sources.length > 0) {
            textResponse += '\n📚 Sources:\n';
            
            // Phase 1.4: Group sources by paperId for cross-bundle queries
            const sourcesByPaper = new Map<string, typeof queryResult.sources>();
            for (const source of queryResult.sources) {
              const key = source.paperId ?? source.bundleId ?? 'unknown';
              if (!sourcesByPaper.has(key)) {
                sourcesByPaper.set(key, []);
              }
              sourcesByPaper.get(key)!.push(source);
            }

            // Display sources grouped by paper
            let globalIndex = 1;
            for (const [paperId, sources] of sourcesByPaper) {
              // Paper header (show only if multiple papers)
              if (sourcesByPaper.size > 1) {
                textResponse += `   📄 ${paperId}:\n`;
              }
              
              // Format each source with enhanced metadata
              for (const s of sources.slice(0, 5)) {
                // Build source label: [paperId] Section X.Y, page N
                let sourceLabel = '';
                
                // Add paperId prefix if available
                if (s.paperId) {
                  sourceLabel += `[${s.paperId}]`;
                }
                
                // Add section/heading info from metadata
                if (s.sectionHeading) {
                  sourceLabel += ` ${s.sectionHeading}`;
                }
                
                // Add page number
                if (s.pageIndex) {
                  sourceLabel += `, page ${s.pageIndex}`;
                }
                
                // Fallback: use sourceType and repoId if no paperId
                if (!sourceLabel) {
                  sourceLabel = `[${s.sourceType}] ${s.repoId ?? s.filePath ?? s.chunkId}`;
                  if (s.pageIndex) {
                    sourceLabel += ` (p.${s.pageIndex})`;
                  }
                }
                
                const indent = sourcesByPaper.size > 1 ? '      ' : '   ';
                textResponse += `${indent}${globalIndex}. ${sourceLabel}\n`;
                globalIndex++;
              }
            }
          }

          if (queryResult.relatedEntities && queryResult.relatedEntities.length > 0) {
            textResponse += `\n🔗 Related: ${queryResult.relatedEntities.slice(0, 5).join(', ')}\n`;
          }

          textResponse += `\n⏱️ Stats: ${queryResult.stats.chunksRetrieved} chunks, `;
          textResponse += `${queryResult.stats.graphExpansion ?? 0} graph expansion, `;
          textResponse += `${queryResult.stats.durationMs}ms\n`;
        }

        // Build structured output
        const structuredContent: Record<string, unknown> = {
          chromaUrl: cfg.chromaUrl,
          embeddingEndpoint,
        };

        if (indexResult) {
          structuredContent.indexed = !indexResult.skipped && !indexResult.rejected;
          structuredContent.skipped = indexResult.skipped;
          structuredContent.rejected = indexResult.rejected;
          structuredContent.rejectionReason = indexResult.rejectionReason;
          structuredContent.chunksWritten = indexResult.chunksWritten;
          structuredContent.entitiesCount = indexResult.entitiesCount;
          structuredContent.relationsCount = indexResult.relationsCount;
          structuredContent.indexDurationMs = indexResult.durationMs;
          structuredContent.contentHash = indexResult.contentHash;
          structuredContent.paperId = indexResult.paperId;
          structuredContent.paperVersion = indexResult.paperVersion;
          structuredContent.existingChunks = indexResult.existingChunks;
          structuredContent.deletedChunks = indexResult.deletedChunks;
          structuredContent.qualityScore = indexResult.qualityScore;
          structuredContent.qaSummary = indexResult.qaSummary;
          if (indexResult.errors.length > 0) {
            structuredContent.indexErrors = indexResult.errors;
          }
        }

        if (queryResult) {
          structuredContent.answer = queryResult.answer;
          structuredContent.sources = queryResult.sources;
          structuredContent.relatedEntities = queryResult.relatedEntities;
          structuredContent.stats = queryResult.stats;
        }

        return {
          content: [{ type: 'text', text: textResponse }],
          structuredContent,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );
}
