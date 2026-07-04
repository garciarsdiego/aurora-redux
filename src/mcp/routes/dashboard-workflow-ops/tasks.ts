// Sprint 4.5 / Agent M2-A3: task-level endpoints — patch, subagent steer/kill,
// adjust, output, thread, handoffs, retry, replay.
//
// Extracted from dashboard-workflow-ops.ts. The retry handler shares
// `dashboardRetryExecutions` (Map) with lifecycle.ts resume handler — both go
// through ctx.dashboardRetryExecutions to prevent concurrent runs of any
// kind for the same workflow.
//
// Sprint 3.5 (D-H2.066, F-REL-3): bgDb lifecycle is contained — phase 1 prep
// uses try/finally to close prepDb, phase 2 background opens its own bgDb
// inside async wrapper with nested try/finally so handle never leaks even if
// setWorkflowDone or insertEvent throws.

import type { ServerResponse } from 'node:http';
import { initDb } from '../../../db/client.js';
import { getDbPath } from '../../../utils/config.js';
import { insertEvent, insertTask, loadWorkflowById, newTaskId, setWorkflowDone } from '../../../db/persist.js';
import { withSqliteRetrySync } from '../../../db/sqlite-retry.js';
import {
  adjustDashboardTaskWithAi,
  prepareDashboardTaskRetryInPlace,
  patchDashboardTask,
} from '../../dashboard-task-ops.js';
import {
  killDashboardSubagents,
  steerDashboardSubagents,
} from '../../dashboard-subagent-ops.js';
import { continueWorkflowExecution } from '../../../brain/executor/orchestrate.js';
import { recordWorkflowCliPermissionMode } from '../../../db/workflow-cli-permission.js';
import { postTaskHandoffTool } from '../../tools/post_task_handoff.js';
import { readTaskThreadTool } from '../../tools/read_task_thread.js';
import { withCliPermissionMode, type CliPermissionMode } from '../../../executors/cli.js';
import type { Router } from '../types.js';
import { badRequest, jsonOk, notFound, readJsonBody } from '../_shared.js';
import { respondWithCollaborationTool } from './shared.js';

async function handleDashboardTaskThread(
  workflowId: string,
  taskId: string,
  res: ServerResponse,
): Promise<void> {
  await respondWithCollaborationTool(
    res,
    'task_thread_read_failed',
    `dashboard_collaboration:task_thread:${taskId}`,
    { workflow_id: workflowId, task_id: taskId },
    'Open the task inspector and confirm the task has started at least once so a task thread can be created.',
    () => readTaskThreadTool({ workflow_id: workflowId, task_id: taskId }),
  );
}

async function handleDashboardPostTaskHandoff(
  workflowId: string,
  taskId: string,
  body: unknown,
  res: ServerResponse,
): Promise<void> {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  await respondWithCollaborationTool(
    res,
    'task_handoff_post_failed',
    `dashboard_collaboration:post_handoff:${taskId}`,
    { workflow_id: workflowId, task_id: taskId },
    'Provide a non-empty handoff body and verify the task belongs to this workflow.',
    () => postTaskHandoffTool({ ...input, workflow_id: workflowId, task_id: taskId }),
  );
}

function handleDashboardTaskPatch(workflowId: string, taskId: string, body: unknown, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try { jsonOk(res, { workflow_id: workflowId, task: patchDashboardTask(db, workflowId, taskId, body) }); }
  catch (err) { badRequest(res, err instanceof Error ? err.message : String(err)); }
  finally { db.close(); }
}

function handleDashboardSubagentSteer(workflowId: string, taskId: string, body: unknown, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try { jsonOk(res, steerDashboardSubagents(db, workflowId, taskId, body)); }
  catch (err) { badRequest(res, err instanceof Error ? err.message : String(err)); }
  finally { db.close(); }
}

function handleDashboardSubagentKill(workflowId: string, taskId: string, body: unknown, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try { jsonOk(res, killDashboardSubagents(db, workflowId, taskId, body)); }
  catch (err) { badRequest(res, err instanceof Error ? err.message : String(err)); }
  finally { db.close(); }
}

async function handleDashboardTaskAdjust(workflowId: string, taskId: string, body: unknown, res: ServerResponse): Promise<void> {
  const db = initDb(getDbPath());
  try { jsonOk(res, await adjustDashboardTaskWithAi(db, workflowId, taskId, body)); }
  catch (err) { badRequest(res, err instanceof Error ? err.message : String(err)); }
  finally { db.close(); }
}

/**
 * Onda 1 follow-up — return the FULL task output_json + input_json (no preview
 * truncation). Snapshot caps these to 1k chars for transmission efficiency;
 * the operator needs them in full when diagnosing failures.
 */
function handleDashboardTaskOutput(workflowId: string, taskId: string, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try {
    const row = db.prepare(
      `SELECT id, workflow_id, output_json, input_json, status, model, executor_hint
         FROM tasks
        WHERE workflow_id = ? AND id = ?`,
    ).get(workflowId, taskId) as
      | {
          id: string;
          workflow_id: string;
          output_json: string | null;
          input_json: string | null;
          status: string;
          model: string | null;
          executor_hint: string | null;
        }
      | undefined;
    if (!row) {
      badRequest(res, `Task not found: ${taskId}`);
      return;
    }
    jsonOk(res, {
      task_id: row.id,
      workflow_id: row.workflow_id,
      status: row.status,
      model: row.model,
      executor_hint: row.executor_hint,
      output_json: row.output_json,
      input_json: row.input_json,
      output_length: row.output_json?.length ?? 0,
      input_length: row.input_json?.length ?? 0,
    });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

async function handleDashboardTaskRetry(
  workflowId: string,
  taskId: string,
  body: unknown,
  res: ServerResponse,
  dashboardRetryExecutions: Map<string, Promise<void>>,
): Promise<void> {
  if (dashboardRetryExecutions.has(workflowId)) {
    badRequest(res, `Retry already running for workflow: ${workflowId}`);
    return;
  }

  let retry: ReturnType<typeof prepareDashboardTaskRetryInPlace>;
  const prepDb = initDb(getDbPath());
  try {
    retry = prepareDashboardTaskRetryInPlace(prepDb, workflowId, taskId, body);
    if (retry.cli_permission_mode) {
      recordWorkflowCliPermissionMode(
        prepDb,
        workflowId,
        retry.cli_permission_mode as CliPermissionMode,
        'dashboard_retry',
      );
    }
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
    return;
  } finally {
    prepDb.close();
  }

  const runRetry = async () => {
    const bgDb = initDb(getDbPath());
    try {
      try {
        const executeRetryInBackground = async () => {
          const workflow = loadWorkflowById(bgDb, workflowId);
          if (!workflow) throw new Error(`Workflow not found after retry preparation: ${workflowId}`);
          await continueWorkflowExecution(bgDb, {
            ...workflow,
            status: 'executing',
            completed_at: null,
          }, {
            workspace: retry.workspace,
            objective: retry.objective,
            autoApprove: retry.auto_approve,
          });
        };
        if (retry.cli_permission_mode) {
          await withCliPermissionMode(retry.cli_permission_mode as CliPermissionMode, executeRetryInBackground);
        } else {
          await executeRetryInBackground();
        }
      } catch (err: unknown) {
        try {
          insertEvent(bgDb, {
            workflow_id: workflowId,
            task_id: taskId,
            type: 'workflow_background_error',
            payload: {
              source: 'dashboard_retry',
              error: err instanceof Error ? err.message : String(err),
            },
          });
          setWorkflowDone(bgDb, workflowId, 'failed');
        } catch (persistErr) {
          process.stderr.write(`[daemon] dashboard_retry persist-on-error failed: ${
            persistErr instanceof Error ? persistErr.message : String(persistErr)
          }\n`);
        }
      }
    } finally {
      try { bgDb.close(); } catch { /* close on already-closed handle is benign */ }
      dashboardRetryExecutions.delete(workflowId);
    }
  };

  const retryPromise = runRetry();
  dashboardRetryExecutions.set(workflowId, retryPromise);

  jsonOk(res, {
    workflow_id: retry.source_workflow_id,
    source_workflow_id: retry.source_workflow_id,
    source_task_id: retry.source_task_id,
    retry_scope: retry.retry_scope,
    task_ids: retry.task_ids,
    omitted_dependencies: retry.omitted_dependencies,
    task_count: retry.task_count,
    status: 'retry_started',
    message: 'Retry queued in the same workflow.',
  });
}

async function handleDashboardTaskReplay(
  taskId: string,
  body: unknown,
  res: ServerResponse,
): Promise<void> {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const target: 'same_workflow' | 'new_workflow' =
    input['target'] === 'new_workflow' ? 'new_workflow' : 'same_workflow';
  const promptOverride = typeof input['prompt_override'] === 'string' ? input['prompt_override'] : null;
  const modelOverride = typeof input['model_override'] === 'string' ? input['model_override'] : null;
  const contextOverride = typeof input['context_override'] === 'string' ? input['context_override'] : null;

  const db = initDb(getDbPath());
  try {
    const origRow = db
      .prepare(`SELECT * FROM tasks WHERE id = ?`)
      .get(taskId) as Record<string, unknown> | undefined;
    if (!origRow) { notFound(res, `Task not found: ${taskId}`); return; }

    const origWorkflowId = origRow['workflow_id'] as string;
    const origWorkflow = loadWorkflowById(db, origWorkflowId);
    if (!origWorkflow) { notFound(res, `Workflow not found: ${origWorkflowId}`); return; }

    let inputObj: Record<string, unknown> = {};
    if (typeof origRow['input_json'] === 'string' && origRow['input_json']) {
      try { inputObj = JSON.parse(origRow['input_json']) as Record<string, unknown>; } catch { /* keep empty */ }
    }
    if (promptOverride !== null) inputObj['prompt'] = promptOverride;
    if (contextOverride !== null) inputObj['context'] = contextOverride;

    let targetWorkflowId = origWorkflowId;
    if (target === 'new_workflow') {
      targetWorkflowId = `wf_${crypto.randomUUID()}`;
      withSqliteRetrySync(() =>
        db.prepare(
          `INSERT INTO workflows
           (id, workspace, objective, pattern_id, status, started_at, completed_at,
            created_at, created_by, estimated_cost_usd, actual_cost_usd, max_total_cost_usd, metadata)
         VALUES (?, ?, ?, NULL, 'executing', ?, NULL, ?, 'dashboard_replay', NULL, NULL, NULL, NULL)`,
        ).run(targetWorkflowId, origWorkflow.workspace, `replay:${taskId}`, Date.now(), Date.now()),
      );
    }

    const newId = newTaskId();
    insertTask(db, {
      id: newId,
      workflow_id: targetWorkflowId,
      name: `replay:${origRow['name'] as string}`,
      kind: origRow['kind'] as import('../../../types/index.js').TaskKind,
      input_json: JSON.stringify(inputObj),
      output_json: null,
      status: 'pending',
      depends_on: [],
      executor_hint: (origRow['executor_hint'] as string | null) ?? null,
      timeout_seconds: (origRow['timeout_seconds'] as number | null) ?? 300,
      max_retries: (origRow['max_retries'] as number | null) ?? 3,
      retry_count: 0,
      retry_policy: (origRow['retry_policy'] as string | null) ?? 'exponential',
      started_at: null,
      completed_at: null,
      created_at: Date.now(),
      acceptance_criteria: (origRow['acceptance_criteria'] as string | null) ?? null,
      refine_count: 0,
      max_refine: (origRow['max_refine'] as number | null) ?? 2,
      refine_feedback: null,
      model: modelOverride ?? (origRow['model'] as string | null) ?? null,
      hitl: false,
      execution_mode: (origRow['execution_mode'] as import('../../../types/index.js').ExecutionMode | undefined) ?? 'ephemeral',
    });

    // Set replay_of pointer (column added by migration 029)
    withSqliteRetrySync(() =>
      db.prepare(`UPDATE tasks SET replay_of = ? WHERE id = ?`).run(taskId, newId),
    );

    // Ensure target workflow is in executing state
    withSqliteRetrySync(() =>
      db.prepare(
        `UPDATE workflows SET status = 'executing', completed_at = NULL WHERE id = ?`,
      ).run(targetWorkflowId),
    );

    insertEvent(db, {
      workflow_id: targetWorkflowId,
      task_id: newId,
      type: 'dashboard_task_replay_enqueued',
      payload: {
        original_task_id: taskId,
        target,
        model_override: modelOverride,
        prompt_override: promptOverride !== null,
      },
    });

    const capturedWorkflow = loadWorkflowById(db, targetWorkflowId)!;
    db.close();

    // Resume in background — same pattern as handleDashboardTaskRetry
    setImmediate(() => {
      const bgDb = initDb(getDbPath());
      continueWorkflowExecution(bgDb, {
        ...capturedWorkflow,
        status: 'executing',
        completed_at: null,
      }, {
        workspace: origWorkflow.workspace,
        objective: capturedWorkflow.objective,
        autoApprove: false,
      }).catch((err: unknown) => {
        const bgDb2 = initDb(getDbPath());
        try {
          insertEvent(bgDb2, {
            workflow_id: targetWorkflowId,
            task_id: newId,
            type: 'workflow_background_error',
            payload: { source: 'dashboard_replay', error: err instanceof Error ? err.message : String(err) },
          });
          setWorkflowDone(bgDb2, targetWorkflowId, 'failed');
        } catch { /* best-effort */ } finally {
          try { bgDb2.close(); } catch { /* benign */ }
        }
      }).finally(() => {
        try { bgDb.close(); } catch { /* benign */ }
      });
    });

    jsonOk(res, { task_id: newId, workflow_id: targetWorkflowId, mode: target });
  } catch (err) {
    try { db.close(); } catch { /* benign */ }
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

export const tasksRouter: Router = async (req, url, res, ctx) => {
  const taskRetryMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/tasks\/([^/]+)\/retry$/);
  if (req.method === 'POST' && taskRetryMatch) {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    await handleDashboardTaskRetry(
      decodeURIComponent(taskRetryMatch[1] ?? ''),
      decodeURIComponent(taskRetryMatch[2] ?? ''),
      body,
      res,
      ctx.dashboardRetryExecutions,
    );
    return true;
  }
  const subagentSteerMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/tasks\/([^/]+)\/subagents\/steer$/);
  if (req.method === 'POST' && subagentSteerMatch) {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    handleDashboardSubagentSteer(
      decodeURIComponent(subagentSteerMatch[1] ?? ''),
      decodeURIComponent(subagentSteerMatch[2] ?? ''),
      body, res,
    );
    return true;
  }
  const subagentKillMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/tasks\/([^/]+)\/subagents\/kill$/);
  if (req.method === 'POST' && subagentKillMatch) {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    handleDashboardSubagentKill(
      decodeURIComponent(subagentKillMatch[1] ?? ''),
      decodeURIComponent(subagentKillMatch[2] ?? ''),
      body, res,
    );
    return true;
  }
  const taskAdjustMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/tasks\/([^/]+)\/adjust$/);
  if (req.method === 'POST' && taskAdjustMatch) {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    await handleDashboardTaskAdjust(
      decodeURIComponent(taskAdjustMatch[1] ?? ''),
      decodeURIComponent(taskAdjustMatch[2] ?? ''),
      body, res,
    );
    return true;
  }
  // Onda 1 follow-up: full output endpoint (snapshot only sends preview).
  const taskOutputMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/tasks\/([^/]+)\/output$/);
  if (req.method === 'GET' && taskOutputMatch) {
    handleDashboardTaskOutput(
      decodeURIComponent(taskOutputMatch[1] ?? ''),
      decodeURIComponent(taskOutputMatch[2] ?? ''),
      res,
    );
    return true;
  }
  const taskThreadMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/tasks\/([^/]+)\/thread$/);
  if (req.method === 'GET' && taskThreadMatch) {
    await handleDashboardTaskThread(
      decodeURIComponent(taskThreadMatch[1] ?? ''),
      decodeURIComponent(taskThreadMatch[2] ?? ''),
      res,
    );
    return true;
  }
  const taskHandoffMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/tasks\/([^/]+)\/handoffs$/);
  if (req.method === 'POST' && taskHandoffMatch) {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    await handleDashboardPostTaskHandoff(
      decodeURIComponent(taskHandoffMatch[1] ?? ''),
      decodeURIComponent(taskHandoffMatch[2] ?? ''),
      body,
      res,
    );
    return true;
  }
  const taskPatchMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/tasks\/([^/]+)$/);
  if (req.method === 'PATCH' && taskPatchMatch) {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    handleDashboardTaskPatch(
      decodeURIComponent(taskPatchMatch[1] ?? ''),
      decodeURIComponent(taskPatchMatch[2] ?? ''),
      body, res,
    );
    return true;
  }
  const taskReplayMatch = url.pathname.match(/^\/api\/dashboard\/tasks\/([^/]+)\/replay$/);
  if (req.method === 'POST' && taskReplayMatch) {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    await handleDashboardTaskReplay(decodeURIComponent(taskReplayMatch[1] ?? ''), body, res);
    return true;
  }
  return false;
};
