import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { redactContextJson } from '../../context/redaction.js';

const GetArchitectureContractSchema = z.object({
  workflow_id: z.string().min(1),
});

export async function getArchitectureContractTool(raw: unknown): Promise<string> {
  const input = GetArchitectureContractSchema.parse(raw);
  const db = initDb(getDbPath());
  try {
    // The LIKE clause is a cheap SQL-side cut; the decision_type check below
    // remains authoritative. Only the columns actually used are selected.
    const rows = db.prepare(
      `SELECT id, created_at, metadata_json FROM context_decisions
        WHERE run_id = ?
          AND metadata_json LIKE '%architecture_contract%'
        ORDER BY created_at DESC, id DESC`,
    ).all(input.workflow_id) as Array<{ id: unknown; created_at: unknown; metadata_json: string | null }>;

    let match: { id: unknown; created_at: unknown; metadata: Record<string, unknown> } | null = null;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(String(row.metadata_json ?? '{}')) as Record<string, unknown>;
        if (parsed['decision_type'] === 'architecture_contract') {
          match = { id: row.id, created_at: row.created_at, metadata: parsed };
          break;
        }
      } catch { /* malformed metadata_json — skip row */ }
    }

    if (!match) {
      return JSON.stringify({
        workflow_id: input.workflow_id,
        architecture_contract: null,
        message: 'No architecture contract decision found for this workflow.',
      });
    }

    return JSON.stringify(redactContextJson({
      workflow_id: input.workflow_id,
      decision_id: match.id,
      created_at: match.created_at,
      architecture_contract: match.metadata['architecture_contract'] ?? null,
    }), null, 2);
  } finally {
    db.close();
  }
}
