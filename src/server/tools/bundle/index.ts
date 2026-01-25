/**
 * Bundle management tools - create, update, delete, repair, list, etc.
 *
 * This module aggregates all bundle-related tools and exports
 * the main registerBundleTools function.
 */

import type { ToolDependencies } from '../types.js';
import { type BundleToolsOptions } from './types.js';

// Tool registration functions
import { registerCreateBundleTool } from './create.js';
import { registerListBundlesTool } from './list.js';
import { registerDeleteBundleTool } from './delete.js';
import { registerGetOverviewTool } from './overview.js';
import { registerReadFileTool } from './read.js';
import { registerRepoTreeTool } from './tree.js';
import { registerUpdateBundleTool } from './update.js';
import { registerCleanupOrphansTool } from './cleanup.js';
import { registerGetTaskStatusTool } from './taskStatus.js';

// Re-export types
export { type BundleToolsOptions } from './types.js';

/**
 * Register bundle management tools.
 * @param deps - Server and config dependencies
 * @param options - Options for registration
 * @param options.coreOnly - If true, only register core tools (6 of 10)
 */
export function registerBundleTools(deps: ToolDependencies, options?: BundleToolsOptions): void {
  const coreOnly = options?.coreOnly ?? false;

  // Core tools (6)
  registerCreateBundleTool(deps, coreOnly);
  registerListBundlesTool(deps, coreOnly);
  registerDeleteBundleTool(deps, coreOnly);
  registerGetOverviewTool(deps, coreOnly);
  registerReadFileTool(deps, coreOnly);
  registerRepoTreeTool(deps, coreOnly);

  // Non-core tools (3)
  registerUpdateBundleTool(deps, coreOnly);
  registerCleanupOrphansTool(deps, coreOnly);
  registerGetTaskStatusTool(deps, coreOnly);
}
