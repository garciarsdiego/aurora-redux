import { describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { buildDashboardSnapshot } from '../../src/mcp/dashboard-data.js';
import {
  acknowledgeDashboardWorkflowAlert,
  patchDashboardWorkflowState,
} from '../../src/mcp/dashboard-run-ops.js';

describe('dashboard run lifecycle ops', () => {
  it('renames, archives, soft-deletes, and restores workflow cards', () => {
    const db = initDb(':memory:');
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO workflows
           (id, workspace, objective, pattern_id, status, started_at, completed_at, created_at,
            created_by, estimated_cost_usd, actual_cost_usd, metadata)
         VALUES ('wf_life', 'internal', 'Nome original', NULL, 'completed', ?, ?, ?, NULL, NULL, NULL, NULL)`,
      ).run(now - 1000, now, now - 2000);

      const renamed = patchDashboardWorkflowState(db, 'wf_life', {
        display_name: 'Nome amigável',
        archived: true,
      });
      expect(renamed.workflow.display_name).toBe('Nome amigável');
      expect(renamed.workflow.archived_at).toEqual(expect.any(Number));

      let snapshot = buildDashboardSnapshot(db, { workspace: 'internal', limit: 10 });
      expect(snapshot.workflows[0]).toMatchObject({
        id: 'wf_life',
        objective: 'Nome original',
        display_name: 'Nome amigável',
        archived_at: expect.any(Number),
      });

      patchDashboardWorkflowState(db, 'wf_life', { deleted: true });
      snapshot = buildDashboardSnapshot(db, { workspace: 'internal', limit: 10 });
      expect(snapshot.workflows.map((workflow) => workflow.id)).toEqual([]);

      patchDashboardWorkflowState(db, 'wf_life', { deleted: false, archived: false });
      snapshot = buildDashboardSnapshot(db, { workspace: 'internal', limit: 10 });
      expect(snapshot.workflows[0]).toMatchObject({
        id: 'wf_life',
        archived_at: null,
      });
    } finally {
      db.close();
    }
  });

  it('dismisses current workflow error alerts without hiding future errors', () => {
    const db = initDb(':memory:');
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO workflows
           (id, workspace, objective, pattern_id, status, started_at, completed_at, created_at,
            created_by, estimated_cost_usd, actual_cost_usd, metadata)
         VALUES ('wf_alert', 'internal', 'Falha antiga', NULL, 'failed', ?, ?, ?, NULL, NULL, NULL, NULL)`,
      ).run(now - 1000, now, now - 2000);
      db.prepare(
        `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
         VALUES ('wf_alert', NULL, 'workflow_background_error', '{"error":"provider timeout"}', ?)`,
      ).run(now - 900);

      const before = buildDashboardSnapshot(db, { workspace: 'internal', limit: 10 });
      const firstError = before.workflows[0]?.latest_error;
      expect(firstError).toMatchObject({ message: 'provider timeout' });

      acknowledgeDashboardWorkflowAlert(db, 'wf_alert', { event_id: firstError?.event_id });
      const dismissed = buildDashboardSnapshot(db, { workspace: 'internal', limit: 10 });
      expect(dismissed.workflows[0]?.latest_error).toBeNull();

      db.prepare(
        `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
         VALUES ('wf_alert', NULL, 'workflow_background_error', '{"error":"new provider error"}', ?)`,
      ).run(now - 100);
      const after = buildDashboardSnapshot(db, { workspace: 'internal', limit: 10 });
      expect(after.workflows[0]?.latest_error).toMatchObject({ message: 'new provider error' });
    } finally {
      db.close();
    }
  });
});
