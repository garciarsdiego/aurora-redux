import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { loadThreadMessages } from '../../context/store.js';
import { redactContextJson } from '../../context/redaction.js';

const ReadTaskThreadSchema = z.object({
  workflow_id: z.string().min(1),
  task_id: z.string().min(1),
});

export async function readTaskThreadTool(raw: unknown): Promise<string> {
  const input = ReadTaskThreadSchema.parse(raw);
  const db = initDb(getDbPath());
  try {
    const thread = db.prepare(
      `SELECT * FROM context_threads
        WHERE run_id = ? AND task_id = ? AND kind = 'task'
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
    ).get(input.workflow_id, input.task_id) as Record<string, unknown> | undefined;
    if (!thread) {
      return JSON.stringify({
        workflow_id: input.workflow_id,
        task_id: input.task_id,
        thread: null,
        messages: [],
      });
    }
    const messages = loadThreadMessages(db, String(thread['id']));
    return JSON.stringify(redactContextJson({
      workflow_id: input.workflow_id,
      task_id: input.task_id,
      thread,
      messages,
    }), null, 2);
  } finally {
    db.close();
  }
}
