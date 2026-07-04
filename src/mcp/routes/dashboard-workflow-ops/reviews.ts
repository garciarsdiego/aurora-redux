// Sprint 4.5 / Agent M2-A3: architecture review, product review, council
// (dry-run + live), fix-task creation.
//
// Extracted from dashboard-workflow-ops.ts. F6-4: live council uses the real
// advisor registry; advisor loader must be imported once so getAdvisor()
// returns populated entries.

import type { ServerResponse } from 'node:http';
import { initDb } from '../../../db/client.js';
import { getDbPath } from '../../../utils/config.js';
import { loadWorkflowById } from '../../../db/persist.js';
import { createCouncilRun } from '../../../context/council.js';
import '../../../v2/advisors/loader.js';
import { runLiveCouncil } from '../../../context/advisors.js';
import { createFixTaskTool } from '../../tools/create_fix_task.js';
import { requestArchitectureReviewTool } from '../../tools/request_architecture_review.js';
import { requestProductReviewTool } from '../../tools/request_product_review.js';
import type { Router } from '../types.js';
import { badRequest, jsonOk, notFound, readJsonBody } from '../_shared.js';
import { collaborationStructuredError, respondWithCollaborationTool } from './shared.js';

/**
 * F6-4: live council — invokes real advisor LLMs via the in-process registry,
 * persists each advisor reply as a ContextMessage, runs the `challenge`
 * advisor over the consensus, and returns a fix-task draft with
 * approval_status='pending'. The draft is NEVER auto-promoted to executable.
 */
async function handleDashboardCouncilRunLive(workflowId: string, body: unknown, res: ServerResponse): Promise<void> {
  const db = initDb(getDbPath());
  try {
    const workflow = loadWorkflowById(db, workflowId);
    if (!workflow) {
      notFound(res, 'Workflow not found');
      return;
    }
    const input = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    const rawParticipants = Array.isArray(input['participants']) ? input['participants'] : [];
    const participants = rawParticipants
      .map((item) => {
        if (typeof item === 'string') {
          return { id: item, role: item };
        }
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const obj = item as Record<string, unknown>;
          const id = typeof obj['id'] === 'string' ? obj['id'] : (typeof obj['role'] === 'string' ? obj['role'] : 'advisor');
          const role = typeof obj['role'] === 'string' ? obj['role'] : id;
          return { id, role };
        }
        return null;
      })
      .filter((item): item is { id: string; role: string } => Boolean(item));

    if (participants.length === 0) {
      badRequest(res, 'live council requires at least one participant', collaborationStructuredError(
        'dashboard_council_live_no_participants',
        'dashboard:council:live',
        'live council requires at least one participant',
        'Pass participants as either ["planner","debug"] or [{id:"planner",role:"planner"}, …].',
        { workflow_id: workflowId },
      ));
      return;
    }

    try {
      const result = await runLiveCouncil(db, {
        workspace: workflow.workspace,
        runId: workflowId,
        taskId: typeof input['task_id'] === 'string' ? input['task_id'] : null,
        topic: typeof input['topic'] === 'string' && input['topic'].trim()
          ? input['topic']
          : `Live council review for ${workflowId}`,
        source: input['source'] === 'task' || input['source'] === 'debug_bundle' || input['source'] === 'quality_review' || input['source'] === 'handoff'
          ? input['source']
          : 'workflow',
        participants,
        contextSummary: typeof input['context_summary'] === 'string' ? input['context_summary'] : undefined,
        actor: typeof input['actor'] === 'string' ? input['actor'] : 'dashboard',
      });
      jsonOk(res, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      badRequest(res, message, collaborationStructuredError(
        'dashboard_council_live_failed',
        'dashboard:council:live',
        message,
        'Live council never executes — review the persisted advisor messages and approve the pending fix-task explicitly.',
        { workflow_id: workflowId },
      ));
    }
  } finally {
    db.close();
  }
}

function handleDashboardCouncilRun(workflowId: string, body: unknown, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try {
    const workflow = loadWorkflowById(db, workflowId);
    if (!workflow) {
      notFound(res, 'Workflow not found');
      return;
    }
    const input = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    const rawParticipants = Array.isArray(input['participants']) ? input['participants'] : [];
    const participants = rawParticipants
      .map((item) => item && typeof item === 'object' && !Array.isArray(item)
        ? item as Record<string, unknown>
        : null)
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map((item) => ({
        id: typeof item['id'] === 'string' ? item['id'] : String(item['role'] ?? 'advisor'),
        role: typeof item['role'] === 'string' ? item['role'] : String(item['id'] ?? 'advisor'),
      }));
    const runMode = input['run_mode'] === 'approved-run' ? 'approved-run' : 'dry-run';
    const result = createCouncilRun(db, {
      workspace: workflow.workspace,
      runId: workflowId,
      taskId: typeof input['task_id'] === 'string' ? input['task_id'] : null,
      topic: typeof input['topic'] === 'string' && input['topic'].trim()
        ? input['topic']
        : `Council review for ${workflowId}`,
      source: input['source'] === 'task' || input['source'] === 'debug_bundle' || input['source'] === 'quality_review' || input['source'] === 'handoff'
        ? input['source']
        : 'workflow',
      participants,
      contextSummary: typeof input['context_summary'] === 'string' ? input['context_summary'] : undefined,
      runMode,
      approvedBy: typeof input['approved_by'] === 'string' ? input['approved_by'] : null,
      actor: typeof input['actor'] === 'string' ? input['actor'] : 'dashboard',
    });
    jsonOk(res, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    badRequest(res, message, collaborationStructuredError(
      'dashboard_council_run_failed',
      'dashboard:council',
      message,
      'Run council in dry-run mode first, then create fix tasks only after inspecting the decision.',
      { workflow_id: workflowId },
    ));
  } finally {
    db.close();
  }
}

async function handleDashboardCreateFixTask(
  workflowId: string,
  body: unknown,
  res: ServerResponse,
): Promise<void> {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  await respondWithCollaborationTool(
    res,
    'fix_task_create_failed',
    'dashboard_collaboration:create_fix_task',
    {
      workflow_id: workflowId,
      run_mode: typeof input['run_mode'] === 'string' ? input['run_mode'] : 'dry-run',
      source_review_id: typeof input['source_review_id'] === 'string' ? input['source_review_id'] : null,
    },
    'Create the fix task as dry-run first. Approved-run requires explicit approved_by metadata.',
    () => createFixTaskTool({ ...input, workflow_id: workflowId }),
  );
}

async function handleDashboardRequestArchitectureReview(
  workflowId: string,
  body: unknown,
  res: ServerResponse,
): Promise<void> {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  await respondWithCollaborationTool(
    res,
    'architecture_review_request_failed',
    'dashboard_collaboration:architecture_review',
    {
      workflow_id: workflowId,
      run_mode: typeof input['run_mode'] === 'string' ? input['run_mode'] : 'dry-run',
    },
    'Run a dry-run architecture review first. Approved-run requires explicit approved_by metadata.',
    () => requestArchitectureReviewTool({ ...input, workflow_id: workflowId }),
  );
}

async function handleDashboardRequestProductReview(
  workflowId: string,
  body: unknown,
  res: ServerResponse,
): Promise<void> {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  await respondWithCollaborationTool(
    res,
    'product_review_request_failed',
    'dashboard_collaboration:product_review',
    {
      workflow_id: workflowId,
      run_mode: typeof input['run_mode'] === 'string' ? input['run_mode'] : 'dry-run',
    },
    'Run a dry-run product review first. Approved-run requires explicit approved_by metadata.',
    () => requestProductReviewTool({ ...input, workflow_id: workflowId }),
  );
}

export const reviewsRouter: Router = async (req, url, res) => {
  const wfFixTasksMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/fix-tasks$/);
  if (req.method === 'POST' && wfFixTasksMatch) {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    await handleDashboardCreateFixTask(decodeURIComponent(wfFixTasksMatch[1] ?? ''), body, res);
    return true;
  }
  const wfArchitectureReviewMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/reviews\/architecture$/);
  if (req.method === 'POST' && wfArchitectureReviewMatch) {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    await handleDashboardRequestArchitectureReview(decodeURIComponent(wfArchitectureReviewMatch[1] ?? ''), body, res);
    return true;
  }
  const wfProductReviewMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/reviews\/product$/);
  if (req.method === 'POST' && wfProductReviewMatch) {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    await handleDashboardRequestProductReview(decodeURIComponent(wfProductReviewMatch[1] ?? ''), body, res);
    return true;
  }
  // F6-4: live council endpoint must be matched BEFORE the legacy /council
  // route — the legacy regex anchors on `/council$` so a literal /council/live
  // path is not eaten, but keeping the order explicit makes the intent
  // obvious to future readers.
  const wfCouncilLiveMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/council\/live$/);
  if (req.method === 'POST' && wfCouncilLiveMatch) {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    await handleDashboardCouncilRunLive(decodeURIComponent(wfCouncilLiveMatch[1] ?? ''), body, res);
    return true;
  }
  const wfCouncilMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/council$/);
  if (req.method === 'POST' && wfCouncilMatch) {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    handleDashboardCouncilRun(decodeURIComponent(wfCouncilMatch[1] ?? ''), body, res);
    return true;
  }
  return false;
};
