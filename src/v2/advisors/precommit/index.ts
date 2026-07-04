// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/precommit.py
// © BeehiveInnovations — see ../NOTICE.md.

import { registerAdvisor } from '../index.js';
import { precommitAdvisor } from './handler.js';

registerAdvisor(precommitAdvisor);

export { precommitAdvisor };
export { PrecommitInputSchema, type PrecommitInput } from './schema.js';
