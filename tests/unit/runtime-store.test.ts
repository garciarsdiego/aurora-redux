import { describe, expect, it } from 'vitest';

import { initDb } from '../../src/db/client.js';
import { buildWorkflowDebugLog } from '../../src/db/workflow-debug-log.js';
import { RuntimeManager } from '../../src/runtime/manager.js';
import {
  appendRuntimeStreamEvent,
  createRuntimeSession,
  listRuntimeSessionsForWorkflow,
  listRuntimeStreamEventsForTurn,
  listRuntimeTurnsForWorkflow,
  startRuntimeTurn,
  upsertRuntimeCapabilities,
} from '../../src/runtime/store.js';

function insertWorkflow(db: ReturnType<typeof initDb>, workflowId: string): void {
  db.prepare(
    `INSERT INTO workflows
       (id, workspace, objective, status, started_at, completed_at, created_at, created_by)
     VALUES (?, 'internal', 'runtime smoke', 'executing', ?, NULL, ?, 'test')`,
  ).run(workflowId, Date.now(), Date.now());
}

describe('runtime session store', () => {
  it('persists capabilities, sessions, turns, and redacted stream events', () => {
    const db = initDb(':memory:');
    const workflowId = 'wf_runtime_store';
    insertWorkflow(db, workflowId);

    upsertRuntimeCapabilities(db);
    const session = createRuntimeSession(db, {
      workflowId,
      taskId: null,
      executorId: 'cli:codex',
      protocolTier: 'jsonl-headless',
      streamFormat: 'codex-jsonl',
      runtimeMode: 'oneshot',
      runMode: 'dry-run',
      metadata: { api_key: 'sk-runtime-store-secret-value' },
    });
    const turn = startRuntimeTurn(db, {
      sessionId: session.id,
      workflowId,
      attempt: 1,
      promptSummary: 'hello',
    });
    appendRuntimeStreamEvent(db, {
      sessionId: session.id,
      turnId: turn.id,
      workflowId,
      event: {
        type: 'assistant.message',
        ts: Date.now(),
        executorId: 'cli:codex',
        text: 'ok sk-runtime-stream-secret-value',
      },
    });

    expect(listRuntimeSessionsForWorkflow(db, workflowId)).toHaveLength(1);
    expect(listRuntimeTurnsForWorkflow(db, workflowId)).toHaveLength(1);
    expect(listRuntimeStreamEventsForTurn(db, turn.id)).toHaveLength(1);
    expect(JSON.stringify(buildWorkflowDebugLog(db, workflowId))).not.toContain('sk-runtime');
    expect(JSON.stringify(buildWorkflowDebugLog(db, workflowId))).toContain('***REDACTED***');

    db.close();
  });
});

describe('runtime manager', () => {
  it('records a successful runtime turn', async () => {
    const db = initDb(':memory:');
    const workflowId = 'wf_runtime_manager';
    insertWorkflow(db, workflowId);

    const manager = new RuntimeManager(db);
    const result = await manager.runTurn(
      {
        workflowId,
        executorId: 'cli:claude-code',
        protocolTier: 'jsonl-headless',
        streamFormat: 'claude-stream-json',
        runtimeMode: 'oneshot',
        promptSummary: 'say hi',
      },
      async ({ emit }) => {
        emit({
          type: 'assistant.message',
          ts: Date.now(),
          executorId: 'cli:claude-code',
          text: 'hi',
        });
        return 'done';
      },
    );

    expect(result).toBe('done');
    const log = buildWorkflowDebugLog(db, workflowId);
    expect(log.runtime_state.active_sessions).toHaveLength(1);
    expect(log.runtime_state.active_turns).toHaveLength(1);
    expect(log.runtime_state.stream_events.map((event) => event.type)).toContain('assistant.message');
    expect(log.terminal_lines.some((line) =>
      line.includes('runtime_session') &&
      line.includes('executor=cli:claude-code') &&
      line.includes('run_mode=dry-run'),
    )).toBe(true);
    expect(log.terminal_lines.some((line) =>
      line.includes('runtime_event') &&
      line.includes('assistant.message') &&
      line.includes('hi'),
    )).toBe(true);

    db.close();
  });

  it('records structured runtime errors', async () => {
    const db = initDb(':memory:');
    const workflowId = 'wf_runtime_error';
    insertWorkflow(db, workflowId);

    const manager = new RuntimeManager(db);
    await expect(manager.runTurn(
      {
        workflowId,
        executorId: 'cli:codex',
        protocolTier: 'jsonl-headless',
        streamFormat: 'codex-jsonl',
      },
      async () => {
        throw new Error('adapter failed sk-runtime-error-secret-value');
      },
    )).rejects.toThrow('adapter failed');

    const log = buildWorkflowDebugLog(db, workflowId);
    expect(log.runtime_state.active_turns[0]?.status).toBe('failed');
    expect(JSON.stringify(log)).not.toContain('sk-runtime-error-secret-value');
    expect(JSON.stringify(log)).toContain('runtime_turn_failed');

    db.close();
  });
});
