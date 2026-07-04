// Copyright 2024 BeehiveInnovations / Omniforge Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server tools/listmodels.py
// © BeehiveInnovations — see ../NOTICE.md.

import { registerAdvisor } from '../index.js';
import { listmodelsAdvisor } from './handler.js';

// Side-effect registration: importing this file wires `listmodels` into the
// advisor registry. Idempotent — registerAdvisor's Map.set is safe on repeat imports.
registerAdvisor(listmodelsAdvisor);

export { listmodelsAdvisor };
export { ListmodelsInputSchema, type ListmodelsInput } from './schema.js';
