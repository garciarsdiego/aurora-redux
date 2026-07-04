import { describe, expect, it, vi } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { auditWorkflowDebugLog } from '../../src/mcp/workflow-log-audit.js';

function seedWorkflow() {
  const db = initDb(':memory:');
  const now = Date.now();
  const workflowId = 'wf_audit';
  const taskId = 'tk_failed';
  db.prepare(
    `INSERT INTO workflows
       (id, workspace, objective, status, started_at, completed_at, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(workflowId, 'internal', 'Audit a failed workflow', 'failed', now, now + 100, now, 'test');
  db.prepare(
    `INSERT INTO tasks
       (id, workflow_id, name, kind, input_json, output_json, status, depends_on_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    workflowId,
    'Failing step',
    'cli_spawn',
    JSON.stringify({ command: 'pnpm test' }),
    JSON.stringify({ error: 'test failed' }),
    'failed',
    JSON.stringify([]),
    now + 1,
  );
  db.prepare(
    `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(workflowId, taskId, 'task_failed', JSON.stringify({ error: 'test failed' }), now + 2);
  return { db, workflowId, taskId };
}

describe('workflow log audit', () => {
  it('runs a dry-run LLM audit and records an audit trail without applying changes', async () => {
    const { db, workflowId } = seedWorkflow();
    const advisorRunner = vi.fn(async () => 'Root cause: failing test. Suggested fix: update task command.');

    const result = await auditWorkflowDebugLog(db, workflowId, { run_mode: 'dry-run' }, {
      advisorRunner,
    });

    expect(result.run_mode).toBe('dry-run');
    expect(result.approval_status).toBe('not_required');
    expect(result.application_status).toBe('not_requested');
    expect(result.output).toContain('Root cause');
    expect(advisorRunner).toHaveBeenCalledTimes(1);

    const events = db
      .prepare(`SELECT type FROM events WHERE workflow_id = ? ORDER BY id`)
      .all(workflowId) as Array<{ type: string }>;
    expect(events.map((e) => e.type)).toContain('workflow_log_audit_requested');
    expect(events.map((e) => e.type)).toContain('workflow_log_audit_completed');
    const decision = db
      .prepare(`SELECT kind, rationale, metadata_json FROM context_decisions WHERE run_id = ?`)
      .get(workflowId) as { kind: string; rationale: string; metadata_json: string } | undefined;
    expect(decision?.kind).toBe('audit');
    expect(decision?.rationale).toContain('audit_status: completed');
    expect(decision?.metadata_json).toContain('"run_mode":"dry-run"');

    db.close();
  });

  it('requires approval for approved-run and applies to the selected failed task', async () => {
    const { db, workflowId, taskId } = seedWorkflow();
    const advisorRunner = vi.fn(async () => 'Apply this approved adjustment.');
    const adjuster = vi.fn(async () => ({ applied: true, task_id: taskId }));

    await expect(
      auditWorkflowDebugLog(db, workflowId, { run_mode: 'approved-run' }, { advisorRunner, adjuster }),
    ).rejects.toThrow(/approved_by/);

    const result = await auditWorkflowDebugLog(
      db,
      workflowId,
      { run_mode: 'approved-run', approved_by: 'dashboard' },
      { advisorRunner, adjuster },
    );

    expect(result.run_mode).toBe('approved-run');
    expect(result.approval_status).toBe('approved');
    expect(result.application_status).toBe('applied');
    expect(result.target_task_id).toBe(taskId);
    expect(adjuster).toHaveBeenCalledWith(
      db,
      workflowId,
      taskId,
      expect.objectContaining({ apply: true }),
    );
    const decision = db
      .prepare(`SELECT kind, rationale FROM context_decisions WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(workflowId) as { kind: string; rationale: string } | undefined;
    expect(decision?.kind).toBe('retry');
    expect(decision?.rationale).toContain('application_status: applied');

    db.close();
  });

  it('returns a structured failed audit when the LLM audit times out', async () => {
    const { db, workflowId } = seedWorkflow();
    const advisorRunner = vi.fn(() => new Promise<string>(() => {}));

    const result = await auditWorkflowDebugLog(db, workflowId, { run_mode: 'dry-run' }, {
      advisorRunner,
      advisorTimeoutMs: 5,
    });

    expect(result.audit_status).toBe('failed');
    expect(result.application_status).toBe('not_requested');
    expect(result.output).toContain('LLM log audit timed out');
    expect(result.output).toContain('OMNIFORGE_LOG_AUDIT_TIMEOUT_MS');

    const completed = db
      .prepare(`SELECT payload_json FROM events WHERE workflow_id = ? AND type = 'workflow_log_audit_completed'`)
      .get(workflowId) as { payload_json: string } | undefined;
    expect(completed?.payload_json).toContain('"audit_status":"failed"');
    const decision = db
      .prepare(`SELECT kind, rationale FROM context_decisions WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(workflowId) as { kind: string; rationale: string } | undefined;
    expect(decision?.kind).toBe('note');
    expect(decision?.rationale).toContain('LLM log audit timed out');

    db.close();
  });
});
