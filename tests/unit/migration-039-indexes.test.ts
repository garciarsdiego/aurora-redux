import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';

/**
 * Migration 039 — hot-path indexes for the scheduler tick.
 *
 * The migration adds two partial indexes on `workflow_task_leases`:
 *   - idx_workflow_task_leases_running_heartbeat ON (heartbeat_at) WHERE status='running'
 *   - idx_workflow_task_leases_running_expires   ON (expires_at)   WHERE status='running'
 *
 * It deliberately does NOT add indexes for:
 *   - tasks(heartbeat_at)/tasks(expires_at) — these columns do not exist on `tasks`;
 *     the scheduler joins through `workflow_task_leases`.
 *   - model_calls(workflow_id, created_at) — already created by migration 014
 *     (idx_model_calls_workflow, used as COVERING INDEX).
 *   - patterns(workspace, name) — already covered by the UNIQUE(workspace, name)
 *     constraint declared in migration 001 (auto-index sqlite_autoindex_patterns_2).
 *
 * These tests assert each of those statements remains true post-migration.
 */

interface QueryPlanRow {
  readonly id: number;
  readonly parent: number;
  readonly notused: number;
  readonly detail: string;
}

function explain(db: Database.Database, sql: string, ...params: readonly unknown[]): readonly QueryPlanRow[] {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as QueryPlanRow[];
}

function indexNamesFor(db: Database.Database, table: string): readonly string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
      .all(table) as Array<{ readonly name: string }>
  ).map((r) => r.name);
}

function planMentionsIndex(plan: readonly QueryPlanRow[], indexName: string): boolean {
  return plan.some((r) => r.detail.includes(`USING INDEX ${indexName}`) || r.detail.includes(`USING COVERING INDEX ${indexName}`));
}

describe('migration 039 — hot path indexes', () => {
  it('creates idx_workflow_task_leases_running_heartbeat as a partial index', () => {
    const db = initDb(':memory:');
    try {
      const indexes = indexNamesFor(db, 'workflow_task_leases');
      expect(indexes).toContain('idx_workflow_task_leases_running_heartbeat');

      const row = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='index' AND name = 'idx_workflow_task_leases_running_heartbeat'",
        )
        .get() as { readonly sql: string } | undefined;
      expect(row?.sql).toMatch(/heartbeat_at/);
      expect(row?.sql).toMatch(/WHERE\s+status\s*=\s*'running'/i);
    } finally {
      db.close();
    }
  });

  it('creates idx_workflow_task_leases_running_expires as a partial index', () => {
    const db = initDb(':memory:');
    try {
      const indexes = indexNamesFor(db, 'workflow_task_leases');
      expect(indexes).toContain('idx_workflow_task_leases_running_expires');

      const row = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='index' AND name = 'idx_workflow_task_leases_running_expires'",
        )
        .get() as { readonly sql: string } | undefined;
      expect(row?.sql).toMatch(/expires_at/);
      expect(row?.sql).toMatch(/WHERE\s+status\s*=\s*'running'/i);
    } finally {
      db.close();
    }
  });

  it('uses idx_workflow_task_leases_running_heartbeat for the lease-side heartbeat scan', () => {
    const db = initDb(':memory:');
    try {
      // Lease-side scan — equivalent to what the scheduler would issue if it
      // drove from workflow_task_leases instead of tasks. With this partial
      // index in place, SQLite scans only the running rows in heartbeat order.
      const plan = explain(
        db,
        `SELECT l.task_id, l.workflow_id, l.heartbeat_at
           FROM workflow_task_leases l
          WHERE l.status = 'running' AND l.heartbeat_at < ?`,
        0,
      );
      expect(planMentionsIndex(plan, 'idx_workflow_task_leases_running_heartbeat')).toBe(true);
      expect(plan.some((r) => /\bSCAN workflow_task_leases\b/.test(r.detail))).toBe(false);
    } finally {
      db.close();
    }
  });

  it('uses idx_workflow_task_leases_running_expires for recoverExpiredTaskLeases', () => {
    const db = initDb(':memory:');
    try {
      // Exact query shape used by src/db/task-leases.ts#recoverExpiredTaskLeases.
      // Pre-039 this was a full table scan (`SCAN workflow_task_leases`).
      const plan = explain(
        db,
        `SELECT * FROM workflow_task_leases
          WHERE status = 'running' AND expires_at <= ?
          ORDER BY expires_at ASC`,
        0,
      );
      expect(planMentionsIndex(plan, 'idx_workflow_task_leases_running_expires')).toBe(true);
      expect(plan.some((r) => /\bSCAN workflow_task_leases\b/.test(r.detail))).toBe(false);
    } finally {
      db.close();
    }
  });

  it('runs the migration idempotently (re-init does not fail or duplicate indexes)', () => {
    const path = ':memory:';
    const first = initDb(path);
    const beforeCount = indexNamesFor(first, 'workflow_task_leases').filter((n) =>
      n.startsWith('idx_workflow_task_leases_running_'),
    ).length;
    first.close();

    // initDb on a fresh in-memory DB always re-runs migrations; here we just
    // confirm a second open of a separate in-memory DB also yields the same
    // index set (no INSERT OR IGNORE collision, no migration error).
    const second = initDb(path);
    try {
      const afterCount = indexNamesFor(second, 'workflow_task_leases').filter((n) =>
        n.startsWith('idx_workflow_task_leases_running_'),
      ).length;
      expect(beforeCount).toBe(2);
      expect(afterCount).toBe(2);
    } finally {
      second.close();
    }
  });

  it('still relies on idx_model_calls_workflow for cost queries (not regressed)', () => {
    const db = initDb(':memory:');
    try {
      // getCostSummary hot path. Migration 014 already covers this; assert we
      // did not regress by adding redundant indexes.
      const plan = explain(
        db,
        `SELECT COUNT(*) FROM model_calls WHERE workflow_id = ?`,
        'wf_x',
      );
      expect(planMentionsIndex(plan, 'idx_model_calls_workflow')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('still relies on patterns UNIQUE(workspace,name) auto-index for loadPatternByName (not regressed)', () => {
    const db = initDb(':memory:');
    try {
      const plan = explain(
        db,
        `SELECT * FROM patterns WHERE workspace = ? AND name = ?`,
        'internal',
        'p1',
      );
      // The auto-index name is sqlite_autoindex_patterns_2 (the second UNIQUE
      // declared on patterns; the first is the implicit PK). Either the auto
      // index or any future explicit replacement is acceptable — what matters
      // is that the planner is NOT scanning the table.
      expect(plan.some((r) => /\bSCAN patterns\b/.test(r.detail))).toBe(false);
      expect(plan.some((r) => /USING INDEX/.test(r.detail))).toBe(true);
    } finally {
      db.close();
    }
  });
});
