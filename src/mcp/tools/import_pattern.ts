import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { DagSchema } from '../../types/schemas.js';
import { insertPattern } from '../../db/persist.js';
import { getDbPath } from '../../utils/config.js';
import type { Pattern } from '../../types/index.js';

export const ImportPatternSchema = z.object({
  workspace: z.string().min(1),
  name: z.string().min(1),
  dag: z.unknown(),
  objective_sample: z.string().optional(),
});

export async function importPatternTool(raw: unknown): Promise<string> {
  const { workspace, name, dag, objective_sample } = ImportPatternSchema.parse(raw);
  const validated = DagSchema.safeParse(dag);
  if (!validated.success) {
    return JSON.stringify({
      error: `Invalid DAG: ${JSON.stringify(validated.error.issues).slice(0, 300)}`,
    });
  }
  const db = initDb(getDbPath());
  try {
    const pattern: Pattern = {
      id: `pt_${crypto.randomUUID()}`,
      workspace,
      name,
      source: 'imported',
      objective_sample: objective_sample ?? '',
      dag_json: JSON.stringify(validated.data),
      usage_count: 0,
      success_count: 0,
      avg_duration_ms: null,
      last_used_at: null,
      created_at: Date.now(),
    };
    insertPattern(db, pattern);
    return JSON.stringify({ pattern_id: pattern.id, name, workspace });
  } finally {
    db.close();
  }
}
