import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — tree-kill ships its own ambient typings
import treeKill from 'tree-kill';
import type Database from 'better-sqlite3';

import type { RuntimeProtocolTier, RuntimeStreamFormat } from './capabilities.js';
import {
  createRuntimeSession,
  heartbeatRuntimeSession,
  listAcpStdioSessions,
  markOrphanRecovered,
  updateRuntimeSessionMetadata,
  updateRuntimeSessionStatus,
  type RuntimeSessionRow,
} from './store.js';

export type RuntimePoolProfile = 'chat' | 'review' | 'code' | 'autonomous';
export type RuntimePoolRunMode = 'dry-run' | 'approved-run';

export interface RuntimeProcessSessionInput {
  workflowId?: string | null;
  taskId?: string | null;
  executorId: string;
  protocolTier: RuntimeProtocolTier;
  streamFormat: RuntimeStreamFormat;
  workspacePath?: string | null;
  profile?: RuntimePoolProfile;
  runMode?: RuntimePoolRunMode;
  approvalStatus?: 'not_required' | 'pending' | 'approved' | 'denied';
  auditStatus?: 'not_required' | 'pending' | 'recorded' | 'failed';
  nativeSessionId?: string | null;
  command?: string | null;
  args?: string[];
  env?: Record<string, string | undefined>;
  dryRun?: boolean;
  fallbackReason?: string | null;
}

export interface RuntimeResumeSafetyInput {
  executorId: string;
  workspacePath?: string | null;
  profile?: RuntimePoolProfile;
  runMode?: RuntimePoolRunMode;
}

export interface RuntimeResumeSafetyDecision {
  canResume: boolean;
  reason: string;
}

interface RuntimePoolEntry {
  sessionId: string;
  child: ChildProcessWithoutNullStreams | null;
}

// ─── Wave C Agent O — ACP-stdio process pool extension ───────────────────────

/**
 * Minimal client surface used by the pool to talk to a running `opencode acp`
 * (or any future ACP-stdio agent) child process. Defined locally so this file
 * has zero direct dependency on `src/runtime/adapters/acp.ts` — keeps the
 * Wave C parallelism safe (Agent N owns the adapter; we own the pool).
 *
 * Anything implementing this interface (mock, real adapter) plugs in via the
 * `acpClientFactory` option on `tryAcquireRuntimeSession`. The factory is
 * called exactly once per fresh process spawn; reused processes get the
 * already-instantiated client back via `pool.attach(sessionId).acpClient`.
 *
 * Method shape mirrors the JSON-RPC ops the mock fixture already implements:
 *   - request(method, params): one-shot RPC, resolves with `result` or rejects on `error`
 *   - notify(method, params): fire-and-forget JSON-RPC notification (no id)
 *   - close(): graceful adapter shutdown — should drain pending requests, NOT kill the child
 */
export interface AcpClientLike {
  request<R = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<R>;
  notify(method: string, params?: unknown): void;
  /**
   * EXEC-01 — optional subscription to JSON-RPC notifications from the adapter
   * (e.g. `session/update` message_chunks) so callers can accumulate assistant
   * text instead of losing it. Returns an unsubscribe function. Typed
   * structurally (no import of adapters/acp) to preserve this module's
   * documented zero dependency on the ACP adapter; the shape mirrors
   * `AcpNotification`.
   */
  onNotification?(handler: (notif: { method: string; params: unknown; receivedAt: number }) => void): () => void;
  close(): Promise<void>;
}

/**
 * Per-process record carried in the ACP pool. Keyed by the synthetic
 * `pool-key` derived from {workspace, executor, protocol_tier}. Tracks every
 * `runtime_sessions` row that points at this same OS process — the pool runs
 * one child per workspace, but each `session/new` against that child becomes
 * a separate runtime_sessions row so cancel/heartbeat semantics stay scoped.
 */
interface AcpPoolProcessEntry {
  /** Human-readable pool key for diagnostics (workspace::executor::tier). */
  poolKey: string;
  /** Underlying child process. `null` only in the test/mocked code path. */
  child: ChildProcess | null;
  /** OS-level pid (or synthetic id from the mock). */
  pid: number | null;
  /** Adapter client wrapping stdio. Lifecycle owned by the pool. */
  acpClient: AcpClientLike;
  /** Resolved + normalised workspace path used as the cwd for the spawn. */
  workspacePath: string;
  /** Executor id (cli:opencode etc.). Locked at spawn time. */
  executorId: string;
  /** Set of runtime_sessions ids whose `metadata.acp_pool_key === poolKey`. */
  trackedSessionIds: Set<string>;
  /** Set of native ACP `sessionId`s observed against this process. */
  trackedAcpSessionIds: Set<string>;
  /** Last heartbeat timestamp (ms). Updated on every successful inbound message. */
  lastHeartbeatAt: number;
  /** Set when shutdown has begun — no new sessions can be tracked once true. */
  shuttingDown: boolean;
}

/**
 * Pool key normalisation rules:
 *   1. Forward-slash separators (Windows path → forward slashes)
 *   2. Trim trailing slash
 *   3. Lowercase only on Windows (POSIX paths are case-sensitive on linux/macOS)
 *   4. `path.resolve()` first to collapse `..` and absolutise relative paths
 *
 * Two callers passing different surface forms of the same workspace
 * (`./repo`, `C:/repo`, `c:\repo\`, etc.) must collide on the same key, so
 * the per-workspace mutex actually serialises them.
 */
function normalisePoolPath(value: string): string {
  const resolved = path.resolve(value);
  const forward = resolved.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? forward.toLowerCase() : forward;
}

function buildAcpPoolKey(executorId: string, protocolTier: RuntimeProtocolTier, workspacePath: string): string {
  return `${executorId}::${protocolTier}::${normalisePoolPath(workspacePath)}`;
}

/** Heartbeat staleness thresholds (ms). Tunable via env in production. */
const ACP_HEARTBEAT_PROBE_MS = 60_000;     // 60s — start probing
const ACP_HEARTBEAT_FORCE_STALE_MS = 90_000; // 90s — mark stale immediately
const ACP_KILL_GRACE_MS = 5_000;            // 5s — SIGTERM → SIGKILL window
const ACP_INITIALIZE_PING_TIMEOUT_MS = 2_000;
const ACP_DRAIN_CLOSE_TIMEOUT_MS = 3_000;

function parseMetadata(row: RuntimeSessionRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.metadata_json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizePath(value: string | null | undefined): string | null {
  return value ? value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : null;
}

export function canResumeRuntimeSession(
  row: RuntimeSessionRow,
  input: RuntimeResumeSafetyInput,
): RuntimeResumeSafetyDecision {
  const metadata = parseMetadata(row);
  if (row.status !== 'active') {
    return { canResume: false, reason: `session status is ${row.status}` };
  }
  if (row.executor_id !== input.executorId) {
    return { canResume: false, reason: `executor mismatch: ${row.executor_id} vs ${input.executorId}` };
  }
  const requestedWorkspace = normalizePath(input.workspacePath);
  const sessionWorkspace = normalizePath(row.workspace_path);
  if (requestedWorkspace && sessionWorkspace && requestedWorkspace !== sessionWorkspace) {
    return { canResume: false, reason: 'workspace path differs from the stored session' };
  }
  const sessionProfile = String(metadata.profile ?? 'code');
  const requestedProfile = input.profile ?? 'code';
  if (sessionProfile !== requestedProfile) {
    return { canResume: false, reason: `profile mismatch: ${sessionProfile} vs ${requestedProfile}` };
  }
  if (row.run_mode !== (input.runMode ?? row.run_mode)) {
    return { canResume: false, reason: `run mode mismatch: ${row.run_mode} vs ${input.runMode}` };
  }
  if (!row.native_session_id && metadata.process_state !== 'live') {
    return { canResume: false, reason: 'no native session id or live process is available' };
  }
  return { canResume: true, reason: 'workspace, executor, profile, and run mode match' };
}

export class RuntimeProcessPool {
  private readonly entries = new Map<string, RuntimePoolEntry>();

  // ─── Wave C Agent O — ACP-stdio state ───────────────────────────────────
  /**
   * Map from pool key → live ACP process record. One process serves N
   * runtime_sessions rows, all in the same workspace + executor + tier.
   */
  private readonly acpProcesses = new Map<string, AcpPoolProcessEntry>();
  /**
   * Per-pool-key mutex chain. Each `acquireAcpProcess` call appends its work
   * to the tail of this promise; the next caller awaits before spawning. This
   * is what prevents the "5 concurrent acquires → 5 spawned processes" race.
   *
   * Implementation: store the tail; new callers `await` the previous tail
   * before they themselves run, then they replace it with their own promise
   * resolved at end-of-block. Identical pattern to a single-slot semaphore
   * keyed by string.
   */
  private readonly acpMutexes = new Map<string, Promise<void>>();
  /**
   * Heartbeat tick interval handle. Started lazily on first ACP acquire so
   * pure non-ACP workloads never see a background timer.
   */
  private heartbeatTick: NodeJS.Timeout | null = null;
  /**
   * Owning daemon pid, captured at construction. Persisted into ACP rows so
   * orphan recovery on a fresh daemon can detect "this row's daemon is dead".
   */
  private readonly daemonPid: number = process.pid;

  startSession(db: Database.Database, input: RuntimeProcessSessionInput): RuntimeSessionRow {
    if (input.profile === 'autonomous' && input.runMode !== 'approved-run') {
      throw new Error('autonomous runtime sessions require approved-run mode');
    }

    let child: ChildProcessWithoutNullStreams | null = null;
    let pid: number | null = null;
    let processState: 'metadata-only' | 'live' = 'metadata-only';

    if (!input.dryRun && input.command?.trim()) {
      child = spawn(input.command, input.args ?? [], {
        cwd: input.workspacePath ?? process.cwd(),
        env: { ...process.env, ...(input.env ?? {}) },
        shell: process.platform === 'win32',
        windowsHide: true,
      });
      pid = child.pid ?? null;
      processState = 'live';
    }

    const session = createRuntimeSession(db, {
      workflowId: input.workflowId,
      taskId: input.taskId,
      executorId: input.executorId,
      protocolTier: input.protocolTier,
      streamFormat: input.streamFormat,
      nativeSessionId: input.nativeSessionId ?? null,
      runtimeMode: 'persistent',
      status: 'active',
      workspacePath: input.workspacePath,
      fallbackReason: input.fallbackReason ?? (processState === 'metadata-only' ? 'persistent process not started; session is metadata-only until an explicit safe start' : null),
      approvalStatus: input.approvalStatus ?? (input.runMode === 'approved-run' ? 'approved' : 'not_required'),
      auditStatus: input.auditStatus ?? 'recorded',
      runMode: input.runMode ?? 'dry-run',
      metadata: {
        profile: input.profile ?? 'code',
        process_state: processState,
        pid,
        command: input.command ?? null,
        last_heartbeat_at: Date.now(),
      },
    });

    if (child) {
      this.entries.set(session.id, { sessionId: session.id, child });
      child.once('exit', (code, signal) => {
        try {
          updateRuntimeSessionStatus(db, session.id, 'archived', {
            process_state: 'dead',
            exit_code: code,
            signal,
            ended_at: Date.now(),
          });
        } catch {
          // Process lifecycle bookkeeping must not crash the daemon.
        }
      });
    }

    return session;
  }

  attach(sessionId: string): RuntimePoolEntry | null {
    return this.entries.get(sessionId) ?? null;
  }

  heartbeat(db: Database.Database, sessionId: string): RuntimeSessionRow | null {
    return heartbeatRuntimeSession(db, sessionId, {
      process_state: this.entries.has(sessionId) ? 'live' : 'metadata-only',
    });
  }

  markStale(db: Database.Database, sessionId: string, reason = 'operator marked session stale'): RuntimeSessionRow | null {
    return updateRuntimeSessionStatus(db, sessionId, 'stale', {
      process_state: 'stale',
      stale_reason: reason,
      stale_at: Date.now(),
    });
  }

  endSession(db: Database.Database, sessionId: string, reason = 'operator ended session'): RuntimeSessionRow | null {
    const entry = this.entries.get(sessionId);
    if (entry?.child?.pid) {
      try {
        entry.child.kill();
      } catch {
        // Best effort; status is still archived so the UI does not offer resume.
      }
    }
    this.entries.delete(sessionId);
    return updateRuntimeSessionStatus(db, sessionId, 'archived', {
      process_state: 'dead',
      end_reason: reason,
      ended_at: Date.now(),
    });
  }

  // ─── Wave C Agent O — ACP API ───────────────────────────────────────────

  /**
   * Acquire (or reuse) an ACP-stdio process for a workspace and create the
   * corresponding runtime_sessions row.
   *
   * Behaviour:
   *   1. Take per-pool-key mutex (serialises concurrent callers).
   *   2. If a fresh-enough live entry exists, reuse it — write a NEW
   *      runtime_sessions row (every logical session is its own row), but
   *      reuse the underlying child + acpClient.
   *   3. Otherwise: invoke `acpClientFactory` to spawn a fresh
   *      `opencode acp --cwd <ws>`, await initialize, persist row, register.
   *   4. Always release the mutex in finally (even on error).
   */
  async acquireAcpProcess(
    db: Database.Database,
    input: RuntimeProcessSessionInput,
    acpClientFactory: AcpClientFactory,
  ): Promise<AcquireAcpResult> {
    if (!input.workspacePath?.trim()) {
      throw new Error('acquireAcpProcess requires workspacePath');
    }
    if (input.protocolTier !== 'acp-stdio') {
      throw new Error(`acquireAcpProcess called with non-acp tier ${input.protocolTier}`);
    }
    if (input.profile === 'autonomous' && input.runMode !== 'approved-run') {
      throw new RuntimePoolEscalationError(
        `Cannot acquire autonomous-profile ACP session in ${input.runMode ?? 'dry-run'} mode (requires approved-run).`,
      );
    }

    const poolKey = buildAcpPoolKey(input.executorId, 'acp-stdio', input.workspacePath);
    const release = await this.takePoolMutex(poolKey);
    try {
      const existing = this.findReusableAcpEntry(db, poolKey);
      if (existing) {
        const session = this.persistAcpRow(db, input, existing, /* reused */ true);
        existing.trackedSessionIds.add(session.id);
        existing.lastHeartbeatAt = Date.now();
        return {
          session,
          process: existing,
          reused: true,
        };
      }

      // Fresh spawn path — delegate process creation to the adapter factory.
      const factoryResult = await acpClientFactory({
        executorId: input.executorId,
        workspacePath: input.workspacePath,
        env: input.env,
      });

      const entry: AcpPoolProcessEntry = {
        poolKey,
        child: factoryResult.child,
        pid: factoryResult.pid ?? factoryResult.child?.pid ?? null,
        acpClient: factoryResult.acpClient,
        workspacePath: input.workspacePath,
        executorId: input.executorId,
        trackedSessionIds: new Set<string>(),
        trackedAcpSessionIds: new Set<string>(),
        lastHeartbeatAt: Date.now(),
        shuttingDown: false,
      };

      // Wire exit handler ONCE per spawn — when the process dies, mark every
      // tracked session as stale so subsequent acquires don't try to reuse it.
      this.attachAcpExitHandler(db, entry);

      this.acpProcesses.set(poolKey, entry);
      this.ensureHeartbeatTick(db);

      const session = this.persistAcpRow(db, input, entry, /* reused */ false);
      entry.trackedSessionIds.add(session.id);

      return {
        session,
        process: entry,
        reused: false,
      };
    } finally {
      release();
    }
  }

  /**
   * Stamp a `last_heartbeat_at` (and optional native ACP sessionId) into the
   * row whenever an inbound message lands. Strategy B (passive): no probe is
   * sent; we only track that bytes are flowing.
   *
   * `nativeAcpSessionId` (when set) is the value the ACP server returned from
   * `session/new` — recorded so cancel can target the right inner session
   * even though the pool entry itself is process-scoped.
   */
  recordAcpInbound(
    db: Database.Database,
    sessionId: string,
    opts?: { nativeAcpSessionId?: string },
  ): RuntimeSessionRow | null {
    const entry = this.findEntryBySessionId(sessionId);
    if (entry) {
      entry.lastHeartbeatAt = Date.now();
      if (opts?.nativeAcpSessionId) entry.trackedAcpSessionIds.add(opts.nativeAcpSessionId);
    }
    const patch: Record<string, unknown> = {
      process_state: entry ? 'live' : 'metadata-only',
    };
    if (opts?.nativeAcpSessionId) patch.native_acp_session_id = opts.nativeAcpSessionId;
    return heartbeatRuntimeSession(db, sessionId, patch);
  }

  /**
   * Cancel a single logical ACP session. Sends `session/cancel` notification
   * targeting the native ACP sessionId (NOT the runtime_sessions row id).
   *
   * Does NOT kill the underlying process — other sessions sharing the same
   * `acp-stdio` child stay alive. The caller is expected to drop their
   * pending prompt promise after the 5s grace window.
   */
  async cancelAcpSession(
    db: Database.Database,
    sessionId: string,
    opts: { nativeAcpSessionId: string; reason?: string },
  ): Promise<void> {
    const entry = this.findEntryBySessionId(sessionId);
    if (!entry || entry.shuttingDown) return;
    try {
      entry.acpClient.notify('session/cancel', { sessionId: opts.nativeAcpSessionId });
    } catch (err) {
      // Notify failure is best-effort; record on the row but don't escalate.
      updateRuntimeSessionMetadata(db, sessionId, {
        last_cancel_error: err instanceof Error ? err.message : String(err),
        last_cancel_at: Date.now(),
      });
      return;
    }
    updateRuntimeSessionMetadata(db, sessionId, {
      last_cancel_at: Date.now(),
      last_cancel_reason: opts.reason ?? 'caller_requested',
      cancelled_acp_session_id: opts.nativeAcpSessionId,
    });
  }

  /**
   * Drain phase A: send `session/close` for every tracked native ACP session
   * across every live entry. Does NOT kill the children — the daemon's main
   * cancel chain (`broadcastCancelToWorkflow`) runs after this and will abort
   * AbortControllers; we only force-kill any survivors at phase B (below).
   *
   * Returns aggregate counters for observability.
   */
  async drainAcpProcesses(db: Database.Database): Promise<AcpDrainResult> {
    let processesTouched = 0;
    let sessionsClosed = 0;
    const errors: Array<{ poolKey: string; error: string }> = [];
    for (const entry of Array.from(this.acpProcesses.values())) {
      entry.shuttingDown = true;
      processesTouched += 1;
      for (const acpSid of entry.trackedAcpSessionIds) {
        try {
          entry.acpClient.notify('session/close', { sessionId: acpSid });
          sessionsClosed += 1;
        } catch (err) {
          errors.push({
            poolKey: entry.poolKey,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Mark every runtime_sessions row that pointed at this process as
      // archived so the dashboard stops offering resume after restart.
      for (const sid of entry.trackedSessionIds) {
        try {
          updateRuntimeSessionStatus(db, sid, 'archived', {
            process_state: 'dead',
            end_reason: 'daemon_drain',
            ended_at: Date.now(),
          });
        } catch (err) {
          errors.push({
            poolKey: entry.poolKey,
            error: `mark archived: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
    return { processesTouched, sessionsClosed, errors };
  }

  /**
   * Drain phase B: after the AbortController cascade has had its grace, kill
   * any ACP processes that did not exit on their own. Used at the very end of
   * `daemon.ts cleanup()` to guarantee no opencode child outlives the daemon.
   */
  async forceKillSurvivingAcpProcesses(): Promise<{ killed: number }> {
    let killed = 0;
    const tasks: Array<Promise<void>> = [];
    for (const [poolKey, entry] of Array.from(this.acpProcesses.entries())) {
      const child = entry.child;
      if (!child || child.exitCode !== null || child.killed) continue;
      tasks.push(this.gracefulThenForceKill(child).then(() => {
        killed += 1;
      }).catch(() => {
        // Already-dead processes throw on kill — non-fatal.
      }));
      // Optimistically drop our reference — heartbeat tick will not see it again.
      this.acpProcesses.delete(poolKey);
    }
    await Promise.all(tasks);
    if (this.heartbeatTick) {
      clearInterval(this.heartbeatTick);
      this.heartbeatTick = null;
    }
    return { killed };
  }

  /**
   * 60s background sweep — for each live ACP entry:
   *   - heartbeat fresh (<60s)        → noop
   *   - heartbeat 60-90s              → send `initialize` ping (2s timeout);
   *                                     pass refreshes lastHeartbeatAt;
   *                                     fail marks stale + kills child
   *   - heartbeat >=90s               → mark stale + kill child immediately
   *
   * Exposed publicly so tests can drive deterministic ticks via fake timers.
   */
  async runAcpHeartbeatTick(db: Database.Database): Promise<void> {
    const now = Date.now();
    for (const [poolKey, entry] of Array.from(this.acpProcesses.entries())) {
      const age = now - entry.lastHeartbeatAt;
      if (age < ACP_HEARTBEAT_PROBE_MS) continue;
      if (age >= ACP_HEARTBEAT_FORCE_STALE_MS) {
        await this.expireAcpEntry(db, poolKey, entry, 'heartbeat_force_stale_90s');
        continue;
      }
      // 60s ≤ age < 90s — try a probe.
      try {
        await entry.acpClient.request('initialize', { protocolVersion: 1 }, {
          timeoutMs: ACP_INITIALIZE_PING_TIMEOUT_MS,
        });
        entry.lastHeartbeatAt = Date.now();
      } catch {
        await this.expireAcpEntry(db, poolKey, entry, 'heartbeat_probe_failed');
      }
    }
  }

  /**
   * Test helper — return the live ACP process registry as a snapshot. Useful
   * to assert "exactly one entry exists for workspace X" without exposing
   * internal types.
   */
  _peekAcpProcesses(): Array<{ poolKey: string; pid: number | null; trackedSessionIds: number; trackedAcpSessionIds: number }> {
    return Array.from(this.acpProcesses.values()).map((entry) => ({
      poolKey: entry.poolKey,
      pid: entry.pid,
      trackedSessionIds: entry.trackedSessionIds.size,
      trackedAcpSessionIds: entry.trackedAcpSessionIds.size,
    }));
  }

  /**
   * Test helper — clear ACP-side state. Necessary because the
   * `runtimeProcessPool` singleton bleeds across tests in the same file.
   */
  _resetAcpState(): void {
    if (this.heartbeatTick) {
      clearInterval(this.heartbeatTick);
      this.heartbeatTick = null;
    }
    this.acpProcesses.clear();
    this.acpMutexes.clear();
  }

  // ─── Wave C Agent O — internals ─────────────────────────────────────────

  private async takePoolMutex(poolKey: string): Promise<() => void> {
    const previous = this.acpMutexes.get(poolKey) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Chain ourselves AFTER the previous tail and immediately publish ours
    // as the new tail. Cleanup removes the entry only if no other caller has
    // already replaced it (avoids leaking memory across many short bursts).
    this.acpMutexes.set(poolKey, previous.then(() => next));
    await previous;
    return () => {
      release();
      // If we are still the registered tail, drop the entry to avoid leak.
      if (this.acpMutexes.get(poolKey) === previous.then(() => next)) {
        this.acpMutexes.delete(poolKey);
      }
    };
  }

  private findReusableAcpEntry(db: Database.Database, poolKey: string): AcpPoolProcessEntry | null {
    const entry = this.acpProcesses.get(poolKey);
    if (!entry) return null;
    if (entry.shuttingDown) return null;
    if (entry.child && entry.child.exitCode !== null) return null;
    if (Date.now() - entry.lastHeartbeatAt > ACP_HEARTBEAT_FORCE_STALE_MS) return null;
    // DB cross-check — if all of this entry's tracked rows are no longer
    // 'active' (operator manually expired everything) we treat it as gone.
    let hasActiveRow = false;
    for (const sid of entry.trackedSessionIds) {
      const row = db.prepare(`SELECT status FROM runtime_sessions WHERE id = ?`).get(sid) as
        | { status: string }
        | undefined;
      if (row?.status === 'active') {
        hasActiveRow = true;
        break;
      }
    }
    // Empty-set means a brand-new entry that has not had its first row
    // attached yet — that is a valid "reuse" candidate too.
    if (entry.trackedSessionIds.size === 0 || hasActiveRow) return entry;
    return null;
  }

  private findEntryBySessionId(sessionId: string): AcpPoolProcessEntry | null {
    for (const entry of this.acpProcesses.values()) {
      if (entry.trackedSessionIds.has(sessionId)) return entry;
    }
    return null;
  }

  private persistAcpRow(
    db: Database.Database,
    input: RuntimeProcessSessionInput,
    entry: AcpPoolProcessEntry,
    reused: boolean,
  ): RuntimeSessionRow {
    return createRuntimeSession(db, {
      workflowId: input.workflowId,
      taskId: input.taskId,
      executorId: input.executorId,
      protocolTier: 'acp-stdio',
      streamFormat: input.streamFormat,
      nativeSessionId: input.nativeSessionId ?? null,
      runtimeMode: 'persistent',
      status: 'active',
      workspacePath: input.workspacePath,
      fallbackReason: input.fallbackReason ?? null,
      approvalStatus: input.approvalStatus ?? (input.runMode === 'approved-run' ? 'approved' : 'not_required'),
      auditStatus: input.auditStatus ?? 'recorded',
      runMode: input.runMode ?? 'dry-run',
      metadata: {
        profile: input.profile ?? 'code',
        process_state: 'live',
        transport: 'acp_stdio',
        acp_pool_key: entry.poolKey,
        pid: entry.pid,
        daemon_pid: this.daemonPid,
        reused,
        last_heartbeat_at: Date.now(),
      },
    });
  }

  private attachAcpExitHandler(db: Database.Database, entry: AcpPoolProcessEntry): void {
    const child = entry.child;
    if (!child) return;
    child.once('exit', (code, signal) => {
      // Only flip rows whose status is still 'active' — `expireAcpEntry` and
      // `drainAcpProcesses` both pre-flip rows to 'stale'/'archived' BEFORE
      // calling kill(), so we must not undo their explicit reason text.
      // This handler is the safety net for unexpected process death (crash,
      // OOM, host kill -9). Newly-tracked sessions added between
      // `shuttingDown=true` and the actual exit also get a status flip here.
      const reason = entry.shuttingDown ? 'daemon_drain' : 'process_exited';
      const targetStatus = entry.shuttingDown ? 'archived' : 'stale';
      for (const sid of entry.trackedSessionIds) {
        try {
          const current = db
            .prepare(`SELECT status FROM runtime_sessions WHERE id = ?`)
            .get(sid) as { status: string } | undefined;
          if (!current || current.status !== 'active') continue;
          updateRuntimeSessionStatus(db, sid, targetStatus, {
            process_state: 'dead',
            exit_code: code,
            signal,
            ended_at: Date.now(),
            stale_reason: reason,
          });
        } catch {
          // Lifecycle bookkeeping must not crash the daemon.
        }
      }
      this.acpProcesses.delete(entry.poolKey);
    });
  }

  private ensureHeartbeatTick(db: Database.Database): void {
    if (this.heartbeatTick) return;
    this.heartbeatTick = setInterval(() => {
      void this.runAcpHeartbeatTick(db).catch(() => {
        // Background tick errors must never crash the daemon. The next tick
        // will re-evaluate; if a row is permanently stale it will trip 90s.
      });
    }, ACP_HEARTBEAT_PROBE_MS);
    // Don't keep the event loop alive solely for heartbeat ticks. Production
    // daemon already has the HTTP server keeping the loop active; tests can
    // explicitly call `runAcpHeartbeatTick` themselves with fake timers.
    if (typeof this.heartbeatTick.unref === 'function') this.heartbeatTick.unref();
  }

  private async expireAcpEntry(
    db: Database.Database,
    poolKey: string,
    entry: AcpPoolProcessEntry,
    reason: string,
  ): Promise<void> {
    entry.shuttingDown = true;
    // Mark every tracked row as stale BEFORE killing the child so the
    // exit-handler-driven status flip does not race with this one.
    for (const sid of entry.trackedSessionIds) {
      try {
        updateRuntimeSessionStatus(db, sid, 'stale', {
          process_state: 'stale',
          stale_reason: reason,
          stale_at: Date.now(),
        });
      } catch {
        // Lifecycle bookkeeping must not crash the daemon.
      }
    }
    // Try to send `session/close` for any still-tracked native sessions. If
    // the adapter is fully wedged, this throws; we fall straight through to
    // tree-kill in that case.
    for (const acpSid of entry.trackedAcpSessionIds) {
      try {
        entry.acpClient.notify('session/close', { sessionId: acpSid });
      } catch {
        // ignore
      }
    }
    try {
      await Promise.race([
        entry.acpClient.close(),
        new Promise((resolve) => setTimeout(resolve, ACP_DRAIN_CLOSE_TIMEOUT_MS)),
      ]);
    } catch {
      // ignore
    }
    if (entry.child) {
      try {
        await this.gracefulThenForceKill(entry.child);
      } catch {
        // ignore
      }
    }
    this.acpProcesses.delete(poolKey);
  }

  private gracefulThenForceKill(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      // If the child is already gone, short-circuit.
      if ((child as { exitCode: number | null }).exitCode !== null || (child as { killed?: boolean }).killed) {
        finish();
        return;
      }
      child.once('exit', finish);
      // Always try child.kill() first — that is what works for in-process
      // EventEmitter mocks AND it covers the common case where the child
      // is a single OS process (no nested shell). tree-kill then walks any
      // real OS subtree (no-op when the pid is already gone or fake).
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore — tree-kill below may still have an effect.
      }
      try {
        if (child.pid != null) {
          treeKill(child.pid, 'SIGTERM', () => {
            // tree-kill callback lands when the kill has been DELIVERED;
            // process exit lands separately on the 'exit' event above.
          });
        }
      } catch {
        // ignore — child.kill above is the primary signal.
      }
      setTimeout(() => {
        if (settled) return;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        try {
          if (child.pid != null) {
            treeKill(child.pid, 'SIGKILL', () => finish());
          }
        } catch {
          // ignore
        }
        // Belt-and-braces: always resolve after another tick so we never
        // strand the daemon shutdown waiting for a zombie.
        setTimeout(finish, 200);
      }, ACP_KILL_GRACE_MS);
    });
  }
}

export const runtimeProcessPool = new RuntimeProcessPool();

/**
 * Wave C Agent O — orphan recovery on daemon startup.
 *
 * Scans `runtime_sessions` for `protocol_tier='acp-stdio'` rows whose status
 * is still 'active' even though the daemon (or the child it spawned) is gone.
 * For each such row:
 *   - if `metadata.daemon_pid` is set AND that pid is no longer alive
 *     → mark stale with reason='parent_daemon_died'
 *   - else if `metadata.pid` is set AND that child pid is gone, AND the row
 *     is older than `windowMs` (default 5min)
 *     → mark stale with reason='orphan_recovery' AND tree-kill the pid in
 *       case it really is alive but unparented
 *
 * Conservative — when neither daemon_pid nor pid is recorded, leaves the row
 * alone and logs a warning (operator must inspect manually).
 */
export interface OrphanRecoveryResult {
  scanned: number;
  marked_stale: number;
  killed_pids: number;
  errors: Array<{ sessionId: string; error: string }>;
}

export async function recoverOrphanAcpSessions(
  db: Database.Database,
  opts?: { windowMs?: number },
): Promise<OrphanRecoveryResult> {
  const windowMs = opts?.windowMs ?? 5 * 60_000;
  const cutoff = Date.now() - windowMs;
  const rows = listAcpStdioSessions(db, 'active');
  const result: OrphanRecoveryResult = {
    scanned: rows.length,
    marked_stale: 0,
    killed_pids: 0,
    errors: [],
  };
  for (const row of rows) {
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    } catch {
      // fall through with empty metadata
    }
    const recordedDaemonPid = typeof metadata.daemon_pid === 'number' ? metadata.daemon_pid : null;
    const recordedChildPid = typeof metadata.pid === 'number' ? metadata.pid : null;
    const ownDaemon = recordedDaemonPid === process.pid;
    if (ownDaemon) continue; // current process owns it — don't recover

    let reason: 'parent_daemon_died' | 'orphan_recovery' | null = null;

    if (recordedDaemonPid != null && !isPidAlive(recordedDaemonPid)) {
      reason = 'parent_daemon_died';
    } else if (recordedChildPid != null && row.updated_at < cutoff && !isPidAlive(recordedChildPid)) {
      reason = 'orphan_recovery';
    }

    if (!reason) continue;

    // Defensive: if the recorded child pid IS alive (different daemon, OR
    // genuinely orphaned), tree-kill it so we don't leak processes.
    if (recordedChildPid != null && isPidAlive(recordedChildPid) && !ownDaemon) {
      try {
        await new Promise<void>((resolve) => {
          treeKill(recordedChildPid, 'SIGTERM', () => resolve());
        });
        result.killed_pids += 1;
      } catch (err) {
        result.errors.push({
          sessionId: row.id,
          error: `tree-kill failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    try {
      markOrphanRecovered(db, row.id, reason);
      result.marked_stale += 1;
    } catch (err) {
      result.errors.push({
        sessionId: row.id,
        error: `markOrphanRecovered failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return result;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Public handle returned by tryAcquireRuntimeSession. Carries enough metadata
 * for downstream observability and a future Wave 2.3 thread-through into
 * runCliTask (where --resume injection will live).
 *
 * Wave C Agent O extension: when `transport === 'acp_stdio'`, the handle
 * carries the process-level `acpClient` reference and the OS pid so the
 * caller (run-task / cli executor) can drive `session/new`+`session/prompt`
 * directly. Other transports leave both fields undefined.
 */
export interface RuntimePoolHandle {
  sessionId: string;
  nativeSessionId: string | null;
  reused: boolean;
  workspacePath: string | null;
  profile: RuntimePoolProfile;
  runMode: RuntimePoolRunMode;
  /** Wave C — set ONLY when protocolTier='acp-stdio' was acquired. */
  transport?: 'acp_stdio';
  /** Wave C — opaque adapter client; AcpClientLike kept local to avoid circular deps. */
  acpClient?: AcpClientLike;
  /** Wave C — OS pid of the long-lived ACP child (or synthetic id from a mock). */
  pid?: number | null;
}

/** Result type for `acquireAcpProcess` (internal helper, exposed for tests). */
export interface AcquireAcpResult {
  session: RuntimeSessionRow;
  process: AcpPoolProcessEntry;
  reused: boolean;
}

/** Result of the SIGTERM drain phase A (sessions closed, before kill). */
export interface AcpDrainResult {
  processesTouched: number;
  sessionsClosed: number;
  errors: Array<{ poolKey: string; error: string }>;
}

/**
 * Factory the caller (cli executor or test) provides to actually spawn the
 * ACP child + wrap it in an AcpClientLike. Kept in the caller's hands so the
 * pool stays adapter-agnostic — Agent N's adapter implements one factory,
 * tests provide a mock factory.
 */
export type AcpClientFactory = (input: {
  executorId: string;
  workspacePath: string;
  env?: Record<string, string | undefined>;
}) => Promise<{
  acpClient: AcpClientLike;
  /**
   * Underlying child process. Tests using PassThrough mocks can leave this
   * null — the pool only uses it to attach an exit handler and to tree-kill.
   */
  child: ChildProcess | null;
  pid?: number | null;
}>;

/**
 * Thrown when the caller tries to acquire a session that would violate the
 * autonomous-profile invariant. Surfaced as a typed error so the caller can
 * differentiate "policy refusal" (must NOT silently fall back) from the
 * generic "pool unavailable" (safe to fall back to ephemeral execution).
 */
export class RuntimePoolEscalationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimePoolEscalationError';
  }
}

/**
 * Try to acquire a runtime session for a task. Returns a metadata-only handle.
 *
 * Wave 2.2 scope (F2-4): NEVER spawns a live process — that requires Wave 2.3
 * live probe validation first. This helper exists to:
 *   1. Persist intent (a row in runtime_sessions with runtime_mode='persistent').
 *   2. Allow future reuse via canResumeRuntimeSession.
 *   3. Emit clear observability events upstream.
 *
 * Invariant: NEVER allow autonomous profile unless runMode is 'approved-run'.
 * This mirrors the inner check inside RuntimeProcessPool.startSession but
 * surfaces a typed error so the caller can refuse to fall back silently.
 *
 * Reuse semantics: deferred. For Wave 2.2 we always create a new metadata row.
 * Reuse will be added when live spawn is enabled (post Wave 2.3) so the gate
 * has a deterministic state to scan against.
 *
 * Wave C Agent O: when `protocolTier === 'acp-stdio'` AND `acpClientFactory`
 * is provided, branches into the ACP per-workspace pool — spawns or reuses a
 * long-lived `opencode acp` process, persists a row, and returns a handle
 * with `transport='acp_stdio'` plus the live `acpClient`.
 */
export async function tryAcquireRuntimeSession(
  db: Database.Database,
  input: RuntimeProcessSessionInput,
  opts?: { acpClientFactory?: AcpClientFactory },
): Promise<RuntimePoolHandle | null> {
  // Invariant check: refuse profile escalation up-front so the caller gets a
  // typed error and can choose between "block" and "downgrade profile".
  if (input.profile === 'autonomous' && input.runMode !== 'approved-run') {
    throw new RuntimePoolEscalationError(
      `Cannot acquire autonomous-profile session in ${input.runMode ?? 'dry-run'} mode (requires approved-run).`,
    );
  }

  // Wave C Agent O — branch into the ACP per-workspace pool when the caller
  // asked for `acp-stdio` AND provided a factory. Falling through to the
  // legacy metadata-only path (no factory) keeps callers that haven't been
  // updated yet from accidentally booting a real opencode child.
  if (input.protocolTier === 'acp-stdio' && opts?.acpClientFactory) {
    try {
      const result = await runtimeProcessPool.acquireAcpProcess(db, input, opts.acpClientFactory);
      return {
        sessionId: result.session.id,
        nativeSessionId: result.session.native_session_id ?? null,
        reused: result.reused,
        workspacePath: input.workspacePath ?? null,
        profile: input.profile ?? 'code',
        runMode: input.runMode ?? 'dry-run',
        transport: 'acp_stdio',
        acpClient: result.process.acpClient,
        pid: result.process.pid,
      };
    } catch (err) {
      if (err instanceof RuntimePoolEscalationError) throw err;
      return null;
    }
  }

  // Try to reuse an existing active session (basic reuse logic; future versions
  // can be smarter). For Wave 2.2 we do NOT actively scan — first iteration
  // only creates new metadata rows so the protocol stays observable end-to-end.

  try {
    const session = runtimeProcessPool.startSession(db, { ...input, dryRun: true });
    return {
      sessionId: session.id,
      nativeSessionId: session.native_session_id ?? null,
      reused: false,
      workspacePath: input.workspacePath ?? null,
      profile: input.profile ?? 'code',
      runMode: input.runMode ?? 'dry-run',
    };
  } catch (err) {
    if (err instanceof RuntimePoolEscalationError) throw err;
    return null;
  }
}
