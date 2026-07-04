// Wave-1.5 triage #2 — gate-timeout orphan. When a HITL gate poll times out
// (CLI/Telegram, no response within the window), the gate must NOT be left
// status='pending' forever (a phantom in the dashboard inbox + a re-prompt
// trap on resume). It is resolved to 'timed_out' before the timeout error
// propagates (the task still fails, as before).
import { describe, it, expect } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { insertHitlGate, resolveHitlGate } from '../../src/db/persist.js';
import {
  pollGateOrMarkTimedOut,
  markGateTimedOut,
  HitlGateTimeoutError,
} from '../../src/brain/executor/hitl-gate.js';
import type Database from 'better-sqlite3';

function setup(): Database.Database {
  const db = initDb(':memory:');
  db.prepare(
    'INSERT INTO workflows (id, workspace, status, objective, created_at) VALUES (?,?,?,?,?)',
  ).run('wf1', 'internal', 'executing', 'o', Date.now());
  insertHitlGate(db, {
    id: 'g1',
    workflow_id: 'wf1',
    task_id: null,
    gate_type: 'cli',
    prompt: 'p',
    channel: 'telegram',
  });
  return db;
}

function gateStatus(db: Database.Database): string {
  return (db.prepare("SELECT status FROM hitl_gates WHERE id='g1'").get() as { status: string }).status;
}

function eventCount(db: Database.Database, type: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ?').get(type) as { n: number }).n;
}

describe('pollGateOrMarkTimedOut', () => {
  it('on timeout: throws HitlGateTimeoutError, marks the gate timed_out, emits an event', async () => {
    const db = setup();
    await expect(
      pollGateOrMarkTimedOut(db, 'wf1', null, 'g1', 10, 40),
    ).rejects.toBeInstanceOf(HitlGateTimeoutError);
    expect(gateStatus(db)).toBe('timed_out');
    expect(eventCount(db, 'hitl_gate_timed_out')).toBe(1);
    db.close();
  });

  it('when the gate resolves before the timeout: returns the decision, gate untouched', async () => {
    const db = setup();
    resolveHitlGate(db, 'g1', 'approved');
    const decision = await pollGateOrMarkTimedOut(db, 'wf1', null, 'g1', 10, 1000);
    expect(decision).toBe('approve');
    expect(gateStatus(db)).toBe('approved');
    expect(eventCount(db, 'hitl_gate_timed_out')).toBe(0);
    db.close();
  });
});

describe('markGateTimedOut', () => {
  it('marks a pending gate timed_out and emits the audit event', () => {
    const db = setup();
    markGateTimedOut(db, 'wf1', null, 'g1');
    expect(gateStatus(db)).toBe('timed_out');
    expect(eventCount(db, 'hitl_gate_timed_out')).toBe(1);
    db.close();
  });

  it('does NOT overwrite an already-resolved gate (conditional on status=pending)', () => {
    const db = setup();
    resolveHitlGate(db, 'g1', 'approved');
    markGateTimedOut(db, 'wf1', null, 'g1');
    expect(gateStatus(db)).toBe('approved'); // unchanged
    expect(eventCount(db, 'hitl_gate_timed_out')).toBe(0); // no event when no row changed
    db.close();
  });
});

// runHitlGate's `cli` channel races the terminal prompt against a detached DB
// poll (so a dashboard / MCP approve_gate also unblocks the executor). When the
// terminal prompt wins, the poll keeps running and may later TIME OUT. Two
// invariants protect that path: (1) the detached poll's eventual rejection is
// caught (`void dbPromise.catch(() => {})` in runHitlGate) so it never surfaces
// as an unhandled rejection; (2) the gate was already resolved by the winning
// path, so the detached poll's `markGateTimedOut` no-ops (it is conditional on
// status='pending') — the already-resolved decision is NOT clobbered to
// 'timed_out'. We exercise these directly on the building blocks because the
// real runHitlGate path waits a 10-minute timer, impractical to drive here.
describe('runHitlGate cli-race — detached poll cannot clobber a resolved gate', () => {
  it('a detached poll on a gate the winner already resolved exits cleanly with that decision — never times out, never clobbers it', async () => {
    const db = setup();

    // The terminal prompt "won the race" and resolved the gate to approved
    // (runHitlGate does this synchronously right after Promise.race settles).
    resolveHitlGate(db, 'g1', 'approved');

    // The still-running detached poll observes the resolution on its NEXT tick
    // and RETURNS the decision — it does NOT reach the timeout, so
    // markGateTimedOut never runs. (A generous 200ms timeout would only fire if
    // the poll wrongly ignored the resolved status.) This is why runHitlGate's
    // `void dbPromise.catch(() => {})` never actually fires for a won race; it is
    // belt-and-braces for the case the gate is never resolved (covered below).
    const decision = await pollGateOrMarkTimedOut(db, 'wf1', null, 'g1', 5, 200);

    expect(decision).toBe('approve');
    // The winning decision survives untouched — no flip to 'timed_out', no event.
    expect(gateStatus(db)).toBe('approved');
    expect(eventCount(db, 'hitl_gate_timed_out')).toBe(0);

    db.close();
  });

  it('the detached poll DOES mark a still-pending orphan timed_out (no winner resolved it)', async () => {
    const db = setup();

    // No racing winner — the gate stays pending and the detached poll times
    // out, resolving the orphan to 'timed_out' before the rejection propagates.
    let rejection: unknown;
    await pollGateOrMarkTimedOut(db, 'wf1', null, 'g1', 5, 20).catch((err) => { rejection = err; });

    expect(rejection).toBeInstanceOf(HitlGateTimeoutError);
    expect(gateStatus(db)).toBe('timed_out');
    expect(eventCount(db, 'hitl_gate_timed_out')).toBe(1);

    db.close();
  });
});
