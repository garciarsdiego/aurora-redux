import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import type { WorkflowStatus } from '../../types/index.js';
import { VALID_WORKSPACE_RE } from '../../utils/workspace.js';

export const ListWorkflowsSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE, 'Invalid workspace name (alphanumeric/underscore/hyphen only)').optional(),
  status: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

interface WorkflowListRow {
  id: string;
  workspace: string;
  objective: string;
  status: WorkflowStatus;
  started_at: number | null;
  created_at: number;
  task_count: number;
}

export async function listWorkflowsTool(raw: unknown): Promise<string> {
  const { workspace, status, limit } = ListWorkflowsSchema.parse(raw);
  const db = initDb(getDbPath());
  try {
    // Filter out _daemon sentinel workflow (migration 046) — only used to
    // satisfy FK on events.workflow_id for daemon-level events; never visible
    // to operators in workflow listings.
    const conditions: string[] = ["w.id != '_daemon'"];
    const params: (string | number)[] = [];

    if (workspace) {
      conditions.push('w.workspace = ?');
      params.push(workspace);
    }
    if (status) {
      conditions.push('w.status = ?');
      params.push(status);
    }
    params.push(limit);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = db
      .prepare(
        `SELECT w.id, w.workspace, w.objective, w.status, w.started_at, w.created_at,
                COUNT(t.id) AS task_count
         FROM workflows w
         LEFT JOIN tasks t ON t.workflow_id = w.id
         ${where}
         GROUP BY w.id
         ORDER BY w.created_at DESC
         LIMIT ?`,
      )
      .all(...params) as WorkflowListRow[];

    return JSON.stringify(
      rows.map((r) => ({
        workflow_id: r.id,
        workspace: r.workspace,
        objective: r.objective,
        status: r.status,
        started_at: r.started_at,
        created_at: r.created_at,
        task_count: Number(r.task_count),
      })),
    );
  } finally {
    db.close();
  }
}
