/**
 * Tests for src/v2/observability/persona-metrics.ts (audit §13 P2 #18).
 *
 * Covers:
 *   - Empty DB → empty result (no agent events, no spans)
 *   - Single persona, multiple invocations → counts roll up correctly
 *   - Mixed personas → separate stats rows, sorted by activity
 *   - Rejection counts (agent_rejected events)
 *   - Short-circuit detection from agent_completed payload
 *   - Latency aggregation from trace_spans (avg + p95)
 *   - Cache-read tokens roll-up (B6.1 / N3 wire effectiveness signal)
 *   - getPersonaVsLegacyShare share calc
 *   - Filters: workflowId scope, sinceMs cutoff
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getPersonaMetrics,
  getPersonaVsLegacyShare,
} from '../../src/v2/observability/persona-metrics.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      status TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
    );
    CREATE TABLE tasks (id TEXT PRIMARY KEY, workflow_id TEXT, workspace TEXT, status TEXT);
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT,
      task_id TEXT,
      workspace TEXT,
      type TEXT NOT NULL,
      payload_json TEXT,
      timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
    );
    CREATE TABLE trace_spans (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      task_id TEXT,
      parent_span_id TEXT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      duration_ms INTEGER,
      attributes_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
  db.prepare('INSERT INTO workflows(id, workspace, status, created_at) VALUES (?,?,?,?)')
    .run('wf-1', 'internal', 'completed', Date.now());
  return db;
}

function emit(
  db: Database.Database,
  type: string,
  workflowId: string,
  payload: Record<string, unknown>,
  ts?: number,
): void {
  const sql = ts != null
    ? 'INSERT INTO events(workflow_id, type, payload_json, timestamp) VALUES (?,?,?,?)'
    : 'INSERT INTO events(workflow_id, type, payload_json) VALUES (?,?,?)';
  if (ts != null) {
    db.prepare(sql).run(workflowId, type, JSON.stringify(payload), ts);
  } else {
    db.prepare(sql).run(workflowId, type, JSON.stringify(payload));
  }
}

function emitSpan(
  db: Database.Database,
  workflowId: string,
  startedAt: number,
  endedAt: number | null,
  attributes: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO trace_spans(id, workflow_id, name, kind, status, started_at, ended_at, attributes_json)
     VALUES (?, ?, ?, 'llm_call', 'ok', ?, ?, ?)`,
  ).run(`span_${Math.random().toString(36).slice(2, 8)}`, workflowId, 'llm_call:cc/sonnet', startedAt, endedAt, JSON.stringify(attributes));
}

describe('getPersonaMetrics', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('returns empty array on a fresh DB', () => {
    expect(getPersonaMetrics(db)).toEqual([]);
  });

  it('counts started/completed for a single persona', () => {
    emit(db, 'agent_started', 'wf-1', { agent_id: 'decomposer' });
    emit(db, 'agent_completed', 'wf-1', { agent_id: 'decomposer' });
    emit(db, 'agent_started', 'wf-1', { agent_id: 'decomposer' });
    emit(db, 'agent_completed', 'wf-1', { agent_id: 'decomposer' });

    const stats = getPersonaMetrics(db);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      agent_id: 'decomposer',
      total_started: 2,
      total_completed: 2,
      total_rejected: 0,
    });
  });

  it('groups by agent_id and sorts by activity desc', () => {
    emit(db, 'agent_started', 'wf-1', { agent_id: 'reviewer' });
    emit(db, 'agent_completed', 'wf-1', { agent_id: 'reviewer' });
    emit(db, 'agent_started', 'wf-1', { agent_id: 'decomposer' });
    emit(db, 'agent_completed', 'wf-1', { agent_id: 'decomposer' });
    emit(db, 'agent_started', 'wf-1', { agent_id: 'decomposer' });
    emit(db, 'agent_completed', 'wf-1', { agent_id: 'decomposer' });
    emit(db, 'agent_started', 'wf-1', { agent_id: 'decomposer' });
    emit(db, 'agent_completed', 'wf-1', { agent_id: 'decomposer' });

    const stats = getPersonaMetrics(db);
    expect(stats).toHaveLength(2);
    expect(stats[0].agent_id).toBe('decomposer');   // 3 invocations → first
    expect(stats[1].agent_id).toBe('reviewer');     // 1 invocation → second
  });

  it('counts rejections', () => {
    emit(db, 'agent_started', 'wf-1', { agent_id: 'reviewer' });
    emit(db, 'agent_rejected', 'wf-1', { agent_id: 'reviewer', reason: 'too vague' });
    emit(db, 'agent_started', 'wf-1', { agent_id: 'reviewer' });
    emit(db, 'agent_completed', 'wf-1', { agent_id: 'reviewer' });

    const stats = getPersonaMetrics(db);
    expect(stats[0]).toMatchObject({
      agent_id: 'reviewer',
      total_started: 2,
      total_completed: 1,
      total_rejected: 1,
    });
  });

  it('detects short_circuited completions', () => {
    emit(db, 'agent_started', 'wf-1', { agent_id: 'consolidator' });
    emit(db, 'agent_completed', 'wf-1', { agent_id: 'consolidator', short_circuited: true });
    emit(db, 'agent_started', 'wf-1', { agent_id: 'consolidator' });
    emit(db, 'agent_completed', 'wf-1', { agent_id: 'consolidator' });

    const stats = getPersonaMetrics(db);
    expect(stats[0].total_short_circuited).toBe(1);
    expect(stats[0].total_completed).toBe(2);
  });

  it('aggregates latency from trace_spans (when scoped to a workflow)', () => {
    emit(db, 'agent_started', 'wf-1', { agent_id: 'decomposer' });
    emit(db, 'agent_completed', 'wf-1', { agent_id: 'decomposer' });
    emitSpan(db, 'wf-1', 1000, 1500, { model: 'cc/sonnet' });   // 500ms
    emitSpan(db, 'wf-1', 2000, 3500, { model: 'cc/sonnet' });   // 1500ms
    emitSpan(db, 'wf-1', 4000, 4100, { model: 'cc/sonnet' });   // 100ms

    const stats = getPersonaMetrics(db, { workflowId: 'wf-1' });
    expect(stats[0].avg_latency_ms).toBe(700);   // (500+1500+100)/3 = 700
    expect(stats[0].p95_latency_ms).toBe(1500);  // floor(3*0.95)=2 → idx=2 → 1500
  });

  it('rolls up cache_read_input_tokens (B6.1 wire effectiveness)', () => {
    emit(db, 'agent_started', 'wf-1', { agent_id: 'decomposer' });
    emit(db, 'agent_completed', 'wf-1', { agent_id: 'decomposer' });
    emitSpan(db, 'wf-1', 1000, 1500, { cache_read_input_tokens: 4500 });
    emitSpan(db, 'wf-1', 2000, 2500, { cache_read_input_tokens: 3200 });
    emitSpan(db, 'wf-1', 3000, 3500, { /* no cache fields */ });

    const stats = getPersonaMetrics(db, { workflowId: 'wf-1' });
    expect(stats[0].total_cache_read_tokens).toBe(7700);
  });

  it('returns null cache_read_tokens when no cache hits at all', () => {
    emit(db, 'agent_started', 'wf-1', { agent_id: 'decomposer' });
    emit(db, 'agent_completed', 'wf-1', { agent_id: 'decomposer' });
    emitSpan(db, 'wf-1', 1000, 1500, { /* no cache fields */ });

    const stats = getPersonaMetrics(db, { workflowId: 'wf-1' });
    expect(stats[0].total_cache_read_tokens).toBeNull();
  });

  it('respects workflowId filter', () => {
    db.prepare('INSERT INTO workflows(id, workspace, status, created_at) VALUES (?,?,?,?)')
      .run('wf-2', 'internal', 'completed', Date.now());

    emit(db, 'agent_started', 'wf-1', { agent_id: 'decomposer' });
    emit(db, 'agent_started', 'wf-2', { agent_id: 'decomposer' });
    emit(db, 'agent_started', 'wf-2', { agent_id: 'reviewer' });

    const wf1 = getPersonaMetrics(db, { workflowId: 'wf-1' });
    const wf2 = getPersonaMetrics(db, { workflowId: 'wf-2' });
    expect(wf1).toHaveLength(1);
    expect(wf1[0].agent_id).toBe('decomposer');
    expect(wf2).toHaveLength(2);
  });

  it('respects sinceMs cutoff', () => {
    const now = Date.now();
    emit(db, 'agent_started', 'wf-1', { agent_id: 'decomposer' }, now - 86_400_000); // 1 day old
    emit(db, 'agent_started', 'wf-1', { agent_id: 'decomposer' }, now);

    const recent = getPersonaMetrics(db, { sinceMs: now - 60_000 });
    expect(recent[0].total_started).toBe(1);
  });

  it('ignores events with malformed or missing agent_id', () => {
    emit(db, 'agent_started', 'wf-1', {} as Record<string, unknown>);                    // no agent_id
    emit(db, 'agent_started', 'wf-1', { agent_id: 42 } as unknown as Record<string, unknown>);  // wrong type
    emit(db, 'agent_started', 'wf-1', { agent_id: 'decomposer' });

    const stats = getPersonaMetrics(db);
    expect(stats).toHaveLength(1);
    expect(stats[0].total_started).toBe(1);
  });
});

describe('getPersonaVsLegacyShare', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('returns 0% when there are no workflows', () => {
    db.prepare('DELETE FROM workflows').run();
    const share = getPersonaVsLegacyShare(db);
    expect(share).toEqual({ workflows_total: 0, workflows_with_persona_path: 0, persona_path_share_pct: 0 });
  });

  it('returns 0% when workflows exist but none had persona events', () => {
    db.prepare('INSERT INTO workflows(id, workspace, status, created_at) VALUES (?,?,?,?)')
      .run('wf-2', 'internal', 'completed', Date.now());
    const share = getPersonaVsLegacyShare(db);
    expect(share.workflows_total).toBe(2);
    expect(share.workflows_with_persona_path).toBe(0);
    expect(share.persona_path_share_pct).toBe(0);
  });

  it('returns 100% when every workflow had persona events', () => {
    db.prepare('INSERT INTO workflows(id, workspace, status, created_at) VALUES (?,?,?,?)')
      .run('wf-2', 'internal', 'completed', Date.now());
    emit(db, 'agent_started', 'wf-1', { agent_id: 'decomposer' });
    emit(db, 'agent_started', 'wf-2', { agent_id: 'reviewer' });
    const share = getPersonaVsLegacyShare(db);
    expect(share.workflows_total).toBe(2);
    expect(share.workflows_with_persona_path).toBe(2);
    expect(share.persona_path_share_pct).toBe(100);
  });

  it('returns 50% on mixed adoption', () => {
    db.prepare('INSERT INTO workflows(id, workspace, status, created_at) VALUES (?,?,?,?)')
      .run('wf-2', 'internal', 'completed', Date.now());
    emit(db, 'agent_started', 'wf-1', { agent_id: 'decomposer' });
    // wf-2 has no agent events → legacy
    const share = getPersonaVsLegacyShare(db);
    expect(share.persona_path_share_pct).toBe(50);
  });

  it('respects sinceMs cutoff (excludes old workflows)', () => {
    const now = Date.now();
    db.prepare('UPDATE workflows SET created_at = ? WHERE id = ?').run(now - 86_400_000, 'wf-1');
    db.prepare('INSERT INTO workflows(id, workspace, status, created_at) VALUES (?,?,?,?)')
      .run('wf-2', 'internal', 'completed', now);
    emit(db, 'agent_started', 'wf-2', { agent_id: 'decomposer' });
    const share = getPersonaVsLegacyShare(db, now - 3_600_000);
    expect(share.workflows_total).toBe(1);  // wf-1 excluded
    expect(share.persona_path_share_pct).toBe(100);
  });
});
