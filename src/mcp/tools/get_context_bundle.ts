import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { buildWorkflowDebugLog } from '../../db/workflow-debug-log.js';
import { getDbPath } from '../../utils/config.js';

export const GetContextBundleSchema = z.object({
  workflow_id: z.string().min(1),
});

export async function getContextBundleTool(raw: unknown): Promise<string> {
  const { workflow_id } = GetContextBundleSchema.parse(raw);
  const db = initDb(getDbPath());
  try {
    const log = buildWorkflowDebugLog(db, workflow_id);
    return JSON.stringify({
      workflow_id,
      generated_at: log.generated_at,
      workflow: {
        id: log.workflow['id'],
        workspace: log.workflow['workspace'],
        status: log.workflow['status'],
        objective: log.workflow['objective'],
      },
      context_orchestration: log.context_orchestration,
      structured_errors: log.structured_errors,
    });
  } finally {
    db.close();
  }
}
