// Sprint 4.5 / Agent M2-A3: DAG validate / import / run / plan + draft CRUD.
//
// Extracted from dashboard-workflow-ops.ts. Both `runDashboardDag` and the
// dashboard helpers come from the existing `_dashboard-dag-helpers.ts` so no
// behavior changes — the dag drafts table CRUD goes through `db/dag-drafts`.

import type { ServerResponse } from 'node:http';
import { initDb } from '../../../db/client.js';
import { getDbPath } from '../../../utils/config.js';
import { importDashboardDag, loadDashboardDagByPatternId } from '../../dashboard-dag-ops.js';
import { planDashboardDag } from '../../dashboard-plan-ops.js';
import {
  createDagDraft,
  deleteDagDraft,
  listDagDrafts,
  loadDagDraft,
  patchDagDraft,
  type DagDraftStatus,
} from '../../../db/dag-drafts.js';
import type { Router } from '../types.js';
import { badRequest, jsonOk, notFound, readBodyOr400, readLargeJsonBody } from '../_shared.js';
import {
  dashboardCliPermissionMode,
  dashboardWorkflowMode,
  parseDashboardDagFromBody,
  runDashboardDag,
} from '../_dashboard-dag-helpers.js';

function handleDashboardDagValidate(body: unknown, res: ServerResponse): void {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  try {
    const dag = parseDashboardDagFromBody(input);
    jsonOk(res, {
      ok: true,
      task_count: dag.tasks.length,
      kinds: [...new Set(dag.tasks.map((task) => task.kind))].sort(),
      dag,
    });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

async function handleDashboardDagImport(body: unknown, res: ServerResponse): Promise<void> {
  const db = initDb(getDbPath());
  try {
    const pattern = importDashboardDag(db, body);
    jsonOk(res, {
      pattern_id: pattern.id,
      name: pattern.name,
      workspace: pattern.workspace,
    });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

async function handleDashboardDagRun(body: unknown, res: ServerResponse): Promise<void> {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const db = initDb(getDbPath());
  try {
    let dag: unknown;
    let workspace = typeof input['workspace'] === 'string' ? input['workspace'] : undefined;
    let objective = typeof input['objective'] === 'string' && input['objective'].trim()
      ? input['objective'].trim()
      : undefined;
    const patternId = typeof input['pattern_id'] === 'string' ? input['pattern_id'] : undefined;

    if (patternId) {
      const pattern = loadDashboardDagByPatternId(db, patternId);
      dag = pattern.dag;
      workspace = workspace ?? pattern.workspace;
      objective = (objective ?? pattern.objective_sample) || pattern.name;
    } else {
      dag = parseDashboardDagFromBody(input);
    }

    if (!workspace) throw new Error('workspace is required');
    if (!objective) throw new Error('objective is required');
    const rawMaxDuration = input['max_duration_seconds'];
    const maxDurationSeconds = typeof rawMaxDuration === 'number' && rawMaxDuration >= 60
      ? Math.min(rawMaxDuration, 86400)
      : null;
    const result = await runDashboardDag({
      workspace,
      objective,
      dag,
      auto_approve: input['auto_approve'] === true,
      cli_permission_mode: dashboardCliPermissionMode(input),
      workflow_mode: dashboardWorkflowMode(input),
      ...(maxDurationSeconds !== null ? { max_duration_seconds: maxDurationSeconds } : {}),
    });
    jsonOk(res, result);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

async function handleDashboardDagPlan(body: unknown, res: ServerResponse): Promise<void> {
  try { jsonOk(res, await planDashboardDag(body)); }
  catch (err) { badRequest(res, err instanceof Error ? err.message : String(err)); }
}

function handleDashboardDagDraftCreate(body: unknown, res: ServerResponse): void {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const db = initDb(getDbPath());
  try {
    jsonOk(res, createDagDraft(db, {
      workspace: typeof input['workspace'] === 'string' ? input['workspace'] : '',
      title: typeof input['title'] === 'string' ? input['title'] : undefined,
      objective: typeof input['objective'] === 'string' ? input['objective'] : '',
      dag: input['dag'] ?? input['dag_json'],
      source: typeof input['source'] === 'string' ? input['source'] : 'dashboard',
    }), 201);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err), {
      structured_error: {
        code: 'dag_draft_create_failed',
        where: 'dashboard_dag_drafts',
        suggested_action: 'Validate the DAG preview, then try saving again.',
      },
    });
  } finally {
    db.close();
  }
}

function handleDashboardDagDraftList(url: URL, res: ServerResponse): void {
  const workspace = url.searchParams.get('workspace') ?? undefined;
  const rawStatus = url.searchParams.get('status');
  const status: DagDraftStatus | undefined =
    rawStatus === 'draft' || rawStatus === 'archived' || rawStatus === 'started'
      ? rawStatus
      : undefined;
  const db = initDb(getDbPath());
  try { jsonOk(res, { drafts: listDagDrafts(db, { workspace, status }) }); }
  catch (err) { badRequest(res, err instanceof Error ? err.message : String(err)); }
  finally { db.close(); }
}

function handleDashboardDagDraftGet(id: string, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try {
    const draft = loadDagDraft(db, id);
    if (!draft) { notFound(res, `DAG draft not found: ${id}`); return; }
    jsonOk(res, draft);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

function handleDashboardDagDraftPatch(id: string, body: unknown, res: ServerResponse): void {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const rawStatus = input['status'];
  const status: DagDraftStatus | undefined =
    rawStatus === 'draft' || rawStatus === 'archived' || rawStatus === 'started'
      ? rawStatus
      : undefined;
  const db = initDb(getDbPath());
  try {
    jsonOk(res, patchDagDraft(db, id, {
      title: typeof input['title'] === 'string' ? input['title'] : undefined,
      objective: typeof input['objective'] === 'string' ? input['objective'] : undefined,
      dag: input['dag'] ?? input['dag_json'],
      status,
      started_workflow_id: typeof input['started_workflow_id'] === 'string'
        ? input['started_workflow_id']
        : undefined,
    }));
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err), {
      structured_error: {
        code: 'dag_draft_patch_failed',
        where: 'dashboard_dag_drafts',
        suggested_action: 'Reload the draft and verify the DAG is still valid.',
      },
    });
  } finally {
    db.close();
  }
}

function handleDashboardDagDraftDelete(id: string, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try { jsonOk(res, { ok: deleteDagDraft(db, id), id }); }
  catch (err) { badRequest(res, err instanceof Error ? err.message : String(err)); }
  finally { db.close(); }
}

export const dagsRouter: Router = async (req, url, res) => {
  if (req.method === 'POST' && url.pathname === '/api/dashboard/dags/validate') {
    const body = await readBodyOr400(req, res);
    if (body === undefined) return true;
    handleDashboardDagValidate(body, res);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/dashboard/dags/import') {
    const body = await readBodyOr400(req, res);
    if (body === undefined) return true;
    await handleDashboardDagImport(body, res);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/dashboard/dags/run') {
    const body = await readBodyOr400(req, res);
    if (body === undefined) return true;
    await handleDashboardDagRun(body, res);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/dashboard/dags/plan') {
    let body: unknown;
    // Sprint F4 (file upload): plan endpoint accepts up to 5 MB of
    // attachments — readLargeJsonBody widens the cap to 8 MB to cover
    // the base64-inflation overhead. The Zod schema re-validates the
    // per-attachment caps after parse.
    try { body = await readLargeJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    await handleDashboardDagPlan(body, res);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/dashboard/dag-drafts') {
    const body = await readBodyOr400(req, res);
    if (body === undefined) return true;
    handleDashboardDagDraftCreate(body, res);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/dashboard/dag-drafts') {
    handleDashboardDagDraftList(url, res);
    return true;
  }
  const dagDraftMatch = url.pathname.match(/^\/api\/dashboard\/dag-drafts\/([^/]+)$/);
  if (dagDraftMatch) {
    const id = decodeURIComponent(dagDraftMatch[1] ?? '');
    if (req.method === 'GET') {
      handleDashboardDagDraftGet(id, res);
      return true;
    }
    if (req.method === 'PATCH') {
      const body = await readBodyOr400(req, res);
      if (body === undefined) return true;
      handleDashboardDagDraftPatch(id, body, res);
      return true;
    }
    if (req.method === 'DELETE') {
      handleDashboardDagDraftDelete(id, res);
      return true;
    }
  }
  return false;
};
