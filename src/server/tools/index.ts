/**
 * Tool registration index.
 * Re-exports all tool registration functions for use in server.ts.
 */

import type { ToolDependencies } from './types.js';
import { registerRagQueryTool } from './ragQueryTool.js';
import { registerRagManageTool } from './ragManageTool.js';

export { registerBundleTools, type BundleToolsOptions } from './bundle/index.js';
export { registerSearchTools } from './searchTools.js';
export { registerLspTools } from './lspTools.js';
export { registerCheckTools } from './checkTools.js';
export { registerDistillTools } from './distillTools.js';
export { registerArxivTools } from './arxivTools.js';

// Re-export individual RAG tools for fine-grained control
export { registerRagQueryTool } from './ragQueryTool.js';
export { registerRagManageTool } from './ragManageTool.js';

/**
 * Register all RAG tools (backward compatible wrapper).
 */
export function registerRagTools(deps: ToolDependencies): void {
  registerRagQueryTool(deps);
  registerRagManageTool(deps);
}

export type { ToolDependencies, ToolResponse } from './types.js';
