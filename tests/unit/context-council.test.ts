import { describe, expect, it } from 'vitest';

import { createCouncilRun } from '../../src/context/council.js';
import { loadThreadMessages } from '../../src/context/store.js';
import { initDb } from '../../src/db/client.js';
import { buildWorkflowDebugLog } from '../../src/db/workflow-debug-log.js';

function insertWorkflow(db: ReturnType<typeof initDb>): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO workflows
       (id, workspace, objective, status, started_at, completed_at, created_at, created_by)
     VALUES ('wf_council', 'internal', 'council smoke', 'executing', ?, NULL, ?, 'test')`,
  ).run(now, now);
}

describe('workflow council context service', () => {
  it('records visible participant messages, a decision, and a dry-run fix draft with redaction', () => {
    const db = initDb(':memory:');
    insertWorkflow(db);

    const result = createCouncilRun(db, {
      workspace: 'internal',
      runId: 'wf_council',
      taskId: 'tk_1',
      topic: 'Debug failed workflow',
      source: 'debug_bundle',
      participants: [
        { id: 'planner', role: 'planner' },
        { id: 'debug', role: 'debug' },
      ],
      contextSummary: 'token=secret123 and issue=missing handoff',
      runMode: 'dry-run',
    });

    expect(result.run_mode).toBe('dry-run');
    expect(result.approval_status).toBe('not_required');
    expect(result.messages).toHaveLength(2);
    expect(result.decision.metadata_json).toContain('council_decision');
    expect(result.fix_task_draft.run_mode).toBe('dry-run');
    expect(loadThreadMessages(db, result.thread.id).map((msg) => msg.sender_id)).toEqual(['planner', 'debug']);

    const logJson = JSON.stringify(buildWorkflowDebugLog(db, 'wf_council'));
    expect(logJson).toContain('Council: Debug failed workflow');
    expect(logJson).toContain('missing handoff');
    expect(logJson).not.toContain('secret123');

    db.close();
  });

  it('requires explicit approval metadata for approved-run council writes', () => {
    const db = initDb(':memory:');
    insertWorkflow(db);

    expect(() => createCouncilRun(db, {
      workspace: 'internal',
      runId: 'wf_council',
      topic: 'Approved council',
      participants: [{ id: 'product', role: 'product' }],
      runMode: 'approved-run',
    })).toThrow(/approved_by/);

    db.close();
  });
});

