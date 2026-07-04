/**
 * External MCP — public barrel.
 *
 * Importers should use:
 *   import { listServers, ExternalMcpManager, prefixToolName } from
 *     '../v2/external-mcp/index.js';
 *
 * Internal modules (registry, client) keep their split for testability
 * but consumers see one surface here.
 */

export * from './types.js';
export * from './registry.js';
export * from './client.js';
