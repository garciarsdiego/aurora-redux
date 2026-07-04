// Wave C Agent O — RuntimeProcessPool ACP-stdio integration tests.
//
// Covers:
//   1. Per-workspace mutex prevents double-spawn (5 concurrent acquires → 1 spawn)
//   2. Reuse: a second acquire on the same workspace re-uses the same process
//   3. Foreign workspace acquire spawns a separate process
//   4. Heartbeat tick marks stale at >90s + kills child
//   5. SIGTERM drain: drainAcpProcesses sends session/close BEFORE kill
//   6. Orphan recovery on daemon restart finds dead-pid rows + marks stale
//
// Mocks: a fake AcpClientLike + a fake ChildProcess (EventEmitter). NO real
// opencode subprocess. The mock client tracks every notify() and request()
// so tests assert on the wire-shape contract.
//
// IMPORTANT: tests reset the singleton's ACP state between cases via the
// `_resetAcpState()` test helper to avoid cross-test bleed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { initDb } from '../../src/db/client.js';
import {
  recoverOrphanAcpSessions,
  runtimeProcessPool,
  RuntimePoolEscalationError,
  tryAcquireRuntimeSession,
  type AcpClientFactory,
  type AcpClientLike,
} from '../../src/runtime/process-pool.js';
import {
  createRuntimeSession,
  listAcpStdioSessions,
} from '../../src/runtime/store.js';

// ─── Fake child process + adapter client ────────────────────────────────────

interface FakeChildOpts {
  pid?: number;
  /** When set, exit() will close the streams + emit 'exit' with this code. */
  alreadyDead?: boolean;
}

interface FakeChildHandle extends EventEmitter {
  pid: number | null;
  exitCode: number | null;
  killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
}

let nextFakePid = 50_000;

function makeFakeChild(opts: FakeChildOpts = {}): FakeChildHandle {
  const ee = new EventEmitter() as FakeChildHandle;
  ee.pid = opts.pid ?? nextFakePid++;
  ee.exitCode = opts.alreadyDead ? 0 : null;
  ee.killed = !!opts.alreadyDead;
  ee.kill = function (_signal?: NodeJS.Signals | number) {
    if (this.exitCode !== null) return false;
    this.exitCode = 0;
    this.killed = true;
    setImmediate(() => this.emit('exit', 0, _signal ?? null));
    return true;
  };
  return ee;
}

interface RecordedCall {
  kind: 'request' | 'notify';
  method: string;
  params?: unknown;
}

interface FakeAcpClientControl extends AcpClientLike {
  calls: RecordedCall[];
  closeCalls: number;
  /** When set, every request() returns this fixed result. */
  requestResult: unknown;
  /** When true, request() rejects with the given message. */
  requestRejectWith: string | null;
}

function makeFakeAcpClient(): FakeAcpClientControl {
  const calls: RecordedCall[] = [];
  const client: FakeAcpClientControl = {
    calls,
    closeCalls: 0,
    requestResult: { protocolVersion: 1 },
    requestRejectWith: null,
    async request<R = unknown>(method: string, params?: unknown): Promise<R> {
      calls.push({ kind: 'request', method, params });
      if (this.requestRejectWith) throw new Error(this.requestRejectWith);
      return this.requestResult as R;
    },
    notify(method: string, params?: unknown): void {
      calls.push({ kind: 'notify', method, params });
    },
    async close(): Promise<void> {
      this.closeCalls += 1;
    },
  };
  return client;
}

interface FactoryRecord {
  invocations: number;
  spawnedChildren: FakeChildHandle[];
  spawnedClients: FakeAcpClientControl[];
}

function makeFactory(spawnDelayMs = 5): { factory: AcpClientFactory; record: FactoryRecord } {
  const record: FactoryRecord = {
    invocations: 0,
    spawnedChildren: [],
    spawnedClients: [],
  };
  const factory: AcpClientFactory = async (input) => {
    record.invocations += 1;
    if (spawnDelayMs > 0) await new Promise((r) => setTimeout(r, spawnDelayMs));
    const child = makeFakeChild();
    const acpClient = makeFakeAcpClient();
    record.spawnedChildren.push(child);
    record.spawnedClients.push(acpClient);
    void input;
    // Cast the EventEmitter-based fake to ChildProcess — pool only uses .pid,
    // .exitCode, .killed, .kill(), and once('exit', ...) which our fake exposes.
    return {
      acpClient,
      child: child as unknown as import('node:child_process').ChildProcess,
      pid: child.pid,
    };
  };
  return { factory, record };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function insertWorkflow(db: ReturnType<typeof initDb>, workflowId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO workflows
       (id, workspace, objective, status, started_at, completed_at, created_at, created_by)
     VALUES (?, 'internal', 'acp pool test', 'executing', ?, NULL, ?, 'test')`,
  ).run(workflowId, now, now);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('RuntimeProcessPool — ACP-stdio extension (Wave C Agent O)', () => {
  beforeEach(() => {
    runtimeProcessPool._resetAcpState();
  });

  afterEach(() => {
    runtimeProcessPool._resetAcpState();
    vi.useRealTimers();
  });

  it('per-workspace mutex prevents double-spawn (5 concurrent acquires → 1 spawn)', async () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_mutex');
    const { factory, record } = makeFactory(20);

    const workspacePath = '/tmp/acp-mutex-ws';
    const handles = await Promise.all(
      Array.from({ length: 5 }).map(() =>
        tryAcquireRuntimeSession(
          db,
          {
            workflowId: 'wf_mutex',
            executorId: 'cli:opencode',
            protocolTier: 'acp-stdio',
            streamFormat: 'acp-jsonrpc',
            workspacePath,
            profile: 'code',
            runMode: 'dry-run',
          },
          { acpClientFactory: factory },
        ),
      ),
    );

    expect(record.invocations).toBe(1);
    expect(handles).toHaveLength(5);
    for (const h of handles) {
      expect(h).not.toBeNull();
      expect(h!.transport).toBe('acp_stdio');
      expect(h!.acpClient).toBe(record.spawnedClients[0]);
      expect(h!.pid).toBe(record.spawnedChildren[0].pid);
    }
    // The first acquire is `reused=false`; the others are `reused=true`.
    const reusedFlags = handles.map((h) => h!.reused);
    expect(reusedFlags.filter((r) => r === false).length).toBe(1);
    expect(reusedFlags.filter((r) => r === true).length).toBe(4);

    // 5 distinct runtime_sessions rows persisted, all pointing at the same pool.
    const rows = listAcpStdioSessions(db, 'active');
    expect(rows.length).toBe(5);
    const poolKeys = new Set(
      rows.map((r) => (JSON.parse(r.metadata_json) as { acp_pool_key?: string }).acp_pool_key),
    );
    expect(poolKeys.size).toBe(1);

    db.close();
  });

  it('foreign workspace acquire spawns a separate process', async () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_foreign');
    const { factory, record } = makeFactory(2);

    const handleA = await tryAcquireRuntimeSession(
      db,
      {
        workflowId: 'wf_foreign',
        executorId: 'cli:opencode',
        protocolTier: 'acp-stdio',
        streamFormat: 'acp-jsonrpc',
        workspacePath: '/tmp/acp-ws-a',
        profile: 'code',
        runMode: 'dry-run',
      },
      { acpClientFactory: factory },
    );
    const handleB = await tryAcquireRuntimeSession(
      db,
      {
        workflowId: 'wf_foreign',
        executorId: 'cli:opencode',
        protocolTier: 'acp-stdio',
        streamFormat: 'acp-jsonrpc',
        workspacePath: '/tmp/acp-ws-b',
        profile: 'code',
        runMode: 'dry-run',
      },
      { acpClientFactory: factory },
    );

    expect(record.invocations).toBe(2);
    expect(handleA!.acpClient).not.toBe(handleB!.acpClient);
    expect(handleA!.pid).not.toBe(handleB!.pid);

    const peek = runtimeProcessPool._peekAcpProcesses();
    expect(peek.length).toBe(2);

    db.close();
  });

  it('reuse skips the factory when a fresh entry already exists', async () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_reuse');
    const { factory, record } = makeFactory(0);

    const first = await tryAcquireRuntimeSession(
      db,
      {
        workflowId: 'wf_reuse',
        executorId: 'cli:opencode',
        protocolTier: 'acp-stdio',
        streamFormat: 'acp-jsonrpc',
        workspacePath: '/tmp/acp-reuse',
        profile: 'code',
        runMode: 'dry-run',
      },
      { acpClientFactory: factory },
    );
    expect(first!.reused).toBe(false);

    const second = await tryAcquireRuntimeSession(
      db,
      {
        workflowId: 'wf_reuse',
        executorId: 'cli:opencode',
        protocolTier: 'acp-stdio',
        streamFormat: 'acp-jsonrpc',
        workspacePath: '/tmp/acp-reuse',
        profile: 'code',
        runMode: 'dry-run',
      },
      { acpClientFactory: factory },
    );
    expect(second!.reused).toBe(true);
    expect(record.invocations).toBe(1);
    expect(second!.acpClient).toBe(first!.acpClient);

    db.close();
  });

  it('Windows-style and POSIX-style same path collide on the same pool key', async () => {
    if (process.platform !== 'win32') return;
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_path_norm');
    const { factory, record } = makeFactory(0);

    await tryAcquireRuntimeSession(
      db,
      {
        workflowId: 'wf_path_norm',
        executorId: 'cli:opencode',
        protocolTier: 'acp-stdio',
        streamFormat: 'acp-jsonrpc',
        workspacePath: 'C:\\repo\\app',
        profile: 'code',
        runMode: 'dry-run',
      },
      { acpClientFactory: factory },
    );
    const second = await tryAcquireRuntimeSession(
      db,
      {
        workflowId: 'wf_path_norm',
        executorId: 'cli:opencode',
        protocolTier: 'acp-stdio',
        streamFormat: 'acp-jsonrpc',
        workspacePath: 'c:/repo/app/',
        profile: 'code',
        runMode: 'dry-run',
      },
      { acpClientFactory: factory },
    );
    expect(second!.reused).toBe(true);
    expect(record.invocations).toBe(1);

    db.close();
  });

  it('heartbeat tick at >=90s marks stale + kills child', async () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_heartbeat');
    const { factory, record } = makeFactory(0);

    const handle = await tryAcquireRuntimeSession(
      db,
      {
        workflowId: 'wf_heartbeat',
        executorId: 'cli:opencode',
        protocolTier: 'acp-stdio',
        streamFormat: 'acp-jsonrpc',
        workspacePath: '/tmp/acp-hb',
        profile: 'code',
        runMode: 'dry-run',
      },
      { acpClientFactory: factory },
    );

    const child = record.spawnedChildren[0];

    // Manually backdate the entry's heartbeat so the next tick treats it as stale.
    const peekedBefore = runtimeProcessPool._peekAcpProcesses();
    expect(peekedBefore.length).toBe(1);

    // Reach in via the singleton. Use the captured factory's child to identify
    // the entry; the cleanest way is to drive the tick directly.
    // Simulate a stale heartbeat by waiting then forcing the timer to think
    // 91s have passed: we hack lastHeartbeatAt via a fresh acquire+expire.
    // Easiest: directly invoke the public test sweep with backdated state.
    // Force lastHeartbeatAt to be old by patching Date.now during the tick.
    const realNow = Date.now;
    try {
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 95_000);
      await runtimeProcessPool.runAcpHeartbeatTick(db);
    } finally {
      vi.restoreAllMocks();
    }

    // Child should have been kill()ed.
    // Wait one tick for the 'exit' event to land + status flip.
    await new Promise((r) => setImmediate(r));
    expect(child.killed).toBe(true);

    const row = db
      .prepare('SELECT status, metadata_json FROM runtime_sessions WHERE id = ?')
      .get(handle!.sessionId) as { status: string; metadata_json: string };
    expect(row.status).toBe('stale');
    const meta = JSON.parse(row.metadata_json) as { stale_reason?: string };
    expect(meta.stale_reason).toBe('heartbeat_force_stale_90s');

    // Pool entry must be dropped.
    expect(runtimeProcessPool._peekAcpProcesses().length).toBe(0);

    db.close();
  });

  it('heartbeat probe in 60-90s window refreshes a healthy entry', async () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_hb_probe');
    const { factory, record } = makeFactory(0);

    await tryAcquireRuntimeSession(
      db,
      {
        workflowId: 'wf_hb_probe',
        executorId: 'cli:opencode',
        protocolTier: 'acp-stdio',
        streamFormat: 'acp-jsonrpc',
        workspacePath: '/tmp/acp-hb-probe',
        profile: 'code',
        runMode: 'dry-run',
      },
      { acpClientFactory: factory },
    );

    const realNow = Date.now;
    try {
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 70_000);
      await runtimeProcessPool.runAcpHeartbeatTick(db);
    } finally {
      vi.restoreAllMocks();
    }

    const probeCall = record.spawnedClients[0].calls.find(
      (c) => c.kind === 'request' && c.method === 'initialize',
    );
    expect(probeCall).toBeDefined();
    // Entry still alive.
    expect(runtimeProcessPool._peekAcpProcesses().length).toBe(1);

    db.close();
  });

  it('drainAcpProcesses sends session/close BEFORE killing child', async () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_drain');
    const { factory, record } = makeFactory(0);

    const handle = await tryAcquireRuntimeSession(
      db,
      {
        workflowId: 'wf_drain',
        executorId: 'cli:opencode',
        protocolTier: 'acp-stdio',
        streamFormat: 'acp-jsonrpc',
        workspacePath: '/tmp/acp-drain',
        profile: 'code',
        runMode: 'dry-run',
      },
      { acpClientFactory: factory },
    );

    // Simulate the adapter having opened a native ACP session against the process.
    runtimeProcessPool.recordAcpInbound(db, handle!.sessionId, {
      nativeAcpSessionId: 'mock-ses-1',
    });

    const child = record.spawnedChildren[0];
    expect(child.killed).toBe(false);

    const result = await runtimeProcessPool.drainAcpProcesses(db);
    expect(result.processesTouched).toBe(1);
    expect(result.sessionsClosed).toBe(1);

    const closeCall = record.spawnedClients[0].calls.find(
      (c) => c.kind === 'notify' && c.method === 'session/close',
    );
    expect(closeCall).toBeDefined();
    expect((closeCall!.params as { sessionId: string }).sessionId).toBe('mock-ses-1');

    // Child still alive — kill happens in phase B.
    expect(child.killed).toBe(false);

    // Row was archived by drain.
    const row = db
      .prepare('SELECT status FROM runtime_sessions WHERE id = ?')
      .get(handle!.sessionId) as { status: string };
    expect(row.status).toBe('archived');

    // Phase B kills the surviving process.
    const killResult = await runtimeProcessPool.forceKillSurvivingAcpProcesses();
    expect(killResult.killed).toBe(1);
    await new Promise((r) => setImmediate(r));
    expect(child.killed).toBe(true);

    db.close();
  });

  it('cancelAcpSession sends session/cancel WITHOUT killing the process', async () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_cancel');
    const { factory, record } = makeFactory(0);

    const handle = await tryAcquireRuntimeSession(
      db,
      {
        workflowId: 'wf_cancel',
        executorId: 'cli:opencode',
        protocolTier: 'acp-stdio',
        streamFormat: 'acp-jsonrpc',
        workspacePath: '/tmp/acp-cancel',
        profile: 'code',
        runMode: 'dry-run',
      },
      { acpClientFactory: factory },
    );

    runtimeProcessPool.recordAcpInbound(db, handle!.sessionId, {
      nativeAcpSessionId: 'mock-ses-cancel',
    });

    await runtimeProcessPool.cancelAcpSession(db, handle!.sessionId, {
      nativeAcpSessionId: 'mock-ses-cancel',
      reason: 'task-aborted',
    });

    const cancelCall = record.spawnedClients[0].calls.find(
      (c) => c.kind === 'notify' && c.method === 'session/cancel',
    );
    expect(cancelCall).toBeDefined();
    expect((cancelCall!.params as { sessionId: string }).sessionId).toBe('mock-ses-cancel');

    // Child must NOT be killed — other sessions on this process stay alive.
    expect(record.spawnedChildren[0].killed).toBe(false);

    const row = db
      .prepare('SELECT metadata_json FROM runtime_sessions WHERE id = ?')
      .get(handle!.sessionId) as { metadata_json: string };
    const meta = JSON.parse(row.metadata_json) as {
      last_cancel_reason?: string;
      cancelled_acp_session_id?: string;
    };
    expect(meta.last_cancel_reason).toBe('task-aborted');
    expect(meta.cancelled_acp_session_id).toBe('mock-ses-cancel');

    db.close();
  });

  it('autonomous-profile + dry-run is rejected before any spawn', async () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_escal');
    const { factory, record } = makeFactory(0);

    await expect(
      tryAcquireRuntimeSession(
        db,
        {
          workflowId: 'wf_escal',
          executorId: 'cli:opencode',
          protocolTier: 'acp-stdio',
          streamFormat: 'acp-jsonrpc',
          workspacePath: '/tmp/acp-escal',
          profile: 'autonomous',
          runMode: 'dry-run',
        },
        { acpClientFactory: factory },
      ),
    ).rejects.toBeInstanceOf(RuntimePoolEscalationError);

    expect(record.invocations).toBe(0);

    db.close();
  });

  it('orphan recovery: dead-pid rows from previous daemon are marked stale', async () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_orphan');

    // Insert two pre-existing acp-stdio rows directly — simulating a previous
    // daemon that died without draining. Use a daemon_pid that is guaranteed
    // dead (Number.MAX_SAFE_INTEGER). Pick a child pid that's also dead.
    const orphanRow = createRuntimeSession(db, {
      workflowId: 'wf_orphan',
      executorId: 'cli:opencode',
      protocolTier: 'acp-stdio',
      streamFormat: 'acp-jsonrpc',
      workspacePath: '/tmp/acp-orphan',
      runtimeMode: 'persistent',
      status: 'active',
      runMode: 'dry-run',
      metadata: {
        profile: 'code',
        process_state: 'live',
        daemon_pid: 1, // pid 1 is real on linux but treat as test-stub; use an impossible one
        pid: 1,
      },
    });
    // Backdate the row past the 5-min orphan window.
    db.prepare(
      `UPDATE runtime_sessions SET updated_at = ? WHERE id = ?`,
    ).run(Date.now() - 10 * 60_000, orphanRow.id);

    // Override the daemon_pid to a guaranteed-dead value.
    db.prepare(
      `UPDATE runtime_sessions
          SET metadata_json = json_set(metadata_json, '$.daemon_pid', ?, '$.pid', ?)
        WHERE id = ?`,
    ).run(99999998, 99999999, orphanRow.id);

    const result = await recoverOrphanAcpSessions(db, { windowMs: 0 });
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.marked_stale).toBeGreaterThanOrEqual(1);

    const refreshed = db
      .prepare('SELECT status, metadata_json FROM runtime_sessions WHERE id = ?')
      .get(orphanRow.id) as { status: string; metadata_json: string };
    expect(refreshed.status).toBe('stale');
    const meta = JSON.parse(refreshed.metadata_json) as { stale_reason?: string };
    expect(meta.stale_reason).toBe('parent_daemon_died');

    db.close();
  });

  it('orphan recovery skips rows owned by the current daemon', async () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_orphan_self');

    const ownRow = createRuntimeSession(db, {
      workflowId: 'wf_orphan_self',
      executorId: 'cli:opencode',
      protocolTier: 'acp-stdio',
      streamFormat: 'acp-jsonrpc',
      workspacePath: '/tmp/acp-self',
      runtimeMode: 'persistent',
      status: 'active',
      runMode: 'dry-run',
      metadata: {
        profile: 'code',
        process_state: 'live',
        daemon_pid: process.pid,
        pid: process.pid,
      },
    });

    const result = await recoverOrphanAcpSessions(db, { windowMs: 0 });
    expect(result.scanned).toBeGreaterThanOrEqual(1);

    const refreshed = db
      .prepare('SELECT status FROM runtime_sessions WHERE id = ?')
      .get(ownRow.id) as { status: string };
    expect(refreshed.status).toBe('active');

    db.close();
  });

  it('legacy non-acp acquire path still returns metadata-only handle', async () => {
    // Regression: confirm we did not break the original flow when no factory
    // is provided OR the protocolTier is something other than acp-stdio.
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_legacy');

    const handle = await tryAcquireRuntimeSession(db, {
      workflowId: 'wf_legacy',
      executorId: 'cli:claude-code',
      protocolTier: 'jsonl-headless',
      streamFormat: 'claude-stream-json',
      workspacePath: '/tmp/legacy',
      profile: 'code',
      runMode: 'dry-run',
    });

    expect(handle).not.toBeNull();
    expect(handle!.transport).toBeUndefined();
    expect(handle!.acpClient).toBeUndefined();
    db.close();
  });

  it('acp-stdio without a factory falls through to legacy metadata-only path', async () => {
    // The pool MUST NOT spawn anything if the caller hasn't passed a factory —
    // this is the safety knob that lets old call sites keep working.
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_acp_no_factory');

    const handle = await tryAcquireRuntimeSession(db, {
      workflowId: 'wf_acp_no_factory',
      executorId: 'cli:opencode',
      protocolTier: 'acp-stdio',
      streamFormat: 'acp-jsonrpc',
      workspacePath: '/tmp/acp-no-factory',
      profile: 'code',
      runMode: 'dry-run',
    });

    expect(handle).not.toBeNull();
    expect(handle!.transport).toBeUndefined();
    expect(handle!.acpClient).toBeUndefined();

    // No acp-stdio process registered.
    expect(runtimeProcessPool._peekAcpProcesses().length).toBe(0);

    db.close();
  });
});
