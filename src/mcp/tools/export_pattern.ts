import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { loadPattern } from '../../patterns/store.js';
import { getDbPath } from '../../utils/config.js';

export const ExportPatternSchema = z.object({
  pattern_id: z.string().min(1),
});

export async function exportPatternTool(raw: unknown): Promise<string> {
  const { pattern_id } = ExportPatternSchema.parse(raw);
  const db = initDb(getDbPath());
  try {
    const pattern = loadPattern(db, pattern_id);
    if (!pattern) return JSON.stringify({ error: `Pattern not found: ${pattern_id}` });
    return JSON.stringify({
      pattern_id: pattern.id,
      name: pattern.name,
      workspace: pattern.workspace,
      objective_sample: pattern.objective_sample,
      dag: JSON.parse(pattern.dag_json) as unknown,
    });
  } finally {
    db.close();
  }
}
