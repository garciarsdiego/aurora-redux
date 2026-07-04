import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { recordTaskHandoff } from '../../context/workflow-adapter.js';
import { insertEvent } from '../../db/persist.js';
import { redactContextJson } from '../../context/redaction.js';

const PostTaskHandoffSchema = z.object({
  workflow_id: z.string().min(1),
  task_id: z.string().min(1),
  attempt: z.number().int().min(1).optional().default(1),
  kind: z.enum(['summary', 'artifact', 'diff', 'decision', 'error', 'instruction', 'mixed']).optional().default('summary'),
  title: z.string().min(1).optional(),
  body: z.string().min(1),
  artifacts: z.array(z.string()).optional().default([]),
  files_touched: z.array(z.string()).optional().default([]),
  decisions: z.array(z.string()).optional().default([]),
  safe_context: z.record(z.string(), z.unknown()).optional().default({}),
});

export async function postTaskHandoffTool(raw: unknown): Promise<string> {
  const input = PostTaskHandoffSchema.parse(raw);
  const db = initDb(getDbPath());
  try {
    const workflow = db.prepare(`SELECT * FROM workflows WHERE id = ?`).get(input.workflow_id) as Record<string, unknown> | undefined;
    if (!workflow) throw new Error(`Workflow not found: ${input.workflow_id}`);
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ? AND workflow_id = ?`).get(input.task_id, input.workflow_id) as Record<string, unknown> | undefined;
    if (!task) throw new Error(`Task not found in workflow: ${input.task_id}`);

    const handoff = recordTaskHandoff(db, {
      workspace: String(workflow['workspace']),
      runId: input.workflow_id,
      taskId: input.task_id,
      taskName: String(task['name'] ?? input.task_id),
      attempt: input.attempt,
      kind: input.kind,
      title: input.title,
      body: input.body,
      artifacts: input.artifacts,
      filesTouched: input.files_touched,
      decisions: input.decisions,
      safeContext: input.safe_context,
      metadata: {
        source: 'mcp_tool',
        tool: 'omniforge_post_task_handoff',
      },
    });
    insertEvent(db, {
      workflow_id: input.workflow_id,
      task_id: input.task_id,
      type: 'mcp_task_handoff_posted',
      payload: {
        handoff_id: handoff.id,
        kind: input.kind,
        audit_status: 'recorded',
      },
    });
    return JSON.stringify(redactContextJson({ handoff }), null, 2);
  } finally {
    db.close();
  }
}
