// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/consensus.py
// © BeehiveInnovations — see ../NOTICE.md.

import { registerAdvisor } from '../index.js';
import { consensusAdvisor } from './handler.js';

registerAdvisor(consensusAdvisor);

export { consensusAdvisor };
export { ConsensusInputSchema, type ConsensusInput } from './schema.js';
