/**
 * Shared types for server tool modules.
 * These types help maintain type safety when splitting tools into separate files.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PreflightConfig } from '../../config.js';

/**
 * Dependencies injected into tool registration functions.
 * This allows tools to access server instance and configuration without
 * importing them directly, improving testability and modularity.
 */
export interface ToolDependencies {
  /** MCP server instance for registering tools */
  server: McpServer;
  /** Preflight configuration */
  cfg: PreflightConfig;
}

/**
 * Standard tool response format for text + structured content.
 */
export interface ToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
}
