import type Database from 'better-sqlite3';
import type {
  Workflow,
  Task,
  TaskStatus,
  Review,
  Artifact,
  Pattern,
  CostByModel,
  CostByTask,
  CostSummary,
} from '../types/index.js';
import { eventBroker } from '../mcp/event-broker.js';
import { emitLatestEventMetadata, isSyntheticEventType } from '../mcp/sse-meta-emitter.js';
import type { WorkflowProgressEvent } from '../brain/executor/types.js';
import { redactSecrets } from '../v2/security/redact.js';
import { withSqliteRetrySync } from './sqlite-retry.js';

// Raw DB row shape (depends_on stored as JSON string, not array)
type TaskRow = Omit<Task, 'depends_on' | 'kind' | 'status' | 'hitl' | 'file_scope' | 'output_pinned'> & {
  depends_on_json: string | null;
  file_scope_json: string | null;
  kind: string;
  status: string;
  hitl: number; // 0 or 1
  output_pinned?: number; // 0 or 1 (migration 060)
};

function rowToTask(row: TaskRow): Task {
  return {
    ...row,
    kind: row.kind as Task['kind'],
    status: row.status as TaskStatus,
    depends_on: row.depends_on_json ? (JSON.parse(row.depends_on_json) as string[]) : [],
    hitl: Boolean(row.hitl),
    output_pinned: Boolean(row.output_pinned),
    ...(row.file_scope_json ? { file_scope: JSON.parse(row.file_scope_json) as string[] } : {}),
  };
}

export function newWorkflowId(): string {
  return `wf_${crypto.randomUUID()}`;
}

export function newTaskId(): string {
  return `tk_${crypto.randomUUID()}`;
}

export function newReviewId(): string {
  return `rv_${crypto.randomUUID()}`;
}

export function insertWorkflow(db: Database.Database, wf: Workflow): void {
  withSqliteRetrySync(() =>
    db.prepare(
      `INSERT INTO workflows
       (id, workspace, objective, pattern_id, status, started_at, completed_at,
        created_at, created_by, estimated_cost_usd, actual_cost_usd, max_total_cost_usd,
        max_duration_seconds, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      wf.id, wf.workspace, wf.objective, wf.pattern_id,
      wf.status, wf.started_at, wf.completed_at, wf.created_at,
      wf.created_by, wf.estimated_cost_usd, wf.actual_cost_usd, wf.max_total_cost_usd,
      wf.max_duration_seconds ?? null, wf.metadata,
    ),
  );
}

export function insertTask(db: Database.Database, task: Task): void {
  withSqliteRetrySync(() =>
    db.prepare(
      `INSERT INTO tasks
       (id, workflow_id, name, kind, input_json, output_json, status,
        depends_on_json, executor_hint, timeout_seconds, max_retries,
        retry_count, retry_policy, started_at, completed_at, created_at,
        acceptance_criteria, refine_count, max_refine, refine_feedback, model, hitl,
        execution_mode, tool_name, file_scope_json, output_pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      task.id, task.workflow_id, task.name, task.kind,
      task.input_json, task.output_json, task.status,
      JSON.stringify(task.depends_on),
      task.executor_hint, task.timeout_seconds, task.max_retries,
      task.retry_count, task.retry_policy, task.started_at,
      task.completed_at, task.created_at, task.acceptance_criteria,
      task.refine_count, task.max_refine, task.refine_feedback, task.model,
      task.hitl ? 1 : 0,
      task.execution_mode ?? 'ephemeral',
      task.tool_name ?? null,
      task.file_scope ? JSON.stringify(task.file_scope) : null,
      task.output_pinned ? 1 : 0,
    ),
  );
}

/**
 * Insert a workflow row plus its task rows atomically.
 *
 * Wraps `insertWorkflow` + `insertTask`-per-row in a single `db.transaction()`
 * so a constraint violation on any task rolls back the workflow row too. This
 * closes the orphan-workflow race window where a partial insert (workflow
 * landed, first task failed) would leave a zero-task workflow visible in the
 * dashboard list — see audit P-05 / PHASE-1.md §1.1.
 *
 * Caller contract: every `task.workflow_id` must equal `wf.id`. Mismatches
 * throw before any rows are written.
 */
export function insertWorkflowWithTasks(
  db: Database.Database,
  wf: Workflow,
  tasks: ReadonlyArray<Task>,
): void {
  for (const t of tasks) {
    if (t.workflow_id !== wf.id) {
      throw new Error(
        `insertWorkflowWithTasks: task ${t.id} workflow_id=${t.workflow_id} does not match workflow ${wf.id}`,
      );
    }
  }
  const tx = db.transaction((_wf: Workflow, _tasks: ReadonlyArray<Task>) => {
    insertWorkflow(db, _wf);
    for (const t of _tasks) insertTask(db, t);
  });
  withSqliteRetrySync(() => tx(wf, tasks));
}

export interface EventInput {
  workflow_id: string;
  task_id?: string | null;
  type: string;
  payload?: unknown;
}

// Sprint Onda-1-E: small LRU cache so we don't query the DB on every event.
const WORKSPACE_CACHE_SIZE = 256;
const workspaceCache = new Map<string, string>();

function resolveWorkspace(db: Database.Database, workflowId: string): string | null {
  const cached = workspaceCache.get(workflowId);
  if (cached !== undefined) return cached;

  const row = db
    .prepare(`SELECT workspace FROM workflows WHERE id = ?`)
    .get(workflowId) as { workspace: string } | undefined;
  const ws = row?.workspace ?? null;
  if (ws) {
    if (workspaceCache.size >= WORKSPACE_CACHE_SIZE) {
      const firstKey = workspaceCache.keys().next().value;
      if (firstKey !== undefined) workspaceCache.delete(firstKey);
    }
    workspaceCache.set(workflowId, ws);
  }
  return ws;
}

function deepRedactPayload(payload: unknown, workspace: string, db: Database.Database): unknown {
  if (typeof payload === 'string') return redactSecrets(payload, workspace, db);
  if (Array.isArray(payload)) return payload.map((v) => deepRedactPayload(v, workspace, db));
  if (payload && typeof payload === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      result[k] = deepRedactPayload(v, workspace, db);
    }
    return result;
  }
  return payload;
}

export function insertEvent(db: Database.Database, ev: EventInput): void {
  let payload = ev.payload;
  const workspace = resolveWorkspace(db, ev.workflow_id);
  if (workspace && payload !== undefined) {
    payload = deepRedactPayload(payload, workspace, db);
  }

  const insertedAt = Date.now();
  const info = withSqliteRetrySync(() =>
    db.prepare(
      `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
     VALUES (?, ?, ?, ?, ?)`,
    ).run(
      ev.workflow_id,
      ev.task_id ?? null,
      ev.type,
      payload !== undefined ? JSON.stringify(payload) : null,
      insertedAt,
    ),
  );

  // D-H2.027 — fan out to in-process SSE subscribers (REPL daemon-client mode,
  // Hermes daemon bridge, curl debugging). The broker handles the case of zero
  // subscribers as a no-op. Failures inside subscriber callbacks are isolated
  // there; this call must not throw.
  try {
    const payloadObject =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    const brokerPayload = {
      ...payloadObject,
      ...(ev.task_id && !payloadObject['task_id'] ? { task_id: ev.task_id } : {}),
    };
    const progressEvent: WorkflowProgressEvent = {
      type: ev.type as WorkflowProgressEvent['type'],
      workflow_id: ev.workflow_id,
      payload: brokerPayload,
    };
    eventBroker.publish(ev.workflow_id, progressEvent);
  } catch {
    // Broker MUST never break persistence. Silent on purpose — the inserted
    // row is already committed.
  }

  // W5-backend (2026-05-11): push `latest_event_metadata` so the dashboard
  // 8s poll becomes a backstop only. Throttled per workflow at 500 ms.
  // Recursion guard handled inside the emitter (skips synthetic types).
  try {
    if (!isSyntheticEventType(ev.type)) {
      const eventId = Number(info.lastInsertRowid);
      if (Number.isFinite(eventId)) {
        emitLatestEventMetadata(
          ev.workflow_id,
          eventId,
          ev.type,
          insertedAt,
          ev.task_id ?? null,
        );
      }
    }
  } catch {
    // Same isolation rule as the primary broker publish above — synthetic
    // emission MUST NOT break persistence.
  }
}

export function setWorkflowStarted(db: Database.Database, id: string): void {
  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE workflows SET status = 'executing', started_at = ? WHERE id = ?`,
    ).run(Date.now(), id),
  );
}

// W2 (2026-05-11): when a remediation child fails, propagate the outcome to
// the parent inline (no dynamic import to avoid a circular edge with
// quality/remediation.ts). Uses raw SQL so setWorkflowDone remains the bottom
// of the dependency graph.
//
// Only fires when the row has a parent_workflow_id. The completed-OK path
// emits a richer event from orchestrate.ts; here we only need to cover the
// FAIL path so the parent doesn't stay stuck in 'awaiting_remediation'
// forever when the child fails.
function propagateRemediationFailureToParent(db: Database.Database, childId: string): void {
  const row = db
    .prepare(`SELECT parent_workflow_id FROM workflows WHERE id = ?`)
    .get(childId) as { parent_workflow_id: string | null } | undefined;
  if (!row?.parent_workflow_id) return;

  const parentId = row.parent_workflow_id;
  const parentRow = db
    .prepare(`SELECT status FROM workflows WHERE id = ?`)
    .get(parentId) as { status: string } | undefined;
  if (parentRow?.status !== 'awaiting_remediation') return;

  db.prepare(
    `UPDATE workflows SET status = 'failed', completed_at = ? WHERE id = ?`,
  ).run(Date.now(), parentId);
  db.prepare(
    `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
     VALUES (?, NULL, 'workflow_remediation_failed', ?, ?)`,
  ).run(parentId, JSON.stringify({ child_workflow_id: childId }), Date.now());
}

export function setWorkflowDone(
  db: Database.Database,
  id: string,
  status: 'completed' | 'failed',
): void {
  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE workflows SET status = ?, completed_at = ? WHERE id = ?`,
    ).run(status, Date.now(), id),
  );

  if (status !== 'failed') return;
  try {
    propagateRemediationFailureToParent(db, id);
  } catch (err) {
    // setWorkflowDone must never throw, but a silent catch hides a stuck
    // parent in 'awaiting_remediation'. Best-effort: write a single stderr
    // line + try to insert a resolve-error event on the CHILD (id), which
    // we know was already committed. If that insertEvent also fails, give up.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[persist.setWorkflowDone] W2 parent-resolution failed for child=${id}: ${message}\n`,
    );
    try {
      db.prepare(
        `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
         VALUES (?, NULL, 'workflow_remediation_resolve_error', ?, ?)`,
      ).run(id, JSON.stringify({ error: message, scope: 'setWorkflowDone' }), Date.now());
    } catch { /* terminal — both writes failed; stderr line is the audit */ }
  }
}

export function setWorkflowMetadata(
  db: Database.Database,
  id: string,
  metadata: string,
): void {
  withSqliteRetrySync(() =>
    db.prepare(`UPDATE workflows SET metadata = ? WHERE id = ?`).run(metadata, id),
  );
}

// ── W2 (2026-05-11): remediation child workflow linkage ─────────────────
//
// `linkRemediationToParent` writes the parent_workflow_id FK onto the
// child workflow row. `getRemediationForWorkflow` answers "does workflow
// X have an active remediation child?" — the dashboard surfaces this so
// operators can navigate from a parent run to its remediation child.
// `setTaskRemediationLink` flags the ORIGINAL parent task that produced
// the failing review with the child workflow id, so logs / inspector
// can show "this task spawned remediation wf X".

export function linkRemediationToParent(
  db: Database.Database,
  childWfId: string,
  parentWfId: string,
): void {
  withSqliteRetrySync(() =>
    db
      .prepare(`UPDATE workflows SET parent_workflow_id = ? WHERE id = ?`)
      .run(parentWfId, childWfId),
  );
}

export interface RemediationLinkRow {
  childWfId: string;
  status: string;
}

export function getRemediationForWorkflow(
  db: Database.Database,
  parentWfId: string,
): RemediationLinkRow | null {
  const row = db
    .prepare(
      `SELECT id, status FROM workflows
       WHERE parent_workflow_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(parentWfId) as { id: string; status: string } | undefined;
  if (!row) return null;
  return { childWfId: row.id, status: row.status };
}

export function setTaskRemediationLink(
  db: Database.Database,
  taskId: string,
  childWfId: string,
): void {
  withSqliteRetrySync(() =>
    db
      .prepare(`UPDATE tasks SET remediation_workflow_id = ? WHERE id = ?`)
      .run(childWfId, taskId),
  );
}

/**
 * Set workflow status to an arbitrary `WorkflowStatus`. Used by W2 to flip
 * the parent workflow into 'awaiting_remediation' while the child workflow
 * runs, and to flip it back to 'completed' / 'failed' when the child
 * resolves. Kept separate from `setWorkflowDone` because that helper writes
 * `completed_at`, which would be misleading for the transient
 * 'awaiting_remediation' state.
 */
export function setWorkflowStatus(
  db: Database.Database,
  id: string,
  status: import('../types/index.js').WorkflowStatus,
): void {
  withSqliteRetrySync(() =>
    db.prepare(`UPDATE workflows SET status = ? WHERE id = ?`).run(status, id),
  );
}

export function setTaskRunning(db: Database.Database, id: string): void {
  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?`,
    ).run(Date.now(), id),
  );
}

export function setTaskCompleted(
  db: Database.Database,
  id: string,
  output: string,
): void {
  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE tasks SET status = 'completed', output_json = ?, completed_at = ? WHERE id = ?`,
    ).run(output, Date.now(), id),
  );
}

/**
 * Aurora-parity Wave 2 — pin/freeze. Toggle a task's output_pinned flag so a
 * re-run reuses its stored output_json instead of re-executing (see the
 * executor short-circuit in run-task/index.ts). The control surface (HTTP route
 * + DagCanvas toggle) lands with the UI follow-up.
 */
export function setTaskOutputPinned(
  db: Database.Database,
  id: string,
  pinned: boolean,
): void {
  withSqliteRetrySync(() =>
    db.prepare(`UPDATE tasks SET output_pinned = ? WHERE id = ?`).run(pinned ? 1 : 0, id),
  );
}

export function setTaskFailed(db: Database.Database, id: string): void {
  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE tasks SET status = 'failed', completed_at = ? WHERE id = ?`,
    ).run(Date.now(), id),
  );
}

export function setTaskSkipped(db: Database.Database, id: string, outputJson: string | null): void {
  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE tasks SET status = 'skipped', output_json = ?, completed_at = ? WHERE id = ?`,
    ).run(outputJson, Date.now(), id),
  );
}

export function setTaskPending(db: Database.Database, id: string): void {
  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE tasks SET status = 'pending', started_at = NULL WHERE id = ?`,
    ).run(id),
  );
}

export function incrementRetryCount(db: Database.Database, id: string): void {
  withSqliteRetrySync(() =>
    db.prepare(`UPDATE tasks SET retry_count = retry_count + 1 WHERE id = ?`).run(id),
  );
}

export function incrementRefineCount(db: Database.Database, id: string): void {
  withSqliteRetrySync(() =>
    db.prepare(`UPDATE tasks SET refine_count = refine_count + 1 WHERE id = ?`).run(id),
  );
}

export function setRefineFeedback(db: Database.Database, id: string, feedback: string): void {
  withSqliteRetrySync(() =>
    db.prepare(`UPDATE tasks SET refine_feedback = ? WHERE id = ?`).run(feedback, id),
  );
}

export function findExecutingWorkflow(
  db: Database.Database,
  workspace: string,
  objective: string,
): Workflow | null {
  const row = db
    .prepare(
      `SELECT * FROM workflows
       WHERE workspace = ? AND objective = ? AND status = 'executing'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(workspace, objective) as Workflow | undefined;
  return row ?? null;
}

export function insertReview(db: Database.Database, review: Review): void {
  withSqliteRetrySync(() =>
    db.prepare(
      `INSERT INTO reviews
       (id, task_id, workflow_id, reviewer_model, criteria,
        score, feedback, passed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      review.id, review.task_id, review.workflow_id, review.reviewer_model,
      review.criteria, review.score, review.feedback, review.passed, review.created_at,
    ),
  );
}

export function loadWorkflowById(db: Database.Database, id: string): Workflow | null {
  const row = db.prepare(`SELECT * FROM workflows WHERE id = ?`).get(id) as Workflow | undefined;
  return row ?? null;
}

export function loadWorkflowTasks(db: Database.Database, workflowId: string): Task[] {
  const rows = db
    .prepare(`SELECT * FROM tasks WHERE workflow_id = ? ORDER BY created_at ASC`)
    .all(workflowId) as TaskRow[];
  return rows.map(rowToTask);
}

export function insertPattern(db: Database.Database, pattern: Pattern): void {
  withSqliteRetrySync(() =>
    db.prepare(
      `INSERT INTO patterns
       (id, workspace, name, source, objective_sample, dag_json,
        usage_count, success_count, avg_duration_ms, last_used_at, created_at,
        objective_shape, template_objective, slots_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      pattern.id, pattern.workspace, pattern.name, pattern.source,
      pattern.objective_sample, pattern.dag_json, pattern.usage_count,
      pattern.success_count, pattern.avg_duration_ms, pattern.last_used_at,
      pattern.created_at,
      pattern.objective_shape ?? null,
      pattern.template_objective ?? null,
      pattern.slots_json ?? null,
    ),
  );
}

/**
 * Week 3 / Task 2.3 — find an existing pattern in a workspace whose
 * normalized objective_shape matches the one we just computed. Used by the
 * orchestrate.ts auto-capture hook to bump counters before deciding whether
 * to mint a new pattern.
 */
export function findPatternByShape(
  db: Database.Database,
  workspace: string,
  objectiveShape: string,
): Pattern | null {
  const row = db
    .prepare(
      `SELECT * FROM patterns
        WHERE workspace = ? AND objective_shape = ?
        ORDER BY usage_count DESC, created_at DESC
        LIMIT 1`,
    )
    .get(workspace, objectiveShape) as Pattern | undefined;
  return row ?? null;
}

/**
 * Bump usage_count + last_used_at AND success_count for an existing pattern
 * after a workflow that matched its shape completes successfully.
 */
export function bumpPatternSuccess(db: Database.Database, id: string): void {
  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE patterns
          SET usage_count = usage_count + 1,
              success_count = success_count + 1,
              last_used_at = ?
        WHERE id = ?`,
    ).run(Date.now(), id),
  );
}

export function loadPatternById(db: Database.Database, id: string): Pattern | null {
  const row = db.prepare(`SELECT * FROM patterns WHERE id = ?`).get(id) as Pattern | undefined;
  return row ?? null;
}

export function loadPatternByName(
  db: Database.Database,
  workspace: string,
  name: string,
): Pattern | null {
  const row = db
    .prepare(`SELECT * FROM patterns WHERE workspace = ? AND name = ?`)
    .get(workspace, name) as Pattern | undefined;
  return row ?? null;
}

export function listPatternsByWorkspace(db: Database.Database, workspace: string): Pattern[] {
  return db
    .prepare(
      `SELECT * FROM patterns WHERE workspace = ? ORDER BY last_used_at DESC NULLS LAST, created_at DESC`,
    )
    .all(workspace) as Pattern[];
}

export function deletePatternById(db: Database.Database, id: string): boolean {
  const info = withSqliteRetrySync(() =>
    db.prepare(`DELETE FROM patterns WHERE id = ?`).run(id),
  );
  return info.changes > 0;
}

export function bumpPatternUsage(db: Database.Database, id: string): void {
  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE patterns SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?`,
    ).run(Date.now(), id),
  );
}

export function insertArtifact(db: Database.Database, artifact: Artifact): void {
  withSqliteRetrySync(() =>
    db.prepare(
      `INSERT INTO artifacts
       (id, workflow_id, task_id, workspace, kind, content_path, content_inline,
        size_bytes, hash_sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      artifact.id, artifact.workflow_id, artifact.task_id, artifact.workspace,
      artifact.kind, artifact.content_path, artifact.content_inline,
      artifact.size_bytes, artifact.hash_sha256, artifact.created_at,
    ),
  );
}

export function loadArtifactsByTaskId(db: Database.Database, taskId: string): Artifact[] {
  return db
    .prepare(`SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC`)
    .all(taskId) as Artifact[];
}

export function loadArtifactsByWorkflowId(db: Database.Database, workflowId: string): Artifact[] {
  return db
    .prepare(`SELECT * FROM artifacts WHERE workflow_id = ? ORDER BY created_at ASC`)
    .all(workflowId) as Artifact[];
}

function normalizeCostNumber(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}

// Columns shared by CostSummary / CostByTask / CostByModel — SQLite can hand
// back NULLs despite the TS types, so every query result passes through here.
type CostTotals = Pick<
  CostSummary,
  'input_tokens' | 'output_tokens' | 'total_tokens' | 'total_cost_usd' | 'first_call_at' | 'last_call_at'
>;

function normalizeCostTotals<T extends CostTotals>(row: T): T {
  return {
    ...row,
    input_tokens: row.input_tokens ?? 0,
    output_tokens: row.output_tokens ?? 0,
    total_tokens: row.total_tokens ?? 0,
    total_cost_usd: normalizeCostNumber(row.total_cost_usd),
    first_call_at: row.first_call_at ?? null,
    last_call_at: row.last_call_at ?? null,
  };
}

export function getCostSummary(db: Database.Database, workflowId: string): CostSummary {
  const row = db
    .prepare(
      `SELECT
         ? AS workflow_id,
         COUNT(*) AS call_count,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS total_tokens,
         COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
         MIN(created_at) AS first_call_at,
         MAX(created_at) AS last_call_at
       FROM model_calls
       WHERE workflow_id = ?`,
    )
    .get(workflowId, workflowId) as CostSummary;
  return normalizeCostTotals(row);
}

export function getCostByTask(db: Database.Database, workflowId: string): CostByTask[] {
  const rows = db
    .prepare(
      `SELECT
         mc.workflow_id AS workflow_id,
         mc.task_id AS task_id,
         t.name AS task_name,
         COUNT(*) AS call_count,
         COALESCE(SUM(mc.input_tokens), 0) AS input_tokens,
         COALESCE(SUM(mc.output_tokens), 0) AS output_tokens,
         COALESCE(SUM(mc.input_tokens), 0) + COALESCE(SUM(mc.output_tokens), 0) AS total_tokens,
         COALESCE(SUM(mc.cost_usd), 0) AS total_cost_usd,
         MIN(mc.created_at) AS first_call_at,
         MAX(mc.created_at) AS last_call_at
       FROM model_calls mc
       LEFT JOIN tasks t ON t.id = mc.task_id
       WHERE mc.workflow_id = ?
       GROUP BY mc.workflow_id, mc.task_id, t.name
       ORDER BY total_cost_usd DESC, last_call_at DESC`,
    )
    .all(workflowId) as CostByTask[];
  return rows.map((row) => ({
    ...normalizeCostTotals(row),
    task_id: row.task_id ?? null,
    task_name: row.task_name ?? null,
  }));
}

export function getCostByModel(db: Database.Database, workflowId: string): CostByModel[] {
  const rows = db
    .prepare(
      `SELECT
         workflow_id,
         model,
         provider,
         COUNT(*) AS call_count,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS total_tokens,
         COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
         MIN(created_at) AS first_call_at,
         MAX(created_at) AS last_call_at
       FROM model_calls
       WHERE workflow_id = ?
       GROUP BY workflow_id, model, provider
       ORDER BY total_cost_usd DESC, last_call_at DESC`,
    )
    .all(workflowId) as CostByModel[];
  return rows.map((row) => ({
    ...normalizeCostTotals(row),
    provider: row.provider ?? null,
  }));
}

export function newHitlGateId(): string {
  return `hg_${crypto.randomUUID()}`;
}

export interface HitlGateInput {
  id: string;
  workflow_id: string;
  task_id?: string | null;
  gate_type: string;
  prompt: string;
  context_json?: string | null;
  channel: string;
}

export function insertHitlGate(db: Database.Database, gate: HitlGateInput): void {
  withSqliteRetrySync(() =>
    db.prepare(
      `INSERT INTO hitl_gates
       (id, workflow_id, task_id, gate_type, prompt, context_json, status, channel, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      gate.id, gate.workflow_id, gate.task_id ?? null, gate.gate_type,
      gate.prompt, gate.context_json ?? null, gate.channel, Date.now(),
    ),
  );
}

export function resolveHitlGate(
  db: Database.Database,
  id: string,
  decision: 'approved' | 'rejected' | 'modify',
): void {
  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE hitl_gates SET status = ?, decision = ?, decided_at = ? WHERE id = ?`,
    ).run(decision, decision, Date.now(), id),
  );
}

export interface HitlGateRow {
  id: string;
  workflow_id: string;
  task_id: string | null;
  status: string;
  decision: string | null;
  decision_reason: string | null;
  resolved_by_actor: string | null;
  context_json: string | null;
  channel: string | null;
  created_at: number;
  decided_at: number | null;
}

export function loadHitlGateById(
  db: Database.Database,
  id: string,
): HitlGateRow | null {
  const row = db
    .prepare(
      `SELECT id, workflow_id, task_id, status, decision, decision_reason,
              resolved_by_actor, context_json, channel, created_at, decided_at
       FROM hitl_gates WHERE id = ?`,
    )
    .get(id) as HitlGateRow | undefined;
  return row ?? null;
}

export interface HitlGateResolveResult {
  /** True only when this call observed pending → flipped status. */
  readonly first_resolver: boolean;
  /** Actor that won the race (this call's actor on success, prior actor otherwise). */
  readonly resolved_by_actor: string | null;
  /** Final status after resolution attempt. */
  readonly status: string;
  /** Final decision after resolution attempt. */
  readonly decision: string | null;
  /** True when caller lost a race to another actor. */
  readonly race_lost: boolean;
}

/**
 * Race-safe HITL gate resolve (D-H2.030). Uses a conditional UPDATE so that
 * only the first writer flips status from 'pending'. Subsequent callers see
 * `first_resolver=false` and `race_lost=true` plus the winning actor's data.
 * The plain `resolveHitlGate` function above is preserved for callers that
 * don't care about provenance (legacy MCP approve_gate tool).
 */
export function resolveHitlGateWithActor(
  db: Database.Database,
  id: string,
  decision: 'approved' | 'rejected' | 'modify',
  actorId: string,
  decisionReason?: string | null,
): HitlGateResolveResult {
  const info = withSqliteRetrySync(() =>
    db
      .prepare(
        `UPDATE hitl_gates
       SET status = ?, decision = ?, decided_at = ?, resolved_by_actor = ?,
           decision_reason = COALESCE(?, decision_reason)
       WHERE id = ? AND status = 'pending'`,
      )
      .run(decision, decision, Date.now(), actorId, decisionReason ?? null, id),
  );

  const after = loadHitlGateById(db, id);
  if (!after) {
    return {
      first_resolver: false,
      resolved_by_actor: null,
      status: 'unknown',
      decision: null,
      race_lost: false,
    };
  }

  const flipped = info.changes > 0;
  return {
    first_resolver: flipped,
    resolved_by_actor: after.resolved_by_actor,
    status: after.status,
    decision: after.decision,
    race_lost: !flipped,
  };
}

// ─── Daemon state (singleton key/value, Sprint 2.6, F-REL-2) ──────────────

export interface DaemonStateEntry {
  key: string;
  value: Record<string, unknown>;
  updated_at: number;
}

export function setDaemonState(
  db: Database.Database,
  key: string,
  value: Record<string, unknown>,
  now = Date.now(),
): void {
  withSqliteRetrySync(() =>
    db.prepare(
      `INSERT INTO daemon_state (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                    updated_at = excluded.updated_at`,
    ).run(key, JSON.stringify(value), now),
  );
}

export function getDaemonState(
  db: Database.Database,
  key: string,
): DaemonStateEntry | null {
  const row = db
    .prepare('SELECT key, value_json, updated_at FROM daemon_state WHERE key = ?')
    .get(key) as { key: string; value_json: string; updated_at: number } | undefined;
  if (!row) return null;
  let value: Record<string, unknown>;
  try { value = JSON.parse(row.value_json) as Record<string, unknown>; }
  catch { value = { _parse_error: row.value_json }; }
  return { key: row.key, value, updated_at: row.updated_at };
}

// ─────────────────────────────────────────────────────────────────────
// Advisor conversations (AETHER γ-2 stepwise memory)
// ─────────────────────────────────────────────────────────────────────
//
// Each stepwise advisor (consensus / codereview / debug / precommit /
// thinkdeep / planner) keeps an ordered list of step entries persisted as
// a JSON array under history_json. One row per task; loop appends.
// Status transitions: 'in_progress' → 'completed' | 'aborted'.

export interface AdvisorConversationStep {
  step_number: number;
  args: unknown;
  output: string;
  findings?: string;
  next_step_request?: string;
  ts: number;
}

export interface AdvisorConversationRow {
  id: string;
  advisor_name: string;
  workflow_id: string;
  task_id: string;
  started_at: number;
  completed_at: number | null;
  status: 'in_progress' | 'completed' | 'aborted';
  history: AdvisorConversationStep[];
}

type AdvisorConversationDbRow = Omit<AdvisorConversationRow, 'history'> & { history_json: string };

// Tolerant history_json parse: corrupted or non-array blobs collapse to [].
function parseAdvisorHistory(raw: string): AdvisorConversationStep[] {
  try {
    const history = JSON.parse(raw) as AdvisorConversationStep[];
    return Array.isArray(history) ? history : [];
  } catch {
    return [];
  }
}

function rowToAdvisorConversation(row: AdvisorConversationDbRow): AdvisorConversationRow {
  return {
    id: row.id,
    advisor_name: row.advisor_name,
    workflow_id: row.workflow_id,
    task_id: row.task_id,
    started_at: row.started_at,
    completed_at: row.completed_at,
    status: row.status,
    history: parseAdvisorHistory(row.history_json),
  };
}

export function newAdvisorConversationId(): string {
  return `ac_${crypto.randomUUID()}`;
}

export function insertAdvisorConversation(
  db: Database.Database,
  c: { id: string; advisor_name: string; workflow_id: string; task_id: string; started_at?: number },
): void {
  withSqliteRetrySync(() =>
    db.prepare(
      `INSERT INTO advisor_conversations
       (id, advisor_name, workflow_id, task_id, started_at, completed_at, history_json, status)
     VALUES (?, ?, ?, ?, ?, NULL, '[]', 'in_progress')`,
    ).run(c.id, c.advisor_name, c.workflow_id, c.task_id, c.started_at ?? Date.now()),
  );
}

export function appendAdvisorConversationStep(
  db: Database.Database,
  conversationId: string,
  step: AdvisorConversationStep,
): void {
  // Read-modify-write under a single transaction to avoid concurrent loops
  // racing on the JSON array. Stepwise advisors are sequential per task
  // anyway, but the explicit transaction makes the contract clear.
  const tx = db.transaction((cid: string, s: AdvisorConversationStep) => {
    const row = db
      .prepare('SELECT history_json FROM advisor_conversations WHERE id = ?')
      .get(cid) as { history_json: string } | undefined;
    if (!row) {
      throw new Error(`advisor_conversations row not found: ${cid}`);
    }
    const history = parseAdvisorHistory(row.history_json);
    history.push(s);
    db.prepare('UPDATE advisor_conversations SET history_json = ? WHERE id = ?')
      .run(JSON.stringify(history), cid);
  });
  // DB-10 — wrap the read-modify-write transaction in the SQLITE_BUSY retry
  // helper like every other write path in this module, so concurrent stepwise
  // advisor loops contending on the same DB don't surface a transient
  // SQLITE_BUSY as a hard failure.
  withSqliteRetrySync(() => tx(conversationId, step));
}

export function completeAdvisorConversation(
  db: Database.Database,
  conversationId: string,
  status: 'completed' | 'aborted' = 'completed',
): void {
  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE advisor_conversations
       SET status = ?, completed_at = ?
     WHERE id = ?`,
    ).run(status, Date.now(), conversationId),
  );
}

export function getAdvisorConversation(
  db: Database.Database,
  conversationId: string,
): AdvisorConversationRow | null {
  const row = db
    .prepare(
      `SELECT id, advisor_name, workflow_id, task_id, started_at, completed_at,
              history_json, status
         FROM advisor_conversations WHERE id = ?`,
    )
    .get(conversationId) as AdvisorConversationDbRow | undefined;
  return row ? rowToAdvisorConversation(row) : null;
}

export function getAdvisorConversationsByTask(
  db: Database.Database,
  workflowId: string,
  taskId: string,
): AdvisorConversationRow[] {
  const rows = db
    .prepare(
      `SELECT id, advisor_name, workflow_id, task_id, started_at, completed_at,
              history_json, status
         FROM advisor_conversations
         WHERE workflow_id = ? AND task_id = ?
         ORDER BY started_at ASC`,
    )
    .all(workflowId, taskId) as AdvisorConversationDbRow[];
  return rows.map(rowToAdvisorConversation);
}

// ── App settings (migration 042, D-H2.076) ────────────────────────────────

export function getSetting(db: Database.Database, key: string): unknown | null {
  const row = withSqliteRetrySync(() =>
    db
      .prepare('SELECT value_json FROM app_settings WHERE key = ?')
      .get(key),
  ) as { value_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as unknown;
  } catch {
    return null;
  }
}

export function patchSetting(db: Database.Database, key: string, value: unknown): void {
  withSqliteRetrySync(() =>
    db
      .prepare(
        `INSERT INTO app_settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), Date.now()),
  );
}

export function listSettings(db: Database.Database): Record<string, unknown> {
  const rows = withSqliteRetrySync(() =>
    db.prepare('SELECT key, value_json FROM app_settings ORDER BY key').all(),
  ) as Array<{ key: string; value_json: string }>;
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.value_json) as unknown;
    } catch {
      result[row.key] = null;
    }
  }
  return result;
}
