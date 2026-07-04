import type { Command } from 'commander';
import { startMcpServer } from '../../mcp/server.js';

export function registerMcpServer(program: Command): void {
  program
    .command('mcp-server')
    .description('Start Omniforge MCP server (stdio transport for Claude Code)')
    .action(async () => {
      await startMcpServer();
    });
}
