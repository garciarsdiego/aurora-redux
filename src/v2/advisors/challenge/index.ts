// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/challenge.py
// © BeehiveInnovations — see ../NOTICE.md.

import { registerAdvisor } from '../index.js';
import { challengeAdvisor } from './handler.js';

// Side-effect registration: importing this file (or the parent advisors
// barrel that re-exports it) wires `challenge` into the registry. Idempotent —
// registerAdvisor's Map.set is safe on repeat imports.
registerAdvisor(challengeAdvisor);

export { challengeAdvisor };
export { ChallengeInputSchema, type ChallengeInput, type ChallengeOutput } from './schema.js';
