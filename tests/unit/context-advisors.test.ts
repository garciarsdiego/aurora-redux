import { describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import {
  recordDebateContextSynthesis,
  recordAdvisorContextReview,
  safeRecordAdvisorContextReview,
} from '../../src/context/advisors.js';
import { loadThreadMessages } from '../../src/context/store.js';
import { buildWorkflowDebugLog } from '../../src/db/workflow-debug-log.js';

describe('context advisor hooks', () => {
  it('records advisor review messages and decisions with redacted rationale', () => {
    const db = initDb(':memory:');
    const now = Date.now();
    const secret = 'lov_real_value';
    db.prepare(
      `INSERT INTO workflows
         (id, workspace, objective, status, started_at, completed_at, created_at, created_by)
       VALUES ('wf_advisor', 'internal', 'advisor test', 'executing', ?, NULL, ?, 'test')`,
    ).run(now, now);

    const review = recordAdvisorContextReview(db, {
      workspace: 'internal',
      runId: 'wf_advisor',
      taskId: 'tk_review',
      advisorName: 'council/debug',
      outcome: 'retry',
      summary: JSON.stringify({ api_key: secret, issue: 'worker wrote a stub file' }),
      recommendation: 'Retry with concrete filesystem deliverables.',
      confidence: 0.91,
    });

    const messages = loadThreadMessages(db, review.thread.id);
    const log = buildWorkflowDebugLog(db, 'wf_advisor');
    const serialized = JSON.stringify(log);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.kind).toBe('advisor_review');
    expect(review.decision.kind).toBe('retry');
    expect(log.context_orchestration.decisions).toHaveLength(1);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('worker wrote a stub file');

    db.close();
  });

  it('safe advisor helper does not throw when tables are unavailable', () => {
    const db = initDb(':memory:');
    db.exec('DROP TABLE context_messages');

    expect(() => safeRecordAdvisorContextReview(db, {
      workspace: 'internal',
      runId: 'wf_safe',
      advisorName: 'safe',
      outcome: 'note',
      summary: 'safe',
    })).not.toThrow();

    db.close();
  });

  it('records AI council debate synthesis as advisor thread context', () => {
    const db = initDb(':memory:');
    const now = Date.now();
    const secret = 'lov_real_value';
    db.prepare(
      `INSERT INTO workflows
         (id, workspace, objective, status, started_at, completed_at, created_at, created_by)
       VALUES ('wf_debate', 'internal', 'debate test', 'executing', ?, NULL, ?, 'test')`,
    ).run(now, now);

    const debate = recordDebateContextSynthesis(db, {
      workspace: 'internal',
      runId: 'wf_debate',
      topic: 'Retry failed task',
      participants: ['debug', 'reviewer', 'planner'],
      summary: JSON.stringify({ api_key: secret, conclusion: 'retry only failed tasks' }),
      consensus: 'Retry task with a stricter filesystem artifact requirement.',
      dissent: 'Planner wants a whole-workflow restart.',
    });
    const log = buildWorkflowDebugLog(db, 'wf_debate');
    const serialized = JSON.stringify(log);

    expect(debate.message.sender_id).toBe('ai-council');
    expect(debate.decision.kind).toBe('note');
    expect(log.context_orchestration.threads[0]?.title).toContain('AI council debate');
    expect(serialized).toContain('retry only failed tasks');
    expect(serialized).not.toContain(secret);

    db.close();
  });
});
