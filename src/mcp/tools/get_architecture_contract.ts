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
    const row = db.prepare(
      `SELECT * FROM context_decisions
        WHERE run_id = ?
        ORDER BY created_at DESC, id DESC`,
    ).all(input.workflow_id)
      .find((decision) => {
        try {
          const parsed = JSON.parse(String((decision as Record<string, unknown>)['metadata_json'] ?? '{}')) as Record<string, unknown>;
          return parsed['decision_type'] === 'architecture_contract';
        } catch {
          return false;
        }
      }) as Record<string, unknown> | undefined;

    if (!row) {
      return JSON.stringify({
        workflow_id: input.workflow_id,
        architecture_contract: null,
        message: 'No architecture contract decision found for this workflow.',
      });
    }

    const metadata = JSON.parse(String(row['metadata_json'] ?? '{}')) as Record<string, unknown>;
    return JSON.stringify(redactContextJson({
      workflow_id: input.workflow_id,
      decision_id: row['id'],
      created_at: row['created_at'],
      architecture_contract: metadata['architecture_contract'] ?? null,
    }), null, 2);
  } finally {
    db.close();
  }
}
