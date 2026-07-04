import { describe, expect, it } from 'vitest';

import { initDb } from '../../src/db/client.js';
import { eventBroker } from '../../src/mcp/event-broker.js';
import { insertEvent } from '../../src/db/persist.js';

describe('insertEvent workflow SSE payload', () => {
  it('publishes task_id in the broker payload for task-scoped DB events', () => {
    const db = initDb(':memory:');
    const workflowId = 'wf_broker_task_id';
    const taskId = 'tk_broker_task_id';
    // W5-backend: insertEvent now also fans out a synthetic
    // `latest_event_metadata` event for the dashboard SSE channel. We
    // filter on the original event type so this regression test still
    // asserts the task_id-propagation contract.
    const received: Array<Record<string, unknown>> = [];

    db.prepare(
      `INSERT INTO workflows
         (id, workspace, objective, status, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(workflowId, 'internal', 'test workflow', 'executing', Date.now(), 'test');
    db.prepare(
      `INSERT INTO tasks
         (id, workflow_id, name, kind, input_json, output_json, status, depends_on_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(taskId, workflowId, 'stream task', 'cli_spawn', '{}', null, 'running', '[]', Date.now());

    const unsubscribe = eventBroker.subscribeWorkflow(workflowId, (event) => {
      if (event.type === 'task_started') {
        received.push(event.payload);
      }
    });

    try {
      insertEvent(db, {
        workflow_id: workflowId,
        task_id: taskId,
        type: 'task_started',
      });
    } finally {
      unsubscribe();
      eventBroker.reset();
      db.close();
    }

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ task_id: taskId });
  });
});
