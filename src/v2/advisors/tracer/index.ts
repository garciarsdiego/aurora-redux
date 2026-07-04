// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/tracer.py
// © BeehiveInnovations — see ../NOTICE.md.

import { registerAdvisor } from '../index.js';
import { tracerAdvisor } from './handler.js';

registerAdvisor(tracerAdvisor);

export { tracerAdvisor };
export { TracerInputSchema, type TracerInput } from './schema.js';
