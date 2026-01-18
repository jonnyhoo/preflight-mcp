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
        '⭐ **START HERE** - Get project overview in one call. Returns OVERVIEW.md + START_HERE.md + AGENTS.md. ' +
        'This is the recommended FIRST tool to call when exploring any bundle. ' +
        'Use when: "了解项目", "项目概览", "what is this project", "show overview", "get started".\n\n' +
        '**Returns:**\n' +
        '- OVERVIEW.md: AI-generated project summary & architecture\n' +
        '- START_HERE.md: Key entry points & critical paths\n' +
        '- AGENTS.md: AI agent usage guide\n\n' +
        '**Next steps after overview:**\n' +
        '1. `preflight_repo_tree` - See file structure\n' +
        '2. `preflight_search` - Find specific code\n' +
        '3. `preflight_read_file` - Read specific files',
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
