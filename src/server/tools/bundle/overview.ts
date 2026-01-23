/**
 * preflight_get_overview - Get bundle overview (OVERVIEW.md + START_HERE.md + AGENTS.md).
 */

import fs from 'node:fs/promises';
import * as z from 'zod';

import type { ToolDependencies } from '../types.js';
import { shouldRegisterTool } from './types.js';
import { findBundleStorageDir, getBundlePathsForId } from '../../../bundle/service.js';
import { safeJoin } from '../../../mcp/uris.js';
import { wrapPreflightError } from '../../../mcp/errorKinds.js';
import { BundleNotFoundError } from '../../../errors.js';
import type { BundleFacts } from '../../../bundle/facts.js';
import { readManifest } from '../../../bundle/manifest.js';

// ==========================================================================
// preflight_get_overview
// ==========================================================================

/**
 * Register preflight_get_overview tool.
 */
export function registerGetOverviewTool({ server, cfg }: ToolDependencies, coreOnly: boolean): void {
  if (!shouldRegisterTool('preflight_get_overview', coreOnly)) return;

  server.registerTool(
    'preflight_get_overview',
    {
      title: 'Get bundle overview',
      description:
        '⭐ **START HERE** - Get bundle overview in one call. ' +
        'This is the recommended FIRST tool to call when exploring any bundle. ' +
        'Use when: "了解项目", "项目概览", "what is this project", "show overview", "get started", "了解论文", "文档概览", "了解文档站".\n\n' +
        '**For Code Repositories:** Project summary, architecture, entry points\n' +
        '**For PDF/Documents:** Title, authors, abstract, table of contents\n' +
        '**For Web Documentation:** Site structure, main topics, page index\n\n' +
        '**Next steps after overview:**\n' +
        '1. `preflight_search_and_read` - Search and read specific content\n' +
        '2. `preflight_repo_tree` - See file/page structure\n' +
        '3. `preflight_read_file` - Read specific file/page',
      inputSchema: {
        bundleId: z.string().describe('Bundle ID to get overview for.'),
        brief: z.boolean().optional().default(false).describe(
          'If true, return concise structured summary (~500 tokens) instead of full markdown. ' +
          'Recommended for initial exploration to save tokens.'
        ),
      },
      outputSchema: {
        bundleId: z.string(),
        overview: z.string().nullable().describe('OVERVIEW.md content'),
        startHere: z.string().nullable().describe('START_HERE.md content'),
        agents: z.string().nullable().describe('AGENTS.md content'),
        sections: z.array(z.string()).describe('List of available sections'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
        if (!storageDir) {
          throw new BundleNotFoundError(args.bundleId);
        }
        const paths = getBundlePathsForId(storageDir, args.bundleId);
        const bundleRoot = paths.rootDir;

        const readFile = async (name: string): Promise<string | null> => {
          try {
            return await fs.readFile(safeJoin(bundleRoot, name), 'utf8');
          } catch {
            return null;
          }
        };

        // Brief mode: return concise structured summary
        if (args.brief) {
          let facts: BundleFacts | null = null;
          try {
            const factsContent = await readFile('analysis/FACTS.json');
            if (factsContent) {
              facts = JSON.parse(factsContent) as BundleFacts;
            }
          } catch {
            // FACTS.json may not exist or be invalid
          }

          const primaryLanguage = facts?.languages?.[0]?.language ?? 'Unknown';
          const languages = facts?.languages?.slice(0, 3).map(l => `${l.language} (${l.fileCount} files)`) ?? [];
          const totalCode = facts?.fileStructure?.totalCode ?? 0;
          const totalDocs = facts?.fileStructure?.totalDocs ?? 0;
          const frameworks = facts?.frameworks ?? [];
          const entryPoints = facts?.entryPoints?.slice(0, 3).map(e => e.file) ?? [];
          const topDirs = facts?.fileStructure?.topLevelDirs?.slice(0, 5) ?? [];

          const textLines = [
            `📦 Bundle: ${args.bundleId}`,
            `📝 Language: ${primaryLanguage}`,
            `📁 Files: ${totalCode} code, ${totalDocs} docs`,
            frameworks.length > 0 ? `🔧 Frameworks: ${frameworks.join(', ')}` : null,
            entryPoints.length > 0 ? `🚀 Entry points: ${entryPoints.join(', ')}` : null,
            topDirs.length > 0 ? `📂 Top dirs: ${topDirs.join(', ')}` : null,
            '',
            '💡 Next: Use preflight_search_and_read to find specific code, or preflight_repo_tree for full structure.',
          ].filter(Boolean);

          // Return schema-compatible structure with brief data in overview field
          return {
            content: [{ type: 'text', text: textLines.join('\n') }],
            structuredContent: {
              bundleId: args.bundleId,
              overview: textLines.join('\n'),
              startHere: null,
              agents: null,
              sections: ['brief'],
            },
          };
        }

        // Full mode: return complete markdown files
        const overview = await readFile('OVERVIEW.md');
        const startHere = await readFile('START_HERE.md');
        const agents = await readFile('AGENTS.md');

        const sections: string[] = [];
        if (overview) sections.push('OVERVIEW.md');
        if (startHere) sections.push('START_HERE.md');
        if (agents) sections.push('AGENTS.md');

        const textParts: string[] = [];
        textParts.push(`[Bundle: ${args.bundleId}] Overview (${sections.length} sections)`);
        textParts.push('');
        
        if (overview) {
          textParts.push('=== OVERVIEW.md ===');
          textParts.push(overview);
          textParts.push('');
        }
        if (startHere) {
          textParts.push('=== START_HERE.md ===');
          textParts.push(startHere);
          textParts.push('');
        }
        if (agents) {
          textParts.push('=== AGENTS.md ===');
          textParts.push(agents);
        }

        if (sections.length === 0) {
          textParts.push('⚠️ No overview files found. Try preflight_repo_tree to explore structure.');
        }

        // Detect bundle type and add tailored next steps
        let bundleType: 'code' | 'document' = 'code';
        try {
          const manifest = await readManifest(paths.manifestPath);
          if (manifest.type === 'document' || manifest.repos?.every(r => r.kind === 'pdf')) {
            bundleType = 'document';
          }
        } catch {
          // Manifest read error, assume code bundle
        }

        textParts.push('');
        textParts.push('---');
        textParts.push('');
        textParts.push('**Next steps:**');
        if (bundleType === 'document') {
          textParts.push('- Use `preflight_search_and_read` to search document content');
          textParts.push('- Use `preflight_read_file` to read the full document');
          textParts.push('- Use `preflight_repo_tree` to see bundle structure');
        } else {
          textParts.push('- Use `preflight_repo_tree` - See file structure');
          textParts.push('- Use `preflight_search` - Find specific code');
          textParts.push('- Use `preflight_read_file` - Read specific files');
        }

        const out = { bundleId: args.bundleId, overview, startHere, agents, sections };
        return {
          content: [{ type: 'text', text: textParts.join('\n') }],
          structuredContent: out,
        };
      } catch (err) {
        throw wrapPreflightError(err);
      }
    }
  );
}
