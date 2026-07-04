import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from '../../src/db/client.js';
import type Database from 'better-sqlite3';
import {
  registerAbortController,
  unregisterAbortController,
  hasAbortController,
  _resetControlRegistry,
  steer,
  kill,
  cleanup,
  broadcastCancelToWorkflow,
} from '../../src/v2/subagent/control.js';

// ─── Setup helpers ─────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  return initDb(':memory:');
}

function insertWorkflow(db: Database.Database, wfId: string): void {
  db.prepare(
    `INSERT INTO workflows (id, workspace, objective, status, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(wfId, 'internal', 'test objective', 'executing', Date.now());
}

function insertTask(
  db: Database.Database,
  taskId: string,
  wfId: string,
  status = 'running',
): void {
  db.prepare(
    `INSERT INTO tasks
       (id, workflow_id, name, kind, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(taskId, wfId, 'Test Task', 'llm_call', status, Date.now());
}

function insertSubagentRun(
  db: Database.Database,
  runId: string,
  taskId: string,
  wfId: string,
  status = 'running',
): void {
  db.prepare(
    `INSERT INTO subagent_runs
       (run_id, task_id, workflow_id, depth, task_text, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, taskId, wfId, 0, 'do something', status, Date.now());
}

function getTaskStatus(db: Database.Database, taskId: string): string {
  const row = db
    .prepare('SELECT status FROM tasks WHERE id = ?')
    .get(taskId) as { status: string };
  return row.status;
}

function getTaskSteerInstruction(db: Database.Database, taskId: string): string | null {
  const row = db
    .prepare('SELECT steer_instruction FROM tasks WHERE id = ?')
    .get(taskId) as { steer_instruction: string | null };
  return row.steer_instruction;
}

function getEvents(db: Database.Database, taskId: string, type?: string): unknown[] {
  if (type !== undefined) {
    return db
      .prepare(
        'SELECT * FROM events WHERE task_id = ? AND type = ? ORDER BY id',
      )
      .all(taskId, type);
  }
  return db
    .prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id')
    .all(taskId);
}

function getSubagentRunStatus(db: Database.Database, runId: string): string {
  const row = db
    .prepare('SELECT status FROM subagent_runs WHERE run_id = ?')
    .get(runId) as { status: string };
  return row.status;
}

// ─── Registry tests ────────────────────────────────────────────────────────

describe('AbortController registry', () => {
  beforeEach(() => {
    _resetControlRegistry();
  });

  it('register and has', () => {
    const ac = new AbortController();
    expect(hasAbortController('task_a')).toBe(false);
    registerAbortController('task_a', ac);
    expect(hasAbortController('task_a')).toBe(true);
  });

  it('unregister removes the entry', () => {
    const ac = new AbortController();
    registerAbortController('task_a', ac);
    unregisterAbortController('task_a');
    expect(hasAbortController('task_a')).toBe(false);
  });

  it('_resetControlRegistry clears all entries', () => {
    registerAbortController('task_a', new AbortController());
    registerAbortController('task_b', new AbortController());
    _resetControlRegistry();
    expect(hasAbortController('task_a')).toBe(false);
    expect(hasAbortController('task_b')).toBe(false);
  });

  it('unregister on non-existent key is a no-op', () => {
    expect(() => unregisterAbortController('unknown')).not.toThrow();
    expect(hasAbortController('unknown')).toBe(false);
  });
});

// ─── steer tests ───────────────────────────────────────────────────────────

describe('steer', () => {
  beforeEach(() => {
    _resetControlRegistry();
  });

  it('happy path: updates column, emits event, returns accepted', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1', 'running');

    const result = steer(db, 'tk_1', 'new direction');

    expect(result).toBe('accepted');
    expect(getTaskSteerInstruction(db, 'tk_1')).toBe('new direction');

    const events = getEvents(db, 'tk_1', 'task_steer_received');
    expect(events).toHaveLength(1);
    db.close();
  });

  it('fires abort on in-flight controller', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1', 'running');

    const ac = new AbortController();
    registerAbortController('tk_1', ac);

    const result = steer(db, 'tk_1', 'redirect');

    expect(result).toBe('accepted');
    expect(ac.signal.aborted).toBe(true);
    db.close();
  });

  it('returns accepted even without a registered controller', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1', 'running');

    // No controller registered
    const result = steer(db, 'tk_1', 'some instruction');

    expect(result).toBe('accepted');
    expect(getTaskSteerInstruction(db, 'tk_1')).toBe('some instruction');
    const events = getEvents(db, 'tk_1', 'task_steer_received');
    expect(events).toHaveLength(1);
    db.close();
  });

  it('returns not_found for unknown task', () => {
    const db = makeDb();
    const result = steer(db, 'tk_nonexistent', 'x');
    expect(result).toBe('not_found');
    db.close();
  });

  it('returns already_done for completed task', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1', 'completed');

    const result = steer(db, 'tk_1', 'too late');
    expect(result).toBe('already_done');
    db.close();
  });

  it('returns already_done for failed task', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1', 'failed');

    expect(steer(db, 'tk_1', 'x')).toBe('already_done');
    db.close();
  });

  it('returns already_done for cancelled task', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1', 'cancelled');

    expect(steer(db, 'tk_1', 'x')).toBe('already_done');
    db.close();
  });
});

// ─── kill tests ────────────────────────────────────────────────────────────

describe('kill', () => {
  beforeEach(() => {
    _resetControlRegistry();
  });

  it('happy path: sets failed, emits event, flips subagent_runs', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1', 'running');
    insertSubagentRun(db, 'sa_1', 'tk_1', 'wf_1', 'running');
    insertSubagentRun(db, 'sa_2', 'tk_1', 'wf_1', 'pending');

    const result = kill(db, 'tk_1', 'operator kill');

    expect(result).toBe('killed');
    expect(getTaskStatus(db, 'tk_1')).toBe('failed');
    expect(getSubagentRunStatus(db, 'sa_1')).toBe('killed');
    expect(getSubagentRunStatus(db, 'sa_2')).toBe('killed');

    const events = getEvents(db, 'tk_1', 'task_killed');
    expect(events).toHaveLength(1);
    db.close();
  });

  it('aborts in-flight controller', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1', 'running');

    const ac = new AbortController();
    registerAbortController('tk_1', ac);

    kill(db, 'tk_1', 'stop now');

    expect(ac.signal.aborted).toBe(true);
    db.close();
  });

  it('works without a registered controller', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1', 'running');

    const result = kill(db, 'tk_1', 'no ac');

    expect(result).toBe('killed');
    expect(getTaskStatus(db, 'tk_1')).toBe('failed');
    db.close();
  });

  it('returns not_found for unknown task', () => {
    const db = makeDb();
    expect(kill(db, 'tk_none', 'reason')).toBe('not_found');
    db.close();
  });

  it('returns already_done for completed task', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1', 'completed');

    expect(kill(db, 'tk_1', 'reason')).toBe('already_done');
    db.close();
  });

  it('returns already_done for failed task', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1', 'failed');

    expect(kill(db, 'tk_1', 'reason')).toBe('already_done');
    db.close();
  });

  it('does not flip already-terminal subagent_run to killed', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1', 'running');
    insertSubagentRun(db, 'sa_done', 'tk_1', 'wf_1', 'complete');

    kill(db, 'tk_1', 'reason');
    expect(getSubagentRunStatus(db, 'sa_done')).toBe('complete');
    db.close();
  });

  it('cancels pending messages tied to the killed task (R-HIGH-4)', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_killed', 'wf_1', 'running');
    insertTask(db, 'tk_peer', 'wf_1', 'running');

    // Outbound from tk_killed → tk_peer
    db.prepare(
      `INSERT INTO subagent_messages
        (id, workflow_id, from_task_id, to_task_id, message_type, payload_json, status, created_at)
       VALUES (?, ?, ?, ?, 'announcement', '{"fenced":"x","raw":{}}', 'pending', ?)`,
    ).run('sm_out', 'wf_1', 'tk_killed', 'tk_peer', Date.now());
    // Inbound to tk_killed from tk_peer
    db.prepare(
      `INSERT INTO subagent_messages
        (id, workflow_id, from_task_id, to_task_id, message_type, payload_json, status, created_at)
       VALUES (?, ?, ?, ?, 'query', '{"fenced":"y","raw":{}}', 'pending', ?)`,
    ).run('sm_in', 'wf_1', 'tk_peer', 'tk_killed', Date.now());

    expect(kill(db, 'tk_killed', 'parent ended')).toBe('killed');

    const cancelled = db
      .prepare(`SELECT COUNT(*) AS c FROM subagent_messages WHERE status = 'cancelled'`)
      .get() as { c: number };
    expect(cancelled.c).toBe(2);

    // Sanity: cancellation event was emitted
    const evt = db
      .prepare(`SELECT COUNT(*) AS c FROM events WHERE type = 'subagent_messages_cancelled'`)
      .get() as { c: number };
    expect(evt.c).toBe(1);
    db.close();
  });
});

// ─── cleanup tests ─────────────────────────────────────────────────────────

describe('cleanup', () => {
  beforeEach(() => {
    _resetControlRegistry();
  });

  it('flips eligible pending/running runs to killed with parent_task_cleanup discriminator', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1', 'running');
    insertSubagentRun(db, 'sa_1', 'tk_1', 'wf_1', 'running');
    insertSubagentRun(db, 'sa_2', 'tk_1', 'wf_1', 'pending');

    const { runs_marked } = cleanup(db, 'tk_1');

    expect(runs_marked).toBe(2);
    // R-HIGH-2/3: cleanup must NOT use 'complete' (would lie to metrics).
    // Parent-cleanup → status='killed' + error_msg='parent_task_cleanup'.
    expect(getSubagentRunStatus(db, 'sa_1')).toBe('killed');
    expect(getSubagentRunStatus(db, 'sa_2')).toBe('killed');
    const errMsg = db
      .prepare(`SELECT error_msg FROM subagent_runs WHERE run_id = 'sa_1'`)
      .get() as { error_msg: string };
    expect(errMsg.error_msg).toBe('parent_task_cleanup');
    db.close();
  });

  it('skips runs with an active in-flight controller keyed by run_id', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1', 'running');
    insertSubagentRun(db, 'sa_inflight', 'tk_1', 'wf_1', 'running');
    insertSubagentRun(db, 'sa_idle', 'tk_1', 'wf_1', 'pending');

    // Register a controller under the run_id (simulates active execution)
    registerAbortController('sa_inflight', new AbortController());

    const { runs_marked } = cleanup(db, 'tk_1');

    expect(runs_marked).toBe(1);
    expect(getSubagentRunStatus(db, 'sa_inflight')).toBe('running'); // untouched
    expect(getSubagentRunStatus(db, 'sa_idle')).toBe('killed');
    db.close();
  });

  it('emits task_cleaned_up event when at least one run changed', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1', 'running');
    insertSubagentRun(db, 'sa_1', 'tk_1', 'wf_1', 'running');

    cleanup(db, 'tk_1');

    const events = getEvents(db, 'tk_1', 'task_cleaned_up');
    expect(events).toHaveLength(1);
    db.close();
  });

  it('does NOT emit event when nothing changed', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1', 'running');
    // No subagent_run rows

    const { runs_marked } = cleanup(db, 'tk_1');

    expect(runs_marked).toBe(0);
    const events = getEvents(db, 'tk_1', 'task_cleaned_up');
    expect(events).toHaveLength(0);
    db.close();
  });

  it('returns 0 for unknown task (no subagent_runs exist)', () => {
    const db = makeDb();
    const { runs_marked } = cleanup(db, 'tk_ghost');
    expect(runs_marked).toBe(0);
    db.close();
  });

  it('ignores already-terminal subagent_runs', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1', 'running');
    insertSubagentRun(db, 'sa_done', 'tk_1', 'wf_1', 'complete');
    insertSubagentRun(db, 'sa_err', 'tk_1', 'wf_1', 'error');

    const { runs_marked } = cleanup(db, 'tk_1');

    expect(runs_marked).toBe(0);
    db.close();
  });
});

// ─── broadcastCancelToWorkflow (Sprint 2.1, F-REL-1) ───────────────────────

describe('broadcastCancelToWorkflow', () => {
  beforeEach(() => {
    _resetControlRegistry();
  });

  it('aborts in-flight controllers, marks tasks cancelled, emits one event per task', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_a');
    insertTask(db, 'tk_a1', 'wf_a', 'running');
    insertTask(db, 'tk_a2', 'wf_a', 'pending');
    insertTask(db, 'tk_a3', 'wf_a', 'ready');

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    registerAbortController('tk_a1', ac1);
    registerAbortController('tk_a3', ac2);
    // tk_a2 has no controller (not currently dispatching) — must still flip status

    const result = broadcastCancelToWorkflow(db, 'wf_a', 'user pressed cancel');

    expect(result.tasks_cancelled).toBe(3);
    expect(result.controllers_aborted).toBe(2);
    expect(ac1.signal.aborted).toBe(true);
    expect(ac2.signal.aborted).toBe(true);

    expect(getTaskStatus(db, 'tk_a1')).toBe('cancelled');
    expect(getTaskStatus(db, 'tk_a2')).toBe('cancelled');
    expect(getTaskStatus(db, 'tk_a3')).toBe('cancelled');

    const evt1 = getEvents(db, 'tk_a1', 'task_cancelled_by_workflow') as Array<{ payload_json: string }>;
    expect(evt1).toHaveLength(1);
    const payload1 = JSON.parse(evt1[0].payload_json);
    expect(payload1.had_controller).toBe(true);
    expect(payload1.prior_status).toBe('running');
    expect(payload1.reason).toBe('user pressed cancel');

    const evt2 = getEvents(db, 'tk_a2', 'task_cancelled_by_workflow') as Array<{ payload_json: string }>;
    expect(evt2).toHaveLength(1);
    const payload2 = JSON.parse(evt2[0].payload_json);
    expect(payload2.had_controller).toBe(false);

    db.close();
  });

  it('skips tasks already in terminal state', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_b');
    insertTask(db, 'tk_b1', 'wf_b', 'completed');
    insertTask(db, 'tk_b2', 'wf_b', 'failed');
    insertTask(db, 'tk_b3', 'wf_b', 'cancelled');
    insertTask(db, 'tk_b4', 'wf_b', 'running');

    const result = broadcastCancelToWorkflow(db, 'wf_b', null);

    expect(result.tasks_cancelled).toBe(1);
    expect(getTaskStatus(db, 'tk_b1')).toBe('completed');
    expect(getTaskStatus(db, 'tk_b2')).toBe('failed');
    expect(getTaskStatus(db, 'tk_b3')).toBe('cancelled');
    expect(getTaskStatus(db, 'tk_b4')).toBe('cancelled');
    db.close();
  });

  it('flips active subagent_runs to killed with workflow_cancelled reason', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_c');
    insertTask(db, 'tk_c1', 'wf_c', 'running');
    insertSubagentRun(db, 'sa_running', 'tk_c1', 'wf_c', 'running');
    insertSubagentRun(db, 'sa_pending', 'tk_c1', 'wf_c', 'pending');
    insertSubagentRun(db, 'sa_done', 'tk_c1', 'wf_c', 'complete');

    broadcastCancelToWorkflow(db, 'wf_c', 'reason here');

    const rows = db
      .prepare('SELECT run_id, status, error_msg FROM subagent_runs WHERE task_id = ? ORDER BY run_id')
      .all('tk_c1') as Array<{ run_id: string; status: string; error_msg: string | null }>;
    expect(rows).toHaveLength(3);
    const done = rows.find((r) => r.run_id === 'sa_done');
    const running = rows.find((r) => r.run_id === 'sa_running');
    const pending = rows.find((r) => r.run_id === 'sa_pending');
    expect(done?.status).toBe('complete'); // already terminal — untouched
    expect(running?.status).toBe('killed');
    expect(running?.error_msg).toBe('reason here');
    expect(pending?.status).toBe('killed');
    db.close();
  });

  it('returns zero counts for workflow with no in-flight tasks', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf_d');
    insertTask(db, 'tk_d1', 'wf_d', 'completed');

    const result = broadcastCancelToWorkflow(db, 'wf_d', null);

    expect(result.tasks_cancelled).toBe(0);
    expect(result.controllers_aborted).toBe(0);
    expect(result.messages_cancelled).toBe(0);
    db.close();
  });

  it('returns zero counts for unknown workflow id', () => {
    const db = makeDb();
    const result = broadcastCancelToWorkflow(db, 'wf_ghost', null);
    expect(result.tasks_cancelled).toBe(0);
    db.close();
  });
});
