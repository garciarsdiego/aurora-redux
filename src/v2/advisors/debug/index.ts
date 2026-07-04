// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server tools/debug.py
// © BeehiveInnovations — see ../NOTICE.md.

import { registerAdvisor } from '../index.js';
import { debugAdvisor } from './handler.js';

// Side-effect registration: importing this file wires `debug` into the registry.
// Idempotent — registerAdvisor's Map.set is safe on repeat imports.
registerAdvisor(debugAdvisor);

export { debugAdvisor };
export { DebugInputSchema, type DebugInput } from './schema.js';
