/**
 * Tool registration index.
 * Re-exports all tool registration functions for use in server.ts.
 */

export { registerBundleTools, type BundleToolsOptions } from './bundle/index.js';
export { registerSearchTools, type SearchToolsOptions } from './searchTools.js';
export { registerSemanticTools } from './semanticTools.js';
export { registerLspTools } from './lspTools.js';
export { registerCheckTools } from './checkTools.js';

// Legacy exports (deprecated, use registerCheckTools instead)
export { registerDocCheckTools } from './doccheckTools.js';
export { registerDuplicatesTools } from './duplicatesTools.js';

export type { ToolDependencies, ToolResponse } from './types.js';
