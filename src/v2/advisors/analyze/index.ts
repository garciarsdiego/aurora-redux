// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/analyze.py
// © BeehiveInnovations — see ../NOTICE.md.

import { registerAdvisor } from '../index.js';
import { analyzeAdvisor } from './handler.js';

registerAdvisor(analyzeAdvisor);

export { analyzeAdvisor };
export { AnalyzeInputSchema, type AnalyzeInput } from './schema.js';
