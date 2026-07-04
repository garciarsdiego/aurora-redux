// FASE 1B Bloco A.1 — Subagent spawn surface.
// Validates guard conditions (depth, max-children) then registers the run as
// 'pending'. Intentionally does NOT dispatch execution — that is Bloco A.2.
//
// No LLM call here. No import from outbox/inbox/control (parallel agents).

import type Database from 'better-sqlite3';
import type { SpawnSubagentParams, SpawnSubagentCtx, SpawnSubagentResult } from './types.js';
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_CHILDREN,
  DEFAULT_RUN_TIMEOUT_SECONDS,
  newSubagentRunId,
} from './types.js';
import { countActiveDescendants, registerSubagentRun } from './registry.js';

export async function spawnSubagent(
  db: Database.Database,
  params: SpawnSubagentParams,
  ctx: SpawnSubagentCtx,
): Promise<SpawnSubagentResult> {
  // ── 1. Depth guard ──────────────────────────────────────────────────────
  const maxDepth = params.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (params.depth >= maxDepth) {
    return { status: 'forbidden', note: 'depth exceeds maxDepth' };
  }

  // ── 2. Max-children guard (only when there is a parent run) ─────────────
  if (ctx.parentRunId != null) {
    const maxChildren = params.maxChildren ?? DEFAULT_MAX_CHILDREN;
    const activeCount = countActiveDescendants(db, ctx.parentRunId);
    if (activeCount >= maxChildren) {
      return { status: 'forbidden', note: 'max children exceeded' };
    }
  }

  // ── 3. Resolve model ────────────────────────────────────────────────────
  const model = params.model ?? ctx.parentModel ?? null;

  // ── 4. Resolve timeout ──────────────────────────────────────────────────
  const timeoutSeconds = params.timeoutSeconds ?? DEFAULT_RUN_TIMEOUT_SECONDS;

  // ── 5. Generate run ID ──────────────────────────────────────────────────
  const runId = newSubagentRunId();

  // ── 6. Persist to DB ────────────────────────────────────────────────────
  try {
    registerSubagentRun(db, {
      runId,
      taskId: ctx.parentTaskId,
      workflowId: ctx.workflowId,
      parentRunId: ctx.parentRunId ?? null,
      depth: params.depth,
      model,
      taskText: params.task,
      cleanup: params.cleanup ?? 'delete',
      spawnMode: params.spawnMode ?? 'run',
      timeoutSeconds,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[spawn] registerSubagentRun failed: ${message}\n`);
    return { status: 'error', error: message };
  }

  // ── 7. Return accepted ──────────────────────────────────────────────────
  return {
    status: 'accepted',
    runId,
    note: 'subagent registered; awaiting Bloco A.2 executor dispatch',
  };
}
