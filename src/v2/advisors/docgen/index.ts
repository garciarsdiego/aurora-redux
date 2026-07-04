// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/docgen.py
// © BeehiveInnovations — see ../NOTICE.md.

import { registerAdvisor } from '../index.js';
import { docgenAdvisor } from './handler.js';

registerAdvisor(docgenAdvisor);

export { docgenAdvisor };
export { DocgenInputSchema, type DocgenInput } from './schema.js';
