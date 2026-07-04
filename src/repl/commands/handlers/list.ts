// /list [--workspace=X] [--status=Y] [--limit=N] — list recent workflows.
// Queries the workflows table directly via ctx.db. Falls back to a placeholder
// message when no db handle is wired (early MA bootstrap, isolated tests).
import type Database from 'better-sqlite3';
import type { SlashCommand, SlashResult, ReplCtx } from '../types.js';

interface ListArgs {
  workspace?: string;
  status?: string;
  limit?: number;
}

interface WorkflowListRow {
  id: string;
  status: string;
  workspace: string;
  objective: string;
  created_at: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const OBJECTIVE_TRUNC = 60;

function relativeTime(now: number, ts: number): string {
  const diffMs = now - ts;
  if (diffMs < 0) return 'in future';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function shortId(id: string): string {
  // wf_<uuid> — show wf_ + first 8 chars of uuid
  if (id.startsWith('wf_')) return id.slice(0, 11);
  return id.slice(0, 11);
}

function queryWorkflows(
  db: Database.Database,
  workspace: string | undefined,
  status: string | undefined,
  limit: number,
): readonly WorkflowListRow[] {
  // Filter out _daemon sentinel workflow (migration 046).
  const conditions: string[] = [`id != '_daemon'`];
  const params: (string | number)[] = [];
  if (workspace) { conditions.push('workspace = ?'); params.push(workspace); }
  if (status)    { conditions.push('status = ?');    params.push(status); }
  params.push(limit);
  const where = `WHERE ${conditions.join(' AND ')}`;
  return db
    .prepare(
      `SELECT id, status, workspace, objective, created_at FROM workflows
       ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(...params) as WorkflowListRow[];
}

function formatTable(rows: readonly WorkflowListRow[]): string {
  if (rows.length === 0) return 'No workflows found.';
  const now = Date.now();
  const lines: string[] = [];
  lines.push(
    `${'ID'.padEnd(11)}  ${'STATUS'.padEnd(10)}  ${'CREATED'.padEnd(12)}  OBJECTIVE`,
  );
  for (const r of rows) {
    lines.push(
      `${shortId(r.id).padEnd(11)}  ${r.status.padEnd(10)}  ${relativeTime(now, r.created_at).padEnd(12)}  ${truncate(r.objective, OBJECTIVE_TRUNC)}`,
    );
  }
  return lines.join('\n');
}

export const listCommand: SlashCommand<ListArgs> = {
  name: 'list',
  category: 'workflow',
  description: 'List recent workflows',
  helpText: 'Lists recent workflows for the current workspace with their status and creation time.',
  argSpec: [
    { name: 'workspace', type: 'workspace_name', required: false, description: 'Filter by workspace' },
    { name: 'status',    type: 'string',         required: false, description: 'Filter by status (pending|executing|completed|failed|paused|cancelled)' },
    { name: 'limit',     type: 'number',         required: false, default: DEFAULT_LIMIT, description: `Max rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
  ],
  autoExecute: true,
  mutates: false,

  async handler(args: ListArgs, ctx: ReplCtx): Promise<SlashResult> {
    if (!ctx.db) {
      return { output: 'MA: list requires a wired db handle; coming in Wire-up phase' };
    }
    const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    try {
      const rows = queryWorkflows(ctx.db, args.workspace, args.status, limit);
      return { output: formatTable(rows) };
    } catch (err) {
      return { error: err instanceof Error ? err : new Error(String(err)) };
    }
  },
};
