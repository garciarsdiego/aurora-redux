import { describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import {
  ensureWorkflowContext,
  recordTaskContextPacket,
  recordTaskHandoff,
  recordTaskThreadEvent,
  safeEnsureWorkflowContext,
  safeRecordTaskContextPacket,
  safeRecordTaskHandoff,
  safeRecordTaskThreadEvent,
} from '../../src/context/workflow-adapter.js';
import { listThreadsForRun, loadContextPacketForAttempt, loadThreadMessages } from '../../src/context/store.js';

describe('workflow context adapter', () => {
  it('creates a run channel and task thread with event messages', () => {
    const db = initDb(':memory:');
    ensureWorkflowContext(db, {
      workspace: 'internal',
      runId: 'wf_1',
      objective: 'Build a dashboard',
    });

    const thread = recordTaskThreadEvent(db, {
      workspace: 'internal',
      runId: 'wf_1',
      taskId: 'tk_1',
      taskName: 'Scaffold app',
      eventType: 'task_started',
      body: 'Task started',
      metadata: { attempt: 1 },
    });

    expect(listThreadsForRun(db, 'wf_1').map((t) => t.task_id)).toContain('tk_1');
    const messages = loadThreadMessages(db, thread.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.kind).toBe('event');
    expect(messages[0]?.metadata_json).toContain('task_started');

    db.close();
  });

  it('safe adapter helpers never throw when context tables are unavailable', () => {
    const db = initDb(':memory:');
    db.exec('DROP TABLE context_messages');

    expect(() => safeEnsureWorkflowContext(db, {
      workspace: 'internal',
      runId: 'wf_safe',
      objective: 'safe',
    })).not.toThrow();
    expect(() => safeRecordTaskThreadEvent(db, {
      workspace: 'internal',
      runId: 'wf_safe',
      taskId: 'tk_safe',
      taskName: 'Safe task',
      eventType: 'task_started',
      body: 'started',
    })).not.toThrow();
    expect(() => safeRecordTaskContextPacket(db, {
      workspace: 'internal',
      runId: 'wf_safe',
      taskId: 'tk_safe',
      taskName: 'Safe task',
      attempt: 1,
      packet: { task: 'safe' },
    })).not.toThrow();
    expect(() => safeRecordTaskHandoff(db, {
      workspace: 'internal',
      runId: 'wf_safe',
      taskId: 'tk_safe',
      taskName: 'Safe task',
      attempt: 1,
      kind: 'summary',
      body: 'safe',
    })).not.toThrow();

    db.close();
  });

  it('captures context packets and dependency handoffs without leaking token-like secrets', () => {
    const db = initDb(':memory:');
    const secret = 'sk-context-packet-secret-value';

    const parent = recordTaskHandoff(db, {
      workspace: 'internal',
      runId: 'wf_packet',
      taskId: 'tk_parent',
      taskName: 'Parent task',
      attempt: 1,
      kind: 'summary',
      body: `Parent result ${secret}`,
    });
    const packet = recordTaskContextPacket(db, {
      workspace: 'internal',
      runId: 'wf_packet',
      taskId: 'tk_child',
      taskName: 'Child task',
      attempt: 2,
      dependsOn: ['tk_parent'],
      packet: {
        task: { id: 'tk_child', model: 'cx/gpt-5.4' },
        input_keys: ['objective', 'execution_context'],
        api_key: secret,
      },
    });

    const loadedPacket = loadContextPacketForAttempt(db, 'tk_child', 2);
    expect(loadedPacket?.id).toBe(packet.id);
    expect(loadedPacket?.included_handoffs_json).toContain(parent.id);
    expect(JSON.stringify({ loadedPacket, parent })).not.toContain(secret);
    expect(JSON.stringify({ loadedPacket, parent })).toContain('***');

    db.close();
  });
});
