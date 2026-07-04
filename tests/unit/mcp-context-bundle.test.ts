import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { getContextBundleTool } from '../../src/mcp/tools/get_context_bundle.js';

const tempDirs: string[] = [];

describe('omniforge_get_context_bundle MCP tool', () => {
  afterEach(() => {
    delete process.env.DB_PATH;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the sanitized context orchestration bundle for a workflow', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'omniforge-context-tool-'));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, 'omniforge.db');
    process.env.DB_PATH = dbPath;
    const db = initDb(dbPath);
    const now = Date.now();

    db.prepare(
      `INSERT INTO workflows
         (id, workspace, objective, status, started_at, completed_at, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('wf_ctx_tool', 'internal', 'Inspect context bundle', 'executing', now, null, now, 'test');
    db.prepare(
      `INSERT INTO tasks
         (id, workflow_id, name, kind, input_json, output_json, status, depends_on_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'tk_ctx_tool',
      'wf_ctx_tool',
      'Context task',
      'llm_call',
      JSON.stringify({ prompt: 'safe' }),
      null,
      'running',
      JSON.stringify([]),
      now + 1,
    );
    db.prepare(
      `INSERT INTO context_channels
         (id, workspace, kind, name, title, run_id, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('ch_ctx_tool', 'internal', 'run', 'run:wf_ctx_tool', 'Context tool channel', 'wf_ctx_tool', '{}', now, now);
    db.prepare(
      `INSERT INTO context_threads
         (id, channel_id, kind, title, run_id, task_id, status, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('th_ctx_tool', 'ch_ctx_tool', 'task', 'Context task thread', 'wf_ctx_tool', 'tk_ctx_tool', 'open', '{}', now, now);
    db.prepare(
      `INSERT INTO context_messages
         (id, thread_id, seq, sender_type, sender_id, kind, body, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('msg_ctx_tool', 'th_ctx_tool', 1, 'system', 'executor', 'event', 'Context packet captured.', '{}', now);
    db.prepare(
      `INSERT INTO context_packets
         (id, run_id, task_id, attempt, thread_id, packet_json, rendered_prompt,
          included_handoffs_json, excluded_items_json, token_estimate, truncated, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'pkt_ctx_tool',
      'wf_ctx_tool',
      'tk_ctx_tool',
      1,
      'th_ctx_tool',
      JSON.stringify({ api_key: 'lov_real_value', keep: 'visible' }),
      'api_key=lov_real_value',
      '[]',
      '[]',
      10,
      0,
      now,
    );
    db.close();

    const raw = await getContextBundleTool({ workflow_id: 'wf_ctx_tool' });
    const parsed = JSON.parse(raw) as {
      context_orchestration: {
        messages: Array<{ body: string }>;
        context_packets: Array<{ packet: { api_key: string; keep: string }; rendered_prompt: string }>;
      };
    };

    expect(parsed.context_orchestration.messages[0]?.body).toBe('Context packet captured.');
    expect(parsed.context_orchestration.context_packets[0]?.packet.api_key).toBe('***');
    expect(parsed.context_orchestration.context_packets[0]?.packet.keep).toBe('visible');
    expect(parsed.context_orchestration.context_packets[0]?.rendered_prompt).toContain('***');
  });
});
