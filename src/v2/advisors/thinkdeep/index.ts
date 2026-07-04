// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/thinkdeep.py
// © BeehiveInnovations — see ../NOTICE.md.

import { registerAdvisor } from '../index.js';
import { thinkdeepAdvisor } from './handler.js';

registerAdvisor(thinkdeepAdvisor);

export { thinkdeepAdvisor };
export { ThinkDeepInputSchema, type ThinkDeepInput } from './schema.js';
