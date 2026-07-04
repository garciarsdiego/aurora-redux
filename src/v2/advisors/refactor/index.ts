// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1
// © BeehiveInnovations — see ../NOTICE.md.

import { registerAdvisor } from '../index.js';
import { refactorAdvisor } from './handler.js';

// Side-effect registration: importing this file wires `refactor` into the
// advisor registry. Idempotent — registerAdvisor's Map.set is safe on repeat
// imports.
registerAdvisor(refactorAdvisor);

export { refactorAdvisor };
export { RefactorInputSchema, type RefactorInput } from './schema.js';
