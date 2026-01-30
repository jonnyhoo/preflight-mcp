/**
 * preflight_rag_manage - Debug and manage ChromaDB vector database.
 * @module server/tools/ragManageTool
 */

import * as z from 'zod';

import type { ToolDependencies } from './types.js';
import { ChromaVectorDB } from '../../vectordb/chroma-client.js';
import { wrapPreflightError } from '../../mcp/errorKinds.js';
import { checkChromaAvailability, getEmbeddingProvider } from './ragCommon.js';

// ============================================================================
// preflight_rag_manage Tool
// ============================================================================

export function registerRagManageTool({ server, cfg }: ToolDependencies): void {
  server.registerTool(
    'preflight_rag_manage',
    {
      title: 'RAG content management',
      description:
        'Manage ChromaDB: list/stats/inspect/delete indexed content, diagnose quality.\n' +
        'Example: `{"action": "stats"}`, `{"action": "delete", "bundleId": "xxx"}`\n' +
        'Actions: collections, stats, list, sample, inspect, search_raw, delete, delete_all, drop_collection, diagnose.\n' +
        'Delete supports: contentHash OR bundleId (use bundleId from list output).\n' +
        'Paper-Code linking: Code repos with CARD.json containing arxivId are linked via relatedPaperId metadata.\n' +
        'Use when: "检查索引", "debug RAG", "清空数据库", "删除索引", "查看论文代码关联".',
      inputSchema: {
        action: z.enum(['list', 'stats', 'collections', 'sample', 'delete', 'delete_all', 'drop_collection', 'inspect', 'search_raw', 'diagnose']).describe('Action to perform'),
        contentHash: z.string().optional().describe('Content hash to delete (for delete action)'),
        bundleId: z.string().optional().describe('Bundle ID - for delete/inspect/search_raw. Use bundleId from `list` output to delete specific content.'),
        collection: z.string().optional().describe('Collection name (for sample or drop_collection, e.g., "preflight_rag_l1_pdf")'),
        query: z.string().optional().describe('Search query text (required for search_raw)'),
        limit: z.number().optional().describe('Max number of results (default 5)'),
        paperId: z.string().optional().describe('Paper ID for diagnose action (e.g., "arxiv:2601.02553")'),
      },
      outputSchema: {
        // List result (hierarchical)
        items: z.array(z.object({
          paperId: z.string(),
          paperVersion: z.string().optional(),
          contentHash: z.string().optional(),
          bundleId: z.string().optional(),
          l1Count: z.number(),
          l2Count: z.number(),
          l3Count: z.number(),
          totalChunks: z.number(),
        })).optional(),
        // Stats result (hierarchical)
        stats: z.object({
          totalChunks: z.number(),
          byLevel: z.record(z.string(), z.number()),
          byPaperId: z.array(z.object({
            paperId: z.string(),
            chunkCount: z.number(),
          })),
        }).optional(),
        // Delete result
        deleted: z.boolean().optional(),
        deletedChunks: z.number().optional(),
      },
      annotations: { openWorldHint: true },
    },
    async (args) => {
      try {
        const { action, contentHash, bundleId, collection, query, limit, paperId } = args;

        // Check ChromaDB availability
        const chromaCheck = await checkChromaAvailability(cfg.chromaUrl);
        if (!chromaCheck.available) {
          throw new Error(
            `ChromaDB not available at ${cfg.chromaUrl}. ${chromaCheck.error}`
          );
        }

        const chromaDB = new ChromaVectorDB({ url: cfg.chromaUrl });
        let textResponse = '';
        const structuredContent: Record<string, unknown> = {};

        switch (action) {
          case 'list': {
            // Use hierarchical index (Phase 3) - now uses contentHash/bundleId as primary key
            const items = await chromaDB.listHierarchicalContent();
            structuredContent.items = items;

          // Categorize by type (from L1 collection)
            // Get repo bundleIds first to identify doc items that belong to repos
            const repos = items.filter(i => i.type === 'repo');
            const repoBundleIds = new Set(repos.map(r => r.bundleId).filter(Boolean));
            // Papers: pdf type, or doc type that doesn't belong to a repo (has paperId or doesn't share bundleId with a repo)
            const papers = items.filter(i => 
              i.type === 'pdf' || 
              (i.type === 'doc' && (i.paperId || !repoBundleIds.has(i.bundleId)))
            );

            textResponse += `📋 Indexed Content (${items.length} total)\n\n`;
            if (items.length === 0) {
              textResponse += 'No content indexed yet.\n';
            } else {
              if (papers.length > 0) {
                textResponse += `**📄 Papers (${papers.length}):**\n`;
                for (const item of papers) {
                  // Display: paperId if available, otherwise contentHash
                  let displayName = item.paperId;
                  if (!displayName && item.contentHash) {
                    displayName = `[hash:${item.contentHash.slice(0, 12)}...]`;
                  }
                  if (!displayName) {
                    displayName = item.id;
                  }
                  // Remove 'name:' prefix for cleaner display
                  if (displayName.startsWith('name:')) {
                    displayName = displayName.slice(5);
                  }
                  const hasCode = item.sourceTypes.includes('l1_repo');
                  const missingPaperId = !item.paperId;
                  textResponse += `• ${displayName}${item.paperVersion ? ` (${item.paperVersion})` : ''}${hasCode ? ' 💻' : ''}${missingPaperId ? ' ⚠️' : ''}\n`;
                  // Show paper title if available
                  if (item.paperTitle) {
                    // Truncate long titles
                    const title = item.paperTitle.length > 70 
                      ? item.paperTitle.slice(0, 67) + '...' 
                      : item.paperTitle;
                    textResponse += `  📝 ${title}\n`;
                  }
                  textResponse += `  L1: ${item.l1Count} | L2: ${item.l2Count} | L3: ${item.l3Count} (total: ${item.totalChunks})\n`;
                  if (item.contentHash) {
                    textResponse += `  hash: ${item.contentHash.slice(0, 12)}...\n`;
                  }
                  if (item.bundleId) {
                    textResponse += `  bundleId: ${item.bundleId}\n`;
                  }
                }
                textResponse += `\n`;
              }
              if (repos.length > 0) {
                textResponse += `**📦 Repos (${repos.length}):**\n`;
                for (const item of repos) {
                  // For repos: prefer repoId, then extract from id if it starts with 'repo:'
                  let displayName = (item as any).repoId;
                  if (!displayName && item.id.startsWith('repo:')) {
                    displayName = item.id.slice(5).split('@')[0]; // 'repo:local/C3Box@xxx' -> 'local/C3Box'
                  }
                  if (!displayName) {
                    displayName = item.bundleId ?? item.id;
                  }
                  // Show linked paper indicator
                  const hasLinkedPaper = !!(item as any).relatedPaperId;
                  textResponse += `• ${displayName}${hasLinkedPaper ? ' 🔗' : ''}\n`;
                  // Show relatedPaperId if available (paper-code link)
                  if ((item as any).relatedPaperId) {
                    textResponse += `  📎 Linked to: ${(item as any).relatedPaperId}\n`;
                  }
                  textResponse += `  L1: ${item.l1Count} | L2: ${item.l2Count} | L3: ${item.l3Count} (total: ${item.totalChunks})\n`;
                  if (item.bundleId) {
                    textResponse += `  bundleId: ${item.bundleId}\n`;
                  }
                }
              }
              // Warning for items missing paperId
              const missingPaperId = items.filter(i => !i.paperId);
              if (missingPaperId.length > 0) {
                textResponse += `\n⚠️ ${missingPaperId.length} item(s) missing paperId (marked with ⚠️)\n`;
              }
            }
            break;
          }

          case 'stats': {
            // Use hierarchical stats for level counts
            const stats = await chromaDB.getHierarchicalStats();
            // Use content list for accurate item counts (uses contentHash as key)
            const contentList = await chromaDB.listHierarchicalContent();
            structuredContent.stats = stats;
            structuredContent.contentList = contentList;

            // Categorize by type (same logic as list)
            const repos = contentList.filter(i => i.type === 'repo');
            const repoBundleIds = new Set(repos.map(r => r.bundleId).filter(Boolean));
            const papers = contentList.filter(i => 
              i.type === 'pdf' || 
              (i.type === 'doc' && (i.paperId || !repoBundleIds.has(i.bundleId)))
            );

            textResponse += `📊 RAG Statistics (Hierarchical)\n\n`;
            textResponse += `Total documents: ${stats.totalChunks}\n\n`;
            textResponse += `By Level:\n`;
            for (const [level, count] of Object.entries(stats.byLevel)) {
              textResponse += `  • ${level}: ${count}\n`;
            }
            if (papers.length > 0) {
              const withPaperId = papers.filter(p => p.paperId).length;
              const missingPaperId = papers.length - withPaperId;
              textResponse += `\n📄 Papers (${papers.length}${missingPaperId > 0 ? `, ${missingPaperId} missing paperId` : ''}):\n`;
              for (const item of papers) {
                let displayName = item.paperId;
                if (!displayName && item.contentHash) {
                  displayName = `[hash:${item.contentHash.slice(0, 12)}...]`;
                }
                if (!displayName) {
                  displayName = item.id;
                }
                if (displayName.startsWith('name:')) {
                  displayName = displayName.slice(5);
                }
                const hasCode = item.sourceTypes.includes('l1_repo');
                const missingId = !item.paperId;
                textResponse += `  • ${displayName}${hasCode ? ' 💻' : ''}${missingId ? ' ⚠️' : ''}: ${item.l1Count} L1 docs\n`;
              }
            }
            if (repos.length > 0) {
              textResponse += `\n📦 Repos (${repos.length}):\n`;
              for (const item of repos) {
                // For repos: prefer repoId, then extract from id if it starts with 'repo:'
                let displayName = (item as any).repoId;
                if (!displayName && item.id.startsWith('repo:')) {
                  displayName = item.id.slice(5).split('@')[0]; // 'repo:local/C3Box@xxx' -> 'local/C3Box'
                }
                if (!displayName) {
                  displayName = item.bundleId ?? item.id;
                }
                textResponse += `  • ${displayName}: ${item.l1Count} L1 docs\n`;
              }
            }
            break;
          }

          case 'collections': {
            // List all collections with document counts
            const collections = await chromaDB.listAllCollections();
            const collectionStats: Array<{ name: string; count: number; metadata?: Record<string, unknown> }> = [];
            
            for (const col of collections) {
              const count = await chromaDB.getCollectionCount(col.name);
              collectionStats.push({ name: col.name, count, metadata: col.metadata });
            }
            
            // Sort by name for better display
            collectionStats.sort((a, b) => a.name.localeCompare(b.name));
            
            structuredContent.collections = collectionStats;

            textResponse += `📦 ChromaDB Collections (${collections.length} total)\n\n`;
            
            // Group by type for display
            const hierarchical = collectionStats.filter(c => c.name.includes('_rag_l'));
            const legacy = collectionStats.filter(c => !c.name.includes('_rag_l'));
            
            if (hierarchical.length > 0) {
              textResponse += `**Hierarchical (Phase 3):**\n`;
              for (const col of hierarchical) {
                const level = col.name.match(/_rag_(l[0-9]_[a-z]+)/)?.[1] ?? 'unknown';
                textResponse += `  • ${col.name}: ${col.count} docs (${level})\n`;
              }
              textResponse += `\n`;
            }
            
            if (legacy.length > 0) {
              textResponse += `**Legacy/Other:**\n`;
              for (const col of legacy) {
                textResponse += `  • ${col.name}: ${col.count} docs\n`;
              }
            }
            
            // Summary
            const totalDocs = collectionStats.reduce((sum, c) => sum + c.count, 0);
            textResponse += `\n**Total:** ${totalDocs} documents across ${collections.length} collections\n`;
            break;
          }

          case 'sample': {
            // Sample chunks from a specific collection
            if (!collection) {
              throw new Error('collection is required for sample action. Example: "preflight_rag_l1_pdf"');
            }

            const maxSamples = limit ?? 5;
            
            // Get collection count first
            const count = await chromaDB.getCollectionCount(collection);
            if (count === 0) {
              textResponse += `⚠️ Collection "${collection}" is empty or does not exist.\n`;
              break;
            }

            // For sampling, we need to use a dummy query to get random-ish results
            // Use a very generic embedding query
            if (!cfg.semanticSearchEnabled && !cfg.openaiApiKey && cfg.embeddingProvider !== 'ollama') {
              throw new Error('Embedding not configured. Cannot sample.');
            }

            const embedding = await getEmbeddingProvider(cfg);
            // Use a generic query to get diverse samples
            const sampleEmbedding = await embedding.embed('document content text');
            
            // Query the specific collection directly
            const basePath = `/api/v2/tenants/default_tenant/databases/default_database`;
            const collectionsResponse = await fetch(
              `${cfg.chromaUrl}${basePath}/collections`
            );
            const allCollections = await collectionsResponse.json() as Array<{ name: string; id: string }>;
            const targetCol = allCollections.find((c: { name: string }) => c.name === collection);
            
            if (!targetCol) {
              textResponse += `⚠️ Collection "${collection}" not found.\n`;
              break;
            }

            const queryResponse = await fetch(
              `${cfg.chromaUrl}${basePath}/collections/${targetCol.id}/query`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  query_embeddings: [sampleEmbedding.vector],
                  n_results: maxSamples,
                  include: ['documents', 'metadatas'],
                }),
              }
            );
            const queryResult = await queryResponse.json() as {
              ids: string[][];
              documents?: (string | null)[][];
              metadatas?: (Record<string, unknown> | null)[][];
            };

            textResponse += `📋 Sample from "${collection}" (${count} total, showing ${maxSamples})\n\n`;
            
            if (queryResult.ids[0]) {
              for (let i = 0; i < queryResult.ids[0].length; i++) {
                const id = queryResult.ids[0][i];
                const doc = queryResult.documents?.[0]?.[i] ?? '';
                const meta = queryResult.metadatas?.[0]?.[i] ?? {};
                
                textResponse += `--- Sample ${i + 1} ---\n`;
                textResponse += `ID: ${id}\n`;
                if (meta.paperId) textResponse += `Paper: ${meta.paperId}\n`;
                if (meta.relatedPaperId) textResponse += `Related Paper: ${meta.relatedPaperId}\n`;
                if (meta.sourceType) textResponse += `Source: ${meta.sourceType}\n`;
                if (meta.repoId) textResponse += `Repo: ${meta.repoId}\n`;
                if (meta.sectionHeading) textResponse += `Section: ${meta.sectionHeading}\n`;
                if (meta.pageIndex) textResponse += `Page: ${meta.pageIndex}\n`;
                if (meta.collectionLevel) textResponse += `Level: ${meta.collectionLevel}\n`;
                if (meta.fieldName) textResponse += `FieldName: ${meta.fieldName}\n`;
                
                const preview = doc.length > 200 ? doc.slice(0, 200) + '...' : doc;
                textResponse += `Content: ${preview}\n\n`;
              }
            }
            
            structuredContent.collection = collection;
            structuredContent.totalCount = count;
            structuredContent.sampleCount = queryResult.ids[0]?.length ?? 0;
            break;
          }

          case 'delete': {
            if (!contentHash && !bundleId) {
              throw new Error(
                'Either contentHash or bundleId is required for delete action.\n' +
                'Example: {"action": "delete", "bundleId": "xxx-xxx-xxx"}\n' +
                'Tip: Use `{"action": "list"}` to see bundleId for each indexed content.'
              );
            }

            let deletedCount = 0;
            let deleteTarget = '';

            if (bundleId) {
              // Delete by bundleId - count first, then delete
              const existing = await chromaDB.getChunksByBundleIdHierarchical(bundleId);
              deletedCount = existing.length;
              if (deletedCount > 0) {
                await chromaDB.deleteByBundleHierarchical(bundleId);
              }
              deleteTarget = `bundleId: ${bundleId}`;
            } else if (contentHash) {
              // Delete by contentHash
              deletedCount = await chromaDB.deleteByContentHashHierarchical(contentHash);
              deleteTarget = `contentHash: ${contentHash.slice(0, 12)}...`;
            }

            structuredContent.deleted = deletedCount > 0;
            structuredContent.deletedChunks = deletedCount;

            if (deletedCount > 0) {
              textResponse += `🗑️ Deleted ${deletedCount} chunks\n`;
              textResponse += `   ${deleteTarget}\n`;
            } else {
              textResponse += `⚠️ No chunks found with ${deleteTarget}\n`;
              textResponse += `💡 Tip: Use \`{"action": "list"}\` to see available bundleIds.\n`;
            }
            break;
          }

          case 'delete_all': {
            // Drop all hierarchical collections to truly delete everything
            const collectionsToDelete = [
              'preflight_rag_l1_pdf',
              'preflight_rag_l1_doc', 
              'preflight_rag_l1_repo',
              'preflight_rag_l1_web',
              'preflight_rag_l1_memory',
              'preflight_rag_l2_section',
              'preflight_rag_l3_chunk',
            ];
            
            const basePath = `/api/v2/tenants/default_tenant/databases/default_database`;
            let totalDeleted = 0;
            let collectionsDeleted = 0;
            
            for (const colName of collectionsToDelete) {
              try {
                // Get count before dropping
                const countBefore = await chromaDB.getCollectionCount(colName);
                if (countBefore === 0) continue;
                
                // Drop the collection
                const deleteResponse = await fetch(`${cfg.chromaUrl}${basePath}/collections/${colName}`, {
                  method: 'DELETE',
                });
                
                if (deleteResponse.ok) {
                  totalDeleted += countBefore;
                  collectionsDeleted++;
                }
              } catch {
                // Collection doesn't exist, skip
              }
            }
            
            if (totalDeleted === 0) {
              textResponse += '⚠️ No content to delete.\n';
              structuredContent.deleted = false;
              structuredContent.deletedChunks = 0;
            } else {
              textResponse += `🗑️ Deleted all content: ${totalDeleted} documents from ${collectionsDeleted} collections\n`;
              structuredContent.deleted = true;
              structuredContent.deletedChunks = totalDeleted;
              structuredContent.collectionsDeleted = collectionsDeleted;
            }
            break;
          }

          case 'drop_collection': {
            if (!collection) {
              throw new Error('collection is required for drop_collection action. Example: "preflight_chunks"');
            }

            // Check if collection exists
            const basePath = `/api/v2/tenants/default_tenant/databases/default_database`;
            const collectionsResponse = await fetch(`${cfg.chromaUrl}${basePath}/collections`);
            const allCollections = await collectionsResponse.json() as Array<{ name: string; id: string }>;
            const targetCol = allCollections.find((c: { name: string }) => c.name === collection);
            
            if (!targetCol) {
              textResponse += `⚠️ Collection "${collection}" not found.\n`;
              structuredContent.dropped = false;
              break;
            }

            // Get count before dropping
            const countBefore = await chromaDB.getCollectionCount(collection);

            // Drop the collection
            const deleteResponse = await fetch(`${cfg.chromaUrl}${basePath}/collections/${collection}`, {
              method: 'DELETE',
            });

            if (deleteResponse.ok) {
              textResponse += `🗑️ Dropped collection "${collection}" (${countBefore} documents)\n`;
              structuredContent.dropped = true;
              structuredContent.collection = collection;
              structuredContent.documentsDropped = countBefore;
            } else {
              const error = await deleteResponse.text();
              textResponse += `❌ Failed to drop collection "${collection}": ${error}\n`;
              structuredContent.dropped = false;
              structuredContent.error = error;
            }
            break;
          }

          case 'inspect': {
            // Use hierarchical index (Phase 3)
            const maxChunks = limit ?? 5;
            
            // Check embedding configuration
            if (!cfg.semanticSearchEnabled && !cfg.openaiApiKey && cfg.embeddingProvider !== 'ollama') {
              throw new Error('Embedding not configured. Cannot inspect.');
            }

            // Use a generic query to get diverse samples from L2+L3
            const embedding = await getEmbeddingProvider(cfg);
            const sampleEmbedding = await embedding.embed('document content section text');
            
            const filter = bundleId ? { bundleId } : undefined;
            const results = await chromaDB.queryHierarchicalRaw(sampleEmbedding.vector, maxChunks, filter);
            structuredContent.chunks = results.chunks;

            textResponse += `🔍 Inspecting ${results.chunks.length} chunks (L2+L3)${bundleId ? ` (bundleId: ${bundleId})` : ''}\n\n`;
            
            for (let i = 0; i < results.chunks.length; i++) {
              const chunk = results.chunks[i]!;
              textResponse += `--- Chunk ${i + 1} ---\n`;
              textResponse += `ID: ${chunk.id}\n`;
              textResponse += `Type: ${chunk.metadata.chunkType ?? 'text'} | Source: ${chunk.metadata.sourceType}\n`;
              if (chunk.metadata.paperId) {
                textResponse += `Paper: ${chunk.metadata.paperId}\n`;
              }
              if (chunk.metadata.pageIndex) {
                textResponse += `Page: ${chunk.metadata.pageIndex}\n`;
              }
              if (chunk.metadata.sectionHeading) {
                textResponse += `Section: ${chunk.metadata.sectionHeading}\n`;
              }
              if (chunk.metadata.collectionLevel) {
                textResponse += `Level: ${chunk.metadata.collectionLevel}\n`;
              }
              // Truncate content for display
              const contentPreview = chunk.content.length > 300 
                ? chunk.content.slice(0, 300) + '...' 
                : chunk.content;
              textResponse += `Content: ${contentPreview}\n\n`;
            }
            break;
          }

          case 'search_raw': {
            if (!query) {
              throw new Error('query is required for search_raw action');
            }

            // Check embedding configuration
            if (!cfg.semanticSearchEnabled && !cfg.openaiApiKey && cfg.embeddingProvider !== 'ollama') {
              throw new Error('Embedding not configured. Cannot perform search_raw.');
            }

            const maxResults = limit ?? 5;
            const filter = bundleId ? { bundleId } : undefined;

            // Get embedding for query
            const embedding = await getEmbeddingProvider(cfg);
            const queryEmbedding = await embedding.embed(query);

            // Use hierarchical search (Phase 3) - searches L2+L3
            const results = await chromaDB.queryHierarchicalRaw(queryEmbedding.vector, maxResults, filter);
            structuredContent.results = results.chunks;

            textResponse += `🔎 Raw Search Results (L2+L3) for: "${query}"\n`;
            textResponse += `Found ${results.chunks.length} chunks${bundleId ? ` (bundleId: ${bundleId})` : ''}\n\n`;

            for (let i = 0; i < results.chunks.length; i++) {
              const chunk = results.chunks[i]!;
              textResponse += `--- Result ${i + 1} (score: ${chunk.score.toFixed(3)}) ---\n`;
              textResponse += `ID: ${chunk.id}\n`;
              textResponse += `Paper: ${chunk.metadata.paperId ?? 'unknown'} | Source: ${chunk.metadata.sourceType}\n`;
              if (chunk.metadata.pageIndex) {
                textResponse += `Page: ${chunk.metadata.pageIndex}\n`;
              }
              if (chunk.metadata.sectionHeading) {
                textResponse += `Section: ${chunk.metadata.sectionHeading}\n`;
              }
              if (chunk.metadata.collectionLevel) {
                textResponse += `Level: ${chunk.metadata.collectionLevel}\n`;
              }
              // Truncate content for display
              const contentPreview = chunk.content.length > 300 
                ? chunk.content.slice(0, 300) + '...' 
                : chunk.content;
              textResponse += `Content: ${contentPreview}\n\n`;
            }
            break;
          }

          case 'diagnose': {
            // Index Quality Diagnosis
            // First tries to read stored QA reports from indexing (produced by index-qa.ts)
            // Falls back to live analysis if no stored report found
            
            // Key sections to check for academic papers
            // Note: 'method' includes common variations like methodology, approach
            const KEY_SECTIONS = ['abstract', 'introduction', 'method', 'experiment', 'result', 'conclusion', 'related work'];
            const METHOD_VARIATIONS = ['method', 'methodology', 'approach', 'framework', 'architecture'];
            const basePath = `/api/v2/tenants/default_tenant/databases/default_database`;

            // Helper: try to read stored QA report from ChromaDB
            const tryGetStoredQAReport = async (targetPaperId: string | undefined, targetContentHash: string | undefined): Promise<{
              found: boolean;
              report?: {
                reportId: string;
                contentHash: string;
                paperId?: string;
                timestamp: string;
                strategyVersion: string;
                parseQA: { isValid: boolean; tablesDetected: number; figuresDetected: number; issues: string[] };
                chunkQA: { isValid: boolean; totalChunks: number; orphanChunks: number; issues: string[] };
                ragQA?: { isValid: boolean; passedCount: number; testQuestionCount: number; avgFaithfulness: number; issues: string[] };
                passed: boolean;
                allIssues: string[];
              };
            }> => {
              try {
                // QA reports are stored in l1_pdf with:
                // - id starting with 'qa_' + contentHash prefix (e.g., qa_0bf68228811d_1769734976924)
                // - paperId in metadata
                // - content contains QA_REPORT_JSON marker
                const colsResponse = await fetch(`${cfg.chromaUrl}${basePath}/collections`);
                const cols = await colsResponse.json() as Array<{ name: string; id: string }>;
                const l1PdfCol = cols.find(c => c.name === 'preflight_rag_l1_pdf');
                if (!l1PdfCol) return { found: false };

                // Get all items and filter for QA reports (id starts with 'qa_')
                // No where clause needed - just get all and filter client-side
                const getResponse = await fetch(
                  `${cfg.chromaUrl}${basePath}/collections/${l1PdfCol.id}/get`,
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      include: ['documents', 'metadatas'],
                      limit: 1000,
                    }),
                  }
                );
                const data = await getResponse.json() as {
                  ids: string[];
                  documents?: (string | null)[];
                  metadatas?: (Record<string, unknown> | null)[];
                };

                if (!data.ids || data.ids.length === 0) return { found: false };

                // Find QA reports (id starts with 'qa_') and match by paperId or contentHash
                for (let i = 0; i < data.ids.length; i++) {
                  const id = data.ids[i];
                  if (!id?.startsWith('qa_')) continue; // Only QA reports

                  const meta = data.metadatas?.[i];
                  const content = data.documents?.[i] ?? '';
                  
                  // Match by paperId
                  if (targetPaperId && meta?.paperId === targetPaperId) {
                    const jsonMatch = content.match(/QA_REPORT_JSON:\n(.+)$/s);
                    if (jsonMatch) {
                      return { found: true, report: JSON.parse(jsonMatch[1]!) };
                    }
                  }
                  
                  // Match by contentHash (stored in bundleId or contentHash field, or in id prefix)
                  if (targetContentHash) {
                    const matchesBundleId = meta?.bundleId === targetContentHash;
                    const matchesContentHash = meta?.contentHash === targetContentHash;
                    const matchesIdPrefix = id.startsWith(`qa_${targetContentHash.slice(0, 12)}`);
                    
                    if (matchesBundleId || matchesContentHash || matchesIdPrefix) {
                      const jsonMatch = content.match(/QA_REPORT_JSON:\n(.+)$/s);
                      if (jsonMatch) {
                        return { found: true, report: JSON.parse(jsonMatch[1]!) };
                      }
                    }
                  }
                }

                return { found: false };
              } catch {
                return { found: false };
              }
            };

            // Helper function to diagnose a single paper
            const diagnosePaper = async (targetPaperId: string | undefined, targetBundleId: string | undefined): Promise<{
              paperId?: string;
              bundleId?: string;
              score: number;
              grade: string;
              distribution: { l1: number; l2: number; l3: number; total: number };
              sectionCoverage: Record<string, boolean>;
              issues: string[];
              details: { hasAbstract: boolean; hasIntroduction: boolean; avgL2Length: number; avgL3Length: number };
              l1Preview?: string;
            }> => {
              // Collect all chunks for this paper from all collections
              const paperChunks: Array<{ id: string; content: string; metadata: Record<string, unknown>; level: string }> = [];
              
              const collectionsToCheck = [
                { name: 'preflight_rag_l1_pdf', level: 'L1' },
                { name: 'preflight_rag_l2_section', level: 'L2' },
                { name: 'preflight_rag_l3_chunk', level: 'L3' },
              ];

              for (const col of collectionsToCheck) {
                try {
                  const whereClause = targetPaperId 
                    ? { paperId: targetPaperId } 
                    : { bundleId: targetBundleId };

                  const colsResponse = await fetch(`${cfg.chromaUrl}${basePath}/collections`);
                  const cols = await colsResponse.json() as Array<{ name: string; id: string }>;
                  const targetCol = cols.find(c => c.name === col.name);
                  if (!targetCol) continue;

                  const getResponse = await fetch(
                    `${cfg.chromaUrl}${basePath}/collections/${targetCol.id}/get`,
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        where: whereClause,
                        include: ['documents', 'metadatas'],
                        limit: 1000,
                      }),
                    }
                  );
                  const data = await getResponse.json() as {
                    ids: string[];
                    documents?: (string | null)[];
                    metadatas?: (Record<string, unknown> | null)[];
                  };

                  for (let i = 0; i < data.ids.length; i++) {
                    paperChunks.push({
                      id: data.ids[i]!,
                      content: data.documents?.[i] ?? '',
                      metadata: data.metadatas?.[i] ?? {},
                      level: col.level,
                    });
                  }
                } catch {
                  // Collection may not exist
                }
              }

              if (paperChunks.length === 0) {
                return {
                  paperId: targetPaperId,
                  bundleId: targetBundleId,
                  score: 0,
                  grade: 'F',
                  distribution: { l1: 0, l2: 0, l3: 0, total: 0 },
                  sectionCoverage: {},
                  issues: ['❌ No chunks found'],
                  details: { hasAbstract: false, hasIntroduction: false, avgL2Length: 0, avgL3Length: 0 },
                };
              }

              // Analyze distribution
              const l1Chunks = paperChunks.filter(c => c.level === 'L1');
              const l2Chunks = paperChunks.filter(c => c.level === 'L2');
              const l3Chunks = paperChunks.filter(c => c.level === 'L3');

              // Check L1 content
              const l1Content = l1Chunks.map(c => c.content.toLowerCase()).join(' ');
              const hasAbstract = l1Content.includes('abstract') || l1Chunks.some(c => 
                (c.metadata.sectionHeading as string)?.toLowerCase().includes('abstract')
              );
              const hasIntroduction = l1Content.includes('introduction') || l1Chunks.some(c => 
                (c.metadata.sectionHeading as string)?.toLowerCase().includes('introduction')
              );

              // Check section coverage
              const l2Headings = l2Chunks.map(c => 
                ((c.metadata.sectionHeading as string) ?? '').toLowerCase()
              );
              const l1Headings = l1Chunks.map(c => 
                ((c.metadata.sectionHeading as string) ?? '').toLowerCase()
              );
              const allHeadings = [...l1Headings, ...l2Headings];
              
              const coverage: Record<string, boolean> = {};
              for (const section of KEY_SECTIONS) {
                if (section === 'method') {
                  coverage[section] = allHeadings.some(h => 
                    METHOD_VARIATIONS.some(v => h.includes(v))
                  );
                } else {
                  coverage[section] = allHeadings.some(h => h.includes(section));
                }
              }
              const coveredSections = Object.values(coverage).filter(Boolean).length;

              // Calculate stats
              const avgL2Length = l2Chunks.length > 0 
                ? l2Chunks.reduce((sum, c) => sum + c.content.length, 0) / l2Chunks.length 
                : 0;
              const avgL3Length = l3Chunks.length > 0 
                ? l3Chunks.reduce((sum, c) => sum + c.content.length, 0) / l3Chunks.length 
                : 0;

              // Calculate scores
              const l1Score = (hasAbstract ? 15 : 0) + (hasIntroduction ? 15 : 0);
              const sectionScore = Math.round((coveredSections / KEY_SECTIONS.length) * 30);
              const depthScore = Math.min(20, 
                (l2Chunks.length >= 3 ? 10 : l2Chunks.length * 3) +
                (l3Chunks.length >= 10 ? 10 : l3Chunks.length)
              );
              const qualityScore = Math.min(20,
                (avgL2Length >= 500 && avgL2Length <= 5000 ? 10 : 5) +
                (avgL3Length >= 100 && avgL3Length <= 2000 ? 10 : 5)
              );

              const totalScore = l1Score + sectionScore + depthScore + qualityScore;
              const grade = totalScore >= 80 ? 'A' : totalScore >= 60 ? 'B' : totalScore >= 40 ? 'C' : 'D';

              // Identify issues
              const issues: string[] = [];
              if (!hasAbstract) issues.push('❌ Missing Abstract in L1');
              if (!hasIntroduction) issues.push('❌ Missing Introduction in L1');
              if (l1Chunks.length === 0) issues.push('❌ No L1 chunks');
              if (l2Chunks.length < 3) issues.push('⚠️ Few L2 chunks');
              if (l3Chunks.length < 5) issues.push('⚠️ Few L3 chunks');
              for (const [section, covered] of Object.entries(coverage)) {
                if (!covered) {
                  if (section === 'abstract' && hasAbstract) continue;
                  if (section === 'introduction' && hasIntroduction) continue;
                  if (['abstract', 'introduction', 'method', 'conclusion'].includes(section)) {
                    issues.push(`⚠️ Missing: ${section}`);
                  }
                }
              }

              return {
                paperId: targetPaperId,
                bundleId: targetBundleId,
                score: totalScore,
                grade,
                distribution: {
                  l1: l1Chunks.length,
                  l2: l2Chunks.length,
                  l3: l3Chunks.length,
                  total: paperChunks.length,
                },
                sectionCoverage: coverage,
                issues,
                details: {
                  hasAbstract,
                  hasIntroduction,
                  avgL2Length: Math.round(avgL2Length),
                  avgL3Length: Math.round(avgL3Length),
                },
                l1Preview: l1Chunks[0]?.content.slice(0, 200),
              };
            };

            // Batch mode: diagnose all indexed papers
            if (!paperId && !bundleId) {
              const allItems = await chromaDB.listHierarchicalContent();
              if (allItems.length === 0) {
                textResponse += '⚠️ No papers indexed yet.\n';
                structuredContent.found = false;
                break;
              }

              // Limit batch size to avoid timeout (default 20, max 100)
              const batchLimit = Math.min(limit ?? 20, 100);
              const items = allItems.slice(0, batchLimit);
              const hasMore = allItems.length > batchLimit;

              textResponse += `🔬 Batch Index Quality Diagnosis (${items.length}/${allItems.length} papers)${hasMore ? ' [limited]' : ''}\n\n`;
              
              const results: Array<{ id: string; paperId?: string; score: number; grade: string; issues: string[] }> = [];
              let totalScore = 0;
              let issueCount = 0;

              for (const item of items) {
                const result = await diagnosePaper(item.paperId, item.bundleId);
                // Use paperId if available, otherwise contentHash or id
                let displayName = item.paperId;
                if (!displayName && item.contentHash) {
                  displayName = `[hash:${item.contentHash.slice(0, 12)}...]`;
                }
                if (!displayName) {
                  displayName = item.id;
                }
                results.push({
                  id: item.id,
                  paperId: item.paperId,
                  score: result.score,
                  grade: result.grade,
                  issues: result.issues,
                });
                totalScore += result.score;
                issueCount += result.issues.length;

                // Compact output per paper
                const issueText = result.issues.length > 0 
                  ? ` - ${result.issues.slice(0, 2).join(', ')}${result.issues.length > 2 ? '...' : ''}`
                  : '';
                const missingPaperId = !item.paperId;
                textResponse += `${result.grade === 'A' ? '✅' : result.grade === 'B' ? '🟡' : '🔴'} ${displayName}${missingPaperId ? ' ⚠️' : ''}: ${result.score}/100 (${result.grade})${issueText}\n`;
              }

              const avgScore = Math.round(totalScore / items.length);
              const avgGrade = avgScore >= 80 ? 'A' : avgScore >= 60 ? 'B' : avgScore >= 40 ? 'C' : 'D';

              textResponse += `\n📊 **Summary**\n`;
              textResponse += `  • Average Score: ${avgScore}/100 (${avgGrade})\n`;
              textResponse += `  • Total Issues: ${issueCount}\n`;
              textResponse += `  • Grade A: ${results.filter(r => r.grade === 'A').length}\n`;
              textResponse += `  • Grade B: ${results.filter(r => r.grade === 'B').length}\n`;
              textResponse += `  • Grade C/D: ${results.filter(r => r.grade === 'C' || r.grade === 'D').length}\n`;
              if (hasMore) {
                textResponse += `\n💡 Showing ${items.length} of ${allItems.length} papers. Use \`limit\` to see more (max 100).\n`;
              }

              structuredContent.batchMode = true;
              structuredContent.paperCount = items.length;
              structuredContent.totalPapers = allItems.length;
              structuredContent.avgScore = avgScore;
              structuredContent.avgGrade = avgGrade;
              structuredContent.results = results;
              structuredContent.hasMore = hasMore;
              break;
            }

            // Single paper mode
            // First try to get stored QA report (from index-time QA)
            const contentList = await chromaDB.listHierarchicalContent();
            const targetItem = paperId 
              ? contentList.find(i => i.paperId === paperId)
              : contentList.find(i => i.bundleId === bundleId);
            
            const storedQA = await tryGetStoredQAReport(paperId, targetItem?.contentHash);

            if (storedQA.found && storedQA.report) {
              // Display stored QA report (from index time)
              const report = storedQA.report;
              const qaScore = report.passed ? 100 : Math.max(0, 100 - report.allIssues.length * 20);
              const qaGrade = report.passed ? 'A' : 'B';

              textResponse += `🔬 Index Quality Diagnosis (from stored QA report)\n`;
              textResponse += `Paper: ${report.paperId ?? paperId ?? bundleId}\n`;
              textResponse += `Report ID: ${report.reportId}\n`;
              textResponse += `Timestamp: ${report.timestamp}\n`;
              textResponse += `Strategy: ${report.strategyVersion}\n\n`;

              textResponse += `📊 **QA Result: ${report.passed ? 'PASSED' : 'FAILED'} (score: ${qaScore})**\n\n`;

              textResponse += `**Parse QA** ${report.parseQA.isValid ? '✅' : '❌'}\n`;
              textResponse += `  • Tables detected: ${report.parseQA.tablesDetected}\n`;
              textResponse += `  • Figures detected: ${report.parseQA.figuresDetected}\n`;
              if (report.parseQA.issues.length > 0) {
                textResponse += `  • Issues: ${report.parseQA.issues.join('; ')}\n`;
              }
              textResponse += `\n`;

              textResponse += `**Chunk QA** ${report.chunkQA.isValid ? '✅' : '❌'}\n`;
              textResponse += `  • Total chunks: ${report.chunkQA.totalChunks}\n`;
              textResponse += `  • Orphan chunks: ${report.chunkQA.orphanChunks}\n`;
              if (report.chunkQA.issues.length > 0) {
                textResponse += `  • Issues: ${report.chunkQA.issues.join('; ')}\n`;
              }
              textResponse += `\n`;

              if (report.ragQA) {
                textResponse += `**RAG QA** ${report.ragQA.isValid ? '✅' : '❌'}\n`;
                textResponse += `  • Test questions: ${report.ragQA.passedCount}/${report.ragQA.testQuestionCount} passed\n`;
                textResponse += `  • Avg faithfulness: ${report.ragQA.avgFaithfulness.toFixed(2)}\n`;
                if (report.ragQA.issues.length > 0) {
                  textResponse += `  • Issues: ${report.ragQA.issues.join('; ')}\n`;
                }
                textResponse += `\n`;
              }

              if (report.allIssues.length > 0) {
                textResponse += `⚠️ **All Issues (${report.allIssues.length})**\n`;
                for (const issue of report.allIssues) {
                  textResponse += `  • ${issue}\n`;
                }
              } else {
                textResponse += `✅ **No issues found**\n`;
              }

              structuredContent.paperId = paperId;
              structuredContent.bundleId = bundleId;
              structuredContent.storedQA = true;
              structuredContent.qaReport = report;
              structuredContent.score = qaScore;
              structuredContent.grade = qaGrade;
              break;
            }

            // Fallback: live analysis (no stored QA report found)
            const result = await diagnosePaper(paperId, bundleId);
            if (result.score === 0 && result.issues.includes('❌ No chunks found')) {
              textResponse += `⚠️ No chunks found for ${paperId ? `paperId: ${paperId}` : `bundleId: ${bundleId}`}\n`;
              structuredContent.found = false;
              break;
            }

            // Build detailed response for single paper (live analysis)
            textResponse += `🔬 Index Quality Diagnosis (live analysis)\n`;
            textResponse += `Paper: ${paperId ?? bundleId}\n\n`;
            
            textResponse += `📊 **Quality Score: ${result.score}/100 (Grade: ${result.grade})**\n`;
            textResponse += `  • L1 Presence: ${result.details.hasAbstract && result.details.hasIntroduction ? 30 : (result.details.hasAbstract || result.details.hasIntroduction ? 15 : 0)}/30 ${result.details.hasAbstract ? '✓Abstract' : '✗Abstract'} ${result.details.hasIntroduction ? '✓Intro' : '✗Intro'}\n`;
            const coveredCount = Object.values(result.sectionCoverage).filter(Boolean).length;
            textResponse += `  • Section Coverage: ${Math.round((coveredCount / KEY_SECTIONS.length) * 30)}/30 (${coveredCount}/${KEY_SECTIONS.length} sections)\n`;
            textResponse += `  • Chunk Depth: (L2:${result.distribution.l2}, L3:${result.distribution.l3})\n`;
            textResponse += `  • Chunk Quality: (avgL2:${result.details.avgL2Length}, avgL3:${result.details.avgL3Length})\n\n`;

            textResponse += `📦 **Distribution**\n`;
            textResponse += `  • L1 (Overview): ${result.distribution.l1} chunks\n`;
            textResponse += `  • L2 (Sections): ${result.distribution.l2} chunks\n`;
            textResponse += `  • L3 (Details): ${result.distribution.l3} chunks\n`;
            textResponse += `  • Total: ${result.distribution.total} chunks\n\n`;

            textResponse += `📑 **Section Coverage**\n`;
            for (const [section, covered] of Object.entries(result.sectionCoverage)) {
              textResponse += `  ${covered ? '✅' : '❌'} ${section}\n`;
            }
            textResponse += `\n`;

            if (result.issues.length > 0) {
              textResponse += `⚠️ **Issues Found (${result.issues.length})**\n`;
              for (const issue of result.issues) {
                textResponse += `  ${issue}\n`;
              }
            } else {
              textResponse += `✅ **No issues found**\n`;
            }

            if (result.l1Preview) {
              textResponse += `\n📝 **L1 Content Preview**\n---\n${result.l1Preview}...\n`;
            }

            textResponse += `\n💡 **Note**: No stored QA report found. This is live analysis.\n`;
            textResponse += `   Re-index with \`index: true\` to generate and store a QA report.\n`;

            structuredContent.paperId = paperId;
            structuredContent.bundleId = bundleId;
            structuredContent.storedQA = false;
            structuredContent.score = result.score;
            structuredContent.grade = result.grade;
            structuredContent.distribution = result.distribution;
            structuredContent.sectionCoverage = result.sectionCoverage;
            structuredContent.issues = result.issues;
            structuredContent.details = result.details;
            break;
          }
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
