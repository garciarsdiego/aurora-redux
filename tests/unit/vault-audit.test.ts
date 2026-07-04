// M1-W1-D — A10 — Vault.write/delete emit audit events when auditCtx is
// passed; remain silent when not. Verifies the payload only contains
// length (not content) so secrets in vault content cannot leak via audit.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initDb } from '../../src/db/client.js';
import {
  insertWorkflow,
  newWorkflowId,
} from '../../src/db/persist.js';
import type { Workflow } from '../../src/types/index.js';
import { Vault } from '../../src/v2/vault/store.js';
import type Database from 'better-sqlite3';

let tmpRoot: string;
let vault: Vault;
let db: Database.Database;
let testWfId: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'omniforge-vault-audit-'));
  vault = new Vault(path.join(tmpRoot, 'vault'));
  db = initDb(path.join(tmpRoot, 'omniforge.db'));

  // Provide a non-sentinel workflow id so we can test workflowId-bound audit.
  testWfId = newWorkflowId();
  const now = Date.now();
  const wf: Workflow = {
    id: testWfId,
    workspace: 'internal',
    objective: '[test] vault audit',
    pattern_id: null,
    status: 'executing',
    started_at: now,
    completed_at: null,
    created_at: now,
    created_by: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: null,
    max_duration_seconds: null,
    metadata: null,
  };
  insertWorkflow(db, wf);
});

afterEach(() => {
  db.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function countEventsByType(type: string, workflowId?: string): number {
  const stmt = workflowId
    ? db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = ? AND workflow_id = ?`)
    : db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = ?`);
  const row = workflowId ? (stmt.get(type, workflowId) as { n: number }) : (stmt.get(type) as { n: number });
  return row.n;
}

function loadLatestEventByType(type: string): Record<string, unknown> | null {
  const row = db
    .prepare(`SELECT payload_json FROM events WHERE type = ? ORDER BY id DESC LIMIT 1`)
    .get(type) as { payload_json: string | null } | undefined;
  if (!row?.payload_json) return null;
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}

describe('A10 — Vault audit (write)', () => {
  it('emits vault_write_audited when auditCtx is passed', async () => {
    const before = countEventsByType('vault_write_audited');
    await vault.write('ws1', 'notes/secret.txt', 'top secret payload', {
      db,
      workflowId: testWfId,
    });
    const after = countEventsByType('vault_write_audited');
    expect(after).toBe(before + 1);
  });

  it('does NOT emit when auditCtx is omitted (operator-driven path stays quiet)', async () => {
    const before = countEventsByType('vault_write_audited');
    await vault.write('ws1', 'plain.txt', 'no audit needed');
    const after = countEventsByType('vault_write_audited');
    expect(after).toBe(before);
  });

  it('payload contains workspace + path + content_length but NEVER the content', async () => {
    const secret = 'OPENAI_API_KEY=sk-this-must-not-leak-to-audit-row';
    await vault.write('ws1', 'env.txt', secret, { db, workflowId: testWfId });

    const payload = loadLatestEventByType('vault_write_audited');
    expect(payload).not.toBeNull();
    expect(payload!.workspace).toBe('ws1');
    expect(payload!.path).toBe('env.txt');
    expect(payload!.content_length).toBe(Buffer.byteLength(secret, 'utf8'));
    // The raw secret must not appear anywhere in the payload.
    expect(JSON.stringify(payload)).not.toContain('sk-this-must-not-leak-to-audit-row');
  });

  it('binds to the supplied workflow_id when provided', async () => {
    await vault.write('ws1', 'a.txt', 'hello', { db, workflowId: testWfId });
    const n = countEventsByType('vault_write_audited', testWfId);
    expect(n).toBeGreaterThan(0);
  });

  it('falls back to _daemon sentinel when no workflowId is supplied', async () => {
    await vault.write('ws1', 'b.txt', 'hello', { db });
    const n = countEventsByType('vault_write_audited', '_daemon');
    expect(n).toBeGreaterThan(0);
  });
});

describe('A10 — Vault audit (delete)', () => {
  it('emits vault_delete_audited when auditCtx is passed', async () => {
    await vault.write('ws1', 'will-be-deleted.txt', 'content');
    const before = countEventsByType('vault_delete_audited');
    await vault.delete('ws1', 'will-be-deleted.txt', { db, workflowId: testWfId });
    const after = countEventsByType('vault_delete_audited');
    expect(after).toBe(before + 1);
  });

  it('does NOT emit when auditCtx is omitted', async () => {
    await vault.write('ws1', 'quiet.txt', 'bye');
    const before = countEventsByType('vault_delete_audited');
    await vault.delete('ws1', 'quiet.txt');
    const after = countEventsByType('vault_delete_audited');
    expect(after).toBe(before);
  });

  it('records the content length captured at delete-time', async () => {
    const content = 'short';
    await vault.write('ws1', 'short.txt', content);
    await vault.delete('ws1', 'short.txt', { db, workflowId: testWfId });

    const payload = loadLatestEventByType('vault_delete_audited');
    expect(payload).not.toBeNull();
    expect(payload!.path).toBe('short.txt');
    expect(payload!.content_length).toBe(Buffer.byteLength(content, 'utf8'));
  });
});
