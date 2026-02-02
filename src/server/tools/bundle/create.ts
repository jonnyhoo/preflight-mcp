/**
 * preflight_create_bundle - Create a new bundle from GitHub repos, local directories, or documents.
 */

import fs from 'node:fs/promises';
import * as z from 'zod';

import type { ToolDependencies } from '../types.js';
import { CreateBundleInputSchema, shouldRegisterTool } from './types.js';
import { createBundle, createDocumentBundle, createPdfBundlesBatch } from '../../../bundle/service.js';
import { isParseableDocument } from '../../../bundle/document-ingest.js';
import { getProgressTracker } from '../../../jobs/progressTracker.js';
import { toBundleFileUri } from '../../../mcp/uris.js';
import { wrapPreflightError } from '../../../mcp/errorKinds.js';
import { getConfigWarnings } from '../../../config.js';

// ==========================================================================
// preflight_create_bundle
// ==========================================================================

/**
 * Register preflight_create_bundle tool.
 */
export function registerCreateBundleTool({ server, cfg }: ToolDependencies, coreOnly: boolean): void {
  if (!shouldRegisterTool('preflight_create_bundle', coreOnly)) return;

  server.registerTool(
    'preflight_create_bundle',
    {
      title: 'Create bundle',
      description:
        'Create a bundle from GitHub repos, local directories, PDFs, web docs, or markdown folders.\n' +
        'Supports: code repos, documentation-only repos (no CARD.json needed), data repos (csv/json/yaml).\n' +
        '**Batch PDF**: Multiple PDFs in repos array → creates SEPARATE bundles (efficient batch parsing).\n' +
        'Example: `{"repos": [{"kind": "github", "repo": "owner/repo"}]}`\n' +
        'Batch PDF: `{"repos": [{"kind": "pdf", "path": "a.pdf"}, {"kind": "pdf", "path": "b.pdf"}]}`\n' +
        'PDF parsing: MinerU (default) | vlmParser=true (VLM) | ruleBasedParser=true (no API).\n' +
        'Use when: "analyze repo", "index project", "分析项目", "批量解析PDF", "爬取文档", "索引文档".',
      inputSchema: CreateBundleInputSchema,
      outputSchema: {
        // Single bundle creation fields
        bundleId: z.string().optional(),
        createdAt: z.string().optional(),
        updatedAt: z.string().optional(),
        resources: z.object({
          startHere: z.string().optional(),
          agents: z.string().optional(),
          overview: z.string().optional(),
          manifest: z.string().optional(),
          documents: z.array(z.string()).optional(),
        }).optional(),
        repos: z.array(
          z.object({
            kind: z.enum(['github', 'local', 'web', 'pdf']),
            id: z.string(),
            source: z.enum(['git', 'archive', 'local', 'crawl', 'download']).optional(),
            headSha: z.string().optional(),
            notes: z.array(z.string()).optional(),
            baseUrl: z.string().optional(),
            pageCount: z.number().optional(),
            usedLlmsTxt: z.boolean().optional(),
            pdfUrl: z.string().optional(),
            localPath: z.string().optional(),
            fileSize: z.number().optional(),
          })
        ).optional(),
        warnings: z.array(z.string()).optional(),
        status: z.enum(['in-progress', 'complete']).optional(),
        message: z.string().optional(),
        taskId: z.string().optional(),
        fingerprint: z.string().optional(),
        requestedRepos: z.array(z.string()).optional(),
        startedAt: z.string().optional(),
        elapsedSeconds: z.number().optional(),
        currentPhase: z.string().optional(),
        currentProgress: z.number().optional(),
        currentMessage: z.string().optional(),
        // Batch PDF creation fields
        batchResult: z.boolean().optional().describe('True when batch PDF mode was used'),
        bundleCount: z.number().optional().describe('Number of bundles created in batch'),
        failedCount: z.number().optional().describe('Number of failed PDFs in batch'),
        bundles: z.array(z.object({
          bundleId: z.string(),
          source: z.string().optional(),
        })).optional().describe('Created bundles in batch mode'),
        failed: z.array(z.object({
          source: z.string(),
          error: z.string(),
        })).optional().describe('Failed PDFs in batch mode'),
        totalTimeMs: z.number().optional().describe('Total batch processing time'),
      },
      annotations: { openWorldHint: true },
    },
    async (args) => {
      try {
        // Check for config warnings that LLM should know about
        const configWarnings = getConfigWarnings();
        
        // Check if this is a multi-PDF request that should create separate bundles
        const isPdfOnlyRequest = args.repos.length > 0 && args.repos.every((r: any) => r.kind === 'pdf');
        const hasMultiplePdfs = isPdfOnlyRequest && args.repos.length > 1;
        
        // Multi-PDF: Create separate bundles for each PDF (batch parse, individual bundles)
        if (hasMultiplePdfs) {
          const pdfInputs = args.repos.map((r: any) => ({
            url: r.url,
            path: r.path,
            name: r.name,
            vlmParser: r.vlmParser,
            ruleBasedParser: r.ruleBasedParser,
          }));
          
          const batchResult = await createPdfBundlesBatch(cfg, pdfInputs, {
            ifExists: args.ifExists as any,
          });
          
          server.sendResourceListChanged();
          
          let textResponse = '';
          
          // Show config warnings first
          if (configWarnings.length > 0) {
            textResponse += '⚠️ **Configuration Issues:**\n';
            for (const warn of configWarnings) {
              textResponse += `- ${warn}\n`;
            }
            textResponse += '\n';
          }
          
          textResponse += `✅ **Batch PDF Bundle Creation Complete**\n`;
          textResponse += `Created: ${batchResult.bundles.length} bundles | Failed: ${batchResult.failed.length} | Time: ${Math.round(batchResult.totalTimeMs / 1000)}s\n\n`;
          
          // List created bundles
          if (batchResult.bundles.length > 0) {
            textResponse += '**Created Bundles:**\n';
            for (const bundle of batchResult.bundles) {
              const pdfInfo = bundle.repos[0];
              const source = pdfInfo?.pdfUrl ?? pdfInfo?.localPath ?? pdfInfo?.id ?? 'unknown';
              textResponse += `- \`${bundle.bundleId}\` ← ${source}\n`;
            }
            textResponse += '\n';
          }
          
          // List failures
          if (batchResult.failed.length > 0) {
            textResponse += '**Failed:**\n';
            for (const fail of batchResult.failed) {
              textResponse += `- ${fail.source}: ${fail.error}\n`;
            }
            textResponse += '\n';
          }
          
        textResponse += '💡 **Next steps:**\n';
        textResponse += '- Use `preflight_get_overview` with a bundle ID to see title, abstract, and structure\n';
        textResponse += '- Use `preflight_search_and_read` to search specific content\n';
        textResponse += '- Use `preflight_rag` with `index: true` to enable RAG queries\n';
          
          return {
            content: [{ type: 'text', text: textResponse }],
            structuredContent: {
              batchResult: true,
              bundleCount: batchResult.bundles.length,
              failedCount: batchResult.failed.length,
              bundles: batchResult.bundles.map(b => ({
                bundleId: b.bundleId,
                source: b.repos[0]?.pdfUrl ?? b.repos[0]?.localPath ?? b.repos[0]?.id,
              })),
              failed: batchResult.failed,
              totalTimeMs: batchResult.totalTimeMs,
            },
          };
        }
        
        // Check if all inputs are document files (PDF, Office, etc.)
        const localPaths = args.repos
          .filter((r: any) => r.kind === 'local' && r.path)
          .map((r: any) => r.path as string);
        
        let documentPaths: string[] = [];
        for (const p of localPaths) {
          try {
            const st = await fs.stat(p);
            if (st.isFile() && isParseableDocument(p)) {
              documentPaths.push(p);
            }
          } catch {
            // Path doesn't exist or can't be accessed, let createBundle handle it
          }
        }
        
        // If all local inputs are document files, use createDocumentBundle
        if (documentPaths.length > 0 && documentPaths.length === localPaths.length && args.repos.length === localPaths.length) {
          const docResult = await createDocumentBundle(cfg, documentPaths, {
            ifExists: args.ifExists === 'returnExisting' ? 'returnExisting' 
                    : args.ifExists === 'updateExisting' ? 'update' 
                    : 'error',
          });
          
          const resources = {
            manifest: toBundleFileUri({ bundleId: docResult.bundleId, relativePath: 'manifest.json' }),
          };
          
          server.sendResourceListChanged();
          
          // Build response with config warnings first
          let textResponse = '';
          if (configWarnings.length > 0) {
            textResponse += '⚠️ **Configuration Issues:**\n';
            for (const warn of configWarnings) {
              textResponse += `- ${warn}\n`;
            }
            textResponse += '\n';
          }
          
          textResponse += docResult.created
            ? `✅ Document bundle created: ${docResult.bundleId}\nParsed: ${docResult.parsed} document(s)${docResult.skipped > 0 ? `, skipped: ${docResult.skipped}` : ''}`
            : `✅ Document bundle already exists: ${docResult.bundleId}`;
          
          // Read and include the parsed md content directly
          const { findBundleStorageDir, getBundlePathsForId } = await import('../../../bundle/service.js');
          const storageDir = await findBundleStorageDir(cfg.storageDirs, docResult.bundleId);
          if (storageDir) {
            const paths = getBundlePathsForId(storageDir, docResult.bundleId);
            const docsDir = `${paths.rootDir}/docs`;
            try {
              const files = await fs.readdir(docsDir);
              const mdFiles = files.filter((f) => f.endsWith('.md'));
              if (mdFiles.length > 0) {
                textResponse += '\n\n---\n';
                for (const mdFile of mdFiles) {
                  try {
                    const mdContent = await fs.readFile(`${docsDir}/${mdFile}`, 'utf8');
                    textResponse += `\n${mdContent}\n`;
                  } catch {
                    // md file not found, skip
                  }
                }
              }
            } catch {
              // docs dir not found, skip
            }
          }
          
          return {
            content: [{ type: 'text', text: textResponse }],
            structuredContent: {
              bundleId: docResult.bundleId,
              created: docResult.created,
              parsed: docResult.parsed,
              skipped: docResult.skipped,
              errors: docResult.errors,
              resources,
            },
          };
        }
        
        const summary = await createBundle(
          cfg,
          {
            repos: args.repos,
          },
          { ifExists: args.ifExists }
        );

        const isPdfOnly = args.repos.length > 0 && args.repos.every((r: any) => r.kind === 'pdf');
        const pdfMdFiles = isPdfOnly
          ? summary.repos
              .filter((r) => r.kind === 'pdf')
              .map((r) => `pdf_${r.id.replace(/^pdf\//, '')}.md`)
          : [];
        const resources = isPdfOnly
          ? {
              manifest: toBundleFileUri({ bundleId: summary.bundleId, relativePath: 'manifest.json' }),
              documents: pdfMdFiles.map((f) => toBundleFileUri({ bundleId: summary.bundleId, relativePath: f })),
            }
          : {
              startHere: toBundleFileUri({ bundleId: summary.bundleId, relativePath: 'START_HERE.md' }),
              agents: toBundleFileUri({ bundleId: summary.bundleId, relativePath: 'AGENTS.md' }),
              overview: toBundleFileUri({ bundleId: summary.bundleId, relativePath: 'OVERVIEW.md' }),
              manifest: toBundleFileUri({ bundleId: summary.bundleId, relativePath: 'manifest.json' }),
            };

        server.sendResourceListChanged();

        const out = {
          ...summary,
          resources,
        };

        let textResponse = '';
        
        // Show config warnings first (critical for LLM to understand issues)
        if (configWarnings.length > 0) {
          textResponse += '⚠️ **Configuration Issues:**\n';
          for (const warn of configWarnings) {
            textResponse += `- ${warn}\n`;
          }
          textResponse += '\n';
        }
        
        if (summary.warnings && summary.warnings.length > 0) {
          textResponse += '📢 **Network Issues Encountered:**\n';
          for (const warn of summary.warnings) {
            textResponse += `${warn}\n`;
          }
          textResponse += '\n';
        }
        textResponse += `✅ Bundle created: ${summary.bundleId}\n`;
        textResponse += `Repos: ${summary.repos.map(r => `${r.id} (${r.source})`).join(', ')}\n`;

        // For PDF bundles, read and include OVERVIEW.md (progressive disclosure)
        if (isPdfOnly) {
          const { findBundleStorageDir, getBundlePathsForId } = await import('../../../bundle/service.js');
          const storageDir = await findBundleStorageDir(cfg.storageDirs, summary.bundleId);
          if (storageDir) {
            const paths = getBundlePathsForId(storageDir, summary.bundleId);
            try {
              const overviewPath = `${paths.rootDir}/OVERVIEW.md`;
              const overviewContent = await fs.readFile(overviewPath, 'utf8');
              textResponse += '\n---\n';
              textResponse += `\n${overviewContent}\n`;
            } catch {
              // OVERVIEW.md not found, skip
            }
          }
        }

        // Unified Next steps for all bundle types
        textResponse += '\n---\n\n';
        textResponse += '💡 **Next steps:**\n';
        
        // Detect bundle type for appropriate hints
        const isWebOnly = args.repos.length > 0 && args.repos.every((r: any) => r.kind === 'web');
        
        if (isPdfOnly) {
          textResponse += '- Use `preflight_search_and_read` to search specific content\n';
          textResponse += '- Use `preflight_read_file` with the `.md` file to read full document\n';
        } else if (isWebOnly) {
          textResponse += '- Use `preflight_get_overview` to see documentation overview\n';
          textResponse += '- Use `preflight_repo_tree` to see page structure\n';
          textResponse += '- Use `preflight_search_and_read` to search documentation\n';
        } else {
          // Code repository
          textResponse += '- Use `preflight_get_overview` to see project summary and architecture\n';
          textResponse += '- Use `preflight_repo_tree` to see file structure\n';
          textResponse += '- Use `preflight_search_and_read` to find specific code\n';
        }

        return {
          content: [{ type: 'text', text: textResponse }],
          structuredContent: out,
        };
      } catch (err: any) {
        if (err?.code === 'BUNDLE_IN_PROGRESS') {
          const elapsedSec = err.startedAt
            ? Math.round((Date.now() - new Date(err.startedAt).getTime()) / 1000)
            : 0;
          
          const tracker = getProgressTracker();
          const task = err.taskId ? tracker.getTask(err.taskId) : undefined;
          
          const out = {
            status: 'in-progress' as const,
            message: `Bundle creation already in progress. Use preflight_get_task_status to check progress.`,
            taskId: err.taskId,
            fingerprint: err.fingerprint,
            requestedRepos: err.repos,
            startedAt: err.startedAt,
            elapsedSeconds: elapsedSec,
            currentPhase: task?.phase,
            currentProgress: task?.progress,
            currentMessage: task?.message,
          };
          
          return {
            content: [{ type: 'text', text: `⚠️ Bundle creation in progress (${elapsedSec}s elapsed). ${task ? `Current: ${task.phase} (${task.progress}%) - ${task.message}` : 'Use preflight_get_task_status to check progress.'}` }],
            structuredContent: out,
          };
        }
        throw wrapPreflightError(err);
      }
    }
  );
}
