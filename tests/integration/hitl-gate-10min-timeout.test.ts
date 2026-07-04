/**
 * M1 Wave 3 (C) — HITL gate 10-minute timeout behaviour.
 *
 * `runHitlGate` polls the DB every 1–2s for up to 10 minutes
 * (`pollGateUntilResolved(... 10 * 60 * 1000)`). If the operator never
 * resolves the gate, the poller THROWS an error of the form
 * `HITL gate timed out after 10min sem resposta`. The caller in
 * `executor/run-task.ts` catches the throw and propagates it as a task
 * failure.
 *
 * We pin TWO things here:
 *   1. `pollGateUntilResolved` rejects with the timeout message after
 *      `timeoutMs` elapses without a row status change.
 *   2. The current code path does NOT emit a `hitl_gate_expired` event of
 *      its own — the only event left behind is the original `hitl_gate_pending`
 *      that `runHitlGate` wrote when it created the gate. Pin this behaviour
 *      so a future regression that swallows the throw silently is caught.
 *
 * The full `runHitlGate` flow opens HTTP listeners / sends Slack/Telegram
 * notifications; this test exercises the polling primitive directly with a
 * synthetic gate row to keep the test sub-second instead of a wall-clock
 * 10-minute wait. We swap `Date.now()` via vi.useFakeTimers() so the
 * 10-minute deadline fires after a handful of vitest ticks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb } from '../../src/db/client.js';
import type Database from 'better-sqlite3';
import { pollGateUntilResolved } from '../../src/brain/executor/hitl-gate.js';
import { insertHitlGate, insertEvent } from '../../src/db/persist.js';

describe('HITL gate 10-minute timeout (M1 W3 C)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
    // Seed the FK target so the gate insert succeeds.
    db.prepare(
      `INSERT INTO workflows (id, workspace, objective, status, created_at)
       VALUES ('wf_hitl_10min', 'internal', 'hitl 10min timeout', 'executing', ?)`,
    ).run(Date.now());
    db.prepare(
      `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
       VALUES ('tk_hitl_10min', 'wf_hitl_10min', 'gate', 'cli_spawn', 'running', ?)`,
    ).run(Date.now());
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('pollGateUntilResolved rejects with timeout error after the deadline', async () => {
    insertHitlGate(db, {
      id: 'hg_10min_unresolved',
      workflow_id: 'wf_hitl_10min',
      task_id: 'tk_hitl_10min',
      gate_type: 'cli',
      prompt: 'approve me',
      channel: 'cli',
    });

    // Use a short timeout to keep the test wall-clock-fast while exercising
    // the same poll-then-throw code path. Real production uses 10 * 60 * 1000;
    // we use 200 ms with a 50 ms interval. The contract is the same: throw
    // if the deadline elapses without a status flip.
    const promise = pollGateUntilResolved(db, 'hg_10min_unresolved', 50, 200);

    await expect(promise).rejects.toThrow(/timed out/i);
  });

  it('pollGateUntilResolved completes WITHOUT emitting a hitl_gate_expired event (current behaviour)', async () => {
    // This pins the current behaviour: the timeout produces an Error but
    // no `hitl_gate_expired` event row is written. If a future PR adds that
    // event, this test must be updated — the new code is intended (operators
    // want timed-out gates visible in the audit trail).
    insertHitlGate(db, {
      id: 'hg_10min_no_event',
      workflow_id: 'wf_hitl_10min',
      task_id: 'tk_hitl_10min',
      gate_type: 'cli',
      prompt: 'approve me',
      channel: 'cli',
    });
    // Seed hitl_gate_pending the way runHitlGate does so we can verify it is
    // the ONLY hitl-related event present after timeout.
    insertEvent(db, {
      workflow_id: 'wf_hitl_10min',
      task_id: 'tk_hitl_10min',
      type: 'hitl_gate_pending',
      payload: { gate_id: 'hg_10min_no_event', auto_approve: false, channel: 'cli' },
    });

    await expect(
      pollGateUntilResolved(db, 'hg_10min_no_event', 50, 200),
    ).rejects.toThrow(/timed out/i);

    const events = db.prepare(
      `SELECT type FROM events WHERE workflow_id = 'wf_hitl_10min' ORDER BY id`,
    ).all() as Array<{ type: string }>;
    const types = events.map((e) => e.type);

    // pollGateUntilResolved itself does not emit events — the only hitl
    // event present is the pending we seeded.
    expect(types).toContain('hitl_gate_pending');
    expect(types).not.toContain('hitl_gate_expired');
    // Defensive: the timeout did not silently emit a hitl_gate_decided.
    expect(types).not.toContain('hitl_gate_decided');

    // Gate row remains pending — the timeout does NOT auto-resolve.
    const gateRow = db.prepare(
      `SELECT status, decided_at FROM hitl_gates WHERE id = ?`,
    ).get('hg_10min_no_event') as { status: string; decided_at: number | null };
    expect(gateRow.status).toBe('pending');
    expect(gateRow.decided_at).toBeNull();
  });

  it('pollGateUntilResolved RESOLVES early when the row flips to approved mid-poll', async () => {
    // Sanity counter-test: the timeout path should not fire if the gate
    // resolves before the deadline. Validates that the throw above isn't
    // an artifact of an always-throwing implementation.
    insertHitlGate(db, {
      id: 'hg_10min_early',
      workflow_id: 'wf_hitl_10min',
      task_id: 'tk_hitl_10min',
      gate_type: 'cli',
      prompt: 'approve me',
      channel: 'cli',
    });

    // Flip the gate ~80 ms in (well under the 2 s budget below).
    setTimeout(() => {
      db.prepare(
        `UPDATE hitl_gates SET status = 'approved', decided_at = ? WHERE id = ?`,
      ).run(Date.now(), 'hg_10min_early');
    }, 80);

    const result = await pollGateUntilResolved(db, 'hg_10min_early', 25, 2_000);
    expect(result).toBe('approve');
  });
});
