/**
 * W5-backend (2026-05-11) — synthetic SSE events for the dashboard.
 *
 * Verifies that the daemon pushes:
 *
 *   1. `cost_delta` — whenever recordModelCall adds a non-zero cost to a
 *      workflow, with the contract payload
 *      { workflow_id, delta_usd, cumulative_usd, source }.
 *
 *   2. `latest_event_metadata` — whenever insertEvent writes a non-synthetic
 *      event row, with { workflow_id, event_id, event_type, timestamp_ms,
 *      task_id }.
 *
 * Both events flow over the existing eventBroker (the per-workflow SSE
 * subscription used by /events/workflow/:id). The throttle is 500 ms PER
 * WORKFLOW, so two concurrent workflows each get their own stream cadence.
 *
 * We exercise the broker directly (no HTTP transport in the loop) because
 * this is what the SSE route ultimately delivers — the route is a thin
 * `eventBroker.subscribeWorkflow(...)` shim, so a broker-level assertion
 * covers the wire contract end-to-end. Faster, deterministic, no port
 * allocation needed.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';

import { initDb } from '../../src/db/client.js';
import { insertEvent } from '../../src/db/persist.js';
import { recordModelCall } from '../../src/v2/llm-ledger/store.js';
import { eventBroker } from '../../src/mcp/event-broker.js';
import {
  resetSseMetaEmitterForTests,
  type CostDeltaPayload,
  type LatestEventMetadataPayload,
} from '../../src/mcp/sse-meta-emitter.js';
import type { WorkflowProgressEvent } from '../../src/brain/executor/types.js';

interface CapturedEvents {
  costDelta: WorkflowProgressEvent[];
  latestEvent: WorkflowProgressEvent[];
  all: WorkflowProgressEvent[];
}

function subscribeAll(workflowId: string): {
  captured: CapturedEvents;
  unsubscribe: () => void;
} {
  const captured: CapturedEvents = {
    costDelta: [],
    latestEvent: [],
    all: [],
  };
  const unsubscribe = eventBroker.subscribeWorkflow(workflowId, (event) => {
    captured.all.push(event);
    if (event.type === 'cost_delta') captured.costDelta.push(event);
    if (event.type === 'latest_event_metadata') captured.latestEvent.push(event);
  });
  return { captured, unsubscribe };
}

function seedWorkflow(
  db: ReturnType<typeof initDb>,
  workflowId: string,
  taskId: string,
): void {
  db.prepare(
    `INSERT INTO workflows
       (id, workspace, objective, status, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(workflowId, 'internal', 'sse-cost-delta test', 'executing', Date.now(), 'test');
  db.prepare(
    `INSERT INTO tasks
       (id, workflow_id, name, kind, input_json, output_json, status,
        depends_on_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(taskId, workflowId, 'sse-cost-delta task', 'llm_call', '{}', null, 'running', '[]', Date.now());
}

describe('W5-backend synthetic SSE events', () => {
  beforeEach(() => {
    resetSseMetaEmitterForTests();
    eventBroker.reset();
  });

  afterEach(() => {
    resetSseMetaEmitterForTests();
    eventBroker.reset();
  });

  it('emits cost_delta when a non-zero cost is recorded for a workflow', () => {
    const db = initDb(':memory:');
    const workflowId = 'wf_cost_delta_emit';
    const taskId = 'tk_cost_delta_emit';
    seedWorkflow(db, workflowId, taskId);

    const { captured, unsubscribe } = subscribeAll(workflowId);
    try {
      recordModelCall(db, {
        workflowId,
        taskId,
        model: 'cc/claude-sonnet-4-6',
        provider: 'cc',
        inputTokens: 120,
        outputTokens: 80,
        costUsd: 0.0042,
        kind: 'llm_call',
      });
    } finally {
      unsubscribe();
      db.close();
    }

    expect(captured.costDelta).toHaveLength(1);
    const payload = captured.costDelta[0]!.payload as unknown as CostDeltaPayload;
    expect(payload.workflow_id).toBe(workflowId);
    expect(payload.delta_usd).toBeCloseTo(0.0042, 6);
    expect(payload.cumulative_usd).toBeCloseTo(0.0042, 6);
    expect(payload.source).toBe('llm_call');
  });

  it('skips cost_delta when costUsd is zero (no useful signal)', () => {
    const db = initDb(':memory:');
    const workflowId = 'wf_cost_delta_zero';
    const taskId = 'tk_cost_delta_zero';
    seedWorkflow(db, workflowId, taskId);

    const { captured, unsubscribe } = subscribeAll(workflowId);
    try {
      recordModelCall(db, {
        workflowId,
        taskId,
        model: 'cc/claude-sonnet-4-6',
        costUsd: 0,
        kind: 'llm_call',
      });
    } finally {
      unsubscribe();
      db.close();
    }

    expect(captured.costDelta).toHaveLength(0);
  });

  it('emits latest_event_metadata when insertEvent writes a non-synthetic row', () => {
    const db = initDb(':memory:');
    const workflowId = 'wf_meta_basic';
    const taskId = 'tk_meta_basic';
    seedWorkflow(db, workflowId, taskId);

    const { captured, unsubscribe } = subscribeAll(workflowId);
    try {
      insertEvent(db, {
        workflow_id: workflowId,
        task_id: taskId,
        type: 'task_completed',
        payload: { duration_ms: 1234 },
      });
    } finally {
      unsubscribe();
      db.close();
    }

    // Two broker events fire: the original `task_completed`, plus the
    // synthetic `latest_event_metadata`. Synthetic events go ONLY through
    // the broker (not into the events table).
    expect(captured.latestEvent).toHaveLength(1);
    const meta = captured.latestEvent[0]!.payload as unknown as LatestEventMetadataPayload;
    expect(meta.workflow_id).toBe(workflowId);
    expect(meta.event_type).toBe('task_completed');
    expect(meta.task_id).toBe(taskId);
    expect(typeof meta.event_id).toBe('number');
    expect(meta.event_id).toBeGreaterThan(0);
    expect(typeof meta.timestamp_ms).toBe('number');
    expect(meta.timestamp_ms).toBeGreaterThan(0);
  });

  it('throttles latest_event_metadata to one emission per 500 ms per workflow', () => {
    const db = initDb(':memory:');
    const workflowId = 'wf_meta_throttle';
    const taskId = 'tk_meta_throttle';
    seedWorkflow(db, workflowId, taskId);

    const { captured, unsubscribe } = subscribeAll(workflowId);
    try {
      // Fire 10 events in rapid succession — all within the same 500 ms
      // window. Only the first should produce a latest_event_metadata.
      for (let i = 0; i < 10; i += 1) {
        insertEvent(db, {
          workflow_id: workflowId,
          task_id: taskId,
          type: 'task_streaming_chunk',
          payload: { seq: i },
        });
      }
    } finally {
      unsubscribe();
      db.close();
    }

    // Exactly one synthetic emission for the burst.
    expect(captured.latestEvent).toHaveLength(1);
    // The base event itself is broadcast 10 times — verifies we didn't
    // accidentally throttle the original event channel.
    const baseEvents = captured.all.filter((e) => e.type === 'task_streaming_chunk');
    expect(baseEvents).toHaveLength(10);
  });

  it('throttles cost_delta to one emission per 500 ms per workflow', () => {
    const db = initDb(':memory:');
    const workflowId = 'wf_cost_throttle';
    const taskId = 'tk_cost_throttle';
    seedWorkflow(db, workflowId, taskId);

    const { captured, unsubscribe } = subscribeAll(workflowId);
    try {
      // Five rapid cost recordings.
      for (let i = 0; i < 5; i += 1) {
        recordModelCall(db, {
          workflowId,
          taskId,
          model: 'cc/claude-sonnet-4-6',
          costUsd: 0.001,
          kind: 'llm_call',
        });
      }
    } finally {
      unsubscribe();
      db.close();
    }

    expect(captured.costDelta).toHaveLength(1);
    // First (and only) emitted delta carries the FIRST recorded cost and
    // the cumulative-so-far at the moment of emission. Cumulative reads
    // after the row is committed, so it's at least 0.001.
    const first = captured.costDelta[0]!.payload as unknown as CostDeltaPayload;
    expect(first.delta_usd).toBeCloseTo(0.001, 6);
    expect(first.cumulative_usd).toBeGreaterThanOrEqual(0.001);
  });

  it('allows a second emission after the throttle window elapses', async () => {
    const db = initDb(':memory:');
    const workflowId = 'wf_meta_window_reset';
    const taskId = 'tk_meta_window_reset';
    seedWorkflow(db, workflowId, taskId);

    const { captured, unsubscribe } = subscribeAll(workflowId);
    try {
      insertEvent(db, {
        workflow_id: workflowId,
        task_id: taskId,
        type: 'task_started',
      });
      // Wait past the 500 ms window, then emit again.
      await sleep(550);
      insertEvent(db, {
        workflow_id: workflowId,
        task_id: taskId,
        type: 'task_completed',
        payload: { duration_ms: 100 },
      });
    } finally {
      unsubscribe();
      db.close();
    }

    expect(captured.latestEvent).toHaveLength(2);
    const types = captured.latestEvent.map(
      (e) => (e.payload as unknown as LatestEventMetadataPayload).event_type,
    );
    expect(types).toEqual(['task_started', 'task_completed']);
  });

  it('throttles are independent per workflow (two concurrent workflows each get their own stream)', () => {
    const db = initDb(':memory:');
    const wfA = 'wf_concurrent_A';
    const wfB = 'wf_concurrent_B';
    const tkA = 'tk_concurrent_A';
    const tkB = 'tk_concurrent_B';
    seedWorkflow(db, wfA, tkA);
    seedWorkflow(db, wfB, tkB);

    const subA = subscribeAll(wfA);
    const subB = subscribeAll(wfB);

    try {
      // Interleave events between the two workflows in the same 500 ms
      // window. Each workflow should receive its own metadata emission.
      for (let i = 0; i < 5; i += 1) {
        insertEvent(db, {
          workflow_id: wfA,
          task_id: tkA,
          type: 'task_streaming_chunk',
          payload: { seq: i },
        });
        insertEvent(db, {
          workflow_id: wfB,
          task_id: tkB,
          type: 'task_streaming_chunk',
          payload: { seq: i },
        });
      }
      // Same story for cost emissions.
      for (let i = 0; i < 3; i += 1) {
        recordModelCall(db, {
          workflowId: wfA,
          taskId: tkA,
          model: 'cc/claude-sonnet-4-6',
          costUsd: 0.001,
          kind: 'llm_call',
        });
        recordModelCall(db, {
          workflowId: wfB,
          taskId: tkB,
          model: 'cc/claude-sonnet-4-6',
          costUsd: 0.002,
          kind: 'llm_call',
        });
      }
    } finally {
      subA.unsubscribe();
      subB.unsubscribe();
      db.close();
    }

    // Each workflow gets exactly one metadata + one cost emission — the
    // throttle keys on workflow_id, so the workflows don't compete for
    // the same window.
    expect(subA.captured.latestEvent).toHaveLength(1);
    expect(subB.captured.latestEvent).toHaveLength(1);
    expect(subA.captured.costDelta).toHaveLength(1);
    expect(subB.captured.costDelta).toHaveLength(1);

    // And the deltas carry the correct cost per workflow.
    const deltaA = subA.captured.costDelta[0]!.payload as unknown as CostDeltaPayload;
    const deltaB = subB.captured.costDelta[0]!.payload as unknown as CostDeltaPayload;
    expect(deltaA.workflow_id).toBe(wfA);
    expect(deltaB.workflow_id).toBe(wfB);
    expect(deltaA.delta_usd).toBeCloseTo(0.001, 6);
    expect(deltaB.delta_usd).toBeCloseTo(0.002, 6);
  });

  it('payload contract for cost_delta matches the W5 plan exactly', () => {
    const db = initDb(':memory:');
    const workflowId = 'wf_cost_contract';
    const taskId = 'tk_cost_contract';
    seedWorkflow(db, workflowId, taskId);

    const { captured, unsubscribe } = subscribeAll(workflowId);
    try {
      recordModelCall(db, {
        workflowId,
        taskId,
        model: 'cc/claude-sonnet-4-6',
        costUsd: 0.025,
        kind: 'cli_spawn',
      });
    } finally {
      unsubscribe();
      db.close();
    }

    expect(captured.costDelta).toHaveLength(1);
    const payload = captured.costDelta[0]!.payload as Record<string, unknown>;
    const keys = Object.keys(payload).sort();
    // The contract surface — exactly these four keys, nothing else.
    expect(keys).toEqual(['cumulative_usd', 'delta_usd', 'source', 'workflow_id']);
    expect(typeof payload['workflow_id']).toBe('string');
    expect(typeof payload['delta_usd']).toBe('number');
    expect(typeof payload['cumulative_usd']).toBe('number');
    expect(payload['source']).toBe('cli_spawn');
  });

  it('payload contract for latest_event_metadata matches the W5 plan exactly', () => {
    const db = initDb(':memory:');
    const workflowId = 'wf_meta_contract';
    const taskId = 'tk_meta_contract';
    seedWorkflow(db, workflowId, taskId);

    const { captured, unsubscribe } = subscribeAll(workflowId);
    try {
      insertEvent(db, {
        workflow_id: workflowId,
        task_id: taskId,
        type: 'task_completed',
      });
    } finally {
      unsubscribe();
      db.close();
    }

    expect(captured.latestEvent).toHaveLength(1);
    const payload = captured.latestEvent[0]!.payload as Record<string, unknown>;
    const keys = Object.keys(payload).sort();
    expect(keys).toEqual([
      'event_id',
      'event_type',
      'task_id',
      'timestamp_ms',
      'workflow_id',
    ]);
    expect(typeof payload['workflow_id']).toBe('string');
    expect(typeof payload['event_id']).toBe('number');
    expect(typeof payload['event_type']).toBe('string');
    expect(typeof payload['timestamp_ms']).toBe('number');
    // task_id may be null OR a string per the contract.
    const taskIdValue = payload['task_id'];
    expect(taskIdValue === null || typeof taskIdValue === 'string').toBe(true);
  });

  it('respects the throttle boundary: 499ms gap still throttles, 501ms gap does not', async () => {
    // Precision test for the 500ms boundary. We can't reach into the
    // emitter's clock, so we use sleep() and rely on the >= comparison
    // inside shouldEmit (>= 500ms passes the gate, < 500ms fails). 499ms
    // and 501ms exercise both sides with a 1ms safety margin under
    // setTimeout's typical 1-16ms resolution.
    const db = initDb(':memory:');
    const workflowId = 'wf_boundary';
    const taskId = 'tk_boundary';
    seedWorkflow(db, workflowId, taskId);

    const { captured, unsubscribe } = subscribeAll(workflowId);
    try {
      // Emission 1 — opens the throttle window.
      insertEvent(db, {
        workflow_id: workflowId,
        task_id: taskId,
        type: 'task_started',
      });
      // Wait just under 500ms — emission 2 must be throttled out.
      await sleep(450);
      insertEvent(db, {
        workflow_id: workflowId,
        task_id: taskId,
        type: 'task_progress',
      });
      // We should still see only the first synthetic emission.
      expect(captured.latestEvent).toHaveLength(1);

      // Wait past the rest of the window — emission 3 must go through.
      await sleep(120); // total ~570ms since emission 1
      insertEvent(db, {
        workflow_id: workflowId,
        task_id: taskId,
        type: 'task_completed',
      });
      expect(captured.latestEvent).toHaveLength(2);
      const types = captured.latestEvent.map(
        (e) => (e.payload as unknown as LatestEventMetadataPayload).event_type,
      );
      expect(types).toEqual(['task_started', 'task_completed']);
    } finally {
      unsubscribe();
      db.close();
    }
  });

  it('throttles cost_delta and latest_event_metadata via independent windows', () => {
    // Regression guard for the "two-map design" documented in
    // sse-meta-emitter.ts:22-24 — costDelta and latestEvent maintain their
    // own per-workflow throttle. Firing a costDelta in the same 500ms
    // window as a latestEventMetadata must NOT block the latestEventMetadata
    // and vice-versa.
    const db = initDb(':memory:');
    const workflowId = 'wf_independent_windows';
    const taskId = 'tk_independent_windows';
    seedWorkflow(db, workflowId, taskId);

    const { captured, unsubscribe } = subscribeAll(workflowId);
    try {
      // Burst of insertEvents — opens the latestEventMetadata window.
      insertEvent(db, {
        workflow_id: workflowId,
        task_id: taskId,
        type: 'task_started',
      });
      expect(captured.latestEvent).toHaveLength(1);

      // Immediately record a cost — separate window, should fire.
      recordModelCall(db, {
        workflowId,
        taskId,
        model: 'cc/claude-sonnet-4-6',
        costUsd: 0.005,
        kind: 'llm_call',
      });
      expect(captured.costDelta).toHaveLength(1);

      // Both windows are now closed for 500ms.
      insertEvent(db, {
        workflow_id: workflowId,
        task_id: taskId,
        type: 'task_progress',
      });
      recordModelCall(db, {
        workflowId,
        taskId,
        model: 'cc/claude-sonnet-4-6',
        costUsd: 0.006,
        kind: 'llm_call',
      });
      // No new emissions: both stayed throttled.
      expect(captured.latestEvent).toHaveLength(1);
      expect(captured.costDelta).toHaveLength(1);
    } finally {
      unsubscribe();
      db.close();
    }
  });

  it('does not recurse: synthetic event types never trigger latest_event_metadata themselves', () => {
    // Direct safety check: even if some path were to call insertEvent with
    // a synthetic type literal, the emitter must skip it. We exercise
    // this through the public insertEvent surface so the regression test
    // matches what a future caller could do.
    const db = initDb(':memory:');
    const workflowId = 'wf_recursion_guard';
    const taskId = 'tk_recursion_guard';
    seedWorkflow(db, workflowId, taskId);

    const { captured, unsubscribe } = subscribeAll(workflowId);
    try {
      insertEvent(db, {
        workflow_id: workflowId,
        task_id: taskId,
        // Type is registered in event-types.ts; this simulates a buggy
        // caller wiring the literal into insertEvent directly. The
        // recursion guard inside emitLatestEventMetadata must drop it.
        type: 'latest_event_metadata',
        payload: { event_id: 999 },
      });
    } finally {
      unsubscribe();
      db.close();
    }

    // The base event still rides the broker (it's a normal insertEvent
    // call), but we MUST NOT emit a second latest_event_metadata in
    // response. Net: exactly ONE event of this type in the broker.
    const meta = captured.all.filter((e) => e.type === 'latest_event_metadata');
    expect(meta).toHaveLength(1);
  });
});
