import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { loadWorkflowById, loadWorkflowTasks } from '../../db/persist.js';
import { getDbPath } from '../../utils/config.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_DAEMON_PORT = 20_129;

export const TaskAwaitSchema = z.object({
  task_id: z.string().min(1),
  timeout_ms: z.number().int().min(1000).max(1_800_000).optional().default(600_000),
});

export const TaskCancelSchema = z.object({
  task_id: z.string().min(1),
});

type TaskAwaitInput = z.infer<typeof TaskAwaitSchema>;
type TaskCancelInput = z.infer<typeof TaskCancelSchema>;

interface WorkflowSnapshot {
  workflow_id: string;
  status: string;
  task_count: number;
  duration_ms: number;
  summary: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarize(status: string, tasks: Array<{ status: string }>): string {
  if (tasks.length === 0) return `Workflow ${status}; no tasks recorded.`;

  const counts = new Map<string, number>();
  for (const task of tasks) {
    counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([taskStatus, count]) => `${count} ${taskStatus}`)
    .join(', ');
  return `Workflow ${status}; ${tasks.length} task(s): ${parts}.`;
}

function readWorkflowSnapshot(workflowId: string, startedAt: number): WorkflowSnapshot {
  const db = initDb(getDbPath());
  try {
    const workflow = loadWorkflowById(db, workflowId);
    if (!workflow) {
      return {
        workflow_id: workflowId,
        status: 'not_found',
        task_count: 0,
        duration_ms: Date.now() - startedAt,
        summary: `Workflow not found: ${workflowId}`,
      };
    }

    const tasks = loadWorkflowTasks(db, workflowId);
    return {
      workflow_id: workflow.id,
      status: workflow.status,
      task_count: tasks.length,
      duration_ms: Date.now() - startedAt,
      summary: summarize(workflow.status, tasks),
    };
  } finally {
    db.close();
  }
}

export async function omniforgeTaskAwait(raw: unknown): Promise<string> {
  const input: TaskAwaitInput = TaskAwaitSchema.parse(raw);
  const workflowId = input.task_id;
  const startedAt = Date.now();
  const deadline = startedAt + input.timeout_ms;

  for (;;) {
    const snapshot = readWorkflowSnapshot(workflowId, startedAt);
    if (TERMINAL_STATUSES.has(snapshot.status) || snapshot.status === 'not_found') {
      return JSON.stringify(snapshot);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return JSON.stringify({
        ...snapshot,
        status: 'timeout',
        duration_ms: Date.now() - startedAt,
        summary: `${snapshot.summary} Await timed out after ${input.timeout_ms}ms.`,
      });
    }

    await sleep(Math.min(DEFAULT_POLL_INTERVAL_MS, remainingMs));
  }
}

function readDaemonToken(): string {
  if (process.env.OMNIFORGE_DAEMON_TOKEN) return process.env.OMNIFORGE_DAEMON_TOKEN;

  const tokenPath = path.resolve(process.cwd(), 'data', 'daemon-token.txt');
  if (!existsSync(tokenPath)) {
    throw new Error('Omniforge daemon token not found. Start the daemon or set OMNIFORGE_DAEMON_TOKEN.');
  }
  const token = readFileSync(tokenPath, 'utf8').trim();
  if (!token) throw new Error(`Omniforge daemon token file is empty: ${tokenPath}`);
  return token;
}

function getDaemonPort(): number {
  const raw = process.env.OMNIFORGE_DAEMON_PORT;
  if (!raw) return DEFAULT_DAEMON_PORT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAEMON_PORT;
}

export async function omniforgeTaskCancel(raw: unknown): Promise<string> {
  const input: TaskCancelInput = TaskCancelSchema.parse(raw);
  const workflowId = input.task_id;
  const token = readDaemonToken();
  const port = getDaemonPort();

  const res = await fetch(`http://127.0.0.1:${port}/workflow/${encodeURIComponent(workflowId)}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ reason: 'mcp_task_cancel' }),
  });

  // Read the body as text first: error responses may not be JSON (e.g. an
  // HTML 502 from a proxy, plain text on 500). Parsing best-effort keeps the
  // real HTTP status in the error message instead of a cryptic SyntaxError.
  const rawBody = await res.text();
  let body: {
    wf_id?: string;
    workflow_id?: string;
    cancelled?: boolean;
    tasks_cancelled?: number;
    error?: string;
    status?: string;
  } = {};
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch { /* non-JSON body — fall back to the status-based error below */ }

  if (!res.ok) {
    throw new Error(body.error ?? `Cancel request failed with HTTP ${res.status}`);
  }

  return JSON.stringify({
    workflow_id: body.workflow_id ?? body.wf_id ?? workflowId,
    cancelled: body.cancelled === true,
    tasks_cancelled: typeof body.tasks_cancelled === 'number' ? body.tasks_cancelled : 0,
  });
}
