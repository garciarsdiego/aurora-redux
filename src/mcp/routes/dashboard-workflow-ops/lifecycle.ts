// Sprint 4.5 / Agent M2-A3: workflow lifecycle endpoints — dag reconstruction,
// state PATCH, alert ack, pause/resume/cancel control, repeat, resume.
//
// Extracted from dashboard-workflow-ops.ts. The resume handler shares
// `dashboardRetryExecutions` (Map) with tasks.ts retry handler — both go
// through ctx.dashboardRetryExecutions to prevent concurrent runs of any
// kind for the same workflow.

import type { ServerResponse } from 'node:http';
import { initDb } from '../../../db/client.js';
import { getDbPath } from '../../../utils/config.js';
import { insertEvent, setWorkflowDone } from '../../../db/persist.js';
import { reconstructWorkflowDag } from '../../dashboard-dag-ops.js';
import {
  acknowledgeDashboardWorkflowAlert,
  patchDashboardWorkflowState,
} from '../../dashboard-run-ops.js';
import { resumeWorkflow } from '../../../brain/executor/resume.js';
import { requestWorkflowControl } from '../../../db/workflow-control.js';
import { recordWorkflowCliPermissionMode } from '../../../db/workflow-cli-permission.js';
import { withCliPermissionMode, type CliPermissionMode } from '../../../executors/cli.js';
import type { Router } from '../types.js';
import { badRequest, jsonOk, readJsonBody } from '../_shared.js';
import {
  dashboardCliPermissionMode,
  runDashboardDag,
} from '../_dashboard-dag-helpers.js';

function handleDashboardWorkflowDag(workflowId: string, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try { jsonOk(res, reconstructWorkflowDag(db, workflowId)); }
  catch (err) { badRequest(res, err instanceof Error ? err.message : String(err)); }
  finally { db.close(); }
}

function handleDashboardWorkflowState(workflowId: string, body: unknown, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try { jsonOk(res, patchDashboardWorkflowState(db, workflowId, body)); }
  catch (err) { badRequest(res, err instanceof Error ? err.message : String(err)); }
  finally { db.close(); }
}

function handleDashboardWorkflowAlertAcknowledge(workflowId: string, body: unknown, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try { jsonOk(res, acknowledgeDashboardWorkflowAlert(db, workflowId, body)); }
  catch (err) { badRequest(res, err instanceof Error ? err.message : String(err)); }
  finally { db.close(); }
}

function handleDashboardWorkflowControl(workflowId: string, body: unknown, res: ServerResponse): void {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const action = input['action'];
  if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
    badRequest(res, 'action must be one of pause|resume|cancel', {
      structured_error: {
        code: 'workflow_control_invalid_action',
        where: 'dashboard_workflow_control',
        suggested_action: 'Send { "action": "pause" | "resume" | "cancel" }.',
      },
    });
    return;
  }
  const db = initDb(getDbPath());
  try {
    jsonOk(res, requestWorkflowControl(db, workflowId, {
      action,
      reason: typeof input['reason'] === 'string' ? input['reason'] : null,
      requestedBy: typeof input['requested_by'] === 'string' ? input['requested_by'] : 'dashboard',
    }));
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err), {
      structured_error: {
        code: 'workflow_control_failed',
        where: 'dashboard_workflow_control',
        suggested_action: 'Open the workflow debugger and confirm the run is still active.',
      },
    });
  } finally {
    db.close();
  }
}

async function handleDashboardWorkflowRepeat(workflowId: string, body: unknown, res: ServerResponse): Promise<void> {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const db = initDb(getDbPath());
  try {
    const replay = reconstructWorkflowDag(db, workflowId);
    const objective = typeof input['objective'] === 'string' && input['objective'].trim()
      ? input['objective'].trim()
      : replay.objective;
    const result = await runDashboardDag({
      workspace: replay.workspace,
      objective,
      dag: replay.dag,
      auto_approve: input['auto_approve'] === true,
      cli_permission_mode: dashboardCliPermissionMode(input),
    });
    jsonOk(res, { source_workflow_id: workflowId, task_count: replay.dag.tasks.length, ...result });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

async function handleDashboardWorkflowResume(
  workflowId: string,
  body: unknown,
  res: ServerResponse,
  dashboardRetryExecutions: Map<string, Promise<void>>,
): Promise<void> {
  if (dashboardRetryExecutions.has(workflowId)) {
    badRequest(res, `Workflow operation already running for: ${workflowId}`);
    return;
  }

  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const skipFailedSteps = input['skip_failed_steps'] === true;
  const autoApprove = input['auto_approve'] === true;
  const cliMode = dashboardCliPermissionMode(input);
  if (cliMode) {
    const db = initDb(getDbPath());
    try {
      recordWorkflowCliPermissionMode(db, workflowId, cliMode as CliPermissionMode, 'dashboard_resume');
    } finally {
      db.close();
    }
  }

  const runResume = async () => {
    try {
      const executeResume = async () => {
        await resumeWorkflow(workflowId, {
          skipFailedSteps,
          autoApprove,
        });
      };
      if (cliMode) {
        await withCliPermissionMode(cliMode as CliPermissionMode, executeResume);
      } else {
        await executeResume();
      }
    } catch (err: unknown) {
      const bgDb = initDb(getDbPath());
      try {
        insertEvent(bgDb, {
          workflow_id: workflowId,
          type: 'workflow_background_error',
          payload: {
            source: 'dashboard_resume',
            error: err instanceof Error ? err.message : String(err),
          },
        });
        setWorkflowDone(bgDb, workflowId, 'failed');
      } catch (persistErr) {
        process.stderr.write(`[daemon] dashboard_resume persist-on-error failed: ${
          persistErr instanceof Error ? persistErr.message : String(persistErr)
        }\n`);
      } finally {
        try { bgDb.close(); } catch { /* benign */ }
      }
    } finally {
      dashboardRetryExecutions.delete(workflowId);
    }
  };

  const resumePromise = runResume();
  dashboardRetryExecutions.set(workflowId, resumePromise);

  jsonOk(res, {
    ok: true,
    workflow_id: workflowId,
    status: 'resume_started',
    skip_failed_steps: skipFailedSteps,
  });
}

export const lifecycleRouter: Router = async (req, url, res, ctx) => {
  const wfDagMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/dag$/);
  if (req.method === 'GET' && wfDagMatch) {
    handleDashboardWorkflowDag(decodeURIComponent(wfDagMatch[1] ?? ''), res);
    return true;
  }
  const wfStateMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/state$/);
  if (req.method === 'PATCH' && wfStateMatch) {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    handleDashboardWorkflowState(decodeURIComponent(wfStateMatch[1] ?? ''), body, res);
    return true;
  }
  const wfAlertAckMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/alerts\/ack$/);
  if (req.method === 'POST' && wfAlertAckMatch) {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    handleDashboardWorkflowAlertAcknowledge(decodeURIComponent(wfAlertAckMatch[1] ?? ''), body, res);
    return true;
  }
  const wfControlMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/control$/);
  if (req.method === 'POST' && wfControlMatch) {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    handleDashboardWorkflowControl(decodeURIComponent(wfControlMatch[1] ?? ''), body, res);
    return true;
  }
  const wfRepeatMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/repeat$/);
  if (req.method === 'POST' && wfRepeatMatch) {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    await handleDashboardWorkflowRepeat(decodeURIComponent(wfRepeatMatch[1] ?? ''), body, res);
    return true;
  }
  const wfResumeMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/resume$/);
  if (req.method === 'POST' && wfResumeMatch) {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    await handleDashboardWorkflowResume(
      decodeURIComponent(wfResumeMatch[1] ?? ''),
      body,
      res,
      ctx.dashboardRetryExecutions,
    );
    return true;
  }
  return false;
};
