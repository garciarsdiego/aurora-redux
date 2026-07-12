// /status [workflow_id?] — show workflow status, tasks, and recent events.
// Without arg, picks the most recent workflow in the active workspace.
// Falls back to a placeholder when no db handle is wired (early MA bootstrap).
import type Database from 'better-sqlite3';
import type { SlashCommand, SlashResult, ReplCtx } from '../types.js';
import { loadWorkflowById, loadWorkflowTasks } from '../../../db/persist.js';
import type { Workflow, Task } from '../../../types/index.js';
import { toError } from '../../utils/errors.js';

interface StatusArgs {
  workflow_id?: string;
}

interface EventRow {
  type: string;
  task_id: string | null;
  payload_json: string | null;
  timestamp: number;
}

const STATUS_ICON: Readonly<Record<string, string>> = {
  pending:   '·',
  ready:     '·',
  running:   '>',
  completed: 'v',
  failed:    'x',
  skipped:   '-',
  waiting:   '?',
};

function findLatestWorkflow(db: Database.Database, workspace: string): Workflow | null {
  const row = db
    .prepare(
      `SELECT * FROM workflows WHERE id != '_daemon' AND workspace = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(workspace) as Workflow | undefined;
  return row ?? null;
}

function loadRecentEvents(db: Database.Database, wfId: string, limit: number): readonly EventRow[] {
  return db
    .prepare(
      `SELECT type, task_id, payload_json, timestamp FROM events
       WHERE workflow_id = ?
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(wfId, limit) as EventRow[];
}

function formatTask(task: Task): string {
  const icon = STATUS_ICON[task.status] ?? '?';
  const model = task.model ? ` [${task.model}]` : '';
  return `  ${icon} ${task.name.padEnd(40)}${task.kind.padEnd(12)} ${task.status}${model}`;
}

function formatEvent(now: number, ev: EventRow): string {
  const ago = Math.floor((now - ev.timestamp) / 1000);
  const where = ev.task_id ? ` task=${ev.task_id.slice(0, 11)}` : '';
  return `  [${ago}s ago] ${ev.type}${where}`;
}

function formatStatus(wf: Workflow, tasks: readonly Task[], events: readonly EventRow[]): string {
  const now = Date.now();
  const lines: string[] = [];
  lines.push(`Workflow ${wf.id}`);
  lines.push(`  Workspace: ${wf.workspace}`);
  lines.push(`  Status:    ${wf.status}`);
  lines.push(`  Objective: ${wf.objective}`);
  lines.push('');
  lines.push(`Tasks (${tasks.length}):`);
  for (const t of tasks) lines.push(formatTask(t));
  if (events.length > 0) {
    lines.push('');
    lines.push(`Recent events (${events.length}):`);
    for (const ev of events) lines.push(formatEvent(now, ev));
  }
  return lines.join('\n');
}

export const statusCommand: SlashCommand<StatusArgs> = {
  name: 'status',
  category: 'workflow',
  description: 'Show status of the current or specified workflow',
  helpText: [
    'Without arguments, shows status of the most recent workflow in the active workspace.',
    'With a workflow ID, shows status for that specific workflow.',
    '',
    'Output: workflow header + per-task status + last 8 events.',
  ].join('\n'),
  argSpec: [
    { name: 'workflow_id', type: 'workflow_id', required: false, description: 'Workflow ID to inspect (e.g. wf_abc123)' },
  ],
  autoExecute: true,
  mutates: false,

  async handler(args: StatusArgs, ctx: ReplCtx): Promise<SlashResult> {
    if (!ctx.db) {
      const target = args.workflow_id ? ` for ${args.workflow_id}` : '';
      return { output: `MA: status${target} requires a wired db handle; coming in Wire-up phase` };
    }
    try {
      const wf = args.workflow_id
        ? loadWorkflowById(ctx.db, args.workflow_id)
        : findLatestWorkflow(ctx.db, ctx.workspace);
      if (!wf) {
        const msg = args.workflow_id
          ? `Workflow not found: ${args.workflow_id}`
          : `No workflows found in workspace '${ctx.workspace}'.`;
        return { output: msg };
      }
      const tasks = loadWorkflowTasks(ctx.db, wf.id);
      const events = loadRecentEvents(ctx.db, wf.id, 8);
      return { output: formatStatus(wf, tasks, events) };
    } catch (err) {
      return { error: toError(err) };
    }
  },
};
