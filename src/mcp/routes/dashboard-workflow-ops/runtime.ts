// Sprint 4.5 / Agent M2-A3: runtime probes + persistent sessions endpoints.
//
// Extracted from dashboard-workflow-ops.ts (was ~155 LOC of handler bodies +
// router branches). Behavior preserved exactly — same DB lifecycle, same
// structured-error envelopes.

import type { ServerResponse } from 'node:http';
import { initDb } from '../../../db/client.js';
import { getDbPath } from '../../../utils/config.js';
import { latestRuntimeProbeSummary, runRuntimeAdapterProbe } from '../../../runtime/probes.js';
import { canResumeRuntimeSession, runtimeProcessPool } from '../../../runtime/process-pool.js';
import { getRuntimeSession } from '../../../runtime/store.js';
import { getRuntimeExecutorCapability } from '../../../runtime/capabilities.js';
import type { Router } from '../types.js';
import { badRequest, jsonOk, notFound, readJsonBody } from '../_shared.js';
import { collaborationStructuredError } from './shared.js';

async function handleDashboardRuntimeProbe(body: unknown, res: ServerResponse): Promise<void> {
  const input = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const mode = input['mode'] === 'live' ? 'live' : 'dry-run';
  const result = await runRuntimeAdapterProbe({
    dryRun: mode !== 'live',
    live: mode === 'live',
    confirmLive: input['confirm_live'] === true,
    executorId: typeof input['executor_id'] === 'string' ? input['executor_id'] : undefined,
    timeoutMs: typeof input['timeout_ms'] === 'number' ? input['timeout_ms'] : undefined,
    repoRoot: process.cwd(),
  });
  if (!result.ok) {
    badRequest(res, result.structured_error?.message ?? 'Runtime probe failed', {
      structured_error: result.structured_error,
      stdout: result.stdout.slice(-1500),
      stderr: result.stderr.slice(-1500),
      summary: result.summary,
    });
    return;
  }
  jsonOk(res, result);
}

function handleDashboardRuntimeProbeLatest(res: ServerResponse): void {
  jsonOk(res, {
    latest: latestRuntimeProbeSummary(process.cwd()),
  });
}

function handleDashboardRuntimeSessionStart(body: unknown, res: ServerResponse): void {
  const input = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const executorId = typeof input['executor_id'] === 'string' ? input['executor_id'] : 'cli:claude-code';
  const capability = getRuntimeExecutorCapability(executorId);
  if (!capability) {
    badRequest(res, `Unknown executor: ${executorId}`, collaborationStructuredError(
      'runtime_session_unknown_executor',
      'dashboard:runtime-session',
      `Unknown executor: ${executorId}`,
      'Pick an executor from the runtime capability matrix before starting a session.',
      { executor_id: executorId },
    ));
    return;
  }
  const protocol = capability.protocols.find((item) => item.tier === capability.defaultProtocolTier)
    ?? capability.protocols[0];
  if (!protocol) {
    badRequest(res, `No protocol declared for executor: ${executorId}`);
    return;
  }
  const db = initDb(getDbPath());
  try {
    const session = runtimeProcessPool.startSession(db, {
      workflowId: typeof input['workflow_id'] === 'string' ? input['workflow_id'] : null,
      taskId: typeof input['task_id'] === 'string' ? input['task_id'] : null,
      executorId,
      protocolTier: protocol.tier,
      streamFormat: protocol.streamFormat,
      workspacePath: typeof input['workspace_path'] === 'string' ? input['workspace_path'] : null,
      profile: input['profile'] === 'chat' || input['profile'] === 'review' || input['profile'] === 'code' || input['profile'] === 'autonomous'
        ? input['profile']
        : 'code',
      runMode: input['run_mode'] === 'approved-run' ? 'approved-run' : 'dry-run',
      approvalStatus: input['run_mode'] === 'approved-run' ? 'approved' : 'not_required',
      auditStatus: 'recorded',
      dryRun: true,
      fallbackReason: 'isolated persistent session metadata created; live process start remains opt-in after probe evidence',
    });
    jsonOk(res, { session });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    badRequest(res, message, collaborationStructuredError(
      'runtime_session_start_failed',
      'dashboard:runtime-session',
      message,
      'Start persistent sessions in dry-run/code profile first; autonomous sessions require approved-run.',
      { executor_id: executorId },
    ));
  } finally {
    db.close();
  }
}

function handleDashboardRuntimeSessionMarkStale(sessionId: string, body: unknown, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try {
    const input = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    const session = runtimeProcessPool.markStale(
      db,
      sessionId,
      typeof input['reason'] === 'string' ? input['reason'] : 'operator marked session stale',
    );
    if (!session) {
      notFound(res, 'Runtime session not found');
      return;
    }
    jsonOk(res, { session });
  } finally {
    db.close();
  }
}

function handleDashboardRuntimeSessionEnd(sessionId: string, body: unknown, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try {
    const input = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    const session = runtimeProcessPool.endSession(
      db,
      sessionId,
      typeof input['reason'] === 'string' ? input['reason'] : 'operator ended session',
    );
    if (!session) {
      notFound(res, 'Runtime session not found');
      return;
    }
    jsonOk(res, { session });
  } finally {
    db.close();
  }
}

function handleDashboardRuntimeSessionResumeCheck(sessionId: string, body: unknown, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try {
    const session = getRuntimeSession(db, sessionId);
    if (!session) {
      notFound(res, 'Runtime session not found');
      return;
    }
    const input = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    const decision = canResumeRuntimeSession(session, {
      executorId: typeof input['executor_id'] === 'string' ? input['executor_id'] : session.executor_id,
      workspacePath: typeof input['workspace_path'] === 'string' ? input['workspace_path'] : session.workspace_path,
      profile: input['profile'] === 'chat' || input['profile'] === 'review' || input['profile'] === 'code' || input['profile'] === 'autonomous'
        ? input['profile']
        : undefined,
      runMode: input['run_mode'] === 'dry-run' || input['run_mode'] === 'approved-run'
        ? input['run_mode']
        : undefined,
    });
    jsonOk(res, { session, resume: decision });
  } finally {
    db.close();
  }
}

export const runtimeRouter: Router = async (req, url, res) => {
  if (req.method === 'GET' && url.pathname === '/api/dashboard/runtime/probes/latest') {
    handleDashboardRuntimeProbeLatest(res);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/dashboard/runtime/probes') {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    await handleDashboardRuntimeProbe(body, res);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/dashboard/runtime/sessions') {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    handleDashboardRuntimeSessionStart(body, res);
    return true;
  }
  const runtimeSessionStaleMatch = url.pathname.match(/^\/api\/dashboard\/runtime\/sessions\/([^/]+)\/mark-stale$/);
  if (req.method === 'POST' && runtimeSessionStaleMatch) {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    handleDashboardRuntimeSessionMarkStale(decodeURIComponent(runtimeSessionStaleMatch[1] ?? ''), body, res);
    return true;
  }
  const runtimeSessionEndMatch = url.pathname.match(/^\/api\/dashboard\/runtime\/sessions\/([^/]+)\/end$/);
  if (req.method === 'POST' && runtimeSessionEndMatch) {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    handleDashboardRuntimeSessionEnd(decodeURIComponent(runtimeSessionEndMatch[1] ?? ''), body, res);
    return true;
  }
  const runtimeSessionResumeCheckMatch = url.pathname.match(/^\/api\/dashboard\/runtime\/sessions\/([^/]+)\/resume-check$/);
  if (req.method === 'POST' && runtimeSessionResumeCheckMatch) {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    handleDashboardRuntimeSessionResumeCheck(decodeURIComponent(runtimeSessionResumeCheckMatch[1] ?? ''), body, res);
    return true;
  }
  return false;
};
