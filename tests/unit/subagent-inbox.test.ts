import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import { insertWorkflow, insertTask, newWorkflowId, newTaskId } from '../../src/db/persist.js';
import type { Workflow, Task } from '../../src/types/index.js';
import { enqueue } from '../../src/v2/subagent/outbox.js';
import { dequeueFor, pendingFor, peekFor } from '../../src/v2/subagent/inbox.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeWorkflow(id: string): Workflow {
  const now = Date.now();
  return {
    id,
    workspace: 'internal',
    objective: 'test',
    pattern_id: null,
    status: 'executing',
    started_at: now,
    completed_at: null,
    created_at: now,
    created_by: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    metadata: null,
  };
}

function makeTask(id: string, wfId: string): Task {
  return {
    id,
    workflow_id: wfId,
    name: `task-${id}`,
    kind: 'llm_call',
    input_json: null,
    output_json: null,
    status: 'running',
    depends_on: [],
    executor_hint: null,
    timeout_seconds: 300,
    max_retries: 0,
    retry_count: 0,
    retry_policy: 'none',
    started_at: Date.now(),
    completed_at: null,
    created_at: Date.now(),
    acceptance_criteria: null,
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
    model: null,
    hitl: false,
  };
}

interface ThreeTasks {
  db: Database.Database;
  wfId: string;
  taskA: string;
  taskB: string;
  taskC: string;
}

function setupThree(): ThreeTasks {
  const db = initDb(':memory:');
  const wfId = newWorkflowId();
  const taskA = newTaskId();
  const taskB = newTaskId();
  const taskC = newTaskId();

  insertWorkflow(db, makeWorkflow(wfId));
  insertTask(db, makeTask(taskA, wfId));
  insertTask(db, makeTask(taskB, wfId));
  insertTask(db, makeTask(taskC, wfId));

  return { db, wfId, taskA, taskB, taskC };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('inbox.dequeueFor — directed messages', () => {
  it('returns directed message addressed to taskId', () => {
    const { db, wfId, taskA, taskB } = setupThree();

    const result = enqueue(db, {
      workflowId: wfId,
      fromTaskId: taskA,
      toTaskId: taskB,
      type: 'steer',
      payload: { instruction: 'focus here' },
    });
    expect(result.ok).toBe(true);

    const msgs = dequeueFor(db, taskB, wfId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].row.from_task_id).toBe(taskA);
    expect(msgs[0].row.to_task_id).toBe(taskB);
    expect(typeof msgs[0].fenced).toBe('string');
    expect(msgs[0].fenced.length).toBeGreaterThan(0);
    expect(msgs[0].raw).toMatchObject({ instruction: 'focus here' });
  });

  it('does not return messages directed to a different task', () => {
    const { db, wfId, taskA, taskB, taskC } = setupThree();

    enqueue(db, {
      workflowId: wfId,
      fromTaskId: taskA,
      toTaskId: taskB,
      type: 'steer',
      payload: { instruction: 'only for B' },
    });

    const msgs = dequeueFor(db, taskC, wfId);
    expect(msgs).toHaveLength(0);
  });
});

describe('inbox.dequeueFor — broadcast messages', () => {
  it('returns broadcast messages from peers (not from self)', () => {
    const { db, wfId, taskA, taskB } = setupThree();

    enqueue(db, {
      workflowId: wfId,
      fromTaskId: taskA,
      type: 'announcement',
      payload: { topic: 'news', summary: 'phase done' },
    });

    const msgs = dequeueFor(db, taskB, wfId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].row.to_task_id).toBeNull();
    expect(msgs[0].fenced).toContain('phase done');
  });

  it('does NOT return broadcast to sender (self-message exclusion)', () => {
    const { db, wfId, taskA } = setupThree();

    enqueue(db, {
      workflowId: wfId,
      fromTaskId: taskA,
      type: 'announcement',
      payload: { topic: 'news', summary: 'hello' },
    });

    const msgs = dequeueFor(db, taskA, wfId);
    expect(msgs).toHaveLength(0);
  });

  it('does NOT return the same broadcast twice to the same task', () => {
    const { db, wfId, taskA, taskB } = setupThree();

    enqueue(db, {
      workflowId: wfId,
      fromTaskId: taskA,
      type: 'announcement',
      payload: { topic: 'once', summary: 'dedup test' },
    });

    const first = dequeueFor(db, taskB, wfId);
    expect(first).toHaveLength(1);

    const second = dequeueFor(db, taskB, wfId);
    expect(second).toHaveLength(0);
  });

  it('two tasks both dequeue the same broadcast — each gets it exactly once', () => {
    const { db, wfId, taskA, taskB, taskC } = setupThree();

    // taskA sends broadcast
    enqueue(db, {
      workflowId: wfId,
      fromTaskId: taskA,
      type: 'announcement',
      payload: { topic: 'shared', summary: 'available to all' },
    });

    // B and C each get it once
    const msgsB = dequeueFor(db, taskB, wfId);
    const msgsC = dequeueFor(db, taskC, wfId);

    expect(msgsB).toHaveLength(1);
    expect(msgsC).toHaveLength(1);

    // Root row still pending (broadcast, not directed)
    const row = db.prepare(
      `SELECT status FROM subagent_messages WHERE workflow_id = ?`,
    ).get(wfId) as { status: string };
    expect(row.status).toBe('pending');

    // Neither B nor C can dequeue again
    expect(dequeueFor(db, taskB, wfId)).toHaveLength(0);
    expect(dequeueFor(db, taskC, wfId)).toHaveLength(0);
  });
});

describe('inbox.dequeueFor — cross-workflow isolation', () => {
  it('does not return messages from another workflow', () => {
    const db = initDb(':memory:');

    const wf1Id = newWorkflowId();
    const wf2Id = newWorkflowId();
    const tA = newTaskId();
    const tB = newTaskId();
    const tC = newTaskId();
    const tD = newTaskId();

    insertWorkflow(db, makeWorkflow(wf1Id));
    insertWorkflow(db, makeWorkflow(wf2Id));
    insertTask(db, makeTask(tA, wf1Id));
    insertTask(db, makeTask(tB, wf1Id));
    insertTask(db, makeTask(tC, wf2Id));
    insertTask(db, makeTask(tD, wf2Id));

    // Send broadcast on wf1
    enqueue(db, {
      workflowId: wf1Id,
      fromTaskId: tA,
      type: 'announcement',
      payload: { topic: 'wf1', summary: 'wf1 only' },
    });

    // tD is in wf2 — should get 0 messages
    const msgs = dequeueFor(db, tD, wf2Id);
    expect(msgs).toHaveLength(0);

    db.close();
  });
});

describe('inbox.pendingFor', () => {
  it('count matches dequeueFor length before the call', () => {
    const { db, wfId, taskA, taskB } = setupThree();

    enqueue(db, {
      workflowId: wfId,
      fromTaskId: taskA,
      toTaskId: taskB,
      type: 'steer',
      payload: { instruction: 'go' },
    });
    enqueue(db, {
      workflowId: wfId,
      fromTaskId: taskA,
      type: 'announcement',
      payload: { topic: 'broadcast', summary: 'hello' },
    });

    const cnt = pendingFor(db, taskB, wfId);
    const msgs = dequeueFor(db, taskB, wfId);
    expect(cnt).toBe(msgs.length);
    expect(cnt).toBe(2);
  });

  it('returns 0 when nothing is pending', () => {
    const { db, wfId, taskA } = setupThree();
    expect(pendingFor(db, taskA, wfId)).toBe(0);
  });
});

describe('inbox.peekFor', () => {
  it('does not advance delivery state — message still available after peek', () => {
    const { db, wfId, taskA, taskB } = setupThree();

    enqueue(db, {
      workflowId: wfId,
      fromTaskId: taskA,
      toTaskId: taskB,
      type: 'query',
      payload: { question: 'what time is it?' },
    });

    const peeked = peekFor(db, taskB, wfId);
    expect(peeked).toHaveLength(1);

    // dequeueFor should still return it
    const msgs = dequeueFor(db, taskB, wfId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].row.id).toBe(peeked[0].id);
  });

  it('returns 0 rows after dequeue has consumed all messages', () => {
    const { db, wfId, taskA, taskB } = setupThree();

    enqueue(db, {
      workflowId: wfId,
      fromTaskId: taskA,
      toTaskId: taskB,
      type: 'steer',
      payload: { instruction: 'stop' },
    });

    dequeueFor(db, taskB, wfId);
    expect(peekFor(db, taskB, wfId)).toHaveLength(0);
  });
});

describe('inbox.dequeueFor — self-message exclusion (explicit)', () => {
  it('task A enqueues broadcast; dequeueFor(A) returns empty', () => {
    const { db, wfId, taskA } = setupThree();

    enqueue(db, {
      workflowId: wfId,
      fromTaskId: taskA,
      type: 'announcement',
      payload: { topic: 'self', summary: 'self-send' },
    });

    expect(dequeueFor(db, taskA, wfId)).toHaveLength(0);
  });
});
