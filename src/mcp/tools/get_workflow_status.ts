import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { loadWorkflowById, loadWorkflowTasks } from '../../db/persist.js';
import { getDbPath } from '../../utils/config.js';

export const GetWorkflowStatusSchema = z.object({
  workflow_id: z.string().min(1),
});

interface EventRow {
  type: string;
  task_id: string | null;
  timestamp: number;
}

/** Parses persisted JSON; returns the raw string when it is not valid JSON. */
function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function getWorkflowStatusTool(raw: unknown): Promise<string> {
  const { workflow_id } = GetWorkflowStatusSchema.parse(raw);
  const db = initDb(getDbPath());
  try {
    const workflow = loadWorkflowById(db, workflow_id);
    if (!workflow) {
      return JSON.stringify({ error: `Workflow not found: ${workflow_id}` });
    }

    const tasks = loadWorkflowTasks(db, workflow_id);

    const recentEvents = db
      .prepare(
        `SELECT type, task_id, timestamp
         FROM events
         WHERE workflow_id = ?
         ORDER BY timestamp DESC
         LIMIT 10`,
      )
      .all(workflow_id) as EventRow[];

    return JSON.stringify({
      workflow_id: workflow.id,
      status: workflow.status,
      workspace: workflow.workspace,
      objective: workflow.objective,
      started_at: workflow.started_at,
      completed_at: workflow.completed_at,
      task_count: tasks.length,
      tasks: tasks.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        kind: t.kind,
        output: t.output_json ? tryParseJson(t.output_json) : null,
      })),
      recent_events: recentEvents.map((e) => ({
        type: e.type,
        task_id: e.task_id ?? null,
        ts: e.timestamp,
      })),
    });
  } finally {
    db.close();
  }
}
