import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { listPatternsByWorkspace } from '../../db/persist.js';
import { getDbPath } from '../../utils/config.js';
import { VALID_WORKSPACE_RE } from '../../utils/workspace.js';

export const ListPatternsSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE, 'Invalid workspace name (alphanumeric/underscore/hyphen only)'),
  limit: z.number().int().min(1).max(50).optional().default(20),
});

export async function listPatternsTool(raw: unknown): Promise<string> {
  const { workspace, limit } = ListPatternsSchema.parse(raw);
  const db = initDb(getDbPath());
  try {
    const patterns = listPatternsByWorkspace(db, workspace).slice(0, limit);
    return JSON.stringify(
      patterns.map((p) => ({
        id: p.id,
        name: p.name,
        workspace: p.workspace,
        objective_sample: p.objective_sample,
        usage_count: p.usage_count,
        success_count: p.success_count,
        last_used_at: p.last_used_at,
      })),
    );
  } finally {
    db.close();
  }
}
