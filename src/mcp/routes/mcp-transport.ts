// Sprint 4.7 (D-H2.066): MCP SSE transport — /mcp/sse, /mcp/messages,
// /mcp/tools/list. POST-AUTH.

import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createOmniforgeServer, TOOLS } from '../server.js';
import type { Router } from './types.js';
import { jsonOk, notFound } from './_shared.js';

export const mcpTransportRouter: Router = async (req, url, res, ctx) => {
  if (req.method === 'GET' && url.pathname === '/mcp/tools/list') {
    jsonOk(res, { tools: TOOLS });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/mcp/sse') {
    const server = createOmniforgeServer();
    const transport = new SSEServerTransport('/mcp/messages', res);
    ctx.mcpTransports.set(transport.sessionId, transport);
    transport.onclose = () => ctx.mcpTransports.delete(transport.sessionId);
    await server.connect(transport);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/mcp/messages') {
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const transport = ctx.mcpTransports.get(sessionId);
    if (!transport) { notFound(res); return true; }
    await transport.handlePostMessage(req, res);
    return true;
  }
  return false;
};
