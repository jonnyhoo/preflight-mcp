/**
 * preflight_create_bundle - Create a new bundle from GitHub repos, local directories, or documents.
 */

import fs from 'node:fs/promises';
import * as z from 'zod';

import type { ToolDependencies } from '../types.js';
import { CreateBundleInputSchema, shouldRegisterTool } from './types.js';
import { createBundle, createDocumentBundle } from '../../../bundle/service.js';
import { isParseableDocument } from '../../../bundle/document-ingest.js';
import { getProgressTracker } from '../../../jobs/progressTracker.js';
import { toBundleFileUri } from '../../../mcp/uris.js';
import { wrapPreflightError } from '../../../mcp/errorKinds.js';

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
      description: 'Create a bundle from GitHub repos, local directories, PDFs, or web documentation sites.\n\n' +
        '**Examples (LLM-ready):**\n' +
        '- GitHub repo: `{"repos": [{"kind": "github", "repo": "owner/repo"}]}`\n' +
        '- Local repo: `{"repos": [{"kind": "local", "repo": "local/<folder>", "path": "C:\\\\path\\\\to\\\\dir"}]}`\n' +
        '- Web docs: `{"repos": [{"kind": "web", "url": "https://docs.example.com"}]}`\n' +
        '- Web docs (filtered): `{"repos": [{"kind": "web", "url": "https://docs.example.com", "config": {"includePatterns": ["/api/"], "maxPages": 100}}]}`\n' +
        '- Online PDF: `{"repos": [{"kind": "pdf", "url": "https://arxiv.org/pdf/2512.14982"}]}`\n' +
        '- Local PDF: `{"repos": [{"kind": "pdf", "path": "C:\\\\docs\\\\paper.pdf"}]}`\n\n' +
        '**Options:** `ifExists: "returnExisting"` to reuse existing bundle.\n' +
        'Use when: "analyze repo", "index project", "crawl docs", "分析项目", "理解代码", "爬取文档".',
      inputSchema: CreateBundleInputSchema,
      outputSchema: {
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
            // Web-specific fields
            baseUrl: z.string().optional(),
            pageCount: z.number().optional(),
            usedLlmsTxt: z.boolean().optional(),
            // PDF-specific fields
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
      },
      annotations: { openWorldHint: true },
    },
    async (args) => {
      try {
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
          
          const textResponse = docResult.created
            ? `✅ Document bundle created: ${docResult.bundleId}\nParsed: ${docResult.parsed} document(s)${docResult.skipped > 0 ? `, skipped: ${docResult.skipped}` : ''}`
            : `✅ Document bundle already exists: ${docResult.bundleId}`;
          
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
        const resources = isPdfOnly
          ? {
              manifest: toBundleFileUri({ bundleId: summary.bundleId, relativePath: 'manifest.json' }),
              documents: summary.repos
                .filter((r) => r.kind === 'pdf')
                .map((r) => toBundleFileUri({ bundleId: summary.bundleId, relativePath: `pdf_${r.id.replace(/^pdf\//, '')}.md` })),
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
        if (summary.warnings && summary.warnings.length > 0) {
          textResponse += '📢 **Network Issues Encountered:**\n';
          for (const warn of summary.warnings) {
            textResponse += `${warn}\n`;
          }
          textResponse += '\n';
        }
        textResponse += `✅ Bundle created: ${summary.bundleId}\n`;
        textResponse += `Repos: ${summary.repos.map(r => `${r.id} (${r.source})`).join(', ')}\n`;

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
