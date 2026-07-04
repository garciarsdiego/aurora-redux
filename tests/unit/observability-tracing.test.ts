/**
 * Tests for src/v2/observability/tracing.ts (audit §3 gap "v2/observability
 * sem teste"). Generated via Omniroute (cx/gpt-5.5-medium) and adapted for
 * the project conventions: TS path-with-.js suffix, valid TraceSpanKind
 * values, endTraceSpan returns void (re-query the DB to assert post-state).
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  endTraceSpan,
  exportTraceSpans,
  spanContextStorage,
  startTraceSpan,
  type TraceSpanRow,
} from '../../src/v2/observability/tracing.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  // FKs intentionally omitted — keeps the test schema self-contained.
  db.exec(`
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
  return db;
}

function fetchRow(db: Database.Database, id: string): TraceSpanRow | undefined {
  return db
    .prepare('SELECT * FROM trace_spans WHERE id = $id')
    .get({ id }) as TraceSpanRow | undefined;
}

describe('tracing — startTraceSpan', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('creates a span row with all input fields persisted', () => {
    const span = startTraceSpan(db, {
      workflowId: 'wf_1',
      taskId: 'tk_1',
      parentSpanId: 'sp_parent',
      name: 'review',
      kind: 'review',
      attributes: { attempt: 1, queue: 'default' },
      now: 1_700_000_000_000,
    });

    expect(span).toEqual({
      id: expect.stringMatching(/^sp_[0-9a-f-]{36}$/i),
      workflow_id: 'wf_1',
      task_id: 'tk_1',
      parent_span_id: 'sp_parent',
      name: 'review',
      kind: 'review',
      status: 'running',
      started_at: 1_700_000_000_000,
      ended_at: null,
      duration_ms: null,
      attributes_json: JSON.stringify({ attempt: 1, queue: 'default' }),
    });
  });

  it('uses Date.now() and {} attributes when defaults are omitted', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123_456);
    const span = startTraceSpan(db, {
      workflowId: 'wf_defaults',
      name: 'no-defaults',
      kind: 'custom',
    });
    expect(span.started_at).toBe(123_456);
    expect(span.attributes_json).toBe('{}');
    expect(span.task_id).toBeNull();
    expect(span.parent_span_id).toBeNull();
    expect(span.status).toBe('running');
    expect(span.ended_at).toBeNull();
    expect(span.duration_ms).toBeNull();
  });

  it('generates unique ids on multiple calls', () => {
    const a = startTraceSpan(db, { workflowId: 'wf', name: 'a', kind: 'custom', now: 100 });
    const b = startTraceSpan(db, { workflowId: 'wf', name: 'b', kind: 'custom', now: 101 });
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^sp_[0-9a-f-]{36}$/i);
    expect(b.id).toMatch(/^sp_[0-9a-f-]{36}$/i);
  });
});

describe('tracing — endTraceSpan', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('marks status, sets ended_at + duration_ms, and merges attributes', () => {
    const span = startTraceSpan(db, {
      workflowId: 'wf_end',
      name: 'merging span',
      kind: 'task',
      attributes: { existing: true, overwritten: 'old' },
      now: 1_000,
    });
    endTraceSpan(db, span.id, {
      status: 'ok',
      attributes: { overwritten: 'new', added: 42 },
      now: 1_250,
    });
    const row = fetchRow(db, span.id)!;
    expect(row.status).toBe('ok');
    expect(row.ended_at).toBe(1_250);
    expect(row.duration_ms).toBe(250);
    expect(JSON.parse(row.attributes_json)).toEqual({
      existing: true,
      overwritten: 'new',
      added: 42,
    });
  });

  it('silently no-ops on a non-existent span id', () => {
    expect(() => endTraceSpan(db, 'sp_missing', { status: 'error', now: 999 })).not.toThrow();
    const count = db.prepare('SELECT COUNT(*) AS n FROM trace_spans').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('clamps duration_ms to >= 0 on clock skew (now < started_at)', () => {
    const span = startTraceSpan(db, {
      workflowId: 'wf_skew',
      name: 'clock skew',
      kind: 'custom',
      now: 2_000,
    });
    endTraceSpan(db, span.id, { status: 'error', now: 1_500 });
    const row = fetchRow(db, span.id)!;
    expect(row.ended_at).toBe(1_500);
    expect(row.duration_ms).toBe(0);
  });

  it('tolerates corrupt existing attributes_json (falls back to {})', () => {
    const span = startTraceSpan(db, {
      workflowId: 'wf_corrupt',
      name: 'corrupt attrs',
      kind: 'task',
      attributes: { original: true },
      now: 100,
    });
    db.prepare('UPDATE trace_spans SET attributes_json = $j WHERE id = $id')
      .run({ id: span.id, j: '{not valid json' });
    endTraceSpan(db, span.id, {
      status: 'ok',
      attributes: { recovered: true },
      now: 150,
    });
    const row = fetchRow(db, span.id)!;
    expect(row.status).toBe('ok');
    expect(row.duration_ms).toBe(50);
    // existing was unparseable → merge starts from {} → only the new attr survives
    expect(JSON.parse(row.attributes_json)).toEqual({ recovered: true });
  });
});

describe('tracing — exportTraceSpans', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('returns [] for a workflow with no spans', () => {
    expect(exportTraceSpans(db, 'wf_empty')).toEqual([]);
  });

  it('orders by started_at ASC with attributes parsed and attributes_json omitted', () => {
    const later = startTraceSpan(db, { workflowId: 'wf', name: 'later', kind: 'task', attributes: { order: 2 }, now: 200 });
    const earlier = startTraceSpan(db, { workflowId: 'wf', name: 'earlier', kind: 'custom', attributes: { order: 1, nested: { ok: true } }, now: 100 });
    endTraceSpan(db, earlier.id, { status: 'ok', attributes: { finished: true }, now: 150 });

    const exported = exportTraceSpans(db, 'wf');
    expect(exported.map((s) => s.id)).toEqual([earlier.id, later.id]);
    expect(exported[0]).toEqual({
      id: earlier.id,
      workflow_id: 'wf',
      task_id: null,
      parent_span_id: null,
      name: 'earlier',
      kind: 'custom',
      status: 'ok',
      started_at: 100,
      ended_at: 150,
      duration_ms: 50,
      attributes: { order: 1, nested: { ok: true }, finished: true },
    });
    expect(exported[1].attributes).toEqual({ order: 2 });
    expect(exported[0]).not.toHaveProperty('attributes_json');
    expect(exported[1]).not.toHaveProperty('attributes_json');
  });

  it('isolates spans by workflow_id', () => {
    const included = startTraceSpan(db, { workflowId: 'wf_a', name: 'a', kind: 'task', now: 100 });
    startTraceSpan(db, { workflowId: 'wf_b', name: 'b', kind: 'task', now: 50 });
    const exported = exportTraceSpans(db, 'wf_a');
    expect(exported).toHaveLength(1);
    expect(exported[0].id).toBe(included.id);
  });

  it('tolerates corrupt attributes_json on a single row (returns {} for it)', () => {
    const corrupt = startTraceSpan(db, { workflowId: 'wf_x', name: 'corrupt', kind: 'custom', attributes: { will: 'corrupt' }, now: 100 });
    const ok = startTraceSpan(db, { workflowId: 'wf_x', name: 'ok', kind: 'custom', attributes: { fine: true }, now: 200 });
    db.prepare('UPDATE trace_spans SET attributes_json = $j WHERE id = $id')
      .run({ id: corrupt.id, j: '[not json' });

    const exported = exportTraceSpans(db, 'wf_x');
    expect(exported).toHaveLength(2);
    expect(exported.find((s) => s.id === corrupt.id)?.attributes).toEqual({});
    expect(exported.find((s) => s.id === ok.id)?.attributes).toEqual({ fine: true });
  });
});

describe('tracing — spanContextStorage (AsyncLocalStorage)', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('exposes context inside run() callback and clears it outside', () => {
    expect(spanContextStorage.getStore()).toBeUndefined();
    spanContextStorage.run(
      { db, parentSpanId: 'sp_parent', workflowId: 'wf_ctx' },
      () => {
        expect(spanContextStorage.getStore()).toEqual({
          db,
          parentSpanId: 'sp_parent',
          workflowId: 'wf_ctx',
        });
      },
    );
    expect(spanContextStorage.getStore()).toBeUndefined();
  });

  it('preserves context across await boundaries inside run()', async () => {
    await spanContextStorage.run({ db, parentSpanId: null }, async () => {
      const before = spanContextStorage.getStore();
      await Promise.resolve();
      const after = spanContextStorage.getStore();
      expect(after).toBe(before);
    });
  });
});
