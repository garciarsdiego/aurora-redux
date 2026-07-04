// Advisor loader — imports every advisor module so its top-level
// `registerAdvisor(...)` call runs. Without this, the registry stays empty
// and `getAdvisor(name)` returns undefined at runtime.
//
// Idempotent: each registerAdvisor uses Map.set, safe on repeat imports.
//
// Side-effect-only imports.

import './analyze/index.js';
import './apilookup/index.js';
import './challenge/index.js';
import './chat/index.js';
// `clink` retired 2026-05-01 round 2 (D-H2.074): redundant with cli_spawn
// task kind which delegates to real CLI binaries (claude-code / codex /
// gemini / kimi / cursor / opencode). The PAL clink simulation-via-LLM
// path was never used in any DAG and added decomposer ambiguity. For
// "use external CLI in this task" use `kind: cli_spawn, executor_hint:
// cli:<name>` directly. See decisions.md D-H2.074.
import './codereview/index.js';
import './consensus/index.js';
import './debug/index.js';
import './docgen/index.js';
import './listmodels/index.js';
import './planner/index.js';
import './precommit/index.js';
import './refactor/index.js';
import './secaudit/index.js';
import './testgen/index.js';
import './thinkdeep/index.js';
import './tracer/index.js';
import './version/index.js';

import { registry } from './index.js';

/** Snapshot of registered advisor names. Useful for MCP tool fan-out. */
export function listAdvisorNames(): string[] {
  return [...registry.keys()].sort();
}
