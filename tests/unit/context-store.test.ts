import { describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import {
  createContextChannel,
  createContextMessage,
  createContextThread,
  listThreadsForRun,
  loadContextPacketForAttempt,
  loadThreadMessages,
  saveContextPacket,
  saveTaskHandoff,
} from '../../src/context/store.js';

describe('context orchestration store', () => {
  it('persists a run channel, task thread, and ordered messages', () => {
    const db = initDb(':memory:');
    const genericSecret = 'lov_real_value';

    const channel = createContextChannel(db, {
      workspace: 'internal',
      kind: 'run',
      name: 'run:wf_123',
      title: 'Workflow wf_123',
      runId: 'wf_123',
    });

    const thread = createContextThread(db, {
      channelId: channel.id,
      kind: 'task',
      title: 'Task tk_1',
      runId: 'wf_123',
      taskId: 'tk_1',
    });

    createContextMessage(db, {
      threadId: thread.id,
      senderType: 'system',
      senderId: 'workflow',
      kind: 'event',
      body: 'task started',
      metadata: { eventType: 'task_started' },
    });
    createContextMessage(db, {
      threadId: thread.id,
      senderType: 'reviewer',
      senderId: 'reviewer',
      kind: 'decision',
      body: 'accepted',
      metadata: { score: 1 },
    });

    const threads = listThreadsForRun(db, 'wf_123');
    expect(threads).toHaveLength(1);
    expect(threads[0]?.task_id).toBe('tk_1');

    const messages = loadThreadMessages(db, thread.id);
    expect(messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(messages[0]?.body).toBe('task started');
    expect(messages[1]?.metadata_json).toContain('"score":1');

    db.close();
  });

  it('persists redacted context packets and task handoffs', () => {
    const db = initDb(':memory:');
    const genericSecret = 'lov_real_value';
    const channel = createContextChannel(db, {
      workspace: 'internal',
      kind: 'run',
      name: 'run:wf_packet',
      title: 'Workflow wf_packet',
      runId: 'wf_packet',
    });
    const thread = createContextThread(db, {
      channelId: channel.id,
      kind: 'task',
      title: 'Task tk_packet',
      runId: 'wf_packet',
      taskId: 'tk_packet',
    });

    const packet = saveContextPacket(db, {
      runId: 'wf_packet',
      taskId: 'tk_packet',
      attempt: 1,
      threadId: thread.id,
      packet: { env: { OPENAI_API_KEY: 'sk-secret123456789' } },
      renderedPrompt: 'Authorization: Bearer abc.def.ghi',
      includedHandoffs: [{ handoffId: 'ho_1', taskId: 'tk_parent', chars: 12 }],
      excludedItems: [],
      tokenEstimate: 20,
      truncated: false,
    });
    const handoff = saveTaskHandoff(db, {
      runId: 'wf_packet',
      taskId: 'tk_packet',
      attempt: 1,
      threadId: thread.id,
      kind: 'summary',
      title: 'Handoff',
      body: JSON.stringify({
        api_key: genericSecret,
        message: 'Created file with token sk-secret123456789',
      }),
      artifacts: [],
      filesTouched: ['src/data/mock.ts'],
      decisions: [],
      safeContext: { password: genericSecret },
      tokenEstimate: 10,
      truncated: false,
    });

    expect(packet.packet_json).not.toContain('sk-secret');
    expect(packet.rendered_prompt).toContain('Bearer ***');
    expect(handoff.body).not.toContain('sk-secret');
    expect(handoff.body).not.toContain(genericSecret);
    expect(handoff.safe_context_json).not.toContain(genericSecret);
    expect(handoff.files_touched_json).toContain('src/data/mock.ts');

    db.close();
  });

  it('updates existing channels when ensure/create is called with fresher metadata', () => {
    const db = initDb(':memory:');
    createContextChannel(db, {
      workspace: 'internal',
      kind: 'run',
      name: 'run:wf_collision',
      title: 'Old title',
      runId: 'wf_old',
      metadata: { old: true },
    });

    const updated = createContextChannel(db, {
      workspace: 'internal',
      kind: 'run',
      name: 'run:wf_collision',
      title: 'New title',
      runId: 'wf_new',
      metadata: { fresh: true },
    });

    expect(updated.title).toBe('New title');
    expect(updated.run_id).toBe('wf_new');
    expect(updated.metadata_json).toContain('"fresh":true');

    db.close();
  });

  it('keeps context packet identity consistent when upserting the same task attempt', () => {
    const db = initDb(':memory:');
    const first = saveContextPacket(db, {
      runId: 'wf_first',
      taskId: 'tk_same',
      attempt: 1,
      packet: { version: 1 },
      renderedPrompt: 'first',
      includedHandoffs: [],
      excludedItems: [],
      tokenEstimate: 1,
      truncated: false,
    });
    const second = saveContextPacket(db, {
      runId: 'wf_first',
      taskId: 'tk_same',
      attempt: 1,
      packet: { version: 2 },
      renderedPrompt: 'second',
      includedHandoffs: [],
      excludedItems: [],
      tokenEstimate: 2,
      truncated: true,
    });

    expect(second.id).toBe(first.id);
    expect(second.run_id).toBe('wf_first');
    expect(second.packet_json).toContain('"version":2');
    expect(second.truncated).toBe(1);

    db.close();
  });

  it('keeps identical task attempt numbers isolated by workflow id', () => {
    const db = initDb(':memory:');
    const first = saveContextPacket(db, {
      runId: 'wf_first',
      taskId: 'tk_same',
      attempt: 1,
      packet: { run: 'first' },
      renderedPrompt: 'first',
      includedHandoffs: [],
      excludedItems: [],
      tokenEstimate: 1,
      truncated: false,
    });
    const second = saveContextPacket(db, {
      runId: 'wf_second',
      taskId: 'tk_same',
      attempt: 1,
      packet: { run: 'second' },
      renderedPrompt: 'second',
      includedHandoffs: [],
      excludedItems: [],
      tokenEstimate: 1,
      truncated: false,
    });

    expect(second.id).not.toBe(first.id);
    expect(loadContextPacketForAttempt(db, 'tk_same', 1, 'wf_first')?.id).toBe(first.id);
    expect(loadContextPacketForAttempt(db, 'tk_same', 1, 'wf_second')?.id).toBe(second.id);

    db.close();
  });
});
