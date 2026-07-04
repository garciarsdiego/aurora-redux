// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/codereview.py
// © BeehiveInnovations — see ../NOTICE.md.

import { registerAdvisor } from '../index.js';
import { codereviewAdvisor } from './handler.js';

registerAdvisor(codereviewAdvisor);

export { codereviewAdvisor };
export { CodereviewInputSchema, type CodereviewInput } from './schema.js';
