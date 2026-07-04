// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/secaudit.py
// © BeehiveInnovations — see ../NOTICE.md.

import { registerAdvisor } from '../index.js';
import { secauditAdvisor } from './handler.js';

registerAdvisor(secauditAdvisor);

export { secauditAdvisor };
export { SecauditInputSchema, type SecauditInput } from './schema.js';
