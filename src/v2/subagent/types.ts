// FASE 1B Bloco A.1 — Subagent type surface.
// Ported selectively from _reference/openclaw/src/agents/subagent-registry.types.ts
// adapted for Omniforge constraints: SQLite-only, single-process, no file
// persistence, depth-limited (default 3), tied to workflow Tasks.
//
// See docs/audit/REFACTORING_PROPOSALS.md is silent on this; the spec lives
// in docs/09-H2-ROADMAP-DETAILED.md § FASE 1B Bloco A.1 and decisions.md
// D-H2.016 (Fase 1B firme).

export type SubagentStatus =
  | 'pending'
  | 'running'
  | 'complete'
  | 'error'
  | 'killed'
  | 'timeout';

export type SubagentCleanup = 'delete' | 'keep';
export type SubagentSpawnMode = 'run' | 'session';

// Row shape mirroring subagent_runs (see migration 010_subagent_module.sql).
export interface SubagentRunRow {
  run_id: string;
  task_id: string;
  workflow_id: string;
  parent_run_id: string | null;
  depth: number;
  model: string | null;
  task_text: string;
  status: SubagentStatus;
  result_text: string | null;
  error_msg: string | null;
  cleanup: SubagentCleanup;
  spawn_mode: SubagentSpawnMode;
  timeout_seconds: number | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  archive_after_ms: number | null;
}

export interface RegisterSubagentRunParams {
  runId: string;
  taskId: string;
  workflowId: string;
  parentRunId?: string | null;
  depth: number;
  model?: string | null;
  taskText: string;
  cleanup?: SubagentCleanup;
  spawnMode?: SubagentSpawnMode;
  timeoutSeconds?: number | null;
}

export interface SubagentOutcome {
  status: 'ok' | 'error' | 'timeout' | 'killed';
  resultText?: string;
  errorMsg?: string;
}

export interface SpawnSubagentParams {
  task: string; // prompt / instruction handed to the spawned agent
  label?: string;
  model?: string;
  depth: number;          // depth this newly-spawned subagent will have (NOT the parent's depth)
  maxDepth?: number;      // hard ceiling — child cannot have depth >= maxDepth
  maxChildren?: number;   // override DEFAULT_MAX_CHILDREN per-spawn (e.g. skill opt-in)
  timeoutSeconds?: number;
  cleanup?: SubagentCleanup;
  spawnMode?: SubagentSpawnMode;
}

export interface SpawnSubagentCtx {
  parentTaskId: string;
  parentRunId?: string | null;
  parentModel: string | null;
  workflowId: string;
}

export interface SpawnSubagentResult {
  status: 'accepted' | 'forbidden' | 'error';
  runId?: string;
  note?: string;
  error?: string;
}

// Sane defaults; callers can override per spawn.
export const DEFAULT_MAX_DEPTH = 3;
export const DEFAULT_MAX_CHILDREN = 5;
export const DEFAULT_RUN_TIMEOUT_SECONDS = 300;

// On startup, runs in 'pending' or 'running' older than this hard ceiling
// are considered orphaned (process exited mid-flight). Used by orphan-recovery.
export const ORPHAN_CEILING_MS = 10 * 60 * 1000;

export function newSubagentRunId(): string {
  return `sa_${crypto.randomUUID()}`;
}
