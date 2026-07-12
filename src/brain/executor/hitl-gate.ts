import { setTimeout } from 'node:timers';
import type Database from 'better-sqlite3';
import type { Task } from '../../types/index.js';
import {
  newHitlGateId,
  insertHitlGate,
  insertEvent,
  resolveHitlGate,
  setTaskFailed,
} from '../../db/persist.js';
import { withSqliteRetrySync } from '../../db/sqlite-retry.js';
import { loadHitlConfig, type HitlConfig } from '../../hitl/config.js';
import { sendSlackGateNotification } from '../../hitl/slack.js';
import { startHitlListener, stopHitlListener } from '../../hitl/listener.js';
import { sendTelegramGateNotification } from '../../hitl/telegram.js';
import { matchesAutoApprovePolicy } from '../../hitl/policy.js';
import { notifyGatePending } from '../../mcp/notification-service.js';
import { HitlModifyError } from './types.js';

type HitlPromptInfo = import('../../hitl/cli.js').HitlPromptInfo;
type HitlDecision = 'approve' | 'reject' | 'modify';

// Aurora W4 — workflow IDs that have already emitted a
// `hitl_terminal_disabled_detached` event in this daemon's lifetime. Used to
// dedupe the dashboard hint so a workflow with N gates only surfaces the
// hint once. Daemon restart resets the set, which is the correct semantic:
// each daemon lifetime gets one event per workflow.
//
// LRU cap (Wave 2 code-review C3): a daemon staying up for weeks across
// thousands of workflows would otherwise grow this Set unbounded. 4096
// recent workflow IDs is plenty for the "one event per workflow per daemon
// lifetime" semantic without permitting memory exhaustion via crafted
// workflow ID spam. FIFO eviction (Set preserves insertion order).
const HITL_DETACHED_EMITTED_CAP = 4096;
const _hitlDetachedEmittedFor = new Set<string>();
function _recordHitlDetachedEmit(wfId: string): void {
  if (_hitlDetachedEmittedFor.size >= HITL_DETACHED_EMITTED_CAP) {
    const oldest = _hitlDetachedEmittedFor.values().next().value;
    if (oldest !== undefined) _hitlDetachedEmittedFor.delete(oldest);
  }
  _hitlDetachedEmittedFor.add(wfId);
}

/**
 * Test-only: clears the dedupe set so each test case starts from a clean
 * slate. Not exported via the module's public surface — tests reach in via
 * `vi.resetModules()` or by importing the named function directly.
 */
export function _resetHitlDetachedEmittedFor(): void {
  _hitlDetachedEmittedFor.clear();
}

/**
 * Distinguishable timeout so callers can resolve the orphaned gate before the
 * error propagates (Wave-1.5 triage #2). Carries the same message as before so
 * existing message-based assertions / logs still read identically.
 */
export class HitlGateTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HitlGateTimeoutError';
  }
}

export async function pollGateUntilResolved(
  db: Database.Database,
  gateId: string,
  intervalMs: number,
  timeoutMs: number,
): Promise<'approve' | 'reject' | 'modify'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = db
      .prepare('SELECT status FROM hitl_gates WHERE id = ?')
      .get(gateId) as { status: string } | undefined;
    if (row && row.status !== 'pending') {
      if (row.status === 'approved') return 'approve';
      if (row.status === 'modify') return 'modify';
      return 'reject';
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new HitlGateTimeoutError(
    `HITL gate timed out after ${Math.round(timeoutMs / 60_000)}min sem resposta`,
  );
}

/**
 * Resolve a still-pending gate to 'timed_out' (Wave-1.5 triage #2). Conditional
 * on `status = 'pending'` so it can never clobber a gate that was resolved by a
 * racing path (e.g. the CLI terminal prompt winning, or a dashboard approve).
 * Emits `hitl_gate_timed_out` ONLY when a row actually flips, so the audit log
 * doesn't gain a phantom event for an already-resolved gate. Never throws —
 * gate hygiene must not inject a new error onto the timeout path.
 */
export function markGateTimedOut(
  db: Database.Database,
  workflowId: string,
  taskId: string | null,
  gateId: string,
): void {
  try {
    // Retry-wrapped like every persist.ts write: under SQLITE_BUSY a raw run
    // would throw → the catch below would swallow it → the gate would stay
    // 'pending', re-introducing the very orphan this function prevents.
    const info = withSqliteRetrySync(() =>
      db
        .prepare(
          `UPDATE hitl_gates SET status = 'timed_out', decision = 'timed_out', decided_at = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .run(Date.now(), gateId),
    );
    if (info.changes > 0) {
      insertEvent(db, {
        workflow_id: workflowId,
        task_id: taskId,
        type: 'hitl_gate_timed_out',
        payload: { gate_id: gateId },
      });
    }
  } catch {
    // Best-effort: the timeout error is about to propagate and fail the task
    // regardless; a failed status-flip must not mask it with a new error type.
  }
}

/**
 * Poll a gate to resolution, but on timeout resolve the orphaned gate to
 * 'timed_out' before re-throwing (so it isn't left 'pending' — a dashboard-inbox
 * phantom + a resume re-prompt trap). The timeout still propagates so the task
 * fails exactly as it did before.
 */
export async function pollGateOrMarkTimedOut(
  db: Database.Database,
  workflowId: string,
  taskId: string | null,
  gateId: string,
  intervalMs: number,
  timeoutMs: number,
): Promise<'approve' | 'reject' | 'modify'> {
  try {
    return await pollGateUntilResolved(db, gateId, intervalMs, timeoutMs);
  } catch (err) {
    if (err instanceof HitlGateTimeoutError) {
      markGateTimedOut(db, workflowId, taskId, gateId);
    }
    throw err;
  }
}

export function readGateFeedback(db: Database.Database, gateId: string): string {
  const row = db
    .prepare('SELECT workflow_id, task_id, context_json FROM hitl_gates WHERE id = ?')
    .get(gateId) as
    | { workflow_id: string; task_id: string | null; context_json: string | null }
    | undefined;
  if (!row?.context_json) return '';
  try {
    const ctx = JSON.parse(row.context_json) as Record<string, unknown>;
    return (ctx['mcp_feedback'] as string | undefined) ?? '';
  } catch (err) {
    // Malformed context_json — fall back to empty feedback. Emit a low-noise
    // event so this failure is enumerable (F-D1-2). Never let observability
    // break the HITL feedback read.
    try {
      insertEvent(db, {
        workflow_id: row.workflow_id,
        task_id: row.task_id,
        type: 'mcp_feedback_extract_failed',
        payload: {
          error: (err as Error).message ?? String(err),
          gate_id: gateId,
        },
      });
    } catch {
      /* observability failure must not break HITL feedback read */
    }
    return '';
  }
}

// Runs the HITL approval flow for a task. Routes through CLI / Slack / Telegram
// based on `loadHitlConfig(workspace)`. On `approve`, returns silently. On
// `modify`, throws `HitlModifyError`. On `reject`, marks the task failed
// (mutates task.status) and throws a generic Error so the caller treats it
// like any other task failure.
/**
 * Build the rich HitlPromptInfo for the operator. When the task is the t0
 * plan-review gate (per H11: depends_on empty + hitl true), the full DAG
 * is included as planContext so the operator can review the entire plan
 * before approving execution.
 */
function buildPromptInfo(
  task: Task,
  workflowId: string,
  workspace: string,
  objective: string,
  allTasks?: Task[],
): HitlPromptInfo {
  const isPlanGate = task.depends_on.length === 0 && task.hitl;

  return {
    name: task.name,
    kind: task.kind,
    model: task.model,
    executorHint: task.executor_hint,
    timeoutSeconds: task.timeout_seconds,
    acceptanceCriteria: task.acceptance_criteria,
    ...(isPlanGate && allTasks && allTasks.length > 0
      ? {
          planContext: {
            workflowId,
            objective,
            tasks: allTasks.map((t) => ({
              id: t.id,
              name: t.name,
              kind: t.kind,
              depends_on: t.depends_on,
              timeoutSeconds: t.timeout_seconds,
              model: t.model,
              executorHint: t.executor_hint,
              acceptanceCriteria: t.acceptance_criteria,
            })),
          },
        }
      : {}),
  };
}

/**
 * Resolution channel selection: slack/telegram require their respective
 * credentials to be configured; every other combination falls back to the
 * terminal (cli) channel.
 */
function selectHitlChannel(hitlConfig: HitlConfig | null): 'slack' | 'telegram' | 'cli' {
  if (hitlConfig?.channel === 'slack' && hitlConfig.slack_webhook_url) return 'slack';
  if (
    hitlConfig?.channel === 'telegram' &&
    hitlConfig.telegram_bot_token &&
    hitlConfig.telegram_chat_id != null
  ) {
    return 'telegram';
  }
  return 'cli';
}

/**
 * WIRE-04 — audit row for a failed gate_pending notification dispatch. Shared
 * by the async-rejection and synchronous-throw catches of the fire-and-forget
 * dispatch in runHitlGate.
 */
function auditNotificationDispatchFailed(
  db: Database.Database,
  wfId: string,
  taskId: string,
  gateId: string,
  err: unknown,
): void {
  try {
    insertEvent(db, {
      workflow_id: wfId,
      task_id: taskId,
      type: 'notification_dispatch_failed',
      payload: {
        kind: 'gate_pending',
        gate_id: gateId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  } catch { /* observability failure must not break the HITL flow */ }
}

interface HitlChannelResolution {
  decision: HitlDecision;
  /** True when a DB-poll path already flipped the gate row (skip double-resolve). */
  resolvedByListener: boolean;
}

// Slack flow — webhook notification + local HTTP listener + DB poll, with a
// terminal-prompt fallback when the listener cannot start (or the poll times out).
async function resolveViaSlack(params: {
  db: Database.Database;
  task: Task;
  wfId: string;
  workspace: string;
  objective: string;
  gateId: string;
  hitlConfig: HitlConfig;
  webhookUrl: string;
  promptInfo: HitlPromptInfo;
  doHitl: (info: HitlPromptInfo) => Promise<'approve' | 'reject'>;
}): Promise<HitlChannelResolution> {
  const { db, task, wfId, workspace, objective, gateId, hitlConfig, webhookUrl, promptInfo, doHitl } = params;
  const port = hitlConfig.slack_listener_port;
  const publicUrl = hitlConfig.slack_listener_public_url;
  const listenerUrl = publicUrl ? `${publicUrl}/hitl/respond` : undefined;

  await sendSlackGateNotification({
    webhookUrl,
    taskName: task.name,
    workspace,
    kind: task.kind,
    model: task.model,
    objective,
    gateId,
    listenerUrl,
  });
  insertEvent(db, {
    workflow_id: wfId,
    task_id: task.id,
    type: 'hitl_slack_sent',
    payload: { channel: 'slack', listener_port: port, public_url: publicUrl ?? null },
  });

  let server: import('node:http').Server | undefined;
  try {
    server = await startHitlListener(db, port);
    console.log(`[HITL] Aguardando em http://localhost:${port}/hitl/respond (gate: ${gateId})`);
    const decision = await pollGateUntilResolved(db, gateId, 2_000, 10 * 60 * 1000);
    return { decision, resolvedByListener: true };
  } catch (err) {
    console.warn(`[HITL] ${(err as Error).message} — fallback para terminal`);
    return { decision: await doHitl(promptInfo), resolvedByListener: false };
  } finally {
    if (server) stopHitlListener(server);
  }
}

// Telegram flow — bot notification, then DB poll for resolution via
// omniforge_approve_gate (10 min timeout). On timeout, the gate is resolved to
// 'timed_out' (not left pending) before the error propagates (Wave-1.5 triage #2).
async function resolveViaTelegram(params: {
  db: Database.Database;
  task: Task;
  wfId: string;
  workspace: string;
  objective: string;
  gateId: string;
  botToken: string;
  chatId: string | number;
}): Promise<HitlChannelResolution> {
  const { db, task, wfId, workspace, objective, gateId, botToken, chatId } = params;
  const result = await sendTelegramGateNotification({
    botToken,
    chatId,
    taskName: task.name,
    workspace,
    kind: task.kind,
    model: task.model,
    objective,
    gateId,
  });
  insertEvent(db, {
    workflow_id: wfId,
    task_id: task.id,
    type: 'hitl_telegram_sent',
    payload: { chat_id: chatId, sent: result.sent, error: result.error },
  });
  const rawDecision = await pollGateOrMarkTimedOut(db, wfId, task.id, gateId, 2_000, 10 * 60 * 1000);
  if (rawDecision === 'modify') {
    throw new HitlModifyError(readGateFeedback(db, gateId));
  }
  return { decision: rawDecision, resolvedByListener: true };
}

// Channel "cli" — race the terminal prompt against DB polling so the
// dashboard's POST /gate/:id/resolve (which marks the gate approved
// in SQLite) also unblocks the executor. Pre-fix the operator could
// approve from the dashboard, see the gate marked resolved in the
// DB, and watch the daemon hang forever waiting on stdin.
// Whichever resolves first wins; the loser is intentionally orphaned
// — node will GC the readline interface, and the next gate prompt
// creates a fresh one.
//
// Example smoke test 2026-04-30: when the daemon was started detached
// (`stdio: ['ignore', logFd, logFd]`), process.stdin is ignored / not
// a TTY. readline.question() then resolves immediately with empty
// string, which becomes 'reject'. The CLI promise won the race in
// <1s and gates were auto-rejected before the operator could click
// approve in the dashboard. Detection: if stdin is NOT a TTY, skip
// the CLI prompt entirely — only the dashboard / API path can
// resolve the gate. The 10-min DB poll timeout still applies.
async function resolveViaCli(params: {
  db: Database.Database;
  task: Task;
  wfId: string;
  gateId: string;
  promptInfo: HitlPromptInfo;
  doHitl: (info: HitlPromptInfo) => Promise<'approve' | 'reject'>;
  forceCliPrompt: boolean;
}): Promise<HitlChannelResolution> {
  const { db, task, wfId, gateId, promptInfo, doHitl, forceCliPrompt } = params;
  const stdinIsTty = process.stdin.isTTY === true || forceCliPrompt;

  // Aurora W4 — surface a one-shot hint to the dashboard so the operator
  // realises that the daemon is running detached and the terminal prompt
  // is intentionally disabled (only dashboard / MCP approve_gate can
  // resolve the gate). Emit BEFORE the DB poll so the event lands first
  // in the SSE stream / inbox view. Module-scoped Set dedupes per
  // workflow per daemon lifetime — see `_hitlDetachedEmittedFor` above.
  if (!stdinIsTty && !_hitlDetachedEmittedFor.has(wfId)) {
    _recordHitlDetachedEmit(wfId);
    insertEvent(db, {
      workflow_id: wfId,
      task_id: task.id,
      type: 'hitl_terminal_disabled_detached',
      payload: { reason: 'stdin_not_tty', resolution: 'dashboard_inbox_only' },
    });
  }

  let resolvedByListener = false;
  const dbPromise = pollGateOrMarkTimedOut(db, wfId, task.id, gateId, 1_000, 10 * 60 * 1000)
    .then((d) => {
      // Mark so the outer code knows the DB transition already happened
      // and doesn't double-resolve.
      resolvedByListener = true;
      return d;
    });
  let rawDecision: HitlDecision;
  if (stdinIsTty) {
    rawDecision = await Promise.race([doHitl(promptInfo), dbPromise]);
    // The terminal prompt may have won the race; the poll is now detached
    // and keeps running. Swallow its eventual settle so a late timeout
    // cannot surface as an unhandled rejection. The gate is resolved below
    // regardless, so markGateTimedOut (conditional on status='pending')
    // no-ops on the detached poll's timeout.
    void dbPromise.catch(() => {});
  } else {
    rawDecision = await dbPromise;
  }
  if (rawDecision === 'modify') {
    throw new HitlModifyError(readGateFeedback(db, gateId));
  }
  return { decision: rawDecision, resolvedByListener };
}

export async function runHitlGate(
  db: Database.Database,
  task: Task,
  wfId: string,
  workspace: string,
  objective: string,
  autoApprove: boolean,
  doHitl: (info: HitlPromptInfo) => Promise<'approve' | 'reject'>,
  allTasks?: Task[],
  forceCliPrompt = false,
): Promise<void> {
  const gateId = newHitlGateId();
  const hitlConfig = loadHitlConfig(workspace);
  const promptInfo = buildPromptInfo(task, wfId, workspace, objective, allTasks);
  const channel = selectHitlChannel(hitlConfig);

  insertHitlGate(db, {
    id: gateId,
    workflow_id: wfId,
    task_id: task.id,
    gate_type: 'cli',
    prompt: task.name,
    channel,
  });
  insertEvent(db, {
    workflow_id: wfId,
    task_id: task.id,
    type: 'hitl_gate_pending',
    payload: { gate_id: gateId, auto_approve: autoApprove, channel },
  });

  let decision: HitlDecision;
  let resolvedByListener = false;

  const policyApproved = matchesAutoApprovePolicy(task, hitlConfig, workspace);
  if (policyApproved) {
    insertEvent(db, {
      workflow_id: wfId,
      task_id: task.id,
      type: 'hitl_policy_approved',
      payload: { matched_rule: hitlConfig?.auto_approve_if },
    });
  }

  // WIRE-04 — surface a dashboard notification when a gate genuinely needs
  // operator action (i.e. not auto-approved and not policy-approved). The
  // dashboard bell / inbox reads the `notifications` table; without this call
  // the gate_pending notification type was never written. Fail-safe: dispatched
  // fire-and-forget so a notification-service failure never blocks the HITL
  // flow, and any rejection is captured into an audit event.
  if (!autoApprove && !policyApproved) {
    try {
      void notifyGatePending(gateId, wfId, task.name).catch((err) => {
        auditNotificationDispatchFailed(db, wfId, task.id, gateId, err);
      });
    } catch (err) {
      auditNotificationDispatchFailed(db, wfId, task.id, gateId, err);
    }
  }

  if (autoApprove || policyApproved) {
    decision = 'approve';
  } else if (channel === 'slack' && hitlConfig?.slack_webhook_url) {
    ({ decision, resolvedByListener } = await resolveViaSlack({
      db,
      task,
      wfId,
      workspace,
      objective,
      gateId,
      hitlConfig,
      webhookUrl: hitlConfig.slack_webhook_url,
      promptInfo,
      doHitl,
    }));
  } else if (
    channel === 'telegram' &&
    hitlConfig?.telegram_bot_token &&
    hitlConfig.telegram_chat_id != null
  ) {
    ({ decision, resolvedByListener } = await resolveViaTelegram({
      db,
      task,
      wfId,
      workspace,
      objective,
      gateId,
      botToken: hitlConfig.telegram_bot_token,
      chatId: hitlConfig.telegram_chat_id,
    }));
  } else {
    ({ decision, resolvedByListener } = await resolveViaCli({
      db,
      task,
      wfId,
      gateId,
      promptInfo,
      doHitl,
      forceCliPrompt,
    }));
  }

  if (!resolvedByListener) {
    const dbDecision = decision === 'approve' ? 'approved' : decision === 'modify' ? 'modify' : 'rejected';
    resolveHitlGate(db, gateId, dbDecision);
  }
  insertEvent(db, {
    workflow_id: wfId,
    task_id: task.id,
    type: 'hitl_gate_decided',
    payload: { gate_id: gateId, decision },
  });

  if (decision === 'modify') {
    throw new HitlModifyError(readGateFeedback(db, gateId));
  }
  if (decision === 'reject') {
    setTaskFailed(db, task.id);
    task.status = 'failed';
    throw new Error(`Task '${task.name}' rejeitada pelo HITL gate`);
  }
}
