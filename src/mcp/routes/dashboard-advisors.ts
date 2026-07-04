// Tier 0 Wave 4 (item 0.5): wire 17 advisor POST endpoints used by the
// dashboard-v2 SPA. The MCP transport already exposes each advisor as
// `omniforge_<name>` via src/mcp/tools/advisor_tools.ts; this router gives
// the browser a direct HTTP surface so AdvisorChatShell.tsx can drive the
// 17 screens without an MCP transport.
//
// Routes:
//   POST /api/dashboard/advisors/:advisor/call
//     Sync advisors → JSON  { advisor, output, structured?, usage?, conversation_id? }
//     Stepwise        → SSE  events:
//                              `step`  — per-step start / completion frames
//                              `done`  — final payload (same shape as sync)
//                              `error` — structured error (validation/runtime/upstream)
//
//   GET  /api/dashboard/advisor-conversations/:id
//     Returns persisted advisor_conversations row (history) for the
//     AdvisorChatShell timeline. 404 when the id is unknown.
//
// Auth: the http-server top-level `requestAuthorized` runs before this
// router. We never bypass it — incoming requests are already trusted by
// the time `dashboardAdvisorsRouter` is reached.
//
// Errors are structured JSON `{ error: { code, message } }`:
//   400 → input validation (Zod / bad JSON)
//   404 → unknown advisor or unknown conversation_id
//   500 → advisor handler threw (logic / unexpected)
//   503 → upstream unreachable (Omniroute transport failure)

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { VALID_WORKSPACE_RE } from '../../utils/workspace.js';
import {
  appendAdvisorConversationStep,
  getAdvisorConversation,
  insertAdvisorConversation,
  newAdvisorConversationId,
  type AdvisorConversationStep,
} from '../../db/persist.js';
import { getAdvisor } from '../../v2/advisors/index.js';
import '../../v2/advisors/loader.js'; // side-effect: populate registry
import { isAdvisorMode } from '../../v2/advisors/shared/mode.js';
import type {
  AdvisorContext,
  AdvisorMode,
  AdvisorResult,
  StepwiseAdvisorContext,
  StepwiseAdvisorResult,
} from '../../v2/advisors/types.js';
import type { Router } from './types.js';
import {
  badRequest,
  notFound,
  jsonOk,
  readJsonBody,
  safeEndSse,
  sendSseEvent,
  sendSseHeartbeat,
  setSseHeaders,
  SSE_HEARTBEAT_MS,
} from './_shared.js';

// ── Route regex ──────────────────────────────────────────────────────────

const CALL_RE = /^\/api\/dashboard\/advisors\/([a-z][a-z_]*)\/call$/;
const CONVERSATION_RE = /^\/api\/dashboard\/advisor-conversations\/([A-Za-z0-9_:-]+)$/;

// ── Types ───────────────────────────────────────────────────────────────

interface CallBody {
  input?: Record<string, unknown>;
  mode?: AdvisorMode;
  workspace?: string;
  conversation_id?: string;
}

interface ErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

// ── Error helpers ────────────────────────────────────────────────────────

function jsonError(res: ServerResponse, status: number, payload: ErrorPayload): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: payload }));
}

function classifyAdvisorError(err: unknown): { status: number; payload: ErrorPayload } {
  if (err && typeof err === 'object' && 'issues' in err) {
    // Zod errors carry an `issues` array. Map to 400.
    const zodErr = err as { issues: unknown; message?: string };
    return {
      status: 400,
      payload: {
        code: 'invalid_input',
        message: typeof zodErr.message === 'string' ? zodErr.message : 'invalid input',
        details: zodErr.issues,
      },
    };
  }
  const rawMessage = err instanceof Error ? err.message : String(err);
  // Security (Wave 5B Issue #3): cap message length and strip URLs / paths
  // before forwarding to the browser. Internal hostnames and absolute paths
  // are a data-leak even on localhost (browser DevTools surface them, and a
  // future reverse-proxy exposure would amplify the leak).
  const message = rawMessage
    .replace(/https?:\/\/\S+/gi, '<url>')          // strip URLs
    .replace(/[A-Za-z]:\\[^\s]+|\/[^\s]+\/[^\s]+/g, '<path>')  // strip win/posix abs paths
    .slice(0, 240);
  // Heuristic: Omniroute transport failures surface as "Omniroute request
  // failed for ..." or contain ECONNREFUSED/ENOTFOUND in the message. Map
  // to 503 (Service Unavailable) so the UI can suggest a daemon/transport
  // restart rather than a "your input was wrong" toast.
  if (
    /Omniroute request (failed|timed out)|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed/i.test(
      rawMessage,
    )
  ) {
    return {
      status: 503,
      payload: { code: 'upstream_unreachable', message },
    };
  }
  return {
    status: 500,
    payload: { code: 'advisor_failure', message },
  };
}

// ── Advisor → response helpers ───────────────────────────────────────────

function isStepwiseResult(r: AdvisorResult | StepwiseAdvisorResult): r is StepwiseAdvisorResult {
  return Boolean((r as StepwiseAdvisorResult).nextStep);
}

function callWorkflowId(): string {
  return `dash-advisor-${randomBytes(4).toString('hex')}-${Date.now()}`;
}

function callTaskId(): string {
  return `dash-call-${randomBytes(4).toString('hex')}`;
}

function buildContext(
  body: CallBody,
  options: {
    onEvent?: AdvisorContext['onEvent'];
    signal?: AbortSignal;
    workflowId?: string;
    taskId?: string;
    conversationId?: string;
  },
): StepwiseAdvisorContext {
  // Security (Wave 5B Issue #2): body.workspace is operator-supplied JSON.
  // Validate against VALID_WORKSPACE_RE (matches every other dashboard route)
  // before letting it reach advisors that may compose workspace into file
  // paths. Reject anything with `../`, drive letters, slashes, etc.
  const candidateWs = typeof body.workspace === 'string' ? body.workspace : '';
  const safeWorkspace = candidateWs.length > 0 && VALID_WORKSPACE_RE.test(candidateWs)
    ? candidateWs
    : 'internal';
  const ctx: StepwiseAdvisorContext = {
    workspace: safeWorkspace,
    workflow_id: options.workflowId ?? callWorkflowId(),
    mode: body.mode && isAdvisorMode(body.mode) ? body.mode : 'auto',
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  };
  if (options.conversationId) {
    ctx.step = {
      // Stepwise advisors expect a step descriptor when conversation memory is
      // in play. The dashboard UI submits one HTTP call per step; the daemon
      // doesn't yet loop, so step_number/total_steps mirror what the operator
      // pasted into the form (or 1/1 by default). The handler is free to
      // override when the input schema demands a richer step.
      stepNumber: 1,
      totalSteps: 1,
      nextStepRequired: false,
      findings: [],
      conversationId: options.conversationId,
    };
  }
  return ctx;
}

function buildAdvisorInput(advisorName: string, body: CallBody): Record<string, unknown> {
  // The shell submits `{ input: { prompt, ... } }`. Each advisor's Zod schema
  // is in src/v2/advisors/<name>/schema.ts — we forward `input` verbatim so
  // advisors that already accept `prompt` (chat, apilookup, challenge) Just
  // Work. For stepwise advisors that need `step` / `findings` / etc., the
  // shell's per-advisor inputSchema fills those fields. When the dashboard
  // sends just `prompt`, we synthesize sensible defaults so the call never
  // 400s on missing required fields — operators get a usable answer instead
  // of a Zod stack trace.
  const input: Record<string, unknown> = { ...(body.input ?? {}) };
  if (body.mode && !('mode' in input)) input['mode'] = body.mode;

  const promptValue = typeof input['prompt'] === 'string' ? input['prompt'] : '';
  const advisorMode = body.mode ?? 'auto';

  // Stepwise advisors require `step` + `step_number` + `total_steps` +
  // `next_step_required` + `findings`. Fill the missing fields from prompt
  // text so a free-form invocation works on first call.
  if (STEPWISE_ADVISORS.has(advisorName) && promptValue) {
    if (typeof input['step'] !== 'string' || input['step'].length === 0) {
      input['step'] = promptValue;
    }
    if (typeof input['step_number'] !== 'number') input['step_number'] = 1;
    if (typeof input['total_steps'] !== 'number') input['total_steps'] = 1;
    if (typeof input['next_step_required'] !== 'boolean') input['next_step_required'] = false;
    if (typeof input['findings'] !== 'string' || input['findings'].length === 0) {
      input['findings'] = promptValue;
    }
  }

  // listmodels / version accept zero-required args. challenge / apilookup /
  // chat take `prompt`. Sync advisors with required-non-prompt fields fall
  // through unchanged.
  void advisorMode; // referenced for future per-advisor branching

  return input;
}

// ── Stepwise classification ──────────────────────────────────────────────

const STEPWISE_ADVISORS = new Set<string>([
  'codereview',
  'consensus',
  'debug',
  'planner',
  'precommit',
  'thinkdeep',
]);

function isStepwiseAdvisor(advisorName: string): boolean {
  const advisor = getAdvisor(advisorName);
  if (!advisor) return false;
  return Boolean(advisor.isStepwise) || STEPWISE_ADVISORS.has(advisorName);
}

// ── Conversation persistence ─────────────────────────────────────────────

function ensureConversationRow(
  advisorName: string,
  workflowId: string,
  taskId: string,
  conversationIdHint?: string,
): string {
  const id = conversationIdHint ?? newAdvisorConversationId();
  // Idempotent: if the id already exists, persist module's INSERT will throw
  // (unique constraint). Wrap in try/catch so callers can re-use an existing
  // id from a previous HTTP turn.
  const db = initDb(getDbPath());
  try {
    if (conversationIdHint) {
      const existing = getAdvisorConversation(db, conversationIdHint);
      if (existing) return existing.id;
    }
    insertAdvisorConversation(db, {
      id,
      advisor_name: advisorName,
      workflow_id: workflowId,
      task_id: taskId,
      started_at: Date.now(),
    });
  } finally {
    db.close();
  }
  return id;
}

function persistStep(
  conversationId: string,
  step: AdvisorConversationStep,
): void {
  const db = initDb(getDbPath());
  try {
    appendAdvisorConversationStep(db, conversationId, step);
  } finally {
    db.close();
  }
}

// ── Sync handler ─────────────────────────────────────────────────────────

async function handleSyncCall(
  advisorName: string,
  body: CallBody,
  res: ServerResponse,
): Promise<void> {
  const advisor = getAdvisor(advisorName);
  if (!advisor) {
    jsonError(res, 404, { code: 'unknown_advisor', message: `Advisor not registered: ${advisorName}` });
    return;
  }

  const args = buildAdvisorInput(advisorName, body);
  const ctx = buildContext(body, {});

  try {
    const result = await advisor.run(ctx, args);
    jsonOk(res, {
      advisor: advisorName,
      output: result.output,
      ...(result.structured !== undefined ? { structured: result.structured } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
    });
  } catch (err) {
    const { status, payload } = classifyAdvisorError(err);
    jsonError(res, status, payload);
  }
}

// ── Stepwise SSE handler ─────────────────────────────────────────────────

async function handleStepwiseCall(
  advisorName: string,
  body: CallBody,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const advisor = getAdvisor(advisorName);
  if (!advisor) {
    jsonError(res, 404, { code: 'unknown_advisor', message: `Advisor not registered: ${advisorName}` });
    return;
  }

  setSseHeaders(res);

  // Provision conversation tracking so /api/dashboard/advisor-conversations/:id
  // can replay the timeline. The shell may pass `conversation_id` to continue
  // an existing thread; otherwise we mint a fresh id.
  const workflowId = callWorkflowId();
  const taskId = callTaskId();
  const conversationId = ensureConversationRow(
    advisorName,
    workflowId,
    taskId,
    body.conversation_id,
  );

  const args = buildAdvisorInput(advisorName, body);
  const abortCtrl = new AbortController();

  // Heartbeat keeps proxies from buffering; cleanup wires every termination
  // path back to abort/close so we never leak the in-flight LLM call.
  const heartbeat = setInterval(() => sendSseHeartbeat(res), SSE_HEARTBEAT_MS);
  if (typeof (heartbeat as unknown as { unref?: () => void }).unref === 'function') {
    (heartbeat as unknown as { unref: () => void }).unref();
  }

  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try { abortCtrl.abort(); } catch { /* abort on already-aborted is fine */ }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

  // step_start frame so the UI can render a "thinking" indicator before the
  // LLM returns. The shell renders these as the timeline of steps.
  sendSseEvent(res, 'step', {
    advisor: advisorName,
    phase: 'start',
    step_number: 1,
    conversation_id: conversationId,
  });

  // Forward advisor-emitted events to the SSE stream (advisor_step_*).
  const onEvent: AdvisorContext['onEvent'] = (event) => {
    if (res.writableEnded) return;
    sendSseEvent(res, 'step', { advisor: advisorName, phase: 'advisor_event', event });
  };

  const ctx = buildContext(body, {
    onEvent,
    signal: abortCtrl.signal,
    workflowId,
    taskId,
    conversationId,
  });

  try {
    const result = await advisor.run(ctx, args);

    // Persist this step's output to the conversation row so subsequent
    // GET /api/dashboard/advisor-conversations/:id calls can replay it.
    persistStep(conversationId, {
      step_number: 1,
      args,
      output: result.output,
      ...(typeof args['findings'] === 'string' ? { findings: args['findings'] as string } : {}),
      ...(isStepwiseResult(result) && result.nextStep
        ? { next_step_request: result.nextStep.request }
        : {}),
      ts: Date.now(),
    });

    sendSseEvent(res, 'step', {
      advisor: advisorName,
      phase: 'complete',
      step_number: 1,
      conversation_id: conversationId,
    });

    sendSseEvent(res, 'done', {
      advisor: advisorName,
      output: result.output,
      conversation_id: conversationId,
      ...(result.structured !== undefined ? { structured: result.structured } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(isStepwiseResult(result) && result.nextStep
        ? {
            next_step: {
              step_number: result.nextStep.stepNumber,
              request: result.nextStep.request,
            },
          }
        : {}),
    });
  } catch (err) {
    const { status, payload } = classifyAdvisorError(err);
    sendSseEvent(res, 'error', { status, ...payload });
  } finally {
    cleanup();
    safeEndSse(res);
  }
}

// ── Conversation GET handler ─────────────────────────────────────────────

function handleGetConversation(conversationId: string, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try {
    const row = getAdvisorConversation(db, conversationId);
    if (!row) {
      notFound(res, `Advisor conversation not found: ${conversationId}`);
      return;
    }
    // Map persistence shape to the dashboard contract — turns array.
    interface TurnView {
      id: string;
      role: 'user' | 'assistant';
      text: string;
      created_at: number;
      structured?: unknown;
    }
    const turns: TurnView[] = [];
    for (const step of row.history) {
      const promptValue = (step.args as Record<string, unknown> | null)?.['prompt']
        ?? (step.args as Record<string, unknown> | null)?.['step'];
      turns.push({
        id: `${row.id}:user:${step.step_number}`,
        role: 'user',
        text: typeof promptValue === 'string' ? promptValue : JSON.stringify(step.args),
        created_at: step.ts,
      });
      turns.push({
        id: `${row.id}:assistant:${step.step_number}`,
        role: 'assistant',
        text: step.output,
        created_at: step.ts,
      });
    }
    jsonOk(res, {
      conversation_id: row.id,
      advisor: row.advisor_name,
      workspace: null,
      turns,
      created_at: row.started_at,
      updated_at: row.completed_at ?? row.started_at,
    });
  } catch (err) {
    jsonError(res, 500, {
      code: 'conversation_read_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    db.close();
  }
}

// ── Router ───────────────────────────────────────────────────────────────

export const dashboardAdvisorsRouter: Router = async (req, url, res) => {
  // GET conversation history
  if (req.method === 'GET') {
    const convMatch = CONVERSATION_RE.exec(url.pathname);
    if (convMatch && convMatch[1]) {
      handleGetConversation(decodeURIComponent(convMatch[1]), res);
      return true;
    }
  }

  // POST advisor call
  if (req.method !== 'POST') return false;
  const m = CALL_RE.exec(url.pathname);
  if (!m || !m[1]) return false;

  const advisorName = decodeURIComponent(m[1]);

  let body: CallBody;
  try {
    body = (await readJsonBody(req)) as CallBody;
  } catch (err) {
    jsonError(res, 400, {
      code: 'invalid_body',
      message: err instanceof Error ? err.message : 'invalid JSON body',
    });
    return true;
  }

  if (body && typeof body !== 'object') {
    jsonError(res, 400, { code: 'invalid_body', message: 'body must be a JSON object' });
    return true;
  }

  // Browsers send `Accept: text/event-stream` on the fetch when they want
  // streaming. We also branch on the advisor's intrinsic stepwise flag so
  // CLI callers that POST without Accept still get a clean JSON response
  // for sync advisors.
  const acceptsSse = (req.headers['accept'] ?? '').includes('text/event-stream');
  const stepwise = isStepwiseAdvisor(advisorName);

  if (stepwise && acceptsSse) {
    await handleStepwiseCall(advisorName, body, req, res);
  } else {
    await handleSyncCall(advisorName, body, res);
  }
  return true;
};

// ── Test surface ─────────────────────────────────────────────────────────

export const __testing__ = {
  buildAdvisorInput,
  classifyAdvisorError,
  isStepwiseAdvisor,
  STEPWISE_ADVISORS,
};
