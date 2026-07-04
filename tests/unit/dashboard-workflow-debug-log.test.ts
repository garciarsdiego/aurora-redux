import { describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { buildWorkflowDebugLog } from '../../src/db/workflow-debug-log.js';
import { recordTaskContextPacket } from '../../src/context/workflow-adapter.js';
import { saveQualityReview } from '../../src/quality/store.js';

describe('workflow debug log', () => {
  it('builds an audit export with terminal lines, structured errors, and redacted payloads', () => {
    const db = initDb(':memory:');
    const now = Date.now();
    const workflowId = 'wf_debug';
    const taskId = 'tk_debug';
    const secret = 'sk-test-secret-value-that-must-not-leak';
    const genericSecret = 'lov_real_value';

    db.prepare(
      `INSERT INTO workflows
         (id, workspace, objective, status, started_at, completed_at, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(workflowId, 'internal', `Debug ${secret}`, 'failed', now, now + 10, now, 'test');
    db.prepare(
      `INSERT INTO tasks
         (id, workflow_id, name, kind, input_json, output_json, status, depends_on_json, created_at, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      taskId,
      workflowId,
      'Run failing command',
      'cli_spawn',
      JSON.stringify({ command: `echo ${secret}`, api_key: genericSecret }),
      JSON.stringify({ error: `Command failed with ${secret}`, password: genericSecret }),
      'failed',
      JSON.stringify([]),
      now + 1,
      'cc/claude-sonnet-4-6',
    );
    db.prepare(
      `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      workflowId,
      taskId,
      'workflow_background_error',
      JSON.stringify({ error: `bad token ${secret}`, api_key: genericSecret }),
      now + 2,
    );
    recordTaskContextPacket(db, {
      workspace: 'internal',
      runId: workflowId,
      taskId,
      taskName: 'Run failing command',
      attempt: 1,
      packet: { api_key: genericSecret, input_keys: ['command'] },
    });

    const log = buildWorkflowDebugLog(db, workflowId);
    const serialized = JSON.stringify(log);

    expect(log.terminal_lines.some((line) => line.includes('task 01'))).toBe(true);
    expect(log.terminal_lines.some((line) => line.includes('workflow_background_error'))).toBe(true);
    expect(log.structured_errors.map((err) => err.code)).toContain('workflow_background_error');
    expect(log.structured_errors.map((err) => err.code)).toContain('task_failed');
    expect(log.context_orchestration.context_packets).toHaveLength(1);
    expect(log.context_orchestration.messages.some((message) => message.kind === 'context_packet')).toBe(true);
    expect(log.runtime_state.executor_capabilities.some((capability) => capability.executorId === 'cli:codex')).toBe(true);
    expect(log.runtime_state.notes.some((note) => note.includes('not persisted for this workflow'))).toBe(true);
    expect(log.tasks[0]).not.toHaveProperty('input_json');
    expect(log.tasks[0]).not.toHaveProperty('output_json');
    expect(log.events[0]).not.toHaveProperty('payload_json');
    expect(log.context_orchestration.context_packets[0]).not.toHaveProperty('packet_json');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(genericSecret);
    expect(serialized).toContain('sk-***');
    expect(serialized).toContain('***');

    db.close();
  });

  it('includes quality reviews, fix task drafts, and quality gate errors in the export', () => {
    const db = initDb(':memory:');
    const now = Date.now();
    const workflowId = 'wf_quality_debug';
    const secret = 'sk-quality-secret-that-must-not-leak';

    db.prepare(
      `INSERT INTO workflows
         (id, workspace, objective, status, started_at, completed_at, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(workflowId, 'internal', 'Quality debug', 'failed', now, null, now, 'test');

    saveQualityReview(db, {
      workflowId,
      scope: 'workflow_final',
      reviewerKind: 'browser_harness',
      reviewerModel: null,
      outcome: 'needs_fixes',
      score: 0.35,
      issues: [
        {
          severity: 'blocking',
          code: 'visible_control_not_implemented',
          origin: 'browser_harness',
          message: `The UI promises controls but does not implement them ${secret}`,
          suggestedAction: 'Create a focused fix task and rerun the product harness.',
        },
      ],
      evidence: [
        {
          kind: 'browser',
          label: 'static web contract',
          summary: `Observed mismatch ${secret}`,
        },
      ],
      fixTasks: [
        {
          title: 'Fix playable controls',
          kind: 'cli_spawn',
          objective: 'Wire visible controls to runtime handlers.',
          acceptanceCriteria: 'Harness passes and the control text matches implemented behavior.',
        },
      ],
      auditStatus: 'recorded',
      runMode: 'dry-run',
      createdAt: now + 1,
    });

    const log = buildWorkflowDebugLog(db, workflowId);
    const serialized = JSON.stringify(log);

    expect(log.quality_reviews).toHaveLength(1);
    expect(log.quality_reviews[0]).not.toHaveProperty('issues_json');
    expect(log.quality_reviews[0]).not.toHaveProperty('evidence_json');
    expect(log.quality_reviews[0]).not.toHaveProperty('fix_tasks_json');
    expect(log.terminal_lines.some((line) => line.includes('quality_review'))).toBe(true);
    expect(log.structured_errors.map((err) => err.code)).toContain('quality_workflow_final_needs_fixes');
    expect(serialized).toContain('Fix playable controls');
    expect(serialized).not.toContain(secret);

    db.close();
  });

  it('keeps resolved retry failures out of current structured errors', () => {
    const db = initDb(':memory:');
    const now = Date.now();
    const workflowId = 'wf_debug_resolved';
    const taskId = 'tk_debug_resolved';

    db.prepare(
      `INSERT INTO workflows
         (id, workspace, objective, status, started_at, completed_at, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(workflowId, 'internal', 'Resolved retry', 'completed', now, now + 50, now, 'test');
    db.prepare(
      `INSERT INTO tasks
         (id, workflow_id, name, kind, input_json, output_json, status, depends_on_json, created_at, completed_at, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      taskId,
      workflowId,
      'Write file',
      'cli_spawn',
      JSON.stringify({}),
      JSON.stringify({ ok: true }),
      'completed',
      JSON.stringify([]),
      now + 1,
      now + 40,
      'cx/gpt-5.4',
    );
    db.prepare(
      `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      workflowId,
      taskId,
      'task_review_error',
      JSON.stringify({ error: 'read-only filesystem sandbox blocked src/index.html' }),
      now + 2,
    );
    db.prepare(
      `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      workflowId,
      taskId,
      'task_completed',
      null,
      now + 45,
    );

    const log = buildWorkflowDebugLog(db, workflowId);

    expect(log.structured_errors).toHaveLength(0);
    expect(log.historical_errors.map((err) => err.code)).toContain('task_review_error');
    expect(log.terminal_lines.some((line) => line.includes('historical_errors=1'))).toBe(true);

    db.close();
  });

  it('classifies workflow background errors by task id referenced in the message', () => {
    const db = initDb(':memory:');
    const now = Date.now();
    const workflowId = 'wf_debug_mixed_errors';
    const reviewTaskId = 'tk_review_done';
    const exploreTaskId = 'tk_explore_done';
    const finalTaskId = 'tk_final_failed';

    db.prepare(
      `INSERT INTO workflows
         (id, workspace, objective, status, started_at, completed_at, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(workflowId, 'dogfood-existing-code', 'Mixed error state', 'failed', now, null, now, 'test');

    for (const [index, task] of [
      [1, { id: reviewTaskId, name: 'Review execution plan', status: 'completed' }],
      [2, { id: exploreTaskId, name: 'Explore existing codebase', status: 'completed' }],
      [3, { id: finalTaskId, name: 'Integrate and verify build', status: 'failed' }],
    ] as const) {
      db.prepare(
        `INSERT INTO tasks
           (id, workflow_id, name, kind, input_json, output_json, status, depends_on_json, created_at, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        task.id,
        workflowId,
        task.name,
        'cli_spawn',
        JSON.stringify({}),
        task.status === 'failed' ? JSON.stringify({ error: 'final integration reviewer failed' }) : JSON.stringify({ ok: true }),
        task.status,
        JSON.stringify([]),
        now + index,
        'cx/gpt-5.4',
      );
    }

    db.prepare(
      `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      workflowId,
      null,
      'workflow_background_error',
      JSON.stringify({ error: `Task 'Review execution plan' [${reviewTaskId}] falhou: old plan review failure` }),
      now + 10,
    );
    db.prepare(
      `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      workflowId,
      exploreTaskId,
      'workflow_background_error',
      JSON.stringify({ error: `Task 'Integrate and verify build' [${finalTaskId}] falhou: current final failure` }),
      now + 11,
    );

    const log = buildWorkflowDebugLog(db, workflowId);
    const currentWorkflowError = log.structured_errors.find((err) =>
      err.code === 'workflow_background_error' && err.message.includes(finalTaskId),
    );

    expect(log.structured_errors.some((err) => err.message.includes(reviewTaskId))).toBe(false);
    expect(log.historical_errors.some((err) => err.message.includes(reviewTaskId))).toBe(true);
    expect(currentWorkflowError).toMatchObject({
      origin: `task:${finalTaskId}`,
      context: {
        task_id: finalTaskId,
        event_task_id: exploreTaskId,
      },
    });

    db.close();
  });

  it('keeps older failed attempts historical when the same task fails again later', () => {
    const db = initDb(':memory:');
    const now = Date.now();
    const workflowId = 'wf_debug_retry_attempts';
    const taskId = 'tk_retry_failed';

    db.prepare(
      `INSERT INTO workflows
         (id, workspace, objective, status, started_at, completed_at, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(workflowId, 'internal', 'Retry attempts', 'failed', now, null, now, 'test');
    db.prepare(
      `INSERT INTO tasks
         (id, workflow_id, name, kind, input_json, output_json, status, depends_on_json, created_at, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      taskId,
      workflowId,
      'Integrate and verify',
      'cli_spawn',
      JSON.stringify({}),
      JSON.stringify({ error: 'latest attempt failed' }),
      'failed',
      JSON.stringify([]),
      now + 1,
      'cx/gpt-5.4',
    );

    for (const [type, payload, timestamp] of [
      ['task_started', null, now + 10],
      ['task_review_error', { error: 'old attempt filesystem empty' }, now + 20],
      ['task_started', null, now + 30],
      ['task_review_error', { error: 'latest attempt command evidence too short' }, now + 40],
    ] as const) {
      db.prepare(
        `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(workflowId, taskId, type, payload ? JSON.stringify(payload) : null, timestamp);
    }

    const log = buildWorkflowDebugLog(db, workflowId);

    expect(log.structured_errors.some((err) => err.message.includes('old attempt'))).toBe(false);
    expect(log.historical_errors.some((err) => err.message.includes('old attempt'))).toBe(true);
    expect(log.structured_errors.some((err) => err.message.includes('latest attempt'))).toBe(true);

    db.close();
  });
});
