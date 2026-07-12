// FASE 1B Bloco A.1 — Orphan detection and recovery.
//
// A subagent run is considered orphaned when it is 'pending' or 'running' and
// its reference timestamp (started_at ?? created_at) is older than
// ORPHAN_CEILING_MS. This means the process that was driving it crashed or was
// killed without updating the row to a terminal state.
//
// All read+write pairs use db.transaction() for atomicity. In practice
// Omniforge is single-process but the transaction guard makes the intent
// explicit and prevents partial states during test parallelism.
//
// Constraints:
//   - No imports from registry.ts / spawn.ts / outbox.ts / inbox.ts.
//   - insertEvent from src/db/persist.ts is the only persist helper needed.
//   - All SQL parameterized.

import type Database from 'better-sqlite3';
import { insertEvent } from '../../db/persist.js';
import { withSqliteRetrySync } from '../../db/sqlite-retry.js';
import { cancelPendingForTask } from './outbox.js';
import { dequeueFor } from './inbox.js';
import { ORPHAN_CEILING_MS } from './types.js';

// ─── Public types ──────────────────────────────────────────────────────────

export interface OrphanRunSummary {
  run_id: string;
  task_id: string;
  workflow_id: string;
  status: 'pending' | 'running';
  age_ms: number;
}

// ─── Internal row shape from DB ────────────────────────────────────────────

interface SubagentRunQueryRow {
  run_id: string;
  task_id: string;
  workflow_id: string;
  status: string;
  started_at: number | null;
  created_at: number;
}

// ─── findOrphans ───────────────────────────────────────────────────────────

export function findOrphans(
  db: Database.Database,
  workflowId?: string,
): OrphanRunSummary[] {
  const cutoff = Date.now() - ORPHAN_CEILING_MS;

  // Same predicate either way — only the optional workflow_id scoping
  // fragment and its param differ, kept in sync by construction instead of
  // two independently-maintained SQL strings.
  const workflowFilter = workflowId !== undefined ? 'workflow_id = ? AND ' : '';
  const params = workflowId !== undefined ? [workflowId, cutoff] : [cutoff];

  const rows = db
    .prepare(
      `SELECT run_id, task_id, workflow_id, status, started_at, created_at
       FROM subagent_runs
       WHERE ${workflowFilter}status IN ('pending', 'running')
         AND COALESCE(started_at, created_at) < ?`,
    )
    .all(...params) as SubagentRunQueryRow[];

  const now = Date.now();

  return rows.map((r) => ({
    run_id: r.run_id,
    task_id: r.task_id,
    workflow_id: r.workflow_id,
    status: r.status as 'pending' | 'running',
    age_ms: now - (r.started_at ?? r.created_at),
  }));
}

// ─── recoverOrphan ─────────────────────────────────────────────────────────

export function recoverOrphan(
  db: Database.Database,
  runId: string,
  action: 'restart' | 'fail',
): boolean {
  const tx = db.transaction((): boolean => {
    type CheckRow = {
      run_id: string;
      task_id: string;
      workflow_id: string;
      status: string;
    };

    const row = db
      .prepare(
        `SELECT run_id, task_id, workflow_id, status
         FROM subagent_runs
         WHERE run_id = ?`,
      )
      .get(runId) as CheckRow | undefined;

    if (row === undefined) return false;

    // Race-safe: if the row already reached a terminal state between
    // findOrphans and recoverOrphan, treat as skipped.
    const nonTerminal = new Set(['pending', 'running']);
    if (!nonTerminal.has(row.status)) return false;

    const now = Date.now();

    if (action === 'restart') {
      db.prepare(
        `UPDATE subagent_runs
           SET status = 'pending', started_at = NULL
         WHERE run_id = ?`,
      ).run(runId);

      // Sprint 3.6 (D-H2.066, F-REL-4): drain stale mailbox before re-spawn.
      // Without this, the restarted subagent inherits messages from the
      // failed prior attempt — duplicate announcements, ghost replies to
      // prompts that are gone, and possibly stale steer instructions. The
      // drain mirrors `kill()` semantics in control.ts (R-HIGH-4).
      const cancelled = cancelPendingForTask(db, row.task_id);
      const dequeued = dequeueFor(db, row.task_id, row.workflow_id);

      insertEvent(db, {
        workflow_id: row.workflow_id,
        task_id: row.task_id,
        type: 'subagent_orphan_restarted',
        payload: {
          run_id: runId,
          mailbox_drained: { outbox_cancelled: cancelled, inbox_dequeued: dequeued.length },
        },
      });
    } else {
      db.prepare(
        `UPDATE subagent_runs
           SET status = 'error', error_msg = 'orphaned-on-restart', ended_at = ?
         WHERE run_id = ?`,
      ).run(now, runId);

      insertEvent(db, {
        workflow_id: row.workflow_id,
        task_id: row.task_id,
        type: 'subagent_orphan_failed',
        payload: { run_id: runId, reason: 'orphaned-on-restart' },
      });
    }

    return true;
  });
  return withSqliteRetrySync(() => tx());
}

// ─── sweepOrphans ──────────────────────────────────────────────────────────

export function sweepOrphans(
  db: Database.Database,
  policy: 'restart' | 'fail',
  workflowId?: string,
): { found: number; recovered: number; skipped: number } {
  const orphans = findOrphans(db, workflowId);
  const found = orphans.length;
  let recovered = 0;
  let skipped = 0;

  for (const orphan of orphans) {
    const changed = recoverOrphan(db, orphan.run_id, policy);
    if (changed) {
      recovered++;
    } else {
      skipped++;
    }
  }

  return { found, recovered, skipped };
}
