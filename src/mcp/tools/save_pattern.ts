import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { saveWorkflowAsPattern } from '../../patterns/store.js';
import { getDbPath } from '../../utils/config.js';

export const SavePatternSchema = z.object({
  workflow_id: z.string().min(1),
  name: z.string().min(1),
});

export async function savePatternTool(raw: unknown): Promise<string> {
  const { workflow_id, name } = SavePatternSchema.parse(raw);
  const db = initDb(getDbPath());
  try {
    const pattern = saveWorkflowAsPattern(db, workflow_id, name);
    return JSON.stringify({ pattern_id: pattern.id, name: pattern.name, workspace: pattern.workspace });
  } finally {
    db.close();
  }
}
