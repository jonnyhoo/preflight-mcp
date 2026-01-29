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
        '⭐ START HERE - Get bundle overview (summary, structure, entry points).\n' +
        'Works for code repos, PDFs, and web docs.\n' +
        'Next: search_and_read → repo_tree → read_file.\n' +
        'Use when: "overview", "概览", "what is this project".',
      inputSchema: {
        bundleId: z.string().describe('Bundle ID to get overview for.'),
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

        // Return OVERVIEW.md and other overview files
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
        } else {
          textParts.push('- Use `preflight_repo_tree` to see file structure');
          textParts.push('- Use `preflight_search_and_read` to find specific code');
          textParts.push('- Use `preflight_read_file` to read specific files');
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
