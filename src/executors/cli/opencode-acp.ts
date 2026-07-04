// =============================================================================
// opencode-acp.ts — OpenCode ACP (Agent Coordination Protocol) transport.
//
// Wave D — opencode ACP routing
//
// When `executor_hint === 'cli:opencode'` and ACP transport is enabled
// (default), `runCliTask` delegates to `runOpencodeViaAcp` instead of spawning
// `opencode run` per task. The ACP path:
//   - Reuses ONE `opencode acp` child per workspace via runtimeProcessPool.
//   - Calls `session/new` per task (one opaque sessionId per Aurora task).
//   - Sends `session/prompt` and waits for the final stopReason / usage.
//   - Closes the inner session (best-effort) — pool keeps the process alive.
//
// Gated by `OMNIFORGE_OPENCODE_TRANSPORT` env:
//   - default (unset)  → 'acp'   (route via AcpClientLike)
//   - 'spawn'          → fall through to legacy `opencode run` spawn path
//   - any other value  → 'acp'   (back-compat: a typo doesn't disable ACP)
//
// The streaming text accumulation now subscribes to `session/update`
// message_chunk notifications via the pool wrapper's `onNotification` (EXEC-01)
// and returns the concatenated assistant text. The terminal `session/prompt`
// response carries ONLY {stopReason, usage}, so the stopReason stub is kept
// strictly as a fallback for the zero-chunk case (wrapper without
// onNotification support, or a genuinely empty turn).
// =============================================================================

import type { Task } from '../../types/index.js';
import { acpEventToRuntimeEvents } from '../../runtime/adapters/acp.js';
import {
  spanContextStorage,
} from '../../v2/observability/tracing.js';
import { runtimeError, type RuntimeRunEvent } from '../../runtime/events.js';
import {
  appendRuntimeStreamEvent,
  completeRuntimeTurn,
  createRuntimeSession,
  startRuntimeTurn,
} from '../../runtime/store.js';
import { applySecretPatterns } from '../../v2/security/patterns.js';
import { isCliSafeMode } from './permission-context.js';
import { opencodeBin } from './bin-resolver.js';
import type { RunCliOpts } from './types.js';

const OPENCODE_ACP_DEFAULT_PROMPT_TIMEOUT_MS = 120_000;
const OPENCODE_ACP_INITIALIZE_TIMEOUT_MS = 15_000;
const OPENCODE_ACP_SESSION_TIMEOUT_MS = 15_000;
const OPENCODE_ACP_CLOSE_TIMEOUT_MS = 5_000;

export function shouldUseOpencodeAcp(): boolean {
  // Default ACP. Only the explicit string 'spawn' opts back into the legacy
  // path. Any other value (including empty / typos) keeps the ACP routing on.
  return process.env.OMNIFORGE_OPENCODE_TRANSPORT !== 'spawn';
}

/**
 * Build the opencode ACP factory shape required by `tryAcquireRuntimeSession`.
 * Spawns `opencode acp --cwd <ws>`, wraps stdio in an AcpStdioClient, calls
 * `initialize` once, and returns an `AcpClientLike` view over the client.
 *
 * The factory MUST NOT throw synchronously — failures are reported via Promise
 * rejection; the pool catches them and returns `null` so callers can fall back
 * to the legacy spawn path or surface a clean error.
 */
export function buildOpencodeAcpClientFactory(): import('../../runtime/process-pool.js').AcpClientFactory {
  return async (input) => {
    const { spawn: spawnLive } = await import('node:child_process');
    const { AcpStdioClient } = await import('../../runtime/adapters/acp.js');
    // Resolve the real binary (Windows .cmd shim) rather than a bare 'opencode'
    // that ENOENTs under shell:false. OMNIFORGE_OPENCODE_BIN still wins.
    const binPath = process.env.OMNIFORGE_OPENCODE_BIN ?? opencodeBin();
    const child = spawnLive(binPath, ['acp', '--cwd', input.workspacePath], {
      cwd: input.workspacePath,
      env: {
        ...process.env,
        ...(input.env ?? {}),
        NO_COLOR: '1',
        // Opencode emits UTF-8 JSON-RPC frames; lock LANG so Windows daemons
        // running under chcp 437 don't garble multibyte content.
        LANG: process.env.LANG ?? 'en_US.UTF-8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // CRITICAL (Aurora dogfood 2026-05-31): a spawn failure (ENOENT/EACCES)
    // emits an asynchronous 'error' event. WITHOUT a listener Node rethrows it
    // as an uncaught exception that crashes the ENTIRE orchestrator process and
    // every concurrent task. Keep a persistent listener (so a later mid-session
    // process error can never crash us either) and surface the FIRST error as a
    // rejection the factory can convert into a clean per-task failure + fallback.
    let rejectOnSpawnError: ((e: Error) => void) | null = null;
    const spawnErrorGuard = new Promise<never>((_, reject) => { rejectOnSpawnError = reject; });
    spawnErrorGuard.catch(() => { /* observed via the race below; never let a late settle be "unhandled" */ });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (rejectOnSpawnError) {
        const reject = rejectOnSpawnError;
        rejectOnSpawnError = null;
        const hint = err.code === 'ENOENT'
          ? ` — '${binPath}' not found; set OMNIFORGE_OPENCODE_BIN to a resolvable opencode path or OMNIFORGE_OPENCODE_TRANSPORT=spawn`
          : '';
        reject(new Error(`opencode acp spawn failed (${err.code ?? 'ERR'}): ${err.message}${hint}`));
      }
      // Subsequent errors are intentionally swallowed here — surfaced via
      // request timeouts — but the listener stays attached to prevent a crash.
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error('opencode acp spawn returned a child without piped stdio');
    }
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    const client = new AcpStdioClient(child.stdin, child.stdout, {
      defaultRequestTimeoutMs: OPENCODE_ACP_DEFAULT_PROMPT_TIMEOUT_MS,
    });
    try {
      // Race initialize against the spawn-error guard so an ENOENT rejects here
      // (clean teardown below) instead of escaping as an uncaught 'error'.
      await Promise.race([
        client.request('initialize', {
          protocolVersion: 1,
          clientInfo: { name: 'aurora-opencode-acp', version: '0.1.0' },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        }, OPENCODE_ACP_INITIALIZE_TIMEOUT_MS),
        spawnErrorGuard,
      ]);
    } catch (err) {
      // Tear down the half-spawned process so the pool doesn't track a corpse.
      try { client.close(); } catch { /* best effort */ }
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
      // Tier-0 Wave 4 (0.15) — redact stderr tail before it propagates through
      // the thrown Error.message (caller logs it via runtime events + console).
      const stderr = applySecretPatterns(
        Buffer.concat(stderrChunks).toString('utf8').slice(-200),
      );
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `opencode acp initialize failed: ${detail}${stderr ? ` (stderr tail: ${stderr})` : ''}`,
      );
    }
    const acpClient: import('../../runtime/process-pool.js').AcpClientLike = {
      async request<R = unknown>(method: string, params?: unknown, callOpts?: { timeoutMs?: number }) {
        return client.request<R>(method, params, callOpts?.timeoutMs);
      },
      notify(method, params) {
        client.notify(method, params);
      },
      // Forward the underlying AcpStdioClient notification fan-out so callers
      // can accumulate `session/update` message_chunk text. Without this the
      // assistant output is silently lost (only stopReason survives).
      onNotification(handler) {
        return client.onNotification(handler);
      },
      async close() {
        client.close();
      },
    };
    return { acpClient, child, pid: child.pid ?? null };
  };
}

/**
 * Drive a single Aurora task through opencode's ACP transport.
 *
 * Lifecycle for ONE task:
 *   1. Acquire (or reuse) the per-workspace AcpClientLike via the pool.
 *   2. session/new                              → opaque native sessionId.
 *   3. session/prompt                           → final stopReason + usage.
 *   4. session/close (best-effort)              → free the inner session.
 *
 * Returns the assistant text (or a stopReason summary if streaming was empty).
 */
export async function runOpencodeViaAcp(
  task: Task,
  signal: AbortSignal | undefined,
  opts: RunCliOpts,
  cwd: string,
  promptText: string,
  runtimeExecutorId: string,
): Promise<string> {
  const startedAt = Date.now();
  const spanCtx = spanContextStorage.getStore();
  let runtimeSessionId: string | null = null;
  let runtimeTurnId: string | null = null;

  const appendRuntime = (event: RuntimeRunEvent): void => {
    if (!spanCtx || !runtimeSessionId || !runtimeTurnId) return;
    try {
      appendRuntimeStreamEvent(spanCtx.db, {
        sessionId: runtimeSessionId,
        turnId: runtimeTurnId,
        workflowId: task.workflow_id,
        taskId: task.id,
        event: {
          ...event,
          executorId: event.executorId || runtimeExecutorId,
          sessionId: event.sessionId ?? runtimeSessionId,
          turnId: event.turnId ?? runtimeTurnId,
        },
      });
    } catch {
      // Runtime recording is observability only.
    }
  };

  const completeRuntime = (
    status: 'completed' | 'failed' | 'canceled',
    summary?: string | null,
    errorMessage?: string,
  ): void => {
    if (!spanCtx || !runtimeTurnId) return;
    try {
      completeRuntimeTurn(spanCtx.db, runtimeTurnId, {
        status,
        resultSummary: summary,
        error: errorMessage
          ? {
            code: 'opencode_acp_failed',
            origin: `task:${task.id}`,
            message: errorMessage,
            suggestedAction: 'Inspect runtime stream events; set OMNIFORGE_OPENCODE_TRANSPORT=spawn to bypass ACP routing if persistent.',
            safeContext: { executorId: runtimeExecutorId, model: task.model ?? null },
          }
          : null,
      });
    } catch {
      // best-effort
    }
  };

  // Pre-create the runtime session/turn rows mirroring the spawn path so the
  // dashboard's runtime tab shows the ACP execution. The ACP pool ALSO creates
  // its own row keyed by pool key; the row we create here is the per-turn view.
  if (spanCtx) {
    try {
      const session = createRuntimeSession(spanCtx.db, {
        workflowId: task.workflow_id,
        taskId: task.id,
        executorId: runtimeExecutorId,
        protocolTier: 'acp-stdio',
        streamFormat: 'acp-jsonrpc',
        nativeSessionId: null,
        runtimeMode: opts.runtime?.runtimeMode ?? 'persistent',
        status: 'active',
        workspacePath: cwd,
        fallbackReason: null,
        approvalStatus: isCliSafeMode() ? 'not_required' : 'approved',
        auditStatus: 'recorded',
        runMode: isCliSafeMode() ? 'dry-run' : 'approved-run',
        metadata: {
          model: task.model ?? null,
          executor_hint: task.executor_hint ?? null,
          transport: 'acp-stdio',
          via: 'runOpencodeViaAcp',
        },
      });
      const turn = startRuntimeTurn(spanCtx.db, {
        sessionId: session.id,
        workflowId: task.workflow_id,
        taskId: task.id,
        attempt: task.retry_count + 1,
        promptSummary: `${task.name} (${task.kind})`,
        metadata: { timeout_seconds: task.timeout_seconds, max_retries: task.max_retries },
      });
      runtimeSessionId = session.id;
      runtimeTurnId = turn.id;
      appendRuntime({
        type: 'runtime.turn.started',
        ts: startedAt,
        executorId: runtimeExecutorId,
        raw: { protocolTier: 'acp-stdio', streamFormat: 'acp-jsonrpc', runtimeMode: 'persistent' },
      });
    } catch {
      // Runtime recording is best-effort.
    }
  }

  void opts.onEvent?.({
    type: 'task_streaming_start',
    workflow_id: task.workflow_id,
    payload: { task_id: task.id, task_name: task.name, ts: startedAt },
  });

  if (!spanCtx) {
    // Without a span context we cannot reach the DB to acquire a pool entry.
    // Fall back to the spawn path by surfacing a typed error the caller can
    // observe; runCliTask will not call us in this state today, but we keep
    // the guard rather than crashing on `spanCtx.db`.
    throw new Error('runOpencodeViaAcp requires an active spanContextStorage store (db)');
  }

  // Resolve the model BEFORE acquiring the pool so we don't spawn opencode
  // when nothing is routable. Warnings are non-fatal; only `source: 'none'` is.
  const { resolveOpencodeModelForWorkflow, readOpencodeConfig } = await import('../../v2/runtime/opencode-config.js');
  const config = readOpencodeConfig();
  const modelResolution = resolveOpencodeModelForWorkflow({
    workflowModelHint: task.model ?? null,
    configSnapshot: config,
    envOverride: process.env.OMNIFORGE_OPENCODE_MODEL,
  });
  for (const warning of modelResolution.warnings) {
    appendRuntime({
      type: 'runtime.meta',
      ts: Date.now(),
      executorId: runtimeExecutorId,
      raw: { kind: 'opencode_model_warning', warning },
    });
  }
  if (modelResolution.source === 'none') {
    const message = `No opencode model resolvable: ${modelResolution.warnings.join('; ')}`;
    appendRuntime(runtimeError(runtimeExecutorId, 'opencode_acp_no_model', message,
      'Configure a default model in opencode (`~/.config/opencode/opencode.json` `model` field) or set OMNIFORGE_OPENCODE_MODEL.'));
    completeRuntime('failed', null, message);
    throw new Error(message);
  }

  const { tryAcquireRuntimeSession } = await import('../../runtime/process-pool.js');
  const factory = buildOpencodeAcpClientFactory();
  const handle = await tryAcquireRuntimeSession(spanCtx.db, {
    workflowId: task.workflow_id,
    taskId: task.id,
    executorId: runtimeExecutorId,
    protocolTier: 'acp-stdio',
    streamFormat: 'acp-jsonrpc',
    workspacePath: cwd,
    profile: 'code',
    runMode: isCliSafeMode() ? 'dry-run' : 'approved-run',
    approvalStatus: isCliSafeMode() ? 'not_required' : 'approved',
    auditStatus: 'recorded',
  }, { acpClientFactory: factory });

  if (!handle || !handle.acpClient) {
    const message = 'opencode ACP pool acquire returned no live client';
    appendRuntime(runtimeError(runtimeExecutorId, 'opencode_acp_acquire_failed', message,
      'Set OMNIFORGE_OPENCODE_TRANSPORT=spawn to bypass ACP routing temporarily.'));
    completeRuntime('failed', null, message);
    throw new Error(message);
  }

  const acpClient = handle.acpClient;

  // Open a fresh ACP session for THIS task. opencode requires `cwd` and
  // (empty) `mcpServers` per the live probe.
  let nativeSessionId: string;
  try {
    const sessionResult = await acpClient.request<{ sessionId?: unknown }>(
      'session/new',
      { cwd, mcpServers: [] },
      { timeoutMs: OPENCODE_ACP_SESSION_TIMEOUT_MS },
    );
    const sid = sessionResult?.sessionId;
    if (typeof sid !== 'string' || sid.length === 0) {
      throw new Error('session/new returned no sessionId');
    }
    nativeSessionId = sid;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const message = `opencode session/new rejected: ${detail}`;
    appendRuntime(runtimeError(runtimeExecutorId, 'opencode_acp_session_new_failed', message,
      'Verify opencode auth (`opencode auth list`) and that the requested model is available.', {
        model: modelResolution.model,
        source: modelResolution.source,
      }));
    completeRuntime('failed', null, message);
    throw new Error(message);
  }

  // Best-effort: stamp the native session id onto the pool row so cancel can
  // target it later. Ignored if the pool entry is gone.
  try {
    const { runtimeProcessPool } = await import('../../runtime/process-pool.js');
    runtimeProcessPool.recordAcpInbound(spanCtx.db, handle.sessionId, { nativeAcpSessionId: nativeSessionId });
  } catch {
    // observability only
  }

  // Accumulate streamed assistant text from `session/update` message_chunk
  // notifications. The terminal `session/prompt` response carries ONLY
  // {stopReason, usage} — the assistant text lives exclusively in the
  // notification stream (ground-truthed by scripts/runtime-resume-harness/
  // opencode-acp-smoke.mjs and the live opencode probe). Scope strictly to
  // THIS task's nativeSessionId so a shared pooled process can't bleed another
  // task's chunks into ours.
  let assistantBuffer = '';
  let chunkSeq = 0;
  let unsubscribeChunks: (() => void) | undefined;
  if (typeof acpClient.onNotification === 'function') {
    unsubscribeChunks = acpClient.onNotification((notif) => {
      if (notif.method !== 'session/update') return;
      const params = notif.params as { sessionId?: unknown; update?: unknown } | undefined;
      if (!params || typeof params !== 'object') return;
      if (typeof params.sessionId === 'string' && params.sessionId !== nativeSessionId) return;
      // Reuse the canonical mapper so chunk-shape parsing stays single-sourced.
      const events = acpEventToRuntimeEvents(runtimeExecutorId, nativeSessionId, params.update);
      for (const event of events) {
        if (event.type !== 'assistant.delta') continue;
        const text = typeof event.text === 'string' ? event.text : '';
        if (!text) continue;
        assistantBuffer += text;
        chunkSeq += 1;
        appendRuntime({ ...event, ts: Date.now() });
        void opts.onEvent?.({
          type: 'task_streaming_chunk',
          workflow_id: task.workflow_id,
          payload: {
            task_id: task.id,
            task_name: task.name,
            chunk: text,
            stream: 'stdout',
            cumulative_chars: assistantBuffer.length,
            seq: chunkSeq,
          },
        });
      }
    });
  }

  // Send the prompt. We forward the parent abort signal as a `session/cancel`
  // notification so the in-flight prompt can settle into stopReason='cancelled'.
  let promptResult: { stopReason?: unknown; usage?: unknown } | undefined;
  let unhookAbort: (() => void) | undefined;
  try {
    if (signal) {
      const onAbort = (): void => {
        try { acpClient.notify('session/cancel', { sessionId: nativeSessionId }); } catch { /* best effort */ }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      unhookAbort = (): void => signal.removeEventListener('abort', onAbort);
    }
    promptResult = await acpClient.request(
      'session/prompt',
      { sessionId: nativeSessionId, prompt: [{ type: 'text', text: promptText }] },
      { timeoutMs: OPENCODE_ACP_DEFAULT_PROMPT_TIMEOUT_MS },
    );
  } catch (err) {
    if (unhookAbort) unhookAbort();
    if (unsubscribeChunks) unsubscribeChunks();
    const detail = err instanceof Error ? err.message : String(err);
    const message = `opencode session/prompt failed: ${detail}`;
    const wasCancel = signal?.aborted === true;
    appendRuntime(runtimeError(
      runtimeExecutorId,
      wasCancel ? 'opencode_acp_cancelled' : 'opencode_acp_prompt_failed',
      message,
      wasCancel
        ? 'No action required — cancellation was requested by the caller.'
        : 'Inspect runtime stream events; the executor stderr will show provider-side errors.',
      { sessionId: nativeSessionId, model: modelResolution.model },
    ));
    completeRuntime(wasCancel ? 'canceled' : 'failed', null, message);
    try { acpClient.notify('session/close', { sessionId: nativeSessionId }); } catch { /* best effort */ }
    throw new Error(message);
  }
  if (unhookAbort) unhookAbort();
  if (unsubscribeChunks) unsubscribeChunks();

  // Best-effort close of THIS native session. Pool keeps the underlying
  // process for the next task.
  try {
    await Promise.race([
      acpClient.request('session/close', { sessionId: nativeSessionId }, { timeoutMs: OPENCODE_ACP_CLOSE_TIMEOUT_MS }),
      new Promise((resolve) => setTimeout(resolve, OPENCODE_ACP_CLOSE_TIMEOUT_MS)),
    ]);
  } catch {
    // session/close failure is non-fatal.
  }

  const stopReason = typeof promptResult?.stopReason === 'string' ? promptResult.stopReason : 'unknown';
  // Prefer the streamed assistant text. Only fall back to the stopReason stub
  // when the server emitted zero message_chunk notifications (e.g. a wrapper
  // without onNotification support, or a genuinely empty turn) so downstream
  // consumers always get a non-empty, debuggable string.
  const finalText = assistantBuffer.length > 0
    ? assistantBuffer
    : `(opencode ACP completed: stopReason=${stopReason})`;
  appendRuntime({
    type: 'runtime.result',
    ts: Date.now(),
    executorId: runtimeExecutorId,
    sessionId: nativeSessionId,
    text: finalText.slice(0, 500),
    result: {
      chars: finalText.length,
      chunks: chunkSeq,
      stopReason,
      usage: promptResult?.usage ?? null,
      model: modelResolution.model,
      source: modelResolution.source,
    },
  });
  completeRuntime('completed', finalText.slice(0, 500));
  void opts.onEvent?.({
    type: 'task_streaming_end',
    workflow_id: task.workflow_id,
    payload: {
      task_id: task.id,
      task_name: task.name,
      total_chars: finalText.length,
      total_chunks: chunkSeq,
      duration_ms: Date.now() - startedAt,
      ttft_ms: Date.now() - startedAt,
      exit_code: 0,
    },
  });
  return finalText;
}
