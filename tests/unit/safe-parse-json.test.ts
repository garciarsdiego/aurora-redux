/**
 * Unit tests for `src/utils/safe-parse-json.ts` (M1-W1-B B9 — gap closure 2026-05-12).
 *
 * Covers:
 *   1. Happy path — valid JSON returns the parsed value typed as T.
 *   2. Empty input (null / undefined / '') returns null silently — no event.
 *   3. Malformed input returns null AND emits `task_input_json_malformed`
 *      with the audit shape { task_id, where, error, raw_length }.
 *   4. Missing context (no db / no workflowId) returns null without throwing
 *      — preserves the silent fallback for unit-test / REPL callers.
 *   5. The function NEVER throws, even when insertEvent itself fails
 *      (closed db handle, FK violation on a missing task row).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { safeParseJson } from '../../src/utils/safe-parse-json.js';

interface EventRow {
  type: string;
  payload_json: string;
  task_id: string | null;
}

function seedWorkflowWithTask(
  db: import('better-sqlite3').Database,
  workflowId: string,
  taskId: string,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO workflows (id, workspace, objective, status, started_at, created_at)
     VALUES (?, 'internal', 'safe-parse-json test', 'executing', ?, ?)`,
  ).run(workflowId, now, now);
  db.prepare(
    `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
     VALUES (?, ?, 'safe-parse test', 'llm_call', 'pending', ?)`,
  ).run(taskId, workflowId, now);
}

function eventsByType(
  db: import('better-sqlite3').Database,
  workflowId: string,
  type: string,
): EventRow[] {
  return db
    .prepare(
      `SELECT type, payload_json, task_id FROM events
       WHERE workflow_id = ? AND type = ?
       ORDER BY id ASC`,
    )
    .all(workflowId, type) as EventRow[];
}

describe('safeParseJson', () => {
  let db: import('better-sqlite3').Database;
  const workflowId = 'wf_safe_parse_json';
  const taskId = 'tk_safe_parse_json';

  beforeEach(() => {
    db = initDb(':memory:');
    seedWorkflowWithTask(db, workflowId, taskId);
  });

  it('returns the parsed value typed as T on valid input', () => {
    interface Shape { foo: string; bar: number }
    const result = safeParseJson<Shape>(
      JSON.stringify({ foo: 'hello', bar: 42 }),
      { db, workflowId, taskId, where: 'happy_path_test' },
    );
    expect(result).not.toBeNull();
    expect(result!.foo).toBe('hello');
    expect(result!.bar).toBe(42);

    // Happy path must NOT emit an audit event — that would be alarm noise.
    const events = eventsByType(db, workflowId, 'task_input_json_malformed');
    expect(events).toHaveLength(0);
  });

  it('returns null silently for null input', () => {
    const result = safeParseJson<Record<string, unknown>>(null, {
      db, workflowId, taskId, where: 'null_test',
    });
    expect(result).toBeNull();
    const events = eventsByType(db, workflowId, 'task_input_json_malformed');
    expect(events).toHaveLength(0);
  });

  it('returns null silently for undefined input', () => {
    const result = safeParseJson<Record<string, unknown>>(undefined, {
      db, workflowId, taskId, where: 'undefined_test',
    });
    expect(result).toBeNull();
    const events = eventsByType(db, workflowId, 'task_input_json_malformed');
    expect(events).toHaveLength(0);
  });

  it('returns null silently for empty-string input', () => {
    const result = safeParseJson<Record<string, unknown>>('', {
      db, workflowId, taskId, where: 'empty_string_test',
    });
    expect(result).toBeNull();
    const events = eventsByType(db, workflowId, 'task_input_json_malformed');
    expect(events).toHaveLength(0);
  });

  it('returns null AND emits task_input_json_malformed on malformed input', () => {
    const malformed = '{not-valid-json,,,';
    const result = safeParseJson<Record<string, unknown>>(malformed, {
      db, workflowId, taskId, where: 'malformed_test',
    });
    expect(result).toBeNull();

    const events = eventsByType(db, workflowId, 'task_input_json_malformed');
    expect(events).toHaveLength(1);

    const payload = JSON.parse(events[0]!.payload_json) as {
      task_id: string | null;
      where: string;
      error: string;
      raw_length: number;
    };
    expect(payload.task_id).toBe(taskId);
    expect(payload.where).toBe('malformed_test');
    expect(typeof payload.error).toBe('string');
    expect(payload.error.length).toBeGreaterThan(0);
    expect(payload.raw_length).toBe(malformed.length);
    expect(events[0]!.task_id).toBe(taskId);
  });

  it('does NOT include the raw input in the audit event (PII safety)', () => {
    // The raw string might contain operator-pasted secrets — the event must
    // only ship length + parser error.
    const secret = '{"api_key":"sk-DO-NOT-LEAK-' + 'x'.repeat(40) + '"}';
    // Make it malformed by chopping the last brace.
    const malformed = secret.slice(0, -1);
    safeParseJson<unknown>(malformed, {
      db, workflowId, taskId, where: 'pii_safety_test',
    });

    const events = eventsByType(db, workflowId, 'task_input_json_malformed');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload_json).not.toContain('sk-DO-NOT-LEAK');
  });

  it('does NOT emit an event when db is missing (silent null fallback)', () => {
    const result = safeParseJson<Record<string, unknown>>(
      '{still bad json',
      { where: 'no_db_test', taskId },
    );
    expect(result).toBeNull();
    // No db means no audit row; cannot assert event absence on a different
    // db but the function must not throw — that's the contract.
  });

  it('does NOT emit an event when workflowId is missing', () => {
    const result = safeParseJson<Record<string, unknown>>(
      '{still bad json',
      { db, where: 'no_wfid_test', taskId },
    );
    expect(result).toBeNull();
    // The function bails before insertEvent — no row should exist.
    const events = db.prepare("SELECT * FROM events WHERE type = 'task_input_json_malformed'").all();
    expect(events).toHaveLength(0);
  });

  it('NEVER throws even when insertEvent would fail (closed db)', () => {
    db.close();
    // db is closed — insertEvent will throw internally; the helper must
    // swallow that and still return null.
    expect(() =>
      safeParseJson<unknown>('{broken', {
        db, workflowId, taskId, where: 'closed_db_test',
      }),
    ).not.toThrow();
  });

  it('parses different JSON shapes (object / array / primitive)', () => {
    const obj = safeParseJson<{ a: number }>(JSON.stringify({ a: 1 }), {
      db, workflowId, taskId, where: 'shape_obj',
    });
    expect(obj).toEqual({ a: 1 });

    const arr = safeParseJson<number[]>(JSON.stringify([1, 2, 3]), {
      db, workflowId, taskId, where: 'shape_arr',
    });
    expect(arr).toEqual([1, 2, 3]);

    const str = safeParseJson<string>(JSON.stringify('hello'), {
      db, workflowId, taskId, where: 'shape_str',
    });
    expect(str).toBe('hello');
  });

  it('emits a fresh event for each malformed parse (no de-dup)', () => {
    safeParseJson<unknown>('{a:1', { db, workflowId, taskId, where: 'first' });
    safeParseJson<unknown>('{b:2', { db, workflowId, taskId, where: 'second' });
    safeParseJson<unknown>('{c:3', { db, workflowId, taskId, where: 'third' });

    const events = eventsByType(db, workflowId, 'task_input_json_malformed');
    expect(events).toHaveLength(3);

    const wheres = events.map((e) => {
      const p = JSON.parse(e.payload_json) as { where: string };
      return p.where;
    });
    expect(wheres).toEqual(['first', 'second', 'third']);
  });
});
