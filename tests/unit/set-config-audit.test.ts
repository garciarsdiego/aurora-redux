// M1-W1-D — A5 — set_config emits a config_updated audit event with
// workflow_id='_daemon'. Verifies the row lands with the correct redacted
// payload shape so an adversary changing OMNIFORGE_MAX_PARALLEL_TASKS
// leaves a trace.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';

let tmpRoot: string;
let dbPath: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'omniforge-set-config-audit-'));
  process.chdir(tmpRoot);
  dbPath = path.join(tmpRoot, 'omniforge.db');
  // Pre-warm so migrations (incl. 046_daemon_sentinel_workflow) apply.
  const warm = initDb(dbPath);
  warm.close();
  // Pin the path config picks up — getDbPath() honours the env override.
  process.env.DB_PATH = dbPath;
});

afterEach(() => {
  delete process.env.DB_PATH;
  delete process.env.OMNIFORGE_MAX_PARALLEL_TASKS;
  delete process.env.TASK_MODEL;
  process.chdir(originalCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function countConfigUpdatedEvents(): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'config_updated' AND workflow_id = '_daemon'`)
      .get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

function loadLatestConfigUpdated(): Record<string, unknown> | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT payload_json FROM events
         WHERE type = 'config_updated' AND workflow_id = '_daemon'
         ORDER BY id DESC LIMIT 1`,
      )
      .get() as { payload_json: string | null } | undefined;
    if (!row?.payload_json) return null;
    return JSON.parse(row.payload_json) as Record<string, unknown>;
  } finally {
    db.close();
  }
}

describe('A5 — set_config audit event', () => {
  it('emits config_updated under _daemon sentinel when a numeric limit is changed', async () => {
    const { setConfigTool } = await import('../../src/mcp/tools/set_config.js');

    const before = countConfigUpdatedEvents();
    await setConfigTool({ key: 'OMNIFORGE_MAX_PARALLEL_TASKS', value: '3' });
    const after = countConfigUpdatedEvents();

    expect(after).toBe(before + 1);
  });

  it('payload includes key, redacted value placeholder, and actor=mcp_tool', async () => {
    const { setConfigTool } = await import('../../src/mcp/tools/set_config.js');

    await setConfigTool({ key: 'OMNIFORGE_MAX_PARALLEL_TASKS', value: '7' });
    const payload = loadLatestConfigUpdated();

    expect(payload).not.toBeNull();
    expect(payload!.key).toBe('OMNIFORGE_MAX_PARALLEL_TASKS');
    expect(payload!.value_set).toBe('<redacted>');
    expect(payload!.actor).toBe('mcp_tool');
  });

  it('never logs the raw value (defence-in-depth — even non-secret config keys)', async () => {
    const { setConfigTool } = await import('../../src/mcp/tools/set_config.js');

    await setConfigTool({ key: 'TASK_MODEL', value: 'claude/claude-sonnet-4-6' });

    const db = new Database(dbPath, { readonly: true });
    try {
      const allConfigEvents = db
        .prepare(`SELECT payload_json FROM events WHERE type = 'config_updated' AND workflow_id = '_daemon'`)
        .all() as { payload_json: string | null }[];
      for (const ev of allConfigEvents) {
        expect(ev.payload_json ?? '').not.toContain('claude/claude-sonnet-4-6');
      }
    } finally {
      db.close();
    }
  });

  it('multiple calls produce multiple distinct audit events', async () => {
    const { setConfigTool } = await import('../../src/mcp/tools/set_config.js');

    const initial = countConfigUpdatedEvents();
    await setConfigTool({ key: 'OMNIFORGE_MAX_PARALLEL_TASKS', value: '2' });
    await setConfigTool({ key: 'OMNIFORGE_MAX_PARALLEL_TASKS', value: '5' });
    await setConfigTool({ key: 'TASK_MODEL', value: 'claude/claude-sonnet-4-6' });

    expect(countConfigUpdatedEvents()).toBe(initial + 3);
  });
});
