import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { loadWorkflowTasks } from '../../db/persist.js';
import { getDbPath } from '../../utils/config.js';
import { findActiveSession } from '../../v2/cli-tail/discovery.js';
import type { TailEvent } from '../../v2/cli-tail/types.js';

export const TailCliSchema = z.object({
  workflow_id: z.string().min(1),
  task_id: z.string().min(1),
  since_event_id: z.number().optional(),
  limit: z.number().optional().default(50),
});

export interface TailCliResult {
  events: TailEvent[];
  session_path: string | null;
  cli_id: string;
  total_events: number;
}

/**
 * Resolves executor_hint → cliId the same way cli.ts does,
 * without importing the full executor (avoids side-effects).
 */
function resolveCli(executorHint: string | null | undefined): string {
  if (executorHint?.startsWith('cli:')) {
    const id = executorHint.slice(4);
    if (id && id !== 'auto' && id !== 'default') return id;
  }
  return 'claude-code';
}

async function loadParser(cliId: string) {
  switch (cliId) {
    case 'codex':
      return (await import('../../v2/cli-tail/parsers/codex.js')).default;
    case 'claude-code':
      return (await import('../../v2/cli-tail/parsers/claude.js')).default;
    case 'gemini':
      return (await import('../../v2/cli-tail/parsers/gemini.js')).default;
    case 'kimi':
      return (await import('../../v2/cli-tail/parsers/kimi.js')).default;
    case 'cursor':
      return (await import('../../v2/cli-tail/parsers/cursor.js')).default;
    case 'opencode':
      return (await import('../../v2/cli-tail/parsers/opencode.js')).default;
    default:
      return (await import('../../v2/cli-tail/parsers/claude.js')).default;
  }
}

export async function tailCliTool(raw: unknown): Promise<TailCliResult> {
  const { workflow_id, task_id, since_event_id, limit } = TailCliSchema.parse(raw);
  const db = initDb(getDbPath());
  try {
    const tasks = loadWorkflowTasks(db, workflow_id);
    const task = tasks.find((t) => t.id === task_id);
    if (!task) {
      return { events: [], session_path: null, cli_id: 'unknown', total_events: 0 };
    }

    const cliId = resolveCli(task.executor_hint);
    const taskStartedAt = task.started_at ?? Date.now() - 3_600_000;
    const sessionPath = findActiveSession(cliId, taskStartedAt);

    if (!sessionPath) {
      return { events: [], session_path: null, cli_id: cliId, total_events: 0 };
    }

    const parser = await loadParser(cliId);
    const allEvents = parser.parse(sessionPath);
    const total_events = allEvents.length;

    // Slice by since_event_id (0-based index) and limit
    const from = since_event_id !== undefined ? since_event_id : 0;
    const events = allEvents.slice(from, from + limit);

    return { events, session_path: sessionPath, cli_id: cliId, total_events };
  } finally {
    db.close();
  }
}
