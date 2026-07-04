import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { listModelCallsForWorkflow } from '../../v2/llm-ledger/store.js';

export const GetModelCallsSchema = z.object({
  workflow_id: z.string().min(1),
});

export async function getModelCallsTool(raw: unknown): Promise<string> {
  const { workflow_id } = GetModelCallsSchema.parse(raw);
  const db = initDb(getDbPath());
  try {
    const calls = listModelCallsForWorkflow(db, workflow_id);
    const totalCost = calls.reduce((sum, call) => sum + (call.cost_usd ?? 0), 0);
    const totalInputTokens = calls.reduce((sum, call) => sum + (call.input_tokens ?? 0), 0);
    const totalOutputTokens = calls.reduce((sum, call) => sum + (call.output_tokens ?? 0), 0);
    return JSON.stringify({
      workflow_id,
      total_cost_usd: totalCost,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      calls,
    });
  } finally {
    db.close();
  }
}
