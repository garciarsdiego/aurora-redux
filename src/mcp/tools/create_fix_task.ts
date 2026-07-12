import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { insertEvent, insertTask, newTaskId } from '../../db/persist.js';
import type { Task } from '../../types/index.js';
import { redactContextJson } from '../../context/redaction.js';

const CreateFixTaskSchema = z.object({
  workflow_id: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  kind: z.enum(['llm_call', 'cli_spawn', 'tool_call']).optional().default('cli_spawn'),
  depends_on: z.array(z.string()).optional().default([]),
  acceptance_criteria: z.string().min(1),
  model: z.string().nullable().optional(),
  executor_hint: z.string().nullable().optional(),
  run_mode: z.enum(['dry-run', 'approved-run']).optional().default('dry-run'),
  approved_by: z.string().optional(),
  source_review_id: z.string().optional(),
});

export async function createFixTaskTool(raw: unknown): Promise<string> {
  const input = CreateFixTaskSchema.parse(raw);
  const db = initDb(getDbPath());
  try {
    const workflow = db.prepare(`SELECT * FROM workflows WHERE id = ?`).get(input.workflow_id) as Record<string, unknown> | undefined;
    if (!workflow) throw new Error(`Workflow not found: ${input.workflow_id}`);

    const draft = {
      workflow_id: input.workflow_id,
      title: input.title,
      objective: input.objective,
      kind: input.kind,
      depends_on: input.depends_on,
      acceptance_criteria: input.acceptance_criteria,
      model: input.model ?? null,
      executor_hint: input.executor_hint ?? (input.kind === 'cli_spawn' ? 'cli:codex' : null),
      run_mode: input.run_mode,
      approval_status: input.run_mode === 'approved-run' ? 'approved' : 'not_required',
      audit_status: 'recorded',
      source_review_id: input.source_review_id ?? null,
    };

    if (input.run_mode !== 'approved-run') {
      return JSON.stringify(redactContextJson({
        created: false,
        reason: 'dry-run',
        draft,
      }), null, 2);
    }

    if (!input.approved_by?.trim()) {
      throw new Error('approved_by is required when run_mode=approved-run');
    }

    const now = Date.now();
    const task: Task = {
      id: newTaskId(),
      workflow_id: input.workflow_id,
      name: input.title,
      kind: input.kind,
      input_json: JSON.stringify({
        objective: input.objective,
        workspace: workflow['workspace'],
        source: 'omniforge_create_fix_task',
        source_review_id: input.source_review_id ?? null,
      }),
      output_json: null,
      status: 'pending',
      depends_on: input.depends_on,
      executor_hint: draft.executor_hint,
      timeout_seconds: 600,
      max_retries: 3,
      retry_count: 0,
      retry_policy: 'exponential',
      started_at: null,
      completed_at: null,
      created_at: now,
      acceptance_criteria: input.acceptance_criteria,
      refine_count: 0,
      max_refine: 2,
      refine_feedback: null,
      model: input.model ?? null,
      hitl: false,
      execution_mode: 'ephemeral',
      workspace: String(workflow['workspace']),
    };
    insertTask(db, task);
    insertEvent(db, {
      workflow_id: input.workflow_id,
      task_id: task.id,
      type: 'mcp_fix_task_created',
      payload: {
        run_mode: input.run_mode,
        approval_status: 'approved',
        audit_status: 'recorded',
        approved_by: input.approved_by,
        source_review_id: input.source_review_id ?? null,
      },
    });

    return JSON.stringify(redactContextJson({
      created: true,
      task_id: task.id,
      draft,
    }), null, 2);
  } finally {
    db.close();
  }
}
