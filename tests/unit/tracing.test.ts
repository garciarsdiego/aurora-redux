import { describe, it, expect } from 'vitest';
import { initDb } from '../../src/db/client.js';
import {
  endTraceSpan,
  exportTraceSpans,
  startTraceSpan,
} from '../../src/v2/observability/tracing.js';

describe('trace spans', () => {
  it('creates trace_spans table through migrations', () => {
    const db = initDb(':memory:');
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trace_spans'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('trace_spans');
    db.close();
  });

  it('starts, ends and exports OTel-like spans', () => {
    const db = initDb(':memory:');
    db.prepare(
      `INSERT INTO workflows (id, workspace, objective, status, created_at)
       VALUES ('wf_1', 'internal', 'trace test', 'executing', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO tasks
         (id, workflow_id, name, kind, status, depends_on_json, timeout_seconds,
          max_retries, retry_count, retry_policy, created_at)
       VALUES ('tk_1', 'wf_1', 'traced task', 'llm_call', 'pending', '[]', 60, 3, 0, 'exponential', 1)`,
    ).run();
    const span = startTraceSpan(db, {
      workflowId: 'wf_1',
      taskId: 'tk_1',
      name: 'task.execute',
      kind: 'task',
      attributes: { model: 'test/model' },
      now: 100,
    });
    endTraceSpan(db, span.id, { status: 'ok', now: 150, attributes: { cost_usd: 0.01 } });

    expect(exportTraceSpans(db, 'wf_1')).toEqual([
      expect.objectContaining({
        id: span.id,
        workflow_id: 'wf_1',
        task_id: 'tk_1',
        name: 'task.execute',
        kind: 'task',
        status: 'ok',
        duration_ms: 50,
        attributes: { model: 'test/model', cost_usd: 0.01 },
      }),
    ]);
    db.close();
  });
});
