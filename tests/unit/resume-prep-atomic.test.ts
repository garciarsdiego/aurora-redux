// Wave-1.5 triage #3 — non-atomic resume prep. prepareWorkflowForResume does
// several independent UPDATEs (clear cancel metadata, re-pend the failed task,
// flip workflow→executing) then an insertEvent. If a later step fails, the
// earlier UPDATEs must NOT remain committed (a half-prepared workflow). The
// body is wrapped in db.transaction() so the whole prep is all-or-nothing.
import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import { insertWorkflow, insertTask } from '../../src/db/persist.js';
import { prepareWorkflowForResume } from '../../src/brain/executor/resume.js';
import type { Workflow, Task } from '../../src/types/index.js';

function failedWorkflowDb(): Database.Database {
  const db = initDb(':memory:');
  insertWorkflow(db, {
    id: 'wf1', workspace: 'internal', objective: 'o', pattern_id: null,
    status: 'failed', started_at: null, completed_at: null, created_at: Date.now(),
    created_by: null, estimated_cost_usd: null, actual_cost_usd: null,
    max_total_cost_usd: null, max_duration_seconds: null, metadata: null,
  } as unknown as Workflow);
  insertTask(db, {
    id: 't1', workflow_id: 'wf1', name: 'T', kind: 'llm_call',
    input_json: null, output_json: 'partial', status: 'failed',
    depends_on: [], executor_hint: null, timeout_seconds: 30, max_retries: 0,
    retry_count: 0, retry_policy: 'fixed:0', started_at: null, completed_at: Date.now(),
    created_at: Date.now(), acceptance_criteria: null, refine_count: 0, max_refine: 0,
    refine_feedback: null, model: null, hitl: false,
    execution_mode: 'ephemeral', tool_name: null, file_scope: null,
  } as unknown as Task);
  return db;
}

describe('prepareWorkflowForResume — atomicity', () => {
  it('rolls back the task re-pend + status flip when the final event insert fails', () => {
    const db = failedWorkflowDb();
    // Fault injection: abort the resume-prepared event INSERT (the last write in
    // the prep body). Without a transaction wrap, the earlier task re-pend and
    // workflow status flip have already committed; with it, they roll back.
    db.exec(
      `CREATE TRIGGER fail_resume_event BEFORE INSERT ON events
         WHEN NEW.type = 'workflow_resume_prepared'
         BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );

    expect(() => prepareWorkflowForResume(db, 'wf1', { skipFailedSteps: false })).toThrow();

    const task = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string };
    const wf = db.prepare("SELECT status FROM workflows WHERE id = 'wf1'").get() as { status: string };
    expect(task.status).toBe('failed'); // re-pend rolled back
    expect(wf.status).toBe('failed'); // executing flip rolled back
    db.close();
  });

  it('happy path still flips the workflow to executing and re-pends the failed task', () => {
    const db = failedWorkflowDb();
    const result = prepareWorkflowForResume(db, 'wf1', { skipFailedSteps: false });
    expect(result.status).toBe('executing');
    const task = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string };
    const wf = db.prepare("SELECT status FROM workflows WHERE id = 'wf1'").get() as { status: string };
    expect(task.status).toBe('pending');
    expect(wf.status).toBe('executing');
    db.close();
  });
});
